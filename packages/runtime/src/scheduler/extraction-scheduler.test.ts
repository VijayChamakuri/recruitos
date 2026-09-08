import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  EXTRACTION_LIMITS,
  SCORING_POLICY_V1,
  sha256Hex,
  type Result
} from "@recruitos/core";

import {
  createFixtureExtractionAdapter,
  type ExtractionAdapter
} from "../adapters/index.js";
import {
  insertAttemptWorkItem,
  insertTriageAttempt,
  prepareAttemptWorkItem,
  prepareTriageAttempt,
  readAttemptWorkItems
} from "../attempts/index.js";
import { runImmediateTransaction, type ImmediateTransactionContext } from "../commands/index.js";
import {
  createRuntime,
  type RuntimeComposition
} from "../composition/index.js";
import {
  insertCandidate,
  insertCandidateDocument,
  insertSourceDocument,
  prepareCandidate,
  prepareCandidateDocument,
  prepareSourceDocument
} from "../entities/index.js";
import type { RuntimeError } from "../errors/index.js";
import {
  insertCorpusManifest,
  insertCorpusManifestSeal,
  insertCorpusMember,
  insertCorpusMemberDocument,
  prepareCorpusManifest,
  prepareCorpusManifestSeal,
  prepareCorpusMember,
  prepareCorpusMemberDocument
} from "../corpus/index.js";
import {
  insertExtractionSpec,
  prepareExtractionSpec,
  readExtractionArtifact,
  readExtractionFailure,
  readExtractionRun
} from "../extraction/index.js";
import { insertRole, prepareRole } from "../roles/index.js";
import { insertRunInputSnapshot, prepareRunInputSnapshot } from "../snapshots/index.js";
import { runExtractionAttempt } from "./extraction-scheduler.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const PROMPT_HASH = sha256Hex("prompt-template-v1");
const SCHEMA_HASH = sha256Hex("extraction-output-schema-v1");
const DIMENSION = "evaluation_practice";
const RESUME_TEXT = "Candidate one ran holdout evaluations before every launch.";

function unwrap<T>(result: Result<T, RuntimeError> | Result<T, { message: string }>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function nativeInTransaction<T>(
  composition: RuntimeComposition,
  work: (context: ImmediateTransactionContext) => Result<T, RuntimeError>
): T {
  return unwrap(runImmediateTransaction(composition.connection, work));
}

function specContent() {
  return {
    modelId: "test-extractor",
    extractorVersion: "extractor-v1",
    promptTemplateVersion: "prompt-v1",
    promptHash: PROMPT_HASH,
    schemaHash: SCHEMA_HASH,
    dimensionId: DIMENSION,
    dimensionDefinition: "Evidence of structured evaluation practice.",
    jobRelatedJustification: "Hiring managers review evaluation quality.",
    limits: { ...EXTRACTION_LIMITS }
  };
}

function snapshotContent() {
  return {
    frozenDate: "2026-09-07",
    roleId: "role-applied-ai-engineer",
    rubricVersion: "1",
    dimensions: [
      {
        dimensionId: DIMENSION,
        weight: 2,
        required: true,
        definition: "Evidence of structured evaluation practice.",
        jobRelatedJustification: "Hiring managers review evaluation quality.",
        ordinal: 0
      }
    ],
    scoringPolicy: {
      levelValues: { ...SCORING_POLICY_V1.levelValues },
      confidenceWeights: { ...SCORING_POLICY_V1.confidenceWeights },
      escalateThreshold: SCORING_POLICY_V1.escalateThreshold,
      shortlistN: SCORING_POLICY_V1.shortlistN,
      requiredFieldIds: [...SCORING_POLICY_V1.requiredFieldIds]
    },
    extractorVersion: "extractor-v1",
    promptTemplateVersion: "prompt-v1",
    limits: { ...EXTRACTION_LIMITS }
  };
}

type SeededItem = Readonly<{ index: number; rawText: string }>;

async function seed(
  items: readonly SeededItem[],
  adapter: ExtractionAdapter
): Promise<RuntimeComposition> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-scheduler-"));
  temporaryDirectories.push(directory);
  const runtime = unwrap(
    createRuntime({
      database: { filename: join(directory, "runtime.db"), migrationsFolder },
      extraction: adapter
    })
  );

  nativeInTransaction(runtime, (context) => {
    unwrap(
      insertRole(
        context,
        unwrap(
          prepareRole({
            roleId: "role-applied-ai-engineer",
            title: "Applied AI Engineer",
            createdAt: CREATED_AT
          })
        )
      )
    );
    unwrap(
      insertRunInputSnapshot(
        context,
        unwrap(
          prepareRunInputSnapshot({
            runInputSnapshotId: "run-input-snapshot-1",
            content: snapshotContent(),
            createdAt: CREATED_AT
          })
        )
      )
    );
    unwrap(
      insertExtractionSpec(
        context,
        unwrap(
          prepareExtractionSpec({
            extractionSpecId: "extraction-spec-1",
            content: specContent(),
            createdAt: CREATED_AT
          })
        )
      )
    );

    const members = items.map((item) => ({
      candidateId: `candidate-${item.index + 1}`,
      importOrdinal: item.index,
      documents: [
        { candidateDocumentId: `candidate-document-${item.index + 1}`, documentOrdinal: 0 }
      ]
    }));
    const sourceDocumentIdByText = new Map<string, string>();
    for (const item of items) {
      unwrap(
        insertCandidate(
          context,
          unwrap(
            prepareCandidate({
              candidateId: `candidate-${item.index + 1}`,
              sourceSystem: "synthetic_corpus",
              sourceKey: `tier-one/${String(item.index + 1).padStart(4, "0")}`,
              channel: "inbound",
              corpusTag: "variant",
              createdAt: CREATED_AT
            })
          )
        )
      );
      let sourceDocumentId = sourceDocumentIdByText.get(item.rawText);
      if (sourceDocumentId === undefined) {
        sourceDocumentId = `source-document-${item.index + 1}`;
        unwrap(
          insertSourceDocument(
            context,
            unwrap(
              prepareSourceDocument({
                sourceDocumentId,
                rawText: item.rawText,
                normalizedText: item.rawText,
                createdAt: CREATED_AT
              })
            )
          )
        );
        sourceDocumentIdByText.set(item.rawText, sourceDocumentId);
      }
      unwrap(
        insertCandidateDocument(
          context,
          unwrap(
            prepareCandidateDocument({
              candidateDocumentId: `candidate-document-${item.index + 1}`,
              candidateId: `candidate-${item.index + 1}`,
              sourceDocumentId,
              documentKind: "resume",
              label: "Resume",
              documentOrdinal: 0,
              createdAt: CREATED_AT
            })
          )
        )
      );
    }

    unwrap(
      insertCorpusManifest(
        context,
        unwrap(
          prepareCorpusManifest({
            corpusManifestId: "corpus-manifest-1",
            kind: "variant",
            sealId: "corpus-manifest-seal-1",
            createdAt: CREATED_AT,
            content: { kind: "variant", members }
          })
        )
      )
    );
    for (const item of items) {
      unwrap(
        insertCorpusMember(
          context,
          unwrap(
            prepareCorpusMember({
              corpusMemberId: `corpus-member-${item.index + 1}`,
              manifestId: "corpus-manifest-1",
              candidateId: `candidate-${item.index + 1}`,
              importOrdinal: item.index,
              createdAt: CREATED_AT
            })
          )
        )
      );
      unwrap(
        insertCorpusMemberDocument(
          context,
          unwrap(
            prepareCorpusMemberDocument({
              corpusMemberDocumentId: `corpus-member-document-${item.index + 1}`,
              corpusMemberId: `corpus-member-${item.index + 1}`,
              candidateDocumentId: `candidate-document-${item.index + 1}`,
              documentOrdinal: 0,
              createdAt: CREATED_AT
            })
          )
        )
      );
    }
    unwrap(
      insertCorpusManifestSeal(
        context,
        unwrap(
          prepareCorpusManifestSeal({
            corpusManifestSealId: "corpus-manifest-seal-1",
            manifestId: "corpus-manifest-1",
            createdAt: CREATED_AT
          })
        )
      )
    );

    unwrap(
      insertTriageAttempt(
        context,
        unwrap(
          prepareTriageAttempt({
            triageAttemptId: "triage-attempt-1",
            kind: "variant_run",
            snapshotId: "run-input-snapshot-1",
            corpusManifestId: "corpus-manifest-1",
            originRunId: null,
            baseResultId: null,
            requestActionId: null,
            scopeCandidateId: null,
            status: "in_progress",
            version: 1,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT
          })
        )
      )
    );
    for (const item of items) {
      unwrap(
        insertAttemptWorkItem(
          context,
          unwrap(
            prepareAttemptWorkItem({
              attemptWorkItemId: `attempt-work-item-${item.index + 1}`,
              triageAttemptId: "triage-attempt-1",
              workItemKey: `candidate-${item.index + 1}:candidate-document-${item.index + 1}:${DIMENSION}`,
              manifestOrdinal: item.index,
              candidateId: `candidate-${item.index + 1}`,
              candidateDocumentId: `candidate-document-${item.index + 1}`,
              dimensionId: DIMENSION,
              extractionSpecId: "extraction-spec-1",
              createdAt: CREATED_AT
            })
          )
        )
      );
    }
    return { ok: true, value: undefined };
  });

  return runtime;
}

/** The composite request hash the scheduler computes for a document. */
function requestHash(specContentHash: string, normalizedText: string): string {
  return sha256Hex([specContentHash, "resume", sha256Hex(normalizedText)].join("|"));
}

function specContentHash(): string {
  return unwrap(
    prepareExtractionSpec({
      extractionSpecId: "extraction-spec-1",
      content: specContent(),
      createdAt: CREATED_AT
    })
  ).contentHash;
}

function responseBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    dimensionId: DIMENSION,
    proposedLevel: "partial",
    spans: [{ quotedText: "ran holdout evaluations", polarity: "supporting" }],
    rejectedClaims: [],
    ...overrides
  });
}

/**
 * Wraps a composition so any prepared statement whose SQL contains `marker`
 * throws. The store's own try/catch turns that into a typed `RuntimeError`,
 * which is how the scheduler's persistence-failure branches are exercised.
 */
function withFailingSql(runtime: RuntimeComposition, marker: string): RuntimeComposition {
  const realClient = (
    runtime.connection.database as unknown as {
      $client: {
        prepare: (sql: string) => unknown;
        transaction: (fn: unknown) => unknown;
        inTransaction: boolean;
      };
    }
  ).$client;
  const fakeClient = {
    get inTransaction() {
      return realClient.inTransaction;
    },
    prepare(sql: string) {
      if (sql.includes(marker)) {
        throw new Error(`injected failure for ${marker}`);
      }
      return realClient.prepare(sql);
    },
    transaction(fn: unknown) {
      return realClient.transaction(fn);
    }
  };
  const fakeConnection = {
    isOpen: () => runtime.connection.isOpen(),
    close: () => runtime.connection.close(),
    migrate: () => runtime.connection.migrate(),
    database: { $client: fakeClient }
  };
  return { ...runtime, connection: fakeConnection as unknown as RuntimeComposition["connection"] };
}

const LONG_ADAPTER_ERROR = "e".repeat(300);

function failingAdapter(message: string): ExtractionAdapter {
  return {
    descriptor: { adapterId: "failing", mode: "fixture", contractVersion: 1 },
    extract: () =>
      Promise.resolve({
        ok: false,
        error: { code: "persistence_failed", message, retryable: false }
      })
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("runExtractionAttempt", () => {
  it("claims, extracts, locates, and completes a work item", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(requestHash(specContentHash(), RESUME_TEXT), responseBody());
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);

    const summary = unwrap(
      await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" })
    );
    expect(summary).toMatchObject({
      totalWorkItems: 1,
      processed: 1,
      succeeded: 1,
      blockedFailures: 0,
      reviewableFailures: 0,
      spansReturned: 1,
      spansLocated: 1
    });

    const items = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readAttemptWorkItems(context, "triage-attempt-1")
      )
    );
    expect(items[0]!.state).toBe("succeeded");
    expect(items[0]!.extractionArtifactId).not.toBeNull();
    const artifact = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readExtractionArtifact(context, items[0]!.extractionArtifactId)
      )
    );
    expect(artifact!.acceptedOutput.proposedLevel).toBe("partial");
    unwrap(runtime.close());
  });

  it("records dropped quotes and still completes when some quotes do not locate", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(
      requestHash(specContentHash(), RESUME_TEXT),
      responseBody({
        spans: [
          { quotedText: "ran holdout evaluations", polarity: "supporting" },
          { quotedText: "led a team of fifty", polarity: "supporting" }
        ]
      })
    );
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);

    const summary = unwrap(
      await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" })
    );
    expect(summary.succeeded).toBe(1);
    expect(summary.spansReturned).toBe(2);
    expect(summary.spansLocated).toBe(1);
    expect(summary.droppedQuotes).toEqual([
      { quotedText: "led a team of fifty", dimensionId: DIMENSION, reason: "unlocated" }
    ]);
    unwrap(runtime.close());
  });

  it("records and links an extraction_run on a completed work item", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(
      requestHash(specContentHash(), RESUME_TEXT),
      responseBody({
        spans: [
          { quotedText: "ran holdout evaluations", polarity: "supporting" },
          { quotedText: "led a team of fifty", polarity: "supporting" }
        ]
      })
    );
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);
    unwrap(await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" }));

    const items = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readAttemptWorkItems(context, "triage-attempt-1")
      )
    );
    expect(items[0]!.extractionRunId).not.toBeNull();
    const run = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readExtractionRun(context, items[0]!.extractionRunId)
      )
    );
    expect(run).toMatchObject({
      spansReturned: 2,
      spansLocated: 1,
      modelId: "test-extractor",
      fixtureKey: requestHash(specContentHash(), RESUME_TEXT)
    });
    expect(run!.droppedQuotes).toEqual([
      { quotedText: "led a team of fifty", dimensionId: DIMENSION, reason: "unlocated" }
    ]);
    unwrap(runtime.close());
  });

  it("records and links an extraction_run on a reviewable failure", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(
      requestHash(specContentHash(), RESUME_TEXT),
      responseBody({
        proposedLevel: "strong",
        spans: [{ quotedText: "absent from the resume", polarity: "supporting" }]
      })
    );
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);
    unwrap(await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" }));

    const items = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readAttemptWorkItems(context, "triage-attempt-1")
      )
    );
    expect(items[0]!.state).toBe("reviewable_failure");
    expect(items[0]!.extractionRunId).not.toBeNull();
    const run = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readExtractionRun(context, items[0]!.extractionRunId)
      )
    );
    expect(run).toMatchObject({ spansReturned: 1, spansLocated: 0 });
    unwrap(runtime.close());
  });

  it("records an extraction_run with zero spans on a blocked provider failure", async () => {
    const runtime = await seed(
      [{ index: 0, rawText: RESUME_TEXT }],
      failingAdapter("provider offline")
    );
    unwrap(await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" }));
    const items = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readAttemptWorkItems(context, "triage-attempt-1")
      )
    );
    expect(items[0]!.extractionRunId).not.toBeNull();
    const run = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readExtractionRun(context, items[0]!.extractionRunId)
      )
    );
    expect(run).toMatchObject({ spansReturned: 0, spansLocated: 0, fixtureKey: null });
    expect(run!.droppedQuotes).toEqual([]);
    unwrap(runtime.close());
  });

  it("records a null fixture key when the adapter is in live mode", async () => {
    const body = responseBody();
    const liveAdapter: ExtractionAdapter = {
      descriptor: { adapterId: "live-stub", mode: "live", contractVersion: 1 },
      extract: () =>
        Promise.resolve({
          ok: true,
          value: {
            extractionSpecHash: requestHash(specContentHash(), RESUME_TEXT),
            descriptor: { adapterId: "live-stub", mode: "live", contractVersion: 1 },
            body,
            bodyHash: sha256Hex(body)
          }
        })
    };
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], liveAdapter);
    unwrap(await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" }));
    const items = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readAttemptWorkItems(context, "triage-attempt-1")
      )
    );
    const run = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readExtractionRun(context, items[0]!.extractionRunId)
      )
    );
    expect(run!.fixtureKey).toBeNull();
    expect(run!.spansLocated).toBe(1);
    unwrap(runtime.close());
  });

  it("propagates a failure inserting the extraction_run on completion", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(requestHash(specContentHash(), RESUME_TEXT), responseBody());
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);
    const result = await runExtractionAttempt(
      withFailingSql(runtime, "INSERT INTO extraction_run"),
      { triageAttemptId: "triage-attempt-1" }
    );
    expect(result).toMatchObject({ ok: false });
    unwrap(runtime.close());
  });

  it("propagates a failure inserting the extraction_run on a recorded failure", async () => {
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], createFixtureExtractionAdapter());
    const result = await runExtractionAttempt(
      withFailingSql(runtime, "INSERT INTO extraction_run"),
      { triageAttemptId: "triage-attempt-1" }
    );
    expect(result).toMatchObject({ ok: false });
    unwrap(runtime.close());
  });

  it("blocks a work item when the fixture is missing", async () => {
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], createFixtureExtractionAdapter());
    const summary = unwrap(
      await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" })
    );
    expect(summary).toMatchObject({ blockedFailures: 1, succeeded: 0 });
    const items = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readAttemptWorkItems(context, "triage-attempt-1")
      )
    );
    expect(items[0]!.state).toBe("blocked_failure");
    const failure = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readExtractionFailure(context, items[0]!.extractionFailureId)
      )
    );
    expect(failure!.errorClass).toBe("structurally_invalid");
    unwrap(runtime.close());
  });

  it("blocks a work item when the response body is not on contract", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(requestHash(specContentHash(), RESUME_TEXT), "{ not json");
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);
    const summary = unwrap(
      await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" })
    );
    expect(summary.blockedFailures).toBe(1);
    unwrap(runtime.close());
  });

  it("blocks a work item when the response is for the wrong dimension", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(
      requestHash(specContentHash(), RESUME_TEXT),
      responseBody({ dimensionId: "systems_thinking" })
    );
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);
    const summary = unwrap(
      await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" })
    );
    expect(summary.blockedFailures).toBe(1);
    const items = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readAttemptWorkItems(context, "triage-attempt-1")
      )
    );
    const failure = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readExtractionFailure(context, items[0]!.extractionFailureId)
      )
    );
    expect(failure!.errorClass).toBe("identity_mismatch");
    unwrap(runtime.close());
  });

  it("blocks a work item when a quote is not usable source text", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(
      requestHash(specContentHash(), RESUME_TEXT),
      responseBody({ spans: [{ quotedText: "\uD800", polarity: "supporting" }] })
    );
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);
    const summary = unwrap(
      await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" })
    );
    expect(summary.blockedFailures).toBe(1);
    unwrap(runtime.close());
  });

  it("marks a claimed level with no located supporting span as a reviewable failure", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(
      requestHash(specContentHash(), RESUME_TEXT),
      responseBody({
        proposedLevel: "strong",
        spans: [{ quotedText: "not present in the resume", polarity: "supporting" }]
      })
    );
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);
    const summary = unwrap(
      await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" })
    );
    expect(summary).toMatchObject({ reviewableFailures: 1, succeeded: 0 });
    const items = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readAttemptWorkItems(context, "triage-attempt-1")
      )
    );
    expect(items[0]!.state).toBe("reviewable_failure");
    unwrap(runtime.close());
  });

  it("succeeds a none level with no spans", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(
      requestHash(specContentHash(), RESUME_TEXT),
      responseBody({ proposedLevel: "none", spans: [] })
    );
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);
    const summary = unwrap(
      await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" })
    );
    expect(summary.succeeded).toBe(1);
    unwrap(runtime.close());
  });

  it("reuses an identical artifact across two candidates with the same document", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(requestHash(specContentHash(), RESUME_TEXT), responseBody());
    const runtime = await seed(
      [
        { index: 0, rawText: RESUME_TEXT },
        { index: 1, rawText: RESUME_TEXT }
      ],
      adapter
    );
    const summary = unwrap(
      await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" })
    );
    expect(summary.succeeded).toBe(2);
    expect(summary.reusedArtifacts).toBe(1);
    unwrap(runtime.close());
  });

  it("skips items that already succeeded on a re-run", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(requestHash(specContentHash(), RESUME_TEXT), responseBody());
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);
    unwrap(await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" }));
    const second = unwrap(
      await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" })
    );
    expect(second).toMatchObject({ alreadySucceeded: 1, processed: 0 });
    unwrap(runtime.close());
  });

  it("returns not_found for an unknown triage attempt", async () => {
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], createFixtureExtractionAdapter());
    const result = await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-missing" });
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
    unwrap(runtime.close());
  });

  it("rejects an invalid composition", async () => {
    const result = await runExtractionAttempt({} as RuntimeComposition, {
      triageAttemptId: "triage-attempt-1"
    });
    expect(result).toMatchObject({ ok: false, error: { message: "Invalid runtime composition" } });
  });

  it("rejects a missing triage attempt id", async () => {
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], createFixtureExtractionAdapter());
    const result = await runExtractionAttempt(runtime, { triageAttemptId: "" });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Extraction run requires a triage attempt id" }
    });
    unwrap(runtime.close());
  });

  it("truncates a long provider error into the failure diagnostic", async () => {
    const runtime = await seed(
      [{ index: 0, rawText: RESUME_TEXT }],
      failingAdapter(LONG_ADAPTER_ERROR)
    );
    const summary = unwrap(
      await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" })
    );
    expect(summary.blockedFailures).toBe(1);
    const items = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readAttemptWorkItems(context, "triage-attempt-1")
      )
    );
    const failure = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readExtractionFailure(context, items[0]!.extractionFailureId)
      )
    );
    expect(failure!.diagnostic.details[0]!.length).toBe(200);
    unwrap(runtime.close());
  });

  it("blocks a work item whose located spans exceed the evidence limit", async () => {
    const words = RESUME_TEXT.replace(".", "").split(" ");
    const spans = Array.from({ length: 13 }, (_unused, index) => ({
      quotedText: words[index % words.length]!,
      polarity: "supporting" as const
    }));
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(
      requestHash(specContentHash(), RESUME_TEXT),
      responseBody({ proposedLevel: "strong", spans })
    );
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);
    const summary = unwrap(
      await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" })
    );
    expect(summary.blockedFailures).toBe(1);
    const items = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readAttemptWorkItems(context, "triage-attempt-1")
      )
    );
    const failure = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readExtractionFailure(context, items[0]!.extractionFailureId)
      )
    );
    expect(failure!.errorClass).toBe("cardinality_exceeded");
    unwrap(runtime.close());
  });

  it("reuses an identical failure row across two work items", async () => {
    const runtime = await seed(
      [
        { index: 0, rawText: RESUME_TEXT },
        { index: 1, rawText: RESUME_TEXT }
      ],
      createFixtureExtractionAdapter()
    );
    const summary = unwrap(
      await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" })
    );
    expect(summary.blockedFailures).toBe(2);
    const items = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readAttemptWorkItems(context, "triage-attempt-1")
      )
    );
    expect(items[0]!.extractionFailureId).toBe(items[1]!.extractionFailureId);
    unwrap(runtime.close());
  });

  it("skips items already in a terminal failure state on a re-run", async () => {
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], createFixtureExtractionAdapter());
    unwrap(await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" }));
    const second = unwrap(
      await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" })
    );
    expect(second).toMatchObject({ processed: 0, blockedFailures: 0, alreadySucceeded: 0 });
    unwrap(runtime.close());
  });

  it("propagates a failure loading the work item context", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(requestHash(specContentHash(), RESUME_TEXT), responseBody());
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);
    const result = await runExtractionAttempt(
      withFailingSql(runtime, "FROM attempt_work_item wi"),
      { triageAttemptId: "triage-attempt-1" }
    );
    expect(result).toMatchObject({ ok: false });
    unwrap(runtime.close());
  });

  it("propagates a failure claiming the work item", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(requestHash(specContentHash(), RESUME_TEXT), responseBody());
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);
    const result = await runExtractionAttempt(
      withFailingSql(runtime, "SET state = 'claimed'"),
      { triageAttemptId: "triage-attempt-1" }
    );
    expect(result).toMatchObject({ ok: false });
    unwrap(runtime.close());
  });

  it("propagates a failure reading an existing failure row", async () => {
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], createFixtureExtractionAdapter());
    const result = await runExtractionAttempt(
      withFailingSql(runtime, "FROM extraction_failure"),
      { triageAttemptId: "triage-attempt-1" }
    );
    expect(result).toMatchObject({ ok: false });
    unwrap(runtime.close());
  });

  it("propagates a failure inserting the failure row", async () => {
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], createFixtureExtractionAdapter());
    const result = await runExtractionAttempt(
      withFailingSql(runtime, "INSERT INTO extraction_failure"),
      { triageAttemptId: "triage-attempt-1" }
    );
    expect(result).toMatchObject({ ok: false });
    unwrap(runtime.close());
  });

  it("propagates a failure moving the work item to failed", async () => {
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], createFixtureExtractionAdapter());
    const result = await runExtractionAttempt(
      withFailingSql(runtime, "SET state = ?"),
      { triageAttemptId: "triage-attempt-1" }
    );
    expect(result).toMatchObject({ ok: false });
    unwrap(runtime.close());
  });

  it("propagates a failure reading an existing artifact", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(requestHash(specContentHash(), RESUME_TEXT), responseBody());
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);
    const result = await runExtractionAttempt(
      withFailingSql(runtime, "FROM extraction_artifact"),
      { triageAttemptId: "triage-attempt-1" }
    );
    expect(result).toMatchObject({ ok: false });
    unwrap(runtime.close());
  });

  it("propagates a failure inserting the artifact", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(requestHash(specContentHash(), RESUME_TEXT), responseBody());
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);
    const result = await runExtractionAttempt(
      withFailingSql(runtime, "INSERT INTO extraction_artifact"),
      { triageAttemptId: "triage-attempt-1" }
    );
    expect(result).toMatchObject({ ok: false });
    unwrap(runtime.close());
  });

  it("propagates a failure completing the work item", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(requestHash(specContentHash(), RESUME_TEXT), responseBody());
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);
    const result = await runExtractionAttempt(
      withFailingSql(runtime, "SET state = 'succeeded'"),
      { triageAttemptId: "triage-attempt-1" }
    );
    expect(result).toMatchObject({ ok: false });
    unwrap(runtime.close());
  });

  it("propagates a failure reading the triage attempt", async () => {
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], createFixtureExtractionAdapter());
    const result = await runExtractionAttempt(
      withFailingSql(runtime, "FROM triage_attempt"),
      { triageAttemptId: "triage-attempt-1" }
    );
    expect(result).toMatchObject({ ok: false });
    unwrap(runtime.close());
  });

  for (const scenario of [
    { name: "a malformed body", body: () => "{ not json" },
    { name: "a wrong dimension", body: () => responseBody({ dimensionId: "systems_thinking" }) },
    {
      name: "an unusable quote",
      body: () => responseBody({ spans: [{ quotedText: "\uD800", polarity: "supporting" }] })
    },
    {
      name: "a claimed level with no located span",
      body: () =>
        responseBody({
          proposedLevel: "strong",
          spans: [{ quotedText: "absent from the resume", polarity: "supporting" }]
        })
    },
    {
      name: "an over-limit span count",
      body: () =>
        responseBody({
          proposedLevel: "strong",
          spans: Array.from({ length: 13 }, () => ({
            quotedText: "ran holdout evaluations",
            polarity: "supporting" as const
          }))
        })
    }
  ]) {
    it(`propagates a failure recording ${scenario.name}`, async () => {
      const adapter = createFixtureExtractionAdapter();
      adapter.registerFixture(requestHash(specContentHash(), RESUME_TEXT), scenario.body());
      const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);
      const result = await runExtractionAttempt(
        withFailingSql(runtime, "INSERT INTO extraction_failure"),
        { triageAttemptId: "triage-attempt-1" }
      );
      expect(result).toMatchObject({ ok: false });
      unwrap(runtime.close());
    });
  }

  it("errors when a failure cannot be prepared from an oversized response", async () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture(
      requestHash(specContentHash(), RESUME_TEXT),
      "x".repeat(70_000)
    );
    const runtime = await seed([{ index: 0, rawText: RESUME_TEXT }], adapter);
    const result = await runExtractionAttempt(runtime, { triageAttemptId: "triage-attempt-1" });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Oversized extraction failures must record a response larger than the provider byte cap" }
    });
    unwrap(runtime.close());
  });
});
