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
  insertCandidate,
  insertCandidateDocument,
  insertSourceDocument,
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
  claimAttemptWorkItem,
  completeAttemptWorkItem,
  insertAttemptWorkItem,
  insertTriageAttempt,
  prepareAttemptWorkItem,
  prepareTriageAttempt
} from "../attempts/index.js";
import {
  insertExtractionArtifact,
  insertExtractionSpec,
  prepareExtractionArtifact,
  prepareExtractionSpec
} from "../extraction/index.js";
import {
  insertResolutionTask,
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
import {
  insertRunInputSnapshot,
  prepareRunInputSnapshot
} from "../snapshots/index.js";
import {
  MAXIMUM_TRIAGE_RUN_MEMBERS,
  insertTriageRun,
  insertTriageRunMember,
  insertTriageRunSeal,
  prepareTriageRun,
  prepareTriageRunMember,
  prepareTriageRunSeal,
  readTriageRun,
  readTriageRunMember,
  readTriageRunMembers,
  readTriageRunSeal
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const CLAIMED_AT = CREATED_AT + 1_000;
const COMPLETED_AT = CREATED_AT + 2_000;
const PROMPT_HASH = sha256Hex("prompt-template-v1");
const SCHEMA_HASH = sha256Hex("extraction-output-schema-v1");
const TRANSACTION_REQUIRED = "Triage run rows require an active command transaction";

const TRIAGE_RUN_COLUMNS = `
  triage_run_id text PRIMARY KEY NOT NULL,
  kind text NOT NULL,
  snapshot_id text NOT NULL,
  corpus_manifest_id text NOT NULL,
  seal_id text NOT NULL,
  created_at integer NOT NULL
`;

const TRIAGE_RUN_MEMBER_COLUMNS = `
  triage_run_member_id text PRIMARY KEY NOT NULL,
  triage_run_id text NOT NULL,
  candidate_id text NOT NULL,
  import_ordinal integer NOT NULL,
  initial_result_id text NOT NULL,
  created_at integer NOT NULL
`;

const TRIAGE_RUN_SEAL_COLUMNS = `
  triage_run_seal_id text PRIMARY KEY NOT NULL,
  triage_run_id text NOT NULL,
  created_at integer NOT NULL
`;

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-triage-run-test-"));
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
    rubricVersion: "1",
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

function runDraft(overrides: Record<string, unknown> = {}) {
  return {
    triageRunId: "triage-run-1",
    kind: "variant",
    snapshotId: "run-input-snapshot-1",
    corpusManifestId: "corpus-manifest-1",
    sealId: "triage-run-seal-1",
    createdAt: CREATED_AT,
    ...overrides
  };
}

function memberDraft(index: number, overrides: Record<string, unknown> = {}) {
  return {
    triageRunMemberId: `triage-run-member-${index + 1}`,
    triageRunId: "triage-run-1",
    candidateId: `candidate-${index + 1}`,
    importOrdinal: index,
    initialResultId: `candidate-result-${index + 1}`,
    createdAt: CREATED_AT,
    ...overrides
  };
}

function sealDraft(overrides: Record<string, unknown> = {}) {
  return {
    triageRunSealId: "triage-run-seal-1",
    triageRunId: "triage-run-1",
    createdAt: CREATED_AT,
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

function seedSealedInitialResult(
  context: ImmediateTransactionContext,
  index: number,
  overrides: Record<string, unknown> = {},
  initializeHead = true
): void {
  const result = unwrap(
    prepareCandidateTriageResult(unavailableResultDraft(index, overrides))
  );
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
  if (initializeHead) {
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
}

function seedOfficialParents(
  context: ImmediateTransactionContext,
  memberCount = 1
): void {
  seedRoleAndSnapshot(context);
  publishVariantCorpus(context, memberCount);
  for (let index = 0; index < memberCount; index += 1) {
    seedSealedInitialResult(context, index);
  }
}

function specDraft() {
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
    createdAt: CREATED_AT
  };
}

function officialAttemptDraft() {
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
    updatedAt: CREATED_AT
  };
}

function workItemDraft(index: number) {
  return {
    attemptWorkItemId: `attempt-work-item-${index + 1}`,
    triageAttemptId: "triage-attempt-1",
    workItemKey: `candidate-${index + 1}:candidate-document-${index + 1}:evaluation_practice`,
    manifestOrdinal: index,
    candidateId: `candidate-${index + 1}`,
    candidateDocumentId: `candidate-document-${index + 1}`,
    dimensionId: "evaluation_practice",
    extractionSpecId: "extraction-spec-1",
    createdAt: CREATED_AT
  };
}

function seedOfficialAttemptReady(
  context: ImmediateTransactionContext,
  memberCount = 1
): void {
  unwrap(insertExtractionSpec(context, unwrap(prepareExtractionSpec(specDraft()))));
  unwrap(insertTriageAttempt(context, unwrap(prepareTriageAttempt(officialAttemptDraft()))));
  for (let index = 0; index < memberCount; index += 1) {
    unwrap(
      insertExtractionArtifact(
        context,
        unwrap(
          prepareExtractionArtifact({
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
            createdAt: CREATED_AT
          })
        )
      )
    );
    unwrap(
      insertAttemptWorkItem(context, unwrap(prepareAttemptWorkItem(workItemDraft(index))))
    );
    unwrap(
      claimAttemptWorkItem(context, {
        attemptWorkItemId: `attempt-work-item-${index + 1}`,
        claimId: `attempt-claim-${index + 1}`,
        claimedAt: CLAIMED_AT,
        claimExpiresAt: CLAIMED_AT + 60_000,
        expectedVersion: 1
      })
    );
    unwrap(
      completeAttemptWorkItem(context, {
        attemptWorkItemId: `attempt-work-item-${index + 1}`,
        extractionArtifactId: `extraction-artifact-${index + 1}`,
        completedAt: COMPLETED_AT,
        expectedVersion: 2
      })
    );
  }
}

function publishOfficialRun(
  context: ImmediateTransactionContext,
  memberCount = 1
): void {
  seedOfficialAttemptReady(context, memberCount);
  unwrap(insertTriageRun(context, unwrap(prepareTriageRun(runDraft()))));
  for (let index = 0; index < memberCount; index += 1) {
    unwrap(
      insertTriageRunMember(context, unwrap(prepareTriageRunMember(memberDraft(index))))
    );
  }
  unwrap(insertTriageRunSeal(context, unwrap(prepareTriageRunSeal(sealDraft()))));
}

function rebuildWithoutChecks(
  database: BetterSqlite3.Database,
  table: "triage_run" | "triage_run_member" | "triage_run_seal"
): void {
  const columns =
    table === "triage_run"
      ? TRIAGE_RUN_COLUMNS
      : table === "triage_run_member"
        ? TRIAGE_RUN_MEMBER_COLUMNS
        : TRIAGE_RUN_SEAL_COLUMNS;
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS triage_run_reject_replace;
    DROP TRIGGER IF EXISTS triage_run_reject_update;
    DROP TRIGGER IF EXISTS triage_run_reject_delete;
    DROP TRIGGER IF EXISTS triage_run_member_reject_result_owner;
    DROP TRIGGER IF EXISTS triage_run_member_reject_replace;
    DROP TRIGGER IF EXISTS triage_run_member_reject_update;
    DROP TRIGGER IF EXISTS triage_run_member_reject_delete;
    DROP TRIGGER IF EXISTS triage_run_seal_reject_incomplete;
    DROP TRIGGER IF EXISTS triage_run_seal_reject_replace;
    DROP TRIGGER IF EXISTS triage_run_seal_reject_update;
    DROP TRIGGER IF EXISTS triage_run_seal_reject_delete;
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

describe("triage run persistence", () => {
  it("seals a variant run whose members match the corpus and current heads", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedOfficialParents(context, 2);
        expect(MAXIMUM_TRIAGE_RUN_MEMBERS).toBe(200);
        publishOfficialRun(context, 2);
        expect(unwrap(readTriageRun(context, "triage-run-1"))).toEqual(runDraft());
        expect(unwrap(readTriageRunMembers(context, "triage-run-1"))).toEqual([
          memberDraft(0),
          memberDraft(1)
        ]);
        expect(unwrap(readTriageRunMember(context, "triage-run-member-1"))).toEqual(
          memberDraft(0)
        );
        expect(unwrap(readTriageRunSeal(context, "triage-run-seal-1"))).toEqual(sealDraft());
        expect(Object.isFrozen(unwrap(readTriageRun(context, "triage-run-1")))).toBe(true);
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("rejects a seal when the official attempt is missing or still pending", async () => {
    const connection = await openMigratedDatabase();
    expect(
      runImmediateTransaction(connection, (context) => {
        seedOfficialParents(context, 2);
        unwrap(insertTriageRun(context, unwrap(prepareTriageRun(runDraft()))));
        unwrap(
          insertTriageRunMember(context, unwrap(prepareTriageRunMember(memberDraft(0))))
        );
        unwrap(
          insertTriageRunMember(context, unwrap(prepareTriageRunMember(memberDraft(1))))
        );
        expect(
          insertTriageRunSeal(context, unwrap(prepareTriageRunSeal(sealDraft())))
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Triage run seal insert failed" })
        });
        unwrap(insertExtractionSpec(context, unwrap(prepareExtractionSpec(specDraft()))));
        unwrap(
          insertTriageAttempt(context, unwrap(prepareTriageAttempt(officialAttemptDraft())))
        );
        unwrap(
          insertAttemptWorkItem(context, unwrap(prepareAttemptWorkItem(workItemDraft(0))))
        );
        unwrap(
          insertAttemptWorkItem(context, unwrap(prepareAttemptWorkItem(workItemDraft(1))))
        );
        expect(
          insertTriageRunSeal(context, unwrap(prepareTriageRunSeal(sealDraft())))
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Triage run seal insert failed" })
        });
        return err({
          code: "persistence_failed",
          message: "rolled back after expected attempt-readiness failures",
          retryable: false
        } as RuntimeError);
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "rolled back after expected attempt-readiness failures"
      })
    });
    expect(connection.close().ok).toBe(true);
  });

  it("fails commit when a run is inserted without its seal", async () => {
    const connection = await openMigratedDatabase();
    expect(
      runImmediateTransaction(connection, (context) => {
        seedOfficialParents(context);
        unwrap(insertTriageRun(context, unwrap(prepareTriageRun(runDraft()))));
        unwrap(
          insertTriageRunMember(context, unwrap(prepareTriageRunMember(memberDraft(0))))
        );
        return ok(undefined);
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Runtime database transaction failed"
      })
    });
    expect(connection.close().ok).toBe(true);
  });

  it("rejects incomplete membership, mismatched heads, and kind drift at seal time", async () => {
    const connection = await openMigratedDatabase();
    expect(
      runImmediateTransaction(connection, (context) => {
        seedOfficialParents(context, 2);
        unwrap(insertTriageRun(context, unwrap(prepareTriageRun(runDraft()))));
        unwrap(
          insertTriageRunMember(context, unwrap(prepareTriageRunMember(memberDraft(0))))
        );
        expect(
          insertTriageRunSeal(context, unwrap(prepareTriageRunSeal(sealDraft())))
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Triage run seal insert failed" })
        });
        unwrap(
          insertTriageRunMember(context, unwrap(prepareTriageRunMember(memberDraft(1))))
        );
        seedSealedInitialResult(
          context,
          0,
          {
            candidateTriageResultId: "candidate-result-1-correction",
            kind: "correction",
            supersedesResultId: "candidate-result-1"
          },
          false
        );
        unwrap(
          setCandidateHead(
            context,
            { candidateId: "candidate-1", currentResultId: "candidate-result-1-correction" },
            1
          )
        );
        expect(
          insertTriageRunSeal(context, unwrap(prepareTriageRunSeal(sealDraft())))
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Triage run seal insert failed" })
        });
        unwrap(
          setCandidateHead(
            context,
            { candidateId: "candidate-1", currentResultId: "candidate-result-1" },
            2
          )
        );
        expect(
          insertTriageRun(
            context,
            unwrap(
              prepareTriageRun(
                runDraft({
                  kind: "main",
                  triageRunId: "triage-run-main",
                  snapshotId: "run-input-snapshot-1",
                  corpusManifestId: "corpus-manifest-1",
                  sealId: "triage-run-seal-main"
                })
              )
            )
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Triage run insert failed" })
        });
        return err({
          code: "persistence_failed",
          message: "rolled back after expected seal failures",
          retryable: false
        } as RuntimeError);
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "rolled back after expected seal failures"
      })
    });
    expect(connection.close().ok).toBe(true);
  });

  it("rejects correction results, missing parents, and unprepared inserts", async () => {
    const connection = await openMigratedDatabase();
    expect(
      runImmediateTransaction(connection, (context) => {
        seedOfficialParents(context);
        expect(insertTriageRun(context, runDraft())).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared triage run" })
        });
        unwrap(insertTriageRun(context, unwrap(prepareTriageRun(runDraft()))));
        seedSealedInitialResult(context, 0, {
          candidateTriageResultId: "candidate-result-correction",
          kind: "correction",
          supersedesResultId: "candidate-result-1"
        }, false);
        expect(
          insertTriageRunMember(
            context,
            unwrap(
              prepareTriageRunMember(
                memberDraft(0, { initialResultId: "candidate-result-correction" })
              )
            )
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Triage run member insert failed" })
        });
        expect(insertTriageRunMember(context, memberDraft(0))).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared triage run member" })
        });
        unwrap(
          insertTriageRunMember(context, unwrap(prepareTriageRunMember(memberDraft(0))))
        );
        expect(insertTriageRunSeal(context, sealDraft())).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared triage run seal" })
        });
        expect(
          insertTriageRunSeal(
            context,
            unwrap(prepareTriageRunSeal(sealDraft({ triageRunId: "missing-run" })))
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Triage run seal requires a stored triage run"
          })
        });
        expect(
          insertTriageRunSeal(
            context,
            unwrap(prepareTriageRunSeal(sealDraft({ triageRunSealId: "other-seal" })))
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Triage run seal ID does not match the run seal_id"
          })
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

  it("rejects invalid and hostile prepare input", () => {
    expect(prepareTriageRun({ ...runDraft(), extra: true })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid triage run input" })
    });
    expect(prepareTriageRun(withThrowingGetter(runDraft(), "kind"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Triage run preparation failed" })
    });
    expect(prepareTriageRunMember({ ...memberDraft(0), extra: true })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid triage run member input" })
    });
    expect(prepareTriageRunMember(withThrowingGetter(memberDraft(0), "candidateId"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Triage run member preparation failed" })
    });
    expect(prepareTriageRunSeal({ ...sealDraft(), extra: true })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid triage run seal input" })
    });
    expect(prepareTriageRunSeal(withThrowingGetter(sealDraft(), "triageRunId"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Triage run seal preparation failed" })
    });
  });

  it("requires an active command transaction for insert and read", () => {
    const preparedRun = unwrap(prepareTriageRun(runDraft()));
    const preparedMember = unwrap(prepareTriageRunMember(memberDraft(0)));
    const preparedSeal = unwrap(prepareTriageRunSeal(sealDraft()));

    for (const contextInput of [undefined, null, {}, { nativeDatabase: null }]) {
      expect(insertTriageRun(contextInput, preparedRun)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(insertTriageRunMember(contextInput, preparedMember)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(insertTriageRunSeal(contextInput, preparedSeal)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readTriageRun(contextInput, "triage-run-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readTriageRunMember(contextInput, "triage-run-member-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readTriageRunMembers(contextInput, "triage-run-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readTriageRunSeal(contextInput, "triage-run-seal-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
    }
    expect(insertTriageRunMember(failingContext(), unwrap(prepareTriageRunMember(memberDraft(0))))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Triage run member insert failed" })
    });
    expect(insertTriageRun(failingContext(), unwrap(prepareTriageRun(runDraft())))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Triage run insert failed" })
    });
    expect(insertTriageRunSeal(failingContext(), unwrap(prepareTriageRunSeal(sealDraft())))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Triage run seal insert failed" })
    });
    expect(readTriageRun(failingContext(), "triage-run-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Triage run read failed" })
    });
    expect(readTriageRunMember(failingContext(), "triage-run-member-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Triage run member read failed" })
    });
    expect(readTriageRunMembers(failingContext(), "triage-run-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Triage run member read failed" })
    });
    expect(readTriageRunSeal(failingContext(), "triage-run-seal-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Triage run seal read failed" })
    });
  });

  it("reads missing rows as undefined and rejects invalid IDs", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(unwrap(readTriageRun(context, "missing"))).toBeUndefined();
        expect(unwrap(readTriageRunMember(context, "missing"))).toBeUndefined();
        expect(unwrap(readTriageRunMembers(context, "missing"))).toEqual([]);
        expect(unwrap(readTriageRunSeal(context, "missing"))).toBeUndefined();
        expect(readTriageRun(context, "has space")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid triage run ID" })
        });
        expect(readTriageRunMember(context, "has space")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid triage run member ID" })
        });
        expect(readTriageRunMembers(context, "has space")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid triage run ID" })
        });
        expect(readTriageRunSeal(context, "has space")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid triage run seal ID" })
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
        publishOfficialRun(context);
        return ok(undefined);
      })
    );
    const database = nativeDatabase(connection);
    rebuildWithoutChecks(database, "triage_run");
    database.exec(`UPDATE triage_run SET kind = 'other' WHERE triage_run_id = 'triage-run-1'`);
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(readTriageRun(context, "triage-run-1")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Stored triage run is invalid" })
        });
        return ok(undefined);
      })
    );
    rebuildWithoutChecks(database, "triage_run_member");
    database.exec(
      `UPDATE triage_run_member SET import_ordinal = -1 WHERE triage_run_member_id = 'triage-run-member-1'`
    );
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(readTriageRunMember(context, "triage-run-member-1")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Stored triage run member is invalid" })
        });
        expect(readTriageRunMembers(context, "triage-run-1")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Stored triage run member is invalid" })
        });
        return ok(undefined);
      })
    );
    rebuildWithoutChecks(database, "triage_run_seal");
    database.exec(`UPDATE triage_run_seal SET created_at = -1 WHERE triage_run_seal_id = 'triage-run-seal-1'`);
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(readTriageRunSeal(context, "triage-run-seal-1")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Stored triage run seal is invalid" })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("keeps triage_run STRICT with a deferred seal_id and restores immutability triggers", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        const database = context.nativeDatabase;
        expect(
          database
            .prepare(
              "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'triage_run'"
            )
            .pluck()
            .get()
        ).toContain("DEFERRABLE INITIALLY DEFERRED");
        expect(
          database
            .prepare(
              "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'triage_run_seal'"
            )
            .pluck()
            .get()
        ).toContain("STRICT");
        expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
        expect(database.pragma("defer_foreign_keys", { simple: true })).toBe(0);
        const triggerNames = (
          database
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name")
            .pluck()
            .all() as string[]
        ).sort();
        expect(triggerNames).toEqual(
          expect.arrayContaining([
            "triage_run_reject_delete",
            "triage_run_reject_replace",
            "triage_run_reject_update",
            "triage_run_member_reject_delete",
            "triage_run_member_reject_replace",
            "triage_run_member_reject_result_owner",
            "triage_run_member_reject_update",
            "triage_run_seal_reject_delete",
            "triage_run_seal_reject_incomplete",
            "triage_run_seal_reject_replace",
            "triage_run_seal_reject_update"
          ])
        );
        seedOfficialParents(context);
        publishOfficialRun(context);
        expect(
          insertTriageRun(
            context,
            unwrap(prepareTriageRun(runDraft({ triageRunId: "triage-run-1" })))
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Triage run insert failed" })
        });
        expect(
          insertTriageRunSeal(
            context,
            unwrap(prepareTriageRunSeal(sealDraft()))
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Triage run seal insert failed" })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });
});
