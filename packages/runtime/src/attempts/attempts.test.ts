import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXTRACTION_LIMITS,
  SCORING_POLICY_V1,
  err,
  ok,
  sha256Hex,
  type Result
} from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runImmediateTransaction, type ImmediateTransactionContext } from "../commands/index.js";
import { openRuntimeDatabase, type RuntimeDatabaseConnection } from "../db/index.js";
import {
  insertActor,
  insertCandidate,
  insertCandidateDocument,
  insertSourceDocument,
  prepareActor,
  prepareCandidate,
  prepareCandidateDocument,
  prepareSourceDocument
} from "../entities/index.js";
import { type RuntimeError } from "../errors/index.js";
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
  insertExtractionArtifact,
  insertExtractionFailure,
  insertExtractionSpec,
  prepareExtractionArtifact,
  prepareExtractionFailure,
  prepareExtractionSpec
} from "../extraction/index.js";
import {
  insertResolutionAction,
  insertResolutionTask,
  prepareResolutionAction,
  prepareResolutionTask
} from "../resolution/index.js";
import {
  insertCandidateResultReason,
  insertCandidateResultSeal,
  insertCandidateTriageResult,
  prepareCandidateResultReason,
  prepareCandidateResultSeal,
  prepareCandidateTriageResult,
  setCandidateHead
} from "../results/index.js";
import { insertRole, prepareRole } from "../roles/index.js";
import { insertRunInputSnapshot, prepareRunInputSnapshot } from "../snapshots/index.js";
import {
  MAXIMUM_ATTEMPT_CANDIDATES,
  claimAttemptWorkItem,
  completeAttemptWorkItem,
  failAttemptWorkItem,
  insertAttemptWorkItem,
  insertTriageAttempt,
  prepareAttemptWorkItem,
  prepareTriageAttempt,
  readAttemptWorkItem,
  readAttemptWorkItems,
  readTriageAttempt
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const CLAIMED_AT = CREATED_AT + 1_000;
const COMPLETED_AT = CREATED_AT + 2_000;
const PROMPT_HASH = sha256Hex("prompt-template-v1");
const SCHEMA_HASH = sha256Hex("extraction-output-schema-v1");
const TRANSACTION_REQUIRED = "Triage attempt rows require an active command transaction";

const TRIAGE_ATTEMPT_COLUMNS = `
  triage_attempt_id text PRIMARY KEY NOT NULL,
  kind text NOT NULL,
  snapshot_id text NOT NULL,
  corpus_manifest_id text NOT NULL,
  origin_run_id text,
  base_result_id text,
  request_action_id text,
  scope_candidate_id text,
  status text NOT NULL,
  version integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
`;

const ATTEMPT_WORK_ITEM_COLUMNS = `
  attempt_work_item_id text PRIMARY KEY NOT NULL,
  triage_attempt_id text NOT NULL,
  work_item_key text NOT NULL,
  manifest_ordinal integer NOT NULL,
  candidate_id text NOT NULL,
  candidate_document_id text NOT NULL,
  dimension_id text NOT NULL,
  extraction_spec_id text NOT NULL,
  state text NOT NULL,
  claim_id text,
  claimed_at integer,
  claim_expires_at integer,
  attempt_count integer NOT NULL,
  extraction_artifact_id text,
  extraction_failure_id text,
  version integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
`;

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-triage-attempt-test-"));
  temporaryDirectories.push(directory);
  const opened = openRuntimeDatabase({
    filename: join(directory, "runtime.db"),
    migrationsFolder
  });
  expect(opened.ok).toBe(true);
  if (!opened.ok) {
    throw new Error(opened.error.message);
  }
  const migrated = opened.value.migrate();
  expect(migrated.ok).toBe(true);
  if (!migrated.ok) {
    throw new Error(migrated.error.message);
  }
  return opened.value;
}

function nativeDatabase(connection: RuntimeDatabaseConnection): BetterSqlite3.Database {
  return (connection.database as unknown as { $client: BetterSqlite3.Database }).$client;
}

function unwrap<T>(result: Result<T, RuntimeError> | Result<T, { message: string }>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function withThrowingGetter(
  base: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const poisoned: Record<string, unknown> = { ...base };
  Object.defineProperty(poisoned, key, {
    get() {
      throw new TypeError("hostile getter");
    },
    enumerable: true
  });
  return poisoned;
}

function failingContext(prepareImpl?: (sql: string) => unknown): object {
  return {
    nativeDatabase: {
      inTransaction: true,
      prepare(sql: string) {
        if (prepareImpl !== undefined) {
          return prepareImpl(sql);
        }
        throw new Error("disk I/O error");
      }
    }
  };
}

function dimension(ordinal: number): Record<string, unknown> {
  return {
    dimensionId: ordinal === 0 ? "evaluation_practice" : "systems_thinking",
    weight: ordinal === 0 ? 2 : 1,
    required: ordinal === 0,
    definition:
      ordinal === 0
        ? "Evidence of structured evaluation practice."
        : "Evidence of systems thinking in production work.",
    jobRelatedJustification:
      ordinal === 0
        ? "Hiring managers review evaluation quality."
        : "The role operates coupled systems.",
    ordinal
  };
}

function snapshotContent() {
  return {
    frozenDate: "2026-09-07",
    roleId: "role-applied-ai-engineer",
    rubricVersion: "draft-v1",
    dimensions: [dimension(0), dimension(1)],
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

function candidateDraft(index: number, overrides: Record<string, unknown> = {}) {
  return {
    candidateId: `candidate-${index + 1}`,
    sourceSystem: "synthetic_corpus",
    sourceKey: `tier-one/${String(index + 1).padStart(4, "0")}`,
    channel: "inbound",
    corpusTag: "variant",
    createdAt: CREATED_AT,
    ...overrides
  };
}

function unavailableResultDraft(index: number, overrides: Record<string, unknown> = {}) {
  const candidateTriageResultId =
    typeof overrides.candidateTriageResultId === "string"
      ? overrides.candidateTriageResultId
      : `candidate-result-${index + 1}`;
  return {
    candidateTriageResultId,
    candidateId: `candidate-${index + 1}`,
    kind: "initial",
    availability: "unavailable",
    status: "escalated",
    supersedesResultId: null,
    evidenceSpans: [],
    evidenceGaps: [],
    dimensionAssessments: [],
    structuredFacts: [],
    factConflicts: [],
    hardRequirementAssessments: [],
    score: null,
    sealId: `candidate-result-seal-${candidateTriageResultId}`,
    createdAt: CREATED_AT,
    ...overrides
  };
}

function officialAttemptDraft(overrides: Record<string, unknown> = {}) {
  return {
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
    updatedAt: CREATED_AT,
    ...overrides
  };
}

function correctionAttemptDraft(overrides: Record<string, unknown> = {}) {
  return officialAttemptDraft({
    triageAttemptId: "triage-attempt-correction",
    kind: "candidate_correction",
    baseResultId: "candidate-result-1",
    requestActionId: "resolution-action-1",
    scopeCandidateId: "candidate-1",
    ...overrides
  });
}

function workItemDraft(index: number, overrides: Record<string, unknown> = {}) {
  return {
    attemptWorkItemId: `attempt-work-item-${index + 1}`,
    triageAttemptId: "triage-attempt-1",
    workItemKey: `candidate-${index + 1}:candidate-document-${index + 1}:evaluation_practice`,
    manifestOrdinal: index,
    candidateId: `candidate-${index + 1}`,
    candidateDocumentId: `candidate-document-${index + 1}`,
    dimensionId: "evaluation_practice",
    extractionSpecId: "extraction-spec-1",
    createdAt: CREATED_AT,
    ...overrides
  };
}

function pendingWorkItem(index: number, overrides: Record<string, unknown> = {}) {
  return {
    ...workItemDraft(index, overrides),
    state: "pending",
    claimId: null,
    claimedAt: null,
    claimExpiresAt: null,
    attemptCount: 0,
    extractionArtifactId: null,
    extractionFailureId: null,
    version: 1,
    updatedAt: CREATED_AT
  };
}

function specDraft(overrides: Record<string, unknown> = {}) {
  return {
    extractionSpecId: "extraction-spec-1",
    content: {
      modelId: "test-extractor",
      extractorVersion: "extractor-v1",
      promptTemplateVersion: "prompt-v1",
      promptHash: PROMPT_HASH,
      schemaHash: SCHEMA_HASH,
      dimensionId: "evaluation_practice",
      dimensionDefinition: "Evidence of structured evaluation practice.",
      jobRelatedJustification: "Hiring managers review evaluation quality.",
      limits: { ...EXTRACTION_LIMITS }
    },
    createdAt: CREATED_AT,
    ...overrides
  };
}

function artifactDraft(index: number, overrides: Record<string, unknown> = {}) {
  return {
    extractionArtifactId: `extraction-artifact-${index + 1}`,
    specId: "extraction-spec-1",
    sourceDocumentId: `source-document-${index + 1}`,
    acceptedOutput: {
      dimensionId: "evaluation_practice",
      proposedLevel: "partial",
      spans: [
        {
          start: 0,
          end: 9,
          quotedText: "Candidate",
          polarity: "supporting",
          matchQuality: "exact"
        }
      ]
    },
    rejectedClaims: [
      {
        kind: "unlocated_quote",
        quotedText: `missing-${index + 1}`,
        reason: "quote was not found in normalized text"
      }
    ],
    createdAt: CREATED_AT,
    ...overrides
  };
}

function failureDraft(index: number, overrides: Record<string, unknown> = {}) {
  return {
    extractionFailureId: `extraction-failure-${index + 1}`,
    specId: "extraction-spec-1",
    sourceDocumentId: `source-document-${index + 1}`,
    errorClass: "structurally_invalid",
    responseHash: sha256Hex(`provider-body-${index + 1}`),
    responseByteLength: 128 + index,
    diagnostic: {
      summary: "Provider output failed schema validation",
      details: [`unknown field score ${index + 1}`]
    },
    createdAt: CREATED_AT,
    ...overrides
  };
}

function claimInput(index: number, overrides: Record<string, unknown> = {}) {
  return {
    attemptWorkItemId: `attempt-work-item-${index + 1}`,
    claimId: `attempt-claim-${index + 1}`,
    claimedAt: CLAIMED_AT,
    claimExpiresAt: CLAIMED_AT + 60_000,
    expectedVersion: 1,
    ...overrides
  };
}

function seedRoleAndSnapshot(context: ImmediateTransactionContext): void {
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
}

function seedCandidateBundle(context: ImmediateTransactionContext, index: number): void {
  const candidateId = `candidate-${index + 1}`;
  unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft(index)))));
  const rawText = `Candidate ${index + 1} resume raw.`;
  unwrap(
    insertSourceDocument(
      context,
      unwrap(
        prepareSourceDocument({
          sourceDocumentId: `source-document-${index + 1}`,
          rawText,
          normalizedText: rawText,
          createdAt: CREATED_AT
        })
      )
    )
  );
  unwrap(
    insertCandidateDocument(
      context,
      unwrap(
        prepareCandidateDocument({
          candidateDocumentId: `candidate-document-${index + 1}`,
          candidateId,
          sourceDocumentId: `source-document-${index + 1}`,
          documentKind: "resume",
          label: "Resume",
          documentOrdinal: 0,
          createdAt: CREATED_AT
        })
      )
    )
  );
}

function publishVariantCorpus(context: ImmediateTransactionContext, memberCount = 1): void {
  const members = Array.from({ length: memberCount }, (_, index) => ({
    candidateId: `candidate-${index + 1}`,
    importOrdinal: index,
    documents: [
      {
        candidateDocumentId: `candidate-document-${index + 1}`,
        documentOrdinal: 0
      }
    ]
  }));
  for (let index = 0; index < memberCount; index += 1) {
    seedCandidateBundle(context, index);
  }
  const manifest = unwrap(
    prepareCorpusManifest({
      corpusManifestId: "corpus-manifest-1",
      kind: "variant",
      sealId: "corpus-manifest-seal-1",
      createdAt: CREATED_AT,
      content: { kind: "variant", members }
    })
  );
  unwrap(insertCorpusManifest(context, manifest));
  for (let index = 0; index < memberCount; index += 1) {
    unwrap(
      insertCorpusMember(
        context,
        unwrap(
          prepareCorpusMember({
            corpusMemberId: `corpus-member-${index + 1}`,
            manifestId: "corpus-manifest-1",
            candidateId: `candidate-${index + 1}`,
            importOrdinal: index,
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
            corpusMemberDocumentId: `corpus-member-document-${index + 1}`,
            corpusMemberId: `corpus-member-${index + 1}`,
            candidateDocumentId: `candidate-document-${index + 1}`,
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
}

function seedSealedInitialResult(context: ImmediateTransactionContext, index: number): void {
  const result = unwrap(prepareCandidateTriageResult(unavailableResultDraft(index)));
  unwrap(insertCandidateTriageResult(context, result));
  const reason = unwrap(
    prepareCandidateResultReason({
      candidateResultReasonId: `candidate-result-reason-${result.candidateTriageResultId}`,
      candidateResultId: result.candidateTriageResultId,
      reasonCode: "assessment_unavailable",
      reasonOrdinal: 0,
      createdAt: result.createdAt
    })
  );
  unwrap(insertCandidateResultReason(context, reason));
  unwrap(
    insertResolutionTask(
      context,
      unwrap(
        prepareResolutionTask({
          resolutionTaskId: `resolution-task-${result.candidateTriageResultId}`,
          candidateResultId: result.candidateTriageResultId,
          candidateResultReasonId: reason.candidateResultReasonId,
          taskOrdinal: 0,
          createdAt: result.createdAt
        })
      )
    )
  );
  unwrap(
    insertCandidateResultSeal(
      context,
      unwrap(
        prepareCandidateResultSeal({
          candidateResultSealId: result.sealId,
          candidateResultId: result.candidateTriageResultId,
          createdAt: result.createdAt
        })
      )
    )
  );
  unwrap(
    setCandidateHead(
      context,
      {
        candidateId: result.candidateId,
        currentResultId: result.candidateTriageResultId
      },
      0
    )
  );
}

function seedOfficialParents(context: ImmediateTransactionContext, memberCount = 1): void {
  seedRoleAndSnapshot(context);
  publishVariantCorpus(context, memberCount);
  for (let index = 0; index < memberCount; index += 1) {
    seedSealedInitialResult(context, index);
  }
  unwrap(insertExtractionSpec(context, unwrap(prepareExtractionSpec(specDraft()))));
}

function seedOfficialAttempt(context: ImmediateTransactionContext): void {
  unwrap(insertTriageAttempt(context, unwrap(prepareTriageAttempt(officialAttemptDraft()))));
}

function seedPendingWorkItem(context: ImmediateTransactionContext, index = 0): void {
  unwrap(insertAttemptWorkItem(context, unwrap(prepareAttemptWorkItem(workItemDraft(index)))));
}

function seedArtifact(context: ImmediateTransactionContext, index = 0): void {
  unwrap(
    insertExtractionArtifact(context, unwrap(prepareExtractionArtifact(artifactDraft(index))))
  );
}

function seedFailure(context: ImmediateTransactionContext, index = 0): void {
  unwrap(
    insertExtractionFailure(context, unwrap(prepareExtractionFailure(failureDraft(index))))
  );
}

function rebuildWithoutChecks(
  database: BetterSqlite3.Database,
  table: "triage_attempt" | "attempt_work_item"
): void {
  const columns = table === "triage_attempt" ? TRIAGE_ATTEMPT_COLUMNS : ATTEMPT_WORK_ITEM_COLUMNS;
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS triage_attempt_reject_replace;
    DROP TRIGGER IF EXISTS triage_attempt_reject_pinned_update;
    DROP TRIGGER IF EXISTS triage_attempt_reject_delete;
    DROP TRIGGER IF EXISTS attempt_work_item_reject_replace;
    DROP TRIGGER IF EXISTS attempt_work_item_reject_owner;
    DROP TRIGGER IF EXISTS attempt_work_item_reject_pinned_update;
    DROP TRIGGER IF EXISTS attempt_work_item_reject_illegal_transition;
    DROP TRIGGER IF EXISTS attempt_work_item_reject_terminal_reopen;
    DROP TRIGGER IF EXISTS attempt_work_item_reject_delete;
    DROP TRIGGER IF EXISTS attempt_work_item_reject_terminal_owner;
    DROP TRIGGER IF EXISTS triage_run_seal_reject_incomplete;
    CREATE TABLE ${table}_rebuilt (
      ${columns}
    ) STRICT;
    INSERT INTO ${table}_rebuilt SELECT * FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE ${table}_rebuilt RENAME TO ${table};
    PRAGMA foreign_keys = ON;
  `);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("triage attempt persistence", () => {
  it("prepares official and correction attempts and pending work items", () => {
    expect(MAXIMUM_ATTEMPT_CANDIDATES).toBe(200);
    const attempt = unwrap(prepareTriageAttempt(officialAttemptDraft()));
    expect(attempt).toEqual(officialAttemptDraft());
    expect(Object.isFrozen(attempt)).toBe(true);

    const correction = unwrap(prepareTriageAttempt(correctionAttemptDraft()));
    expect(correction.kind).toBe("candidate_correction");
    expect(correction.scopeCandidateId).toBe("candidate-1");

    const item = unwrap(prepareAttemptWorkItem(workItemDraft(0)));
    expect(item).toEqual(pendingWorkItem(0));
    expect(Object.isFrozen(item)).toBe(true);
  });

  it("rejects invalid and hostile prepare input", () => {
    expect(prepareTriageAttempt({ ...officialAttemptDraft(), extra: true })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid triage attempt input" })
    });
    expect(
      prepareTriageAttempt(
        officialAttemptDraft({
          kind: "variant_run",
          baseResultId: "candidate-result-1"
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid triage attempt input" })
    });
    expect(
      prepareTriageAttempt(
        officialAttemptDraft({
          kind: "candidate_correction",
          baseResultId: null,
          requestActionId: null,
          scopeCandidateId: null
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid triage attempt input" })
    });
    expect(
      prepareTriageAttempt(officialAttemptDraft({ updatedAt: CREATED_AT - 1 }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid triage attempt input" })
    });
    expect(prepareTriageAttempt(withThrowingGetter(officialAttemptDraft(), "kind"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Triage attempt preparation failed" })
    });
    expect(prepareAttemptWorkItem({ ...workItemDraft(0), extra: true })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid attempt work item input" })
    });
    expect(prepareAttemptWorkItem(withThrowingGetter(workItemDraft(0), "workItemKey"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Attempt work item preparation failed" })
    });
  });

  it("inserts an official attempt, claims a work item, and marks the attempt ready", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedOfficialParents(context, 2);
        seedOfficialAttempt(context);
        seedArtifact(context, 0);
        seedArtifact(context, 1);
        seedPendingWorkItem(context, 0);
        seedPendingWorkItem(context, 1);
        expect(unwrap(readTriageAttempt(context, "triage-attempt-1"))).toEqual(
          officialAttemptDraft()
        );
        expect(unwrap(readAttemptWorkItems(context, "triage-attempt-1"))).toEqual([
          pendingWorkItem(0),
          pendingWorkItem(1)
        ]);

        const claimed = unwrap(claimAttemptWorkItem(context, claimInput(0)));
        expect(claimed.state).toBe("claimed");
        expect(claimed.attemptCount).toBe(1);
        expect(claimed.version).toBe(2);
        expect(claimed.claimId).toBe("attempt-claim-1");

        const completed = unwrap(
          completeAttemptWorkItem(context, {
            attemptWorkItemId: "attempt-work-item-1",
            extractionArtifactId: "extraction-artifact-1",
            completedAt: COMPLETED_AT,
            expectedVersion: 2
          })
        );
        expect(completed.state).toBe("succeeded");
        expect(completed.extractionArtifactId).toBe("extraction-artifact-1");
        expect(unwrap(readTriageAttempt(context, "triage-attempt-1"))?.status).toBe(
          "in_progress"
        );

        unwrap(claimAttemptWorkItem(context, claimInput(1)));
        unwrap(
          completeAttemptWorkItem(context, {
            attemptWorkItemId: "attempt-work-item-2",
            extractionArtifactId: "extraction-artifact-2",
            completedAt: COMPLETED_AT,
            expectedVersion: 2
          })
        );
        const ready = unwrap(readTriageAttempt(context, "triage-attempt-1"));
        expect(ready?.status).toBe("ready");
        expect(ready?.version).toBe(2);
        expect(ready?.updatedAt).toBe(COMPLETED_AT);
        expect(Object.isFrozen(unwrap(readAttemptWorkItem(context, "attempt-work-item-1")))).toBe(
          true
        );
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("reclaims expired claims and retries from retryable failure", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedOfficialParents(context);
        seedOfficialAttempt(context);
        seedArtifact(context);
        seedFailure(context);
        seedPendingWorkItem(context);

        unwrap(
          claimAttemptWorkItem(
            context,
            claimInput(0, { claimExpiresAt: CLAIMED_AT + 1 })
          )
        );
        expect(
          claimAttemptWorkItem(
            context,
            claimInput(0, {
              claimId: "attempt-claim-too-soon",
              claimedAt: CLAIMED_AT,
              expectedVersion: 2
            })
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Attempt work item is not claimable" })
        });

        const reclaimed = unwrap(
          claimAttemptWorkItem(
            context,
            claimInput(0, {
              claimId: "attempt-claim-reclaim",
              claimedAt: CLAIMED_AT + 2,
              claimExpiresAt: CLAIMED_AT + 62_000,
              expectedVersion: 2
            })
          )
        );
        expect(reclaimed.claimId).toBe("attempt-claim-reclaim");
        expect(reclaimed.attemptCount).toBe(2);

        unwrap(
          failAttemptWorkItem(context, {
            attemptWorkItemId: "attempt-work-item-1",
            state: "retryable_failure",
            extractionFailureId: "extraction-failure-1",
            failedAt: COMPLETED_AT,
            expectedVersion: 3
          })
        );
        const retried = unwrap(
          claimAttemptWorkItem(
            context,
            claimInput(0, {
              claimId: "attempt-claim-retry",
              claimedAt: COMPLETED_AT + 1,
              claimExpiresAt: COMPLETED_AT + 61_000,
              expectedVersion: 4
            })
          )
        );
        expect(retried.state).toBe("claimed");
        expect(retried.extractionFailureId).toBeNull();
        expect(retried.attemptCount).toBe(3);

        unwrap(
          completeAttemptWorkItem(context, {
            attemptWorkItemId: "attempt-work-item-1",
            extractionArtifactId: "extraction-artifact-1",
            completedAt: COMPLETED_AT + 2,
            expectedVersion: 5
          })
        );
        expect(unwrap(readTriageAttempt(context, "triage-attempt-1"))?.status).toBe("ready");
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("marks reviewable failures ready and blocked failures blocked", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedOfficialParents(context, 2);
        seedOfficialAttempt(context);
        seedFailure(context, 0);
        seedFailure(context, 1);
        seedPendingWorkItem(context, 0);
        seedPendingWorkItem(context, 1);

        unwrap(claimAttemptWorkItem(context, claimInput(0)));
        unwrap(
          failAttemptWorkItem(context, {
            attemptWorkItemId: "attempt-work-item-1",
            state: "reviewable_failure",
            extractionFailureId: "extraction-failure-1",
            failedAt: COMPLETED_AT,
            expectedVersion: 2
          })
        );
        expect(unwrap(readTriageAttempt(context, "triage-attempt-1"))?.status).toBe(
          "in_progress"
        );

        unwrap(claimAttemptWorkItem(context, claimInput(1)));
        unwrap(
          failAttemptWorkItem(context, {
            attemptWorkItemId: "attempt-work-item-2",
            state: "reviewable_failure",
            extractionFailureId: "extraction-failure-2",
            failedAt: COMPLETED_AT,
            expectedVersion: 2
          })
        );
        expect(unwrap(readTriageAttempt(context, "triage-attempt-1"))?.status).toBe("ready");

        unwrap(
          insertTriageAttempt(
            context,
            unwrap(
              prepareTriageAttempt(
                officialAttemptDraft({
                  triageAttemptId: "triage-attempt-blocked",
                  kind: "main_run"
                })
              )
            )
          )
        );
        unwrap(
          insertAttemptWorkItem(
            context,
            unwrap(
              prepareAttemptWorkItem(
                workItemDraft(0, {
                  triageAttemptId: "triage-attempt-blocked",
                  attemptWorkItemId: "attempt-work-item-blocked"
                })
              )
            )
          )
        );
        unwrap(
          claimAttemptWorkItem(
            context,
            claimInput(0, { attemptWorkItemId: "attempt-work-item-blocked" })
          )
        );
        unwrap(
          failAttemptWorkItem(context, {
            attemptWorkItemId: "attempt-work-item-blocked",
            state: "blocked_failure",
            extractionFailureId: "extraction-failure-1",
            failedAt: COMPLETED_AT,
            expectedVersion: 2
          })
        );
        expect(unwrap(readTriageAttempt(context, "triage-attempt-blocked"))?.status).toBe(
          "blocked"
        );
        expect(
          failAttemptWorkItem(context, {
            attemptWorkItemId: "attempt-work-item-blocked",
            state: "retryable_failure",
            extractionFailureId: "extraction-failure-1",
            failedAt: COMPLETED_AT + 1,
            expectedVersion: 3
          })
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Attempt work item is not claimed" })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("inserts a correction attempt scoped to one candidate", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedOfficialParents(context, 2);
        unwrap(insertActor(context, unwrap(prepareActor({
          actorId: "actor-recruiter-1",
          displayName: "Dana Recruiter",
          createdAt: CREATED_AT
        }))));
        unwrap(
          insertResolutionAction(
            context,
            unwrap(
              prepareResolutionAction({
                resolutionActionId: "resolution-action-1",
                resolutionTaskId: "resolution-task-candidate-result-1",
                actorId: "actor-recruiter-1",
                actionOrdinal: 0,
                payload: { kind: "request_re_extraction" },
                createdAt: CREATED_AT
              })
            ),
            0
          )
        );
        unwrap(
          insertTriageAttempt(context, unwrap(prepareTriageAttempt(correctionAttemptDraft())))
        );
        expect(
          insertAttemptWorkItem(
            context,
            unwrap(
              prepareAttemptWorkItem(
                workItemDraft(0, {
                  triageAttemptId: "triage-attempt-correction",
                  candidateId: "candidate-2",
                  candidateDocumentId: "candidate-document-2"
                })
              )
            )
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Attempt work item insert failed" })
        });
        unwrap(
          insertAttemptWorkItem(
            context,
            unwrap(
              prepareAttemptWorkItem(
                workItemDraft(0, { triageAttemptId: "triage-attempt-correction" })
              )
            )
          )
        );
        expect(
          unwrap(readTriageAttempt(context, "triage-attempt-correction"))
        ).toEqual(correctionAttemptDraft());
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("rejects mismatched owners, duplicate keys, and unprepared inserts", async () => {
    const connection = await openMigratedDatabase();
    expect(
      runImmediateTransaction(connection, (context) => {
        seedOfficialParents(context);
        expect(insertTriageAttempt(context, officialAttemptDraft())).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared triage attempt" })
        });
        seedOfficialAttempt(context);
        expect(
          insertTriageAttempt(context, unwrap(prepareTriageAttempt(officialAttemptDraft())))
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Triage attempt insert failed" })
        });
        expect(insertAttemptWorkItem(context, workItemDraft(0))).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared attempt work item" })
        });
        expect(
          insertAttemptWorkItem(
            context,
            unwrap(
              prepareAttemptWorkItem(
                workItemDraft(0, { candidateDocumentId: "candidate-document-missing" })
              )
            )
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Attempt work item insert failed" })
        });
        expect(
          insertAttemptWorkItem(
            context,
            unwrap(
              prepareAttemptWorkItem(workItemDraft(0, { dimensionId: "systems_thinking" }))
            )
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Attempt work item insert failed" })
        });
        seedPendingWorkItem(context);
        expect(
          insertAttemptWorkItem(
            context,
            unwrap(
              prepareAttemptWorkItem(
                workItemDraft(0, { attemptWorkItemId: "attempt-work-item-dup" })
              )
            )
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Attempt work item insert failed" })
        });
        return err({
          code: "persistence_failed",
          message: "rolled back after expected insert failures",
          retryable: false
        } as RuntimeError);
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "rolled back after expected insert failures"
      })
    });
    expect(connection.close().ok).toBe(true);
  });

  it("rejects stale versions and illegal completions", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedOfficialParents(context);
        seedOfficialAttempt(context);
        seedArtifact(context);
        seedFailure(context);
        seedPendingWorkItem(context);

        expect(
          claimAttemptWorkItem(context, { ...claimInput(0), extra: true })
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid attempt work item claim input" })
        });
        expect(
          claimAttemptWorkItem(
            context,
            claimInput(0, { claimedAt: CLAIMED_AT, claimExpiresAt: CLAIMED_AT - 1 })
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid attempt work item claim input" })
        });
        expect(
          claimAttemptWorkItem(context, claimInput(0, { expectedVersion: 9 }))
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            code: "version_conflict",
            message: "Attempt work item version conflict"
          })
        });
        expect(
          completeAttemptWorkItem(context, {
            attemptWorkItemId: "attempt-work-item-1",
            extractionArtifactId: "extraction-artifact-1",
            completedAt: COMPLETED_AT,
            expectedVersion: 1
          })
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Attempt work item is not claimed" })
        });
        expect(
          failAttemptWorkItem(context, {
            attemptWorkItemId: "attempt-work-item-1",
            state: "reviewable_failure",
            extractionFailureId: "extraction-failure-1",
            failedAt: COMPLETED_AT,
            expectedVersion: 1
          })
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Attempt work item is not claimed" })
        });
        expect(
          claimAttemptWorkItem(context, claimInput(0, { attemptWorkItemId: "missing-item" }))
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Attempt work item is missing" })
        });
        expect(
          completeAttemptWorkItem(context, {
            attemptWorkItemId: "missing-item",
            extractionArtifactId: "extraction-artifact-1",
            completedAt: COMPLETED_AT,
            expectedVersion: 1
          })
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Attempt work item is missing" })
        });
        expect(
          failAttemptWorkItem(context, {
            attemptWorkItemId: "missing-item",
            state: "reviewable_failure",
            extractionFailureId: "extraction-failure-1",
            failedAt: COMPLETED_AT,
            expectedVersion: 1
          })
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Attempt work item is missing" })
        });
        unwrap(claimAttemptWorkItem(context, claimInput(0)));
        expect(
          completeAttemptWorkItem(context, {
            attemptWorkItemId: "attempt-work-item-1",
            extractionArtifactId: "extraction-artifact-1",
            completedAt: COMPLETED_AT,
            expectedVersion: 1
          })
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ code: "version_conflict" })
        });
        expect(
          failAttemptWorkItem(context, {
            attemptWorkItemId: "attempt-work-item-1",
            state: "blocked_failure",
            extractionFailureId: "extraction-failure-1",
            failedAt: COMPLETED_AT,
            expectedVersion: 1
          })
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ code: "version_conflict" })
        });
        expect(
          completeAttemptWorkItem(context, {
            attemptWorkItemId: "attempt-work-item-1",
            extra: true
          })
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Invalid attempt work item completion input"
          })
        });
        expect(
          failAttemptWorkItem(context, {
            attemptWorkItemId: "attempt-work-item-1",
            state: "succeeded",
            extractionFailureId: "extraction-failure-1",
            failedAt: COMPLETED_AT,
            expectedVersion: 2
          })
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Invalid attempt work item failure input"
          })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("requires an active command transaction for insert, read, and named updates", () => {
    const preparedAttempt = unwrap(prepareTriageAttempt(officialAttemptDraft()));
    const preparedItem = unwrap(prepareAttemptWorkItem(workItemDraft(0)));

    for (const contextInput of [undefined, null, {}, { nativeDatabase: null }]) {
      expect(insertTriageAttempt(contextInput, preparedAttempt)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(insertAttemptWorkItem(contextInput, preparedItem)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readTriageAttempt(contextInput, "triage-attempt-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readAttemptWorkItem(contextInput, "attempt-work-item-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readAttemptWorkItems(contextInput, "triage-attempt-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(claimAttemptWorkItem(contextInput, claimInput(0))).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(
        completeAttemptWorkItem(contextInput, {
          attemptWorkItemId: "attempt-work-item-1",
          extractionArtifactId: "extraction-artifact-1",
          completedAt: COMPLETED_AT,
          expectedVersion: 2
        })
      ).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(
        failAttemptWorkItem(contextInput, {
          attemptWorkItemId: "attempt-work-item-1",
          state: "reviewable_failure",
          extractionFailureId: "extraction-failure-1",
          failedAt: COMPLETED_AT,
          expectedVersion: 2
        })
      ).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
    }

    expect(insertTriageAttempt(failingContext(), preparedAttempt)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Triage attempt insert failed" })
    });
    expect(insertAttemptWorkItem(failingContext(), preparedItem)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Attempt work item insert failed" })
    });
    expect(readTriageAttempt(failingContext(), "triage-attempt-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Triage attempt read failed" })
    });
    expect(readAttemptWorkItem(failingContext(), "attempt-work-item-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Attempt work item read failed" })
    });
    expect(readAttemptWorkItems(failingContext(), "triage-attempt-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Attempt work item read failed" })
    });
    expect(claimAttemptWorkItem(failingContext(), claimInput(0))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Attempt work item claim failed" })
    });
    expect(
      completeAttemptWorkItem(failingContext(), {
        attemptWorkItemId: "attempt-work-item-1",
        extractionArtifactId: "extraction-artifact-1",
        completedAt: COMPLETED_AT,
        expectedVersion: 2
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Attempt work item completion failed" })
    });
    expect(
      failAttemptWorkItem(failingContext(), {
        attemptWorkItemId: "attempt-work-item-1",
        state: "reviewable_failure",
        extractionFailureId: "extraction-failure-1",
        failedAt: COMPLETED_AT,
        expectedVersion: 2
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Attempt work item failure failed" })
    });
  });

  it("reads missing rows as undefined and rejects invalid IDs", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(unwrap(readTriageAttempt(context, "missing"))).toBeUndefined();
        expect(unwrap(readAttemptWorkItem(context, "missing"))).toBeUndefined();
        expect(unwrap(readAttemptWorkItems(context, "missing"))).toEqual([]);
        expect(readTriageAttempt(context, "has space")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid triage attempt ID" })
        });
        expect(readAttemptWorkItem(context, "has space")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid attempt work item ID" })
        });
        expect(readAttemptWorkItems(context, "has space")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid triage attempt ID" })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("rejects invalid stored rows after a check-free rebuild", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedOfficialParents(context);
        seedOfficialAttempt(context);
        seedPendingWorkItem(context);
        return ok(undefined);
      })
    );
    const database = nativeDatabase(connection);
    rebuildWithoutChecks(database, "triage_attempt");
    database.exec(`UPDATE triage_attempt SET kind = 'other' WHERE triage_attempt_id = 'triage-attempt-1'`);
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(readTriageAttempt(context, "triage-attempt-1")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Stored triage attempt is invalid" })
        });
        return ok(undefined);
      })
    );
    rebuildWithoutChecks(database, "attempt_work_item");
    database.exec(
      `UPDATE attempt_work_item SET state = 'other' WHERE attempt_work_item_id = 'attempt-work-item-1'`
    );
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(readAttemptWorkItem(context, "attempt-work-item-1")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Stored attempt work item is invalid" })
        });
        expect(readAttemptWorkItems(context, "triage-attempt-1")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Stored attempt work item is invalid" })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("keeps attempt tables STRICT and restores immutability triggers", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        const database = context.nativeDatabase;
        expect(
          database
            .prepare(
              "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'triage_attempt'"
            )
            .pluck()
            .get()
        ).toContain("STRICT");
        expect(
          database
            .prepare(
              "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'attempt_work_item'"
            )
            .pluck()
            .get()
        ).toContain("STRICT");
        const triggerNames = (
          database
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name")
            .pluck()
            .all() as string[]
        ).sort();
        expect(triggerNames).toEqual(
          expect.arrayContaining([
            "attempt_work_item_reject_delete",
            "attempt_work_item_reject_illegal_transition",
            "attempt_work_item_reject_owner",
            "attempt_work_item_reject_pinned_update",
            "attempt_work_item_reject_replace",
            "attempt_work_item_reject_terminal_owner",
            "attempt_work_item_reject_terminal_reopen",
            "triage_attempt_reject_delete",
            "triage_attempt_reject_pinned_update",
            "triage_attempt_reject_replace",
            "triage_run_seal_reject_incomplete"
          ])
        );
        seedOfficialParents(context);
        seedOfficialAttempt(context);
        seedPendingWorkItem(context);
        expect(
          insertTriageAttempt(
            context,
            unwrap(prepareTriageAttempt(officialAttemptDraft({ triageAttemptId: "triage-attempt-1" })))
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Triage attempt insert failed" })
        });
        expect(() =>
          database.exec("DELETE FROM triage_attempt WHERE triage_attempt_id = 'triage-attempt-1'")
        ).toThrow(/cannot be deleted/u);
        expect(() =>
          database.exec("DELETE FROM attempt_work_item WHERE attempt_work_item_id = 'attempt-work-item-1'")
        ).toThrow(/cannot be deleted/u);
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("covers status-refresh and named-update I/O failures", () => {
    const preparedItem = unwrap(prepareAttemptWorkItem(workItemDraft(0)));
    expect(
      insertAttemptWorkItem(
        failingContext((sql) => {
          if (sql.includes("INSERT INTO attempt_work_item")) {
            return { run() {} };
          }
          if (sql.includes("FROM triage_attempt")) {
            return { get() {} };
          }
          throw new Error("disk I/O error");
        }),
        preparedItem
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Triage attempt is missing for status refresh"
      })
    });

    const storedItem = pendingWorkItem(0);
    expect(
      claimAttemptWorkItem(
        failingContext((sql) => {
          if (sql.includes("FROM attempt_work_item") && sql.includes("WHERE attempt_work_item_id")) {
            return { get: () => storedItem };
          }
          throw new Error("disk I/O error");
        }),
        claimInput(0)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Attempt work item claim failed" })
    });
    expect(
      completeAttemptWorkItem(
        failingContext((sql) => {
          if (sql.includes("FROM attempt_work_item") && sql.includes("WHERE attempt_work_item_id")) {
            return {
              get: () => ({
                ...storedItem,
                state: "claimed",
                claimId: "attempt-claim-1",
                claimedAt: CLAIMED_AT,
                claimExpiresAt: CLAIMED_AT + 60_000,
                attemptCount: 1,
                version: 2
              })
            };
          }
          throw new Error("disk I/O error");
        }),
        {
          attemptWorkItemId: "attempt-work-item-1",
          extractionArtifactId: "extraction-artifact-1",
          completedAt: COMPLETED_AT,
          expectedVersion: 2
        }
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Attempt work item completion failed" })
    });
    expect(
      failAttemptWorkItem(
        failingContext((sql) => {
          if (sql.includes("FROM attempt_work_item") && sql.includes("WHERE attempt_work_item_id")) {
            return {
              get: () => ({
                ...storedItem,
                state: "claimed",
                claimId: "attempt-claim-1",
                claimedAt: CLAIMED_AT,
                claimExpiresAt: CLAIMED_AT + 60_000,
                attemptCount: 1,
                version: 2
              })
            };
          }
          throw new Error("disk I/O error");
        }),
        {
          attemptWorkItemId: "attempt-work-item-1",
          state: "reviewable_failure",
          extractionFailureId: "extraction-failure-1",
          failedAt: COMPLETED_AT,
          expectedVersion: 2
        }
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Attempt work item failure failed" })
    });

    const claimedItem = {
      ...storedItem,
      state: "claimed",
      claimId: "attempt-claim-1",
      claimedAt: CLAIMED_AT,
      claimExpiresAt: CLAIMED_AT + 60_000,
      attemptCount: 1,
      version: 2
    };
    expect(
      completeAttemptWorkItem(
        failingContext((sql) => {
          if (sql.includes("UPDATE attempt_work_item")) {
            return { run() {} };
          }
          if (sql.includes("FROM attempt_work_item")) {
            return { get: () => claimedItem };
          }
          if (sql.includes("FROM triage_attempt")) {
            return { get() {} };
          }
          throw new Error("disk I/O error");
        }),
        {
          attemptWorkItemId: "attempt-work-item-1",
          extractionArtifactId: "extraction-artifact-1",
          completedAt: COMPLETED_AT,
          expectedVersion: 2
        }
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Triage attempt is missing for status refresh"
      })
    });
    expect(
      failAttemptWorkItem(
        failingContext((sql) => {
          if (sql.includes("UPDATE attempt_work_item")) {
            return { run() {} };
          }
          if (sql.includes("FROM attempt_work_item")) {
            return { get: () => claimedItem };
          }
          if (sql.includes("FROM triage_attempt")) {
            return { get() {} };
          }
          throw new Error("disk I/O error");
        }),
        {
          attemptWorkItemId: "attempt-work-item-1",
          state: "reviewable_failure",
          extractionFailureId: "extraction-failure-1",
          failedAt: COMPLETED_AT,
          expectedVersion: 2
        }
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Triage attempt is missing for status refresh"
      })
    });
    expect(
      claimAttemptWorkItem(
        failingContext((sql) => {
          if (sql.includes("UPDATE attempt_work_item")) {
            return { run() {} };
          }
          if (sql.includes("FROM attempt_work_item")) {
            return { get: () => storedItem };
          }
          if (sql.includes("FROM triage_attempt")) {
            return { get() {} };
          }
          throw new Error("disk I/O error");
        }),
        claimInput(0)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Triage attempt is missing for status refresh"
      })
    });
  });
});
