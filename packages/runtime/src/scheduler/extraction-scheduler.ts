import {
  err,
  ok,
  sha256Hex,
  type ExtractionFailureErrorClass,
  type Result
} from "@recruitos/core";

import {
  claimAttemptWorkItem,
  completeAttemptWorkItem,
  failAttemptWorkItem,
  readAttemptWorkItems,
  readTriageAttempt,
  type AttemptWorkItem
} from "../attempts/index.js";
import type { RuntimeComposition } from "../composition/index.js";
import { runImmediateTransaction } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import type { DroppedQuote } from "../evidence/index.js";
import {
  insertExtractionArtifact,
  insertExtractionFailure,
  insertExtractionRun,
  prepareExtractionArtifact,
  prepareExtractionFailure,
  prepareExtractionRun,
  readExtractionArtifactByContentHash,
  readExtractionFailureByContentHash
} from "../extraction/index.js";
import {
  locateResponseSpans,
  parseExtractionResponseBody
} from "../extraction/response.js";

/**
 * The serial extraction scheduler. It serves one triage attempt's work items in
 * manifest order: each pending item is claimed in a short transaction, the
 * extraction adapter is called outside any lock, the response is parsed and
 * every quote is located against the stored normalized text, and the item moves
 * to `succeeded`, `reviewable_failure` (a claimed level with no located
 * supporting span), or `blocked_failure` (fixture miss, malformed body,
 * dimension mismatch, unusable quote).
 *
 * Concurrency, `SIGINT` grace, claim-expiry reclaim, and live retry and backoff
 * are out of scope here and are documented follow-ups.
 *
 * Every processed work item, succeeded or failed, records one `extraction_run`
 * row carrying the returned and located span counts and the dropped quotes, and
 * links it on the work item. Finalize aggregates those rows into the confidence
 * resolution term, so the term is reproducible from stored rows.
 */

const CLAIM_TTL_MS = 5 * 60 * 1000;
const MAXIMUM_DIAGNOSTIC_DETAIL = 200;

const utf8Encoder = new TextEncoder();

export type ExtractionSchedulerSummary = Readonly<{
  triageAttemptId: string;
  totalWorkItems: number;
  alreadySucceeded: number;
  processed: number;
  succeeded: number;
  reviewableFailures: number;
  blockedFailures: number;
  reusedArtifacts: number;
  spansReturned: number;
  spansLocated: number;
  droppedQuotes: readonly DroppedQuote[];
}>;

export type RunExtractionAttemptInput = Readonly<{ triageAttemptId: string }>;

function schedulerFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function truncateDetail(text: string): string {
  return text.length > MAXIMUM_DIAGNOSTIC_DETAIL
    ? text.slice(0, MAXIMUM_DIAGNOSTIC_DETAIL)
    : text;
}

type WorkItemContext = Readonly<{
  specContentJson: string;
  specContentHash: string;
  specModelId: string;
  sourceDocumentId: string;
  documentKind: string;
  normalizedText: string;
  normalizedHash: string;
}>;

const WORK_ITEM_CONTEXT_SELECT = `SELECT
  s.content_json AS specContentJson,
  s.content_hash AS specContentHash,
  s.model_id AS specModelId,
  cd.document_kind AS documentKind,
  sd.source_document_id AS sourceDocumentId,
  sd.normalized_text AS normalizedText,
  sd.normalized_hash AS normalizedHash
FROM attempt_work_item wi
JOIN extraction_spec s ON s.extraction_spec_id = wi.extraction_spec_id
JOIN candidate_document cd ON cd.candidate_document_id = wi.candidate_document_id
JOIN source_document sd ON sd.source_document_id = cd.source_document_id
WHERE wi.attempt_work_item_id = ?`;

/**
 * The spec text and the exact document a work item extracts from, read in one
 * join. Every joined row is reachable through a not-null foreign key, so a
 * missing row is a database integrity fault, not an ordinary outcome.
 */
function loadWorkItemContext(
  connection: RuntimeComposition["connection"],
  item: AttemptWorkItem
): Result<WorkItemContext, RuntimeError> {
  return runImmediateTransaction(connection, (context) => {
    // Every join is on a NOT NULL foreign key from an existing work item, so a
    // row always comes back; any fault throws and is caught as a persistence
    // error by runImmediateTransaction.
    const row = context.nativeDatabase
      .prepare(WORK_ITEM_CONTEXT_SELECT)
      .get(item.attemptWorkItemId) as WorkItemContext;
    return ok(row);
  });
}

/** Field separator that cannot appear in a hash or the closed documentKind enum. */
const REQUEST_HASH_SEPARATOR = "|";

/**
 * The content address of everything that determines one extraction answer: the
 * per-dimension spec content plus the exact document read. The fixture adapter
 * keys its lookup on this, so two candidates with different resumes never
 * collide. All three parts are fixed-shape strings, so a plain delimiter join
 * is an unambiguous encoding.
 */
function buildRequestHash(workContext: WorkItemContext): string {
  return sha256Hex(
    [
      workContext.specContentHash,
      workContext.documentKind,
      workContext.normalizedHash
    ].join(REQUEST_HASH_SEPARATOR)
  );
}

type FailurePlan = Readonly<{
  state: "reviewable_failure" | "blocked_failure";
  errorClass: ExtractionFailureErrorClass;
  summary: string;
  detail: string;
  responseBody: string;
  spansReturned: number;
  spansLocated: number;
  droppedQuotes: readonly DroppedQuote[];
}>;

/**
 * Builds the `extraction_run` record for one processed work item outside the
 * writer lock. `fixtureKey` is the content-address the fixture adapter keyed on
 * in fixture mode, and null for a live call or a provider error with no body.
 */
function prepareRunForItem(
  composition: RuntimeComposition,
  workContext: WorkItemContext,
  spansReturned: number,
  spansLocated: number,
  droppedQuotes: readonly DroppedQuote[],
  fixtureKey: string | null,
  now: number
): Result<{ extractionRunId: string }, RuntimeError> {
  const prepared = prepareExtractionRun({
    extractionRunId: composition.idGenerator.next(),
    spansReturned,
    spansLocated,
    droppedQuotes: [...droppedQuotes],
    modelId: workContext.specModelId,
    fixtureKey,
    createdAt: now
  });
  /* v8 ignore next 3 -- callers always pass counts that satisfy prepareExtractionRun. */
  if (!prepared.ok) {
    return prepared;
  }
  return ok(prepared.value);
}

function recordFailure(
  composition: RuntimeComposition,
  item: AttemptWorkItem,
  claimedVersion: number,
  workContext: WorkItemContext,
  fixtureKey: string | null,
  plan: FailurePlan,
  now: number
): Result<void, RuntimeError> {
  const responseByteLength = utf8Encoder.encode(plan.responseBody).length;
  const prepared = prepareExtractionFailure({
    extractionFailureId: composition.idGenerator.next(),
    specId: item.extractionSpecId,
    sourceDocumentId: workContext.sourceDocumentId,
    errorClass: plan.errorClass,
    responseHash: sha256Hex(plan.responseBody),
    responseByteLength,
    diagnostic: { summary: plan.summary, details: [truncateDetail(plan.detail)] },
    createdAt: now
  });
  if (!prepared.ok) {
    return prepared;
  }
  const preparedRun = prepareRunForItem(
    composition,
    workContext,
    plan.spansReturned,
    plan.spansLocated,
    plan.droppedQuotes,
    fixtureKey,
    now
  );
  /* v8 ignore next 3 -- span counts are always consistent, so prepareExtractionRun cannot fail. */
  if (!preparedRun.ok) {
    return preparedRun;
  }
  return runImmediateTransaction(composition.connection, (context) => {
    const existing = readExtractionFailureByContentHash(context, prepared.value.contentHash);
    if (!existing.ok) {
      return existing;
    }
    const failureId =
      existing.value === undefined
        ? prepared.value.extractionFailureId
        : existing.value.extractionFailureId;
    if (existing.value === undefined) {
      const inserted = insertExtractionFailure(context, prepared.value);
      if (!inserted.ok) {
        return inserted;
      }
    }
    const insertedRun = insertExtractionRun(context, preparedRun.value);
    if (!insertedRun.ok) {
      return insertedRun;
    }
    const failed = failAttemptWorkItem(context, {
      attemptWorkItemId: item.attemptWorkItemId,
      state: plan.state,
      extractionFailureId: failureId,
      extractionRunId: preparedRun.value.extractionRunId,
      failedAt: now,
      expectedVersion: claimedVersion
    });
    if (!failed.ok) {
      return failed;
    }
    return ok(undefined);
  });
}

type ProcessOutcome =
  | Readonly<{ kind: "succeeded"; reused: boolean; spansReturned: number; spansLocated: number; dropped: readonly DroppedQuote[] }>
  | Readonly<{ kind: "reviewable_failure"; spansReturned: number; spansLocated: number; dropped: readonly DroppedQuote[] }>
  | Readonly<{ kind: "blocked_failure" }>;

async function processWorkItem(
  composition: RuntimeComposition,
  item: AttemptWorkItem
): Promise<Result<ProcessOutcome, RuntimeError>> {
  const loaded = loadWorkItemContext(composition.connection, item);
  if (!loaded.ok) {
    return loaded;
  }
  const workContext = loaded.value;
  const requestHash = buildRequestHash(workContext);

  const claimedAt = composition.clock.now();
  const claimed = runImmediateTransaction(composition.connection, (context) =>
    claimAttemptWorkItem(context, {
      attemptWorkItemId: item.attemptWorkItemId,
      claimId: composition.idGenerator.next(),
      claimedAt,
      claimExpiresAt: claimedAt + CLAIM_TTL_MS,
      expectedVersion: item.version
    })
  );
  if (!claimed.ok) {
    return claimed;
  }
  const claimedVersion = claimed.value.version;
  const sourceDocumentId = workContext.sourceDocumentId;
  const noSpans: Pick<FailurePlan, "spansReturned" | "spansLocated" | "droppedQuotes"> = {
    spansReturned: 0,
    spansLocated: 0,
    droppedQuotes: []
  };

  const response = await composition.extraction.extract({
    extractionSpecHash: requestHash,
    instructions: workContext.specContentJson,
    documents: [
      {
        documentId: sourceDocumentId,
        documentKind: workContext.documentKind,
        normalizedText: workContext.normalizedText,
        normalizedHash: workContext.normalizedHash
      }
    ]
  });
  const now = composition.clock.now();

  if (!response.ok) {
    const recorded = recordFailure(
      composition,
      item,
      claimedVersion,
      workContext,
      null,
      {
        state: "blocked_failure",
        errorClass: "structurally_invalid",
        summary: "Extraction provider call failed",
        detail: response.error.message,
        responseBody: "",
        ...noSpans
      },
      now
    );
    return recorded.ok ? ok({ kind: "blocked_failure" }) : recorded;
  }

  const fixtureKey =
    response.value.descriptor.mode === "fixture" ? requestHash : null;

  const parsed = parseExtractionResponseBody(response.value.body);
  if (!parsed.ok) {
    const recorded = recordFailure(
      composition,
      item,
      claimedVersion,
      workContext,
      fixtureKey,
      {
        state: "blocked_failure",
        errorClass: "structurally_invalid",
        summary: "Extraction response body is off contract",
        detail: parsed.error.message,
        responseBody: response.value.body,
        ...noSpans
      },
      now
    );
    return recorded.ok ? ok({ kind: "blocked_failure" }) : recorded;
  }

  if (parsed.value.dimensionId !== item.dimensionId) {
    const recorded = recordFailure(
      composition,
      item,
      claimedVersion,
      workContext,
      fixtureKey,
      {
        state: "blocked_failure",
        errorClass: "identity_mismatch",
        summary: "Extraction response is for the wrong dimension",
        detail: `expected ${item.dimensionId}, received ${parsed.value.dimensionId}`,
        responseBody: response.value.body,
        ...noSpans
      },
      now
    );
    return recorded.ok ? ok({ kind: "blocked_failure" }) : recorded;
  }

  const located = locateResponseSpans(parsed.value, workContext.normalizedText);
  if (!located.ok) {
    const recorded = recordFailure(
      composition,
      item,
      claimedVersion,
      workContext,
      fixtureKey,
      {
        state: "blocked_failure",
        errorClass: "structurally_invalid",
        summary: "Extraction response quote is unusable",
        detail: located.error.message,
        responseBody: response.value.body,
        ...noSpans
      },
      now
    );
    return recorded.ok ? ok({ kind: "blocked_failure" }) : recorded;
  }

  const { acceptedOutput, rejectedClaims, droppedQuotes, spansReturned, spansLocated } =
    located.value;
  const spanCounts = { spansReturned, spansLocated, droppedQuotes };

  const hasSupportingSpan = acceptedOutput.spans.some(
    (span) => span.polarity === "supporting"
  );
  if (acceptedOutput.proposedLevel !== "none" && !hasSupportingSpan) {
    const recorded = recordFailure(
      composition,
      item,
      claimedVersion,
      workContext,
      fixtureKey,
      {
        state: "reviewable_failure",
        errorClass: "structurally_invalid",
        summary: "Extraction proposed a level with no located supporting span",
        detail: `level ${acceptedOutput.proposedLevel}, ${spansLocated} of ${spansReturned} spans located`,
        responseBody: response.value.body,
        ...spanCounts
      },
      now
    );
    return recorded.ok
      ? ok({ kind: "reviewable_failure", spansReturned, spansLocated, dropped: droppedQuotes })
      : recorded;
  }

  const preparedArtifact = prepareExtractionArtifact({
    extractionArtifactId: composition.idGenerator.next(),
    specId: item.extractionSpecId,
    sourceDocumentId,
    acceptedOutput,
    rejectedClaims,
    createdAt: now
  });
  if (!preparedArtifact.ok) {
    const recorded = recordFailure(
      composition,
      item,
      claimedVersion,
      workContext,
      fixtureKey,
      {
        state: "blocked_failure",
        errorClass: "cardinality_exceeded",
        summary: "Extraction artifact failed preparation",
        detail: preparedArtifact.error.message,
        responseBody: response.value.body,
        ...spanCounts
      },
      now
    );
    return recorded.ok ? ok({ kind: "blocked_failure" }) : recorded;
  }

  const preparedRun = prepareRunForItem(
    composition,
    workContext,
    spansReturned,
    spansLocated,
    droppedQuotes,
    fixtureKey,
    now
  );
  /* v8 ignore next 3 -- locateResponseSpans guarantees consistent counts, so this cannot fail. */
  if (!preparedRun.ok) {
    return preparedRun;
  }

  const completion = runImmediateTransaction(composition.connection, (context) => {
    const existing = readExtractionArtifactByContentHash(
      context,
      preparedArtifact.value.contentHash
    );
    if (!existing.ok) {
      return existing;
    }
    const reused = existing.value !== undefined;
    const artifactId = reused
      ? existing.value!.extractionArtifactId
      : preparedArtifact.value.extractionArtifactId;
    if (!reused) {
      const inserted = insertExtractionArtifact(context, preparedArtifact.value);
      if (!inserted.ok) {
        return inserted;
      }
    }
    const insertedRun = insertExtractionRun(context, preparedRun.value);
    if (!insertedRun.ok) {
      return insertedRun;
    }
    const completed = completeAttemptWorkItem(context, {
      attemptWorkItemId: item.attemptWorkItemId,
      extractionArtifactId: artifactId,
      extractionRunId: preparedRun.value.extractionRunId,
      completedAt: now,
      expectedVersion: claimedVersion
    });
    if (!completed.ok) {
      return completed;
    }
    return ok(reused);
  });
  if (!completion.ok) {
    return completion;
  }

  return ok({
    kind: "succeeded",
    reused: completion.value,
    spansReturned,
    spansLocated,
    dropped: droppedQuotes
  });
}

export async function runExtractionAttempt(
  composition: RuntimeComposition,
  input: RunExtractionAttemptInput
): Promise<Result<ExtractionSchedulerSummary, RuntimeError>> {
  if (!isObject(composition) || !isObject(composition.extraction)) {
    return err(schedulerFailure("Invalid runtime composition"));
  }
  if (
    !isObject(input) ||
    typeof input.triageAttemptId !== "string" ||
    input.triageAttemptId.length === 0
  ) {
    return err(schedulerFailure("Extraction run requires a triage attempt id"));
  }

  const items = runImmediateTransaction(composition.connection, (context) => {
    const attempt = readTriageAttempt(context, input.triageAttemptId);
    if (!attempt.ok) {
      return attempt;
    }
    if (attempt.value === undefined) {
      return err(createRuntimeError("not_found", "Triage attempt not found", false));
    }
    return readAttemptWorkItems(context, input.triageAttemptId);
  });
  if (!items.ok) {
    return items;
  }

  let alreadySucceeded = 0;
  let processed = 0;
  let succeeded = 0;
  let reviewableFailures = 0;
  let blockedFailures = 0;
  let reusedArtifacts = 0;
  let spansReturned = 0;
  let spansLocated = 0;
  const droppedQuotes: DroppedQuote[] = [];

  for (const item of items.value) {
    if (item.state === "succeeded") {
      alreadySucceeded += 1;
      continue;
    }
    if (item.state !== "pending" && item.state !== "retryable_failure") {
      continue;
    }

    const outcome = await processWorkItem(composition, item);
    if (!outcome.ok) {
      return outcome;
    }
    processed += 1;
    if (outcome.value.kind === "succeeded") {
      succeeded += 1;
      if (outcome.value.reused) {
        reusedArtifacts += 1;
      }
      spansReturned += outcome.value.spansReturned;
      spansLocated += outcome.value.spansLocated;
      droppedQuotes.push(...outcome.value.dropped);
    } else if (outcome.value.kind === "reviewable_failure") {
      reviewableFailures += 1;
      spansReturned += outcome.value.spansReturned;
      spansLocated += outcome.value.spansLocated;
      droppedQuotes.push(...outcome.value.dropped);
    } else {
      blockedFailures += 1;
    }
  }

  return ok({
    triageAttemptId: input.triageAttemptId,
    totalWorkItems: items.value.length,
    alreadySucceeded,
    processed,
    succeeded,
    reviewableFailures,
    blockedFailures,
    reusedArtifacts,
    spansReturned,
    spansLocated,
    droppedQuotes
  });
}
