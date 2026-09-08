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
  prepareExtractionArtifact,
  prepareExtractionFailure,
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
 * are out of scope here and are documented follow-ups. `extraction_run`
 * persistence is a filed schema request; until it lands the span counts and
 * dropped quotes are returned in the summary but not stored.
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
  sourceDocumentId: string;
  documentKind: string;
  normalizedText: string;
  normalizedHash: string;
}>;

const WORK_ITEM_CONTEXT_SELECT = `SELECT
  s.content_json AS specContentJson,
  s.content_hash AS specContentHash,
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
}>;

function recordFailure(
  composition: RuntimeComposition,
  item: AttemptWorkItem,
  claimedVersion: number,
  sourceDocumentId: string,
  plan: FailurePlan,
  now: number
): Result<void, RuntimeError> {
  const responseByteLength = utf8Encoder.encode(plan.responseBody).length;
  const prepared = prepareExtractionFailure({
    extractionFailureId: composition.idGenerator.next(),
    specId: item.extractionSpecId,
    sourceDocumentId,
    errorClass: plan.errorClass,
    responseHash: sha256Hex(plan.responseBody),
    responseByteLength,
    diagnostic: { summary: plan.summary, details: [truncateDetail(plan.detail)] },
    createdAt: now
  });
  if (!prepared.ok) {
    return prepared;
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
    const failed = failAttemptWorkItem(context, {
      attemptWorkItemId: item.attemptWorkItemId,
      state: plan.state,
      extractionFailureId: failureId,
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
      sourceDocumentId,
      {
        state: "blocked_failure",
        errorClass: "structurally_invalid",
        summary: "Extraction provider call failed",
        detail: response.error.message,
        responseBody: ""
      },
      now
    );
    return recorded.ok ? ok({ kind: "blocked_failure" }) : recorded;
  }

  const parsed = parseExtractionResponseBody(response.value.body);
  if (!parsed.ok) {
    const recorded = recordFailure(
      composition,
      item,
      claimedVersion,
      sourceDocumentId,
      {
        state: "blocked_failure",
        errorClass: "structurally_invalid",
        summary: "Extraction response body is off contract",
        detail: parsed.error.message,
        responseBody: response.value.body
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
      sourceDocumentId,
      {
        state: "blocked_failure",
        errorClass: "identity_mismatch",
        summary: "Extraction response is for the wrong dimension",
        detail: `expected ${item.dimensionId}, received ${parsed.value.dimensionId}`,
        responseBody: response.value.body
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
      sourceDocumentId,
      {
        state: "blocked_failure",
        errorClass: "structurally_invalid",
        summary: "Extraction response quote is unusable",
        detail: located.error.message,
        responseBody: response.value.body
      },
      now
    );
    return recorded.ok ? ok({ kind: "blocked_failure" }) : recorded;
  }

  const { acceptedOutput, rejectedClaims, droppedQuotes, spansReturned, spansLocated } =
    located.value;

  const hasSupportingSpan = acceptedOutput.spans.some(
    (span) => span.polarity === "supporting"
  );
  if (acceptedOutput.proposedLevel !== "none" && !hasSupportingSpan) {
    const recorded = recordFailure(
      composition,
      item,
      claimedVersion,
      sourceDocumentId,
      {
        state: "reviewable_failure",
        errorClass: "structurally_invalid",
        summary: "Extraction proposed a level with no located supporting span",
        detail: `level ${acceptedOutput.proposedLevel}, ${spansLocated} of ${spansReturned} spans located`,
        responseBody: response.value.body
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
      sourceDocumentId,
      {
        state: "blocked_failure",
        errorClass: "cardinality_exceeded",
        summary: "Extraction artifact failed preparation",
        detail: preparedArtifact.error.message,
        responseBody: response.value.body
      },
      now
    );
    return recorded.ok ? ok({ kind: "blocked_failure" }) : recorded;
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
    const completed = completeAttemptWorkItem(context, {
      attemptWorkItemId: item.attemptWorkItemId,
      extractionArtifactId: artifactId,
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
