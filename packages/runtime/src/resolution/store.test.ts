import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeAggregateScore,
  computeConfidence,
  createDomainError,
  RUBRIC_V1,
  err,
  formatRational,
  ok,
  sha256Hex,
  type Result
} from "@recruitos/core";
import * as core from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runImmediateTransaction as runBareImmediateTransaction,
  type ImmediateTransactionContext
} from "../commands/index.js";
import { openRuntimeDatabase, type RuntimeDatabaseConnection } from "../db/index.js";
import {
  insertActor,
  insertCandidate,
  insertCandidateDocument,
  insertSourceDocument,
  prepareActor,
  prepareCandidate,
  prepareCandidateDocument,
  prepareSourceDocument,
  SYSTEM_ACTOR_ID
} from "../entities/index.js";
import { type RuntimeError } from "../errors/index.js";
import {
  insertDimensionAssessment,
  insertEvidenceGap,
  insertEvidenceSpan,
  prepareDimensionAssessment,
  prepareEvidenceGap,
  prepareEvidenceSpan
} from "../evidence/index.js";
import {
  insertFactConflict,
  insertHardRequirementAssessment,
  insertStructuredFact,
  prepareFactConflict,
  prepareHardRequirementAssessment,
  prepareStructuredFact
} from "../facts/index.js";
import {
  insertCandidateResultReason,
  insertCandidateResultSeal,
  insertCandidateTriageResult,
  prepareCandidateResultReason,
  prepareCandidateResultSeal,
  prepareCandidateTriageResult
} from "../results/index.js";
import {
  insertResolutionAction,
  insertResolutionTask,
  prepareResolutionAction,
  prepareResolutionTask,
  readResolutionAction,
  readResolutionActions,
  readResolutionTask,
  readResolutionTaskHead,
  readResolutionTasks,
  readResolutionTaskStatus,
  ResolutionActionSchema
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const DOCUMENT_TEXT = "ABCDEFGHIJ";
const TASK_TRANSACTION_REQUIRED =
  "Resolution task rows require an active command transaction";
const ACTION_TRANSACTION_REQUIRED =
  "Resolution action rows require an active command transaction";
const HEAD_TRANSACTION_REQUIRED =
  "Resolution task head rows require an active command transaction";
const ASSESSMENT_ID = "dimension-assessment-applied_ml_llm_systems";
const RUBRIC_DIMENSIONS = RUBRIC_V1.dimensions.map((dimension) => dimension.dimensionId);

const RESOLUTION_TASK_COLUMNS = `
  resolution_task_id text PRIMARY KEY NOT NULL,
  candidate_result_id text NOT NULL,
  candidate_result_reason_id text NOT NULL,
  task_ordinal integer NOT NULL,
  created_at integer NOT NULL
`;

const RESOLUTION_ACTION_COLUMNS = `
  resolution_action_id text PRIMARY KEY NOT NULL,
  resolution_task_id text NOT NULL,
  actor_id text NOT NULL,
  action_kind text NOT NULL,
  action_ordinal integer NOT NULL,
  payload_json text NOT NULL,
  payload_hash text NOT NULL,
  evidence_span_id text,
  dimension_assessment_id text,
  resulting_result_id text,
  created_at integer NOT NULL
`;

const RESOLUTION_TASK_HEAD_COLUMNS = `
  resolution_task_id text PRIMARY KEY NOT NULL,
  current_action_id text NOT NULL,
  version integer NOT NULL
`;

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-resolution-test-"));
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

function sealUnsealedResults(context: ImmediateTransactionContext): void {
  const rows = context.nativeDatabase
    .prepare(
      `SELECT
         result.candidate_triage_result_id AS candidateResultId,
         result.seal_id AS sealId,
         result.availability AS availability,
         result.created_at AS createdAt
       FROM candidate_triage_result AS result
       WHERE NOT EXISTS (
         SELECT 1
         FROM candidate_result_seal AS seal
         WHERE seal.candidate_result_seal_id = result.seal_id
       )`
    )
    .all() as Array<{
    candidateResultId: string;
    sealId: string;
    availability: string;
    createdAt: number;
  }>;
  for (const row of rows) {
    if (row.availability === "unavailable") {
      const reasons = context.nativeDatabase
        .prepare(
          `SELECT candidate_result_reason_id AS id
           FROM candidate_result_reason
           WHERE candidate_result_id = ?`
        )
        .all(row.candidateResultId) as Array<{ id: string }>;
      let reasonIds = reasons.map((reason) => reason.id);
      if (reasonIds.length === 0) {
        const reason = unwrap(
          prepareCandidateResultReason({
            candidateResultReasonId: `candidate-result-reason-${row.candidateResultId}`,
            candidateResultId: row.candidateResultId,
            reasonCode: "assessment_unavailable",
            reasonOrdinal: 0,
            createdAt: row.createdAt
          })
        );
        unwrap(insertCandidateResultReason(context, reason));
        reasonIds = [reason.candidateResultReasonId];
      }
      const tasked = new Set(
        (
          context.nativeDatabase
            .prepare(
              `SELECT candidate_result_reason_id AS reasonId
               FROM resolution_task
               WHERE candidate_result_id = ?`
            )
            .all(row.candidateResultId) as Array<{ reasonId: string }>
        ).map((task) => task.reasonId)
      );
      const maxOrdinal = (
        context.nativeDatabase
          .prepare(
            `SELECT COALESCE(MAX(task_ordinal), -1) AS maxOrdinal
             FROM resolution_task
             WHERE candidate_result_id = ?`
          )
          .get(row.candidateResultId) as { maxOrdinal: number }
      ).maxOrdinal;
      let nextOrdinal = maxOrdinal + 1;
      for (const reasonId of reasonIds) {
        if (tasked.has(reasonId)) {
          continue;
        }
        unwrap(
          insertResolutionTask(
            context,
            unwrap(
              prepareResolutionTask({
                resolutionTaskId: `resolution-task-seal-${reasonId}`,
                candidateResultId: row.candidateResultId,
                candidateResultReasonId: reasonId,
                taskOrdinal: nextOrdinal,
                createdAt: row.createdAt
              })
            )
          )
        );
        nextOrdinal += 1;
      }
    }
    unwrap(
      insertCandidateResultSeal(
        context,
        unwrap(
          prepareCandidateResultSeal({
            candidateResultSealId: row.sealId,
            candidateResultId: row.candidateResultId,
            createdAt: row.createdAt
          })
        )
      )
    );
  }
}

function runImmediateTransaction<TResult>(
  connection: RuntimeDatabaseConnection,
  work: (context: ImmediateTransactionContext) => Result<TResult, RuntimeError>
): Result<TResult, RuntimeError> {
  return runBareImmediateTransaction(connection, (context) => {
    const result = work(context);
    if (!result.ok) {
      return result;
    }
    sealUnsealedResults(context);
    return result;
  });
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

function candidateDraft(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: "candidate-1",
    sourceSystem: "synthetic_corpus",
    sourceKey: "tier-one/0001",
    channel: "inbound",
    corpusTag: "main",
    createdAt: CREATED_AT,
    ...overrides
  };
}

function actorDraft(overrides: Record<string, unknown> = {}) {
  return {
    actorId: "actor-recruiter-1",
    displayName: "Dana Recruiter",
    createdAt: CREATED_AT,
    ...overrides
  };
}

function sourceDocumentDraft(overrides: Record<string, unknown> = {}) {
  return {
    sourceDocumentId: "source-document-1",
    rawText: DOCUMENT_TEXT,
    normalizedText: DOCUMENT_TEXT,
    createdAt: CREATED_AT,
    ...overrides
  };
}

function evidenceSpanDraft(overrides: Record<string, unknown> = {}) {
  return {
    evidenceSpanId: "evidence-span-1",
    documentId: "source-document-1",
    start: 2,
    end: 5,
    quotedText: "CDE",
    dimensionId: "applied_ml_llm_systems",
    polarity: "supporting",
    source: "extracted",
    matchQuality: "exact",
    extractorVersion: "extractor-v1",
    createdAt: CREATED_AT,
    ...overrides
  };
}

function factDraft(overrides: Record<string, unknown> = {}) {
  return {
    structuredFactId: "structured-fact-1",
    candidateId: "candidate-1",
    payload: { kind: "current_title", title: "Staff Engineer" },
    evidenceSpans: [
      {
        structuredFactEvidenceSpanId: "structured-fact-span-1",
        evidenceSpanId: "evidence-span-1"
      }
    ],
    provenances: [
      {
        structuredFactProvenanceId: "structured-fact-provenance-1",
        source: "extracted",
        actorId: null
      }
    ],
    createdAt: CREATED_AT,
    ...overrides
  };
}

function conflictDraft(overrides: Record<string, unknown> = {}) {
  return {
    factConflictId: "fact-conflict-1",
    members: [
      {
        factConflictMemberId: "fact-conflict-member-1",
        structuredFactId: "structured-fact-1"
      },
      {
        factConflictMemberId: "fact-conflict-member-2",
        structuredFactId: "structured-fact-2"
      }
    ],
    createdAt: CREATED_AT,
    ...overrides
  };
}

function requirementDraft(overrides: Record<string, unknown> = {}) {
  return {
    hardRequirementAssessmentId: "hard-requirement-assessment-1",
    candidateId: "candidate-1",
    requirementFieldId: "current_title",
    outcome: "pass",
    facts: [
      {
        hardRequirementAssessmentFactId: "hard-requirement-assessment-fact-1",
        structuredFactId: "structured-fact-1",
        polarity: "supporting"
      }
    ],
    createdAt: CREATED_AT,
    ...overrides
  };
}

function zeroConfidenceInput() {
  return {
    contradictionCount: 0,
    dimensionsWithLocatedSpan: 0,
    requiredFieldsMissing: 0,
    spansLocated: 0,
    spansReturned: 0,
    totalDimensions: 6,
    totalRequiredFields: 4
  };
}

function computedScoreDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const computation = unwrap(
    computeAggregateScore(
      RUBRIC_V1.dimensions.map((dimension) => ({
        dimensionId: dimension.dimensionId,
        level: "none" as const
      })),
      RUBRIC_V1
    )
  );
  const confidenceInput = zeroConfidenceInput();
  const confidence = unwrap(computeConfidence(confidenceInput));
  return {
    scoreResultId: "score-result-1",
    aggregate: formatRational(computation.aggregate),
    confidence: formatRational(confidence),
    confidenceInput,
    contributions: computation.contributions.map((contribution) => ({
      dimensionId: contribution.dimensionId,
      level: contribution.level,
      levelValue: formatRational(contribution.levelValue),
      weight: contribution.weight,
      weightedValue: formatRational(contribution.weightedValue)
    })),
    ...overrides
  };
}

function completeResultDraft(overrides: Record<string, unknown> = {}) {
  const candidateTriageResultId =
    typeof overrides.candidateTriageResultId === "string"
      ? overrides.candidateTriageResultId
      : "candidate-result-1";
  return {
    candidateTriageResultId,
    candidateId: "candidate-1",
    kind: "initial",
    availability: "complete",
    status: "escalated",
    supersedesResultId: null,
    evidenceSpans: [
      {
        candidateResultEvidenceSpanId: "candidate-result-span-1",
        evidenceSpanId: "evidence-span-1"
      }
    ],
    evidenceGaps: RUBRIC_DIMENSIONS.map((dimensionId) => ({
      candidateResultEvidenceGapId: `candidate-result-gap-${dimensionId}`,
      evidenceGapId: `evidence-gap-${dimensionId}`,
      dimensionId
    })),
    dimensionAssessments: RUBRIC_DIMENSIONS.map((dimensionId) => ({
      candidateResultDimensionAssessmentId: `candidate-result-assessment-${dimensionId}`,
      dimensionAssessmentId: `dimension-assessment-${dimensionId}`,
      dimensionId
    })),
    structuredFacts: [
      {
        candidateResultStructuredFactId: "candidate-result-fact-1",
        structuredFactId: "structured-fact-1"
      }
    ],
    factConflicts: [
      {
        candidateResultFactConflictId: "candidate-result-conflict-1",
        factConflictId: "fact-conflict-1"
      }
    ],
    hardRequirementAssessments: [
      {
        candidateResultHardRequirementAssessmentId: "candidate-result-requirement-1",
        hardRequirementAssessmentId: "hard-requirement-assessment-1"
      }
    ],
    score: computedScoreDraft(),
    sealId: `candidate-result-seal-${candidateTriageResultId}`,
    createdAt: CREATED_AT,
    ...overrides
  };
}

function unavailableResultDraft(overrides: Record<string, unknown> = {}) {
  const candidateTriageResultId =
    typeof overrides.candidateTriageResultId === "string"
      ? overrides.candidateTriageResultId
      : "candidate-result-1";
  return {
    candidateTriageResultId,
    candidateId: "candidate-1",
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

function reasonDraft(overrides: Record<string, unknown> = {}) {
  return {
    candidateResultReasonId: "candidate-result-reason-1",
    candidateResultId: "candidate-result-1",
    reasonCode: "assessment_unavailable",
    reasonOrdinal: 0,
    createdAt: CREATED_AT,
    ...overrides
  };
}

function taskDraft(overrides: Record<string, unknown> = {}) {
  return {
    resolutionTaskId: "resolution-task-1",
    candidateResultId: "candidate-result-1",
    candidateResultReasonId: "candidate-result-reason-1",
    taskOrdinal: 0,
    createdAt: CREATED_AT,
    ...overrides
  };
}

function actionDraft(overrides: Record<string, unknown> = {}) {
  return {
    resolutionActionId: "resolution-action-1",
    resolutionTaskId: "resolution-task-1",
    actorId: "actor-recruiter-1",
    actionOrdinal: 0,
    payload: { kind: "dismiss", rationale: "Duplicate of 0002" },
    createdAt: CREATED_AT,
    ...overrides
  };
}

function seedParents(context: ImmediateTransactionContext): void {
  unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
  unwrap(insertSourceDocument(context, unwrap(prepareSourceDocument(sourceDocumentDraft()))));
  unwrap(insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft()))));
  unwrap(insertActor(context, unwrap(prepareActor(actorDraft()))));
  unwrap(
    insertDimensionAssessment(
      context,
      unwrap(
        prepareDimensionAssessment({
          dimensionAssessmentId: ASSESSMENT_ID,
          dimensionId: "applied_ml_llm_systems",
          level: "none",
          source: "extracted",
          actorId: null,
          createdAt: CREATED_AT
        })
      )
    )
  );
}

function seedRichParents(context: ImmediateTransactionContext): void {
  unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
  unwrap(insertSourceDocument(context, unwrap(prepareSourceDocument(sourceDocumentDraft()))));
  unwrap(
    insertCandidateDocument(
      context,
      unwrap(
        prepareCandidateDocument({
          candidateDocumentId: "candidate-document-1",
          candidateId: "candidate-1",
          sourceDocumentId: "source-document-1",
          documentKind: "resume",
          label: "Resume",
          documentOrdinal: 0,
          createdAt: CREATED_AT
        })
      )
    )
  );
  unwrap(insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft()))));
  unwrap(insertActor(context, unwrap(prepareActor(actorDraft()))));
  unwrap(
    insertEvidenceSpan(
      context,
      unwrap(
        prepareEvidenceSpan(
          evidenceSpanDraft({
            evidenceSpanId: "evidence-span-2",
            start: 0,
            end: 3,
            quotedText: "ABC"
          })
        )
      )
    )
  );
  unwrap(insertStructuredFact(context, unwrap(prepareStructuredFact(factDraft()))));
  unwrap(
    insertStructuredFact(
      context,
      unwrap(
        prepareStructuredFact(
          factDraft({
            structuredFactId: "structured-fact-2",
            payload: { kind: "current_title", title: "Principal Engineer" },
            evidenceSpans: [
              {
                structuredFactEvidenceSpanId: "structured-fact-span-2",
                evidenceSpanId: "evidence-span-2"
              }
            ],
            provenances: [
              {
                structuredFactProvenanceId: "structured-fact-provenance-2",
                source: "parsed",
                actorId: null
              }
            ]
          })
        )
      )
    )
  );
  for (const dimension of RUBRIC_V1.dimensions) {
    unwrap(
      insertEvidenceGap(
        context,
        unwrap(
          prepareEvidenceGap({
            evidenceGapId: `evidence-gap-${dimension.dimensionId}`,
            dimensionId: dimension.dimensionId,
            reasonCode: `missing_evidence:${dimension.dimensionId}`,
            documentsSearched: ["source-document-1"],
            createdAt: CREATED_AT
          })
        )
      )
    );
    unwrap(
      insertDimensionAssessment(
        context,
        unwrap(
          prepareDimensionAssessment({
            dimensionAssessmentId: `dimension-assessment-${dimension.dimensionId}`,
            dimensionId: dimension.dimensionId,
            level: "none",
            source: "extracted",
            actorId: null,
            createdAt: CREATED_AT
          })
        )
      )
    );
  }
  unwrap(insertFactConflict(context, unwrap(prepareFactConflict(conflictDraft()))));
  unwrap(
    insertHardRequirementAssessment(
      context,
      unwrap(prepareHardRequirementAssessment(requirementDraft()))
    )
  );
}

function seedCompleteResult(context: ImmediateTransactionContext): void {
  const result = unwrap(prepareCandidateTriageResult(completeResultDraft()));
  unwrap(insertCandidateTriageResult(context, result));
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
}

function seedUnavailableResult(
  context: ImmediateTransactionContext,
  overrides: Record<string, unknown> = {}
): void {
  unwrap(
    insertCandidateTriageResult(
      context,
      unwrap(prepareCandidateTriageResult(unavailableResultDraft(overrides)))
    )
  );
}

function seedReason(
  context: ImmediateTransactionContext,
  overrides: Record<string, unknown> = {}
): void {
  unwrap(
    insertCandidateResultReason(context, unwrap(prepareCandidateResultReason(reasonDraft(overrides))))
  );
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

function rebuildTableWithoutChecks(
  database: BetterSqlite3.Database,
  table: string,
  columns: string,
  extraTriggers: readonly string[] = []
): void {
  const triggerNames = [
    `${table}_reject_update`,
    `${table}_reject_delete`,
    `${table}_reject_replace`,
    ...extraTriggers
  ];
  if (table === "resolution_action" || table === "resolution_task") {
    triggerNames.push(
      "resolution_task_head_insert_action_owner",
      "resolution_task_head_update_action_owner"
    );
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    ${triggerNames.map((name) => `DROP TRIGGER IF EXISTS ${name};`).join("\n")}
    DROP TRIGGER IF EXISTS candidate_result_seal_reject_incomplete;
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

describe("resolution task and action preparation", () => {
  it("freezes a valid task and denormalizes action payload columns", () => {
    const task = unwrap(prepareResolutionTask(taskDraft()));
    expect(task.taskOrdinal).toBe(0);
    expect(Object.isFrozen(task)).toBe(true);

    const dismiss = unwrap(prepareResolutionAction(actionDraft()));
    expect(dismiss.actionKind).toBe("dismiss");
    expect(dismiss.evidenceSpanId).toBeNull();
    expect(dismiss.payloadHash).toBe(sha256Hex(dismiss.payloadJson));
    expect(Object.isFrozen(dismiss)).toBe(true);

    const supply = unwrap(
      prepareResolutionAction(
        actionDraft({
          payload: {
            kind: "supply_evidence_and_set_level",
            evidenceSpanId: "evidence-span-1",
            dimensionAssessmentId: ASSESSMENT_ID
          }
        })
      )
    );
    expect(supply.evidenceSpanId).toBe("evidence-span-1");
    expect(supply.dimensionAssessmentId).toBe(ASSESSMENT_ID);

    const confirm = unwrap(
      prepareResolutionAction(
        actionDraft({
          payload: { kind: "confirm_judgment", dimensionAssessmentId: ASSESSMENT_ID }
        })
      )
    );
    expect(confirm.dimensionAssessmentId).toBe(ASSESSMENT_ID);
    expect(confirm.evidenceSpanId).toBeNull();

    const completed = unwrap(
      prepareResolutionAction(
        actionDraft({
          actorId: SYSTEM_ACTOR_ID,
          payload: {
            kind: "reextraction_completed",
            resultingResultId: "candidate-result-2"
          }
        })
      )
    );
    expect(completed.resultingResultId).toBe("candidate-result-2");
    expect(completed.actorId).toBe(SYSTEM_ACTOR_ID);

    expect(
      unwrap(prepareResolutionAction(actionDraft({ payload: { kind: "request_re_extraction" } })))
        .actionKind
    ).toBe("request_re_extraction");
    expect(
      unwrap(prepareResolutionAction(actionDraft({ payload: { kind: "correct_parse" } }))).actionKind
    ).toBe("correct_parse");
    expect(
      unwrap(
        prepareResolutionAction(
          actionDraft({ payload: { kind: "block", rationale: "Hard requirement failed" } })
        )
      ).actionKind
    ).toBe("block");
  });

  it("rejects extra keys, hostile drafts, and actor/kind mismatches", () => {
    expect(prepareResolutionTask({ ...taskDraft(), extra: true })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid resolution task input" })
    });
    expect(prepareResolutionTask(withThrowingGetter(taskDraft(), "resolutionTaskId"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Resolution task preparation failed" })
    });
    expect(prepareResolutionAction({ ...actionDraft(), extra: true })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid resolution action input" })
    });
    expect(prepareResolutionAction(withThrowingGetter(actionDraft(), "payload"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Resolution action preparation failed" })
    });
    expect(
      prepareResolutionAction(actionDraft({ payload: { kind: "dismiss" } }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid resolution action input" })
    });
    expect(
      prepareResolutionAction(actionDraft({ actorId: SYSTEM_ACTOR_ID }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Resolution action actor does not match action kind"
      })
    });
    const stringify = vi.spyOn(core, "canonicalJsonStringify").mockReturnValueOnce(
      err(createDomainError("invalid_input", "Value is not canonical JSON"))
    );
    expect(prepareResolutionAction(actionDraft())).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Resolution action payload is not canonical JSON"
      })
    });
    stringify.mockRestore();
    const parse = vi.spyOn(ResolutionActionSchema, "safeParse").mockReturnValueOnce({
      success: false,
      error: { issues: [] }
    } as never);
    expect(prepareResolutionAction(actionDraft())).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid resolution action input" })
    });
    parse.mockRestore();
    expect(
      prepareResolutionAction(
        actionDraft({
          payload: {
            kind: "reextraction_completed",
            resultingResultId: "candidate-result-2"
          }
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Resolution action actor does not match action kind"
      })
    });
  });
});

describe("resolution task persistence", () => {
  it("stores one task per reason and lists by ordinal", async () => {
    const connection = await openMigratedDatabase();
    const first = unwrap(prepareResolutionTask(taskDraft()));
    const second = unwrap(
      prepareResolutionTask(
        taskDraft({
          resolutionTaskId: "resolution-task-2",
          candidateResultReasonId: "candidate-result-reason-2",
          taskOrdinal: 1,
          createdAt: CREATED_AT + 1
        })
      )
    );
    const listed = unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRichParents(context);
        seedCompleteResult(context);
        seedReason(context, { reasonCode: "parse_failure" });
        seedReason(context, {
          candidateResultReasonId: "candidate-result-reason-2",
          reasonCode: "low_confidence",
          reasonOrdinal: 1
        });
        seedReason(context, {
          candidateResultReasonId: "candidate-result-reason-3",
          reasonCode: "missing_evidence:applied_ml_llm_systems",
          reasonOrdinal: 2
        });
        unwrap(insertResolutionTask(context, first));
        unwrap(insertResolutionTask(context, second));
        expect(
          insertResolutionTask(
            context,
            unwrap(
              prepareResolutionTask(
                taskDraft({
                  resolutionTaskId: "resolution-task-dup-ordinal",
                  candidateResultReasonId: "candidate-result-reason-3",
                  taskOrdinal: 0
                })
              )
            )
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Resolution task insert failed" })
        });
        expect(unwrap(readResolutionTask(context, first.resolutionTaskId))).toEqual(first);
        expect(unwrap(readResolutionTaskStatus(context, first.resolutionTaskId))).toBe("open");
        expect(unwrap(readResolutionTaskHead(context, first.resolutionTaskId))).toBeUndefined();
        return readResolutionTasks(context, "candidate-result-1");
      })
    );
    expect(listed.map((task) => task.resolutionTaskId)).toEqual([
      "resolution-task-1",
      "resolution-task-2"
    ]);
    expect(connection.close().ok).toBe(true);
  });

  it("rejects missing parents, reason mismatch, and uniqueness collisions", async () => {
    const connection = await openMigratedDatabase();
    const task = unwrap(prepareResolutionTask(taskDraft()));
    const mismatched = unwrap(
      prepareResolutionTask(
        taskDraft({
          resolutionTaskId: "resolution-task-mismatch",
          candidateResultId: "candidate-result-2"
        })
      )
    );
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(insertResolutionTask(context, task)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Resolution task requires a stored candidate result"
          })
        });
        seedParents(context);
        seedUnavailableResult(context);
        expect(insertResolutionTask(context, task)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Resolution task requires a stored candidate result reason"
          })
        });
        seedReason(context);
        seedUnavailableResult(context, {
          candidateTriageResultId: "candidate-result-2",
          kind: "correction",
          supersedesResultId: "candidate-result-1"
        });
        expect(insertResolutionTask(context, mismatched)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Resolution task reason must belong to the same candidate result"
          })
        });
        unwrap(insertResolutionTask(context, task));
        expect(
          insertResolutionTask(
            context,
            unwrap(
              prepareResolutionTask(
                taskDraft({
                  resolutionTaskId: "resolution-task-dup-reason",
                  taskOrdinal: 1
                })
              )
            )
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Resolution task insert failed" })
        });
        seedReason(context, {
          candidateResultId: "candidate-result-2",
          candidateResultReasonId: "candidate-result-reason-2",
          reasonCode: "assessment_unavailable"
        });
        expect(
          insertResolutionTask(
            context,
            unwrap(
              prepareResolutionTask(
                taskDraft({
                  resolutionTaskId: "resolution-task-dup-ordinal",
                  candidateResultId: "candidate-result-1",
                  candidateResultReasonId: "candidate-result-reason-2",
                  taskOrdinal: 0
                })
              )
            )
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Resolution task reason must belong to the same candidate result"
          })
        });
        expect(
          insertResolutionTask(
            context,
            unwrap(
              prepareResolutionTask(
                taskDraft({
                  resolutionTaskId: "resolution-task-result-2",
                  candidateResultId: "candidate-result-2",
                  candidateResultReasonId: "candidate-result-reason-2",
                  taskOrdinal: 0
                })
              )
            )
          )
        ).toEqual({
          ok: true,
          value: expect.objectContaining({ resolutionTaskId: "resolution-task-result-2" })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("requires a command transaction and prepared records", () => {
    const prepared = unwrap(prepareResolutionTask(taskDraft()));
    expect(insertResolutionTask(null, prepared)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TASK_TRANSACTION_REQUIRED })
    });
    expect(insertResolutionTask(undefined, prepared)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TASK_TRANSACTION_REQUIRED })
    });
    expect(insertResolutionTask({}, prepared)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TASK_TRANSACTION_REQUIRED })
    });
    expect(insertResolutionTask({ nativeDatabase: null }, prepared)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TASK_TRANSACTION_REQUIRED })
    });
    expect(
      insertResolutionTask({ nativeDatabase: { inTransaction: false } }, prepared)
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TASK_TRANSACTION_REQUIRED })
    });
    expect(readResolutionTask({}, "resolution-task-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TASK_TRANSACTION_REQUIRED })
    });
    expect(readResolutionTasks({}, "candidate-result-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TASK_TRANSACTION_REQUIRED })
    });
    expect(insertResolutionTask(failingContext(), prepared)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Resolution task insert failed" })
    });
    expect(insertResolutionTask(failingContext(), { resolutionTaskId: "x" })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid prepared resolution task" })
    });
    expect(readResolutionTask(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid resolution task ID" })
    });
    expect(readResolutionTask(failingContext(), "resolution-task-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Resolution task read failed" })
    });
    expect(readResolutionTasks(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate result ID" })
    });
    expect(readResolutionTasks(failingContext(), "candidate-result-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Resolution task read failed" })
    });
    expect(
      insertResolutionTask(withThrowingGetter({ nativeDatabase: { inTransaction: true } }, "nativeDatabase"), prepared)
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Resolution task insert failed" })
    });
  });

  it("returns undefined or an empty list when no task row exists", async () => {
    const connection = await openMigratedDatabase();
    const missing = unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRichParents(context);
        seedCompleteResult(context);
        expect(unwrap(readResolutionTaskStatus(context, "resolution-task-1"))).toBeUndefined();
        return readResolutionTask(context, "resolution-task-1");
      })
    );
    expect(missing).toBeUndefined();
    expect(
      unwrap(
        runImmediateTransaction(connection, (context) =>
          readResolutionTasks(context, "candidate-result-1")
        )
      )
    ).toEqual([]);
    expect(connection.close().ok).toBe(true);
  });
});

describe("resolution action persistence and task heads", () => {
  it("initializes the head on the first action and compare-and-sets later actions", async () => {
    const connection = await openMigratedDatabase();
    const task = unwrap(prepareResolutionTask(taskDraft()));
    const first = unwrap(
      prepareResolutionAction(actionDraft({ payload: { kind: "request_re_extraction" } }))
    );
    const second = unwrap(
      prepareResolutionAction(
        actionDraft({
          resolutionActionId: "resolution-action-2",
          actorId: SYSTEM_ACTOR_ID,
          actionOrdinal: 1,
          payload: {
            kind: "reextraction_completed",
            resultingResultId: "candidate-result-2"
          }
        })
      )
    );
    const third = unwrap(
      prepareResolutionAction(
        actionDraft({
          resolutionActionId: "resolution-action-3",
          actionOrdinal: 2,
          payload: { kind: "confirm_judgment", dimensionAssessmentId: ASSESSMENT_ID }
        })
      )
    );
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        seedUnavailableResult(context);
        seedUnavailableResult(context, {
          candidateTriageResultId: "candidate-result-2",
          kind: "correction",
          supersedesResultId: "candidate-result-1"
        });
        seedReason(context);
        unwrap(insertResolutionTask(context, task));
        expect(insertResolutionAction(context, first, 1)).toEqual({
          ok: false,
          error: expect.objectContaining({
            code: "version_conflict",
            details: expect.objectContaining({
              expectedVersion: 1,
              actualVersion: null
            })
          })
        });
        unwrap(insertResolutionAction(context, first, 0));
        expect(unwrap(readResolutionAction(context, first.resolutionActionId))).toEqual(first);
        expect(unwrap(readResolutionTaskHead(context, task.resolutionTaskId))).toEqual({
          resolutionTaskId: task.resolutionTaskId,
          currentActionId: first.resolutionActionId,
          version: 1
        });
        expect(unwrap(readResolutionTaskStatus(context, task.resolutionTaskId))).toBe("open");
        expect(insertResolutionAction(context, second, 0)).toEqual({
          ok: false,
          error: expect.objectContaining({
            code: "version_conflict",
            details: expect.objectContaining({
              expectedVersion: 0,
              actualVersion: 1
            })
          })
        });
        unwrap(insertResolutionAction(context, second, 1));
        expect(unwrap(readResolutionTaskStatus(context, task.resolutionTaskId))).toBe(
          "review_required"
        );
        unwrap(insertResolutionAction(context, third, 2));
        expect(unwrap(readResolutionTaskHead(context, task.resolutionTaskId))).toEqual({
          resolutionTaskId: task.resolutionTaskId,
          currentActionId: third.resolutionActionId,
          version: 3
        });
        expect(unwrap(readResolutionTaskStatus(context, task.resolutionTaskId))).toBe("resolved");
        expect(
          unwrap(readResolutionActions(context, task.resolutionTaskId)).map(
            (action) => action.resolutionActionId
          )
        ).toEqual([
          "resolution-action-1",
          "resolution-action-2",
          "resolution-action-3"
        ]);
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("derives dismissed and remaining resolved statuses from the current action", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        seedUnavailableResult(context);
        seedReason(context);
        unwrap(insertResolutionTask(context, unwrap(prepareResolutionTask(taskDraft()))));
        unwrap(insertResolutionAction(context, unwrap(prepareResolutionAction(actionDraft())), 0));
        expect(unwrap(readResolutionTaskStatus(context, "resolution-task-1"))).toBe("dismissed");
        return ok(undefined);
      })
    );

    const connectionResolved = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connectionResolved, (context) => {
        seedParents(context);
        seedUnavailableResult(context);
        seedReason(context);
        unwrap(
          insertResolutionTask(
            context,
            unwrap(prepareResolutionTask(taskDraft({ resolutionTaskId: "resolution-task-block" })))
          )
        );
        unwrap(
          insertResolutionAction(
            context,
            unwrap(
              prepareResolutionAction(
                actionDraft({
                  resolutionTaskId: "resolution-task-block",
                  payload: { kind: "block", rationale: "Failed the title screen" }
                })
              )
            ),
            0
          )
        );
        expect(unwrap(readResolutionTaskStatus(context, "resolution-task-block"))).toBe("resolved");
        seedUnavailableResult(context, {
          candidateTriageResultId: "candidate-result-2",
          kind: "correction",
          supersedesResultId: "candidate-result-1"
        });
        seedReason(context, {
          candidateResultReasonId: "candidate-result-reason-2",
          candidateResultId: "candidate-result-2",
          reasonCode: "assessment_unavailable"
        });
        unwrap(
          insertResolutionTask(
            context,
            unwrap(
              prepareResolutionTask(
                taskDraft({
                  resolutionTaskId: "resolution-task-supply",
                  candidateResultId: "candidate-result-2",
                  candidateResultReasonId: "candidate-result-reason-2",
                  taskOrdinal: 0
                })
              )
            )
          )
        );
        unwrap(
          insertResolutionAction(
            context,
            unwrap(
              prepareResolutionAction(
                actionDraft({
                  resolutionActionId: "resolution-action-supply",
                  resolutionTaskId: "resolution-task-supply",
                  payload: {
                    kind: "supply_evidence_and_set_level",
                    evidenceSpanId: "evidence-span-1",
                    dimensionAssessmentId: ASSESSMENT_ID
                  }
                })
              )
            ),
            0
          )
        );
        expect(unwrap(readResolutionTaskStatus(context, "resolution-task-supply"))).toBe("resolved");
        seedUnavailableResult(context, {
          candidateTriageResultId: "candidate-result-3",
          kind: "correction",
          supersedesResultId: "candidate-result-2"
        });
        seedReason(context, {
          candidateResultReasonId: "candidate-result-reason-3",
          candidateResultId: "candidate-result-3",
          reasonCode: "assessment_unavailable"
        });
        unwrap(
          insertResolutionTask(
            context,
            unwrap(
              prepareResolutionTask(
                taskDraft({
                  resolutionTaskId: "resolution-task-parse",
                  candidateResultId: "candidate-result-3",
                  candidateResultReasonId: "candidate-result-reason-3",
                  taskOrdinal: 0
                })
              )
            )
          )
        );
        unwrap(
          insertResolutionAction(
            context,
            unwrap(
              prepareResolutionAction(
                actionDraft({
                  resolutionActionId: "resolution-action-parse",
                  resolutionTaskId: "resolution-task-parse",
                  payload: { kind: "correct_parse", rationale: "Dates were swapped" }
                })
              )
            ),
            0
          )
        );
        expect(unwrap(readResolutionTaskStatus(context, "resolution-task-parse"))).toBe("resolved");
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
    expect(connectionResolved.close().ok).toBe(true);
  });

  it("rejects missing action parents and a stale head version", async () => {
    const connection = await openMigratedDatabase();
    const action = unwrap(prepareResolutionAction(actionDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(insertResolutionAction(context, action, "1")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid expected head version" })
        });
        expect(insertResolutionAction(context, action, 0)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Resolution action requires a stored resolution task"
          })
        });
        seedParents(context);
        seedUnavailableResult(context);
        seedUnavailableResult(context, {
          candidateTriageResultId: "candidate-result-2",
          kind: "correction",
          supersedesResultId: "candidate-result-1"
        });
        seedReason(context);
        unwrap(insertResolutionTask(context, unwrap(prepareResolutionTask(taskDraft()))));
        expect(
          insertResolutionAction(
            context,
            unwrap(prepareResolutionAction(actionDraft({ actorId: "actor-missing" }))),
            0
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Resolution action requires a stored actor"
          })
        });
        expect(
          insertResolutionAction(
            context,
            unwrap(
              prepareResolutionAction(
                actionDraft({
                  payload: {
                    kind: "supply_evidence_and_set_level",
                    evidenceSpanId: "evidence-span-missing",
                    dimensionAssessmentId: ASSESSMENT_ID
                  }
                })
              )
            ),
            0
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Resolution action requires a stored evidence span"
          })
        });
        expect(
          insertResolutionAction(
            context,
            unwrap(
              prepareResolutionAction(
                actionDraft({
                  payload: {
                    kind: "confirm_judgment",
                    dimensionAssessmentId: "dimension-assessment-missing"
                  }
                })
              )
            ),
            0
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Resolution action requires a stored dimension assessment"
          })
        });
        expect(
          insertResolutionAction(
            context,
            unwrap(
              prepareResolutionAction(
                actionDraft({
                  actorId: SYSTEM_ACTOR_ID,
                  payload: {
                    kind: "reextraction_completed",
                    resultingResultId: "candidate-result-missing"
                  }
                })
              )
            ),
            0
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Resolution action requires a stored resulting candidate result"
          })
        });
        unwrap(insertResolutionAction(context, action, 0));
        expect(
          insertResolutionAction(
            context,
            unwrap(
              prepareResolutionAction(
                actionDraft({
                  resolutionActionId: "resolution-action-stale",
                  actionOrdinal: 1,
                  payload: { kind: "request_re_extraction" }
                })
              )
            ),
            2
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            code: "version_conflict",
            details: expect.objectContaining({ expectedVersion: 2, actualVersion: 1 })
          })
        });
        expect(
          insertResolutionAction(
            context,
            unwrap(
              prepareResolutionAction(
                actionDraft({
                  resolutionActionId: "resolution-action-dup",
                  payload: { kind: "request_re_extraction" }
                })
              )
            ),
            1
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Resolution action insert failed" })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("requires a command transaction and prepared action records", () => {
    const prepared = unwrap(prepareResolutionAction(actionDraft()));
    expect(insertResolutionAction(null, prepared, 0)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: ACTION_TRANSACTION_REQUIRED })
    });
    expect(readResolutionAction({}, "resolution-action-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: ACTION_TRANSACTION_REQUIRED })
    });
    expect(readResolutionActions({}, "resolution-task-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: ACTION_TRANSACTION_REQUIRED })
    });
    expect(readResolutionTaskHead({}, "resolution-task-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: HEAD_TRANSACTION_REQUIRED })
    });
    expect(readResolutionTaskStatus({}, "resolution-task-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TASK_TRANSACTION_REQUIRED })
    });
    expect(insertResolutionAction(failingContext(), prepared, 0)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Resolution action insert failed" })
    });
    expect(
      insertResolutionAction(
        failingContext((sql) => {
          if (sql.includes("resolution_task_head")) {
            throw new Error("head read boom");
          }
          return { get: () => ({}) };
        }),
        prepared,
        0
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Mutable head read failed" })
    });
    expect(
      insertResolutionAction(
        failingContext((sql) => {
          if (sql.includes("INSERT INTO") && sql.includes("resolution_task_head")) {
            throw new Error("head write boom");
          }
          return {
            get: () => (sql.includes("resolution_task_head") ? undefined : {}),
            run: () => ({ changes: 1 })
          };
        }),
        prepared,
        0
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Mutable head initialization failed" })
    });
    expect(insertResolutionAction(failingContext(), { resolutionActionId: "x" }, 0)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid prepared resolution action" })
    });
    expect(insertResolutionAction(failingContext(), prepared, -1)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid expected head version" })
    });
    expect(readResolutionAction(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid resolution action ID" })
    });
    expect(readResolutionAction(failingContext(), "resolution-action-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Resolution action read failed" })
    });
    expect(readResolutionActions(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid resolution task ID" })
    });
    expect(readResolutionActions(failingContext(), "resolution-task-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Resolution action read failed" })
    });
    expect(readResolutionTaskHead(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid resolution task ID" })
    });
    expect(readResolutionTaskHead(failingContext(), "resolution-task-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Mutable head read failed" })
    });
    expect(
      readResolutionTaskHead(
        withThrowingGetter({ nativeDatabase: { inTransaction: true } }, "nativeDatabase"),
        "resolution-task-1"
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Resolution task head read failed" })
    });
    expect(
      unwrap(
        readResolutionAction(
          {
            nativeDatabase: {
              inTransaction: true,
              prepare() {
                return { get: () => undefined };
              }
            }
          },
          "resolution-action-1"
        )
      )
    ).toBeUndefined();
    expect(
      unwrap(
        readResolutionActions(
          {
            nativeDatabase: {
              inTransaction: true,
              prepare() {
                return { all: () => [] };
              }
            }
          },
          "resolution-task-1"
        )
      )
    ).toEqual([]);
  });
});

describe("resolution schema checks and immutability", () => {
  it("declares STRICT tables and rejects replace, update, and delete", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const task = unwrap(prepareResolutionTask(taskDraft()));
    const action = unwrap(prepareResolutionAction(actionDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        seedUnavailableResult(context);
        seedReason(context);
        unwrap(insertResolutionTask(context, task));
        unwrap(insertResolutionAction(context, action, 0));
        return ok(undefined);
      })
    );
    expect(
      database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(
        "resolution_task"
      )
    ).toEqual({ sql: expect.stringContaining("STRICT") });
    expect(
      database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(
        "resolution_action"
      )
    ).toEqual({ sql: expect.stringContaining("STRICT") });
    expect(
      database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(
        "resolution_task_head"
      )
    ).toEqual({ sql: expect.stringContaining("STRICT") });
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO resolution_task (
            resolution_task_id, candidate_result_id, candidate_result_reason_id, task_ordinal, created_at
          ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          task.resolutionTaskId,
          task.candidateResultId,
          task.candidateResultReasonId,
          task.taskOrdinal,
          CREATED_AT
        )
    ).toThrow(/immutable/u);
    expect(() =>
      database.prepare("UPDATE resolution_task SET task_ordinal = task_ordinal").run()
    ).toThrow(/immutable/u);
    expect(() => database.prepare("DELETE FROM resolution_task").run()).toThrow(/immutable/u);
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO resolution_action (
            resolution_action_id, resolution_task_id, actor_id, action_kind, action_ordinal,
            payload_json, payload_hash, evidence_span_id, dimension_assessment_id, resulting_result_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          action.resolutionActionId,
          action.resolutionTaskId,
          action.actorId,
          action.actionKind,
          action.actionOrdinal,
          action.payloadJson,
          action.payloadHash,
          action.evidenceSpanId,
          action.dimensionAssessmentId,
          action.resultingResultId,
          CREATED_AT
        )
    ).toThrow(/immutable/u);
    expect(() =>
      database.prepare("UPDATE resolution_action SET action_kind = action_kind").run()
    ).toThrow(/immutable/u);
    expect(() => database.prepare("DELETE FROM resolution_action").run()).toThrow(/immutable/u);
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO resolution_task_head (
            resolution_task_id, current_action_id, version
          ) VALUES (?, ?, ?)`
        )
        .run(task.resolutionTaskId, action.resolutionActionId, 1)
    ).toThrow(/cannot be replaced/u);
    expect(() => database.prepare("DELETE FROM resolution_task_head").run()).toThrow(
      /cannot be deleted/u
    );
    expect(() =>
      database
        .prepare("UPDATE resolution_task_head SET version = version WHERE resolution_task_id = ?")
        .run(task.resolutionTaskId)
    ).toThrow(/version must increment by 1/u);
    expect(() =>
      database
        .prepare(
          "UPDATE resolution_task_head SET resolution_task_id = resolution_task_id, version = version + 1 WHERE resolution_task_id = ?"
        )
        .run(task.resolutionTaskId)
    ).toThrow(/identity is immutable/u);
    expect(connection.close().ok).toBe(true);
  });

  it("enforces action shape, kind, and head ownership CHECKs", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        seedUnavailableResult(context);
        seedReason(context);
        unwrap(insertResolutionTask(context, unwrap(prepareResolutionTask(taskDraft()))));
        seedUnavailableResult(context, {
          candidateTriageResultId: "candidate-result-2",
          kind: "correction",
          supersedesResultId: "candidate-result-1"
        });
        seedReason(context, {
          candidateResultReasonId: "candidate-result-reason-2",
          candidateResultId: "candidate-result-2",
          reasonCode: "assessment_unavailable"
        });
        unwrap(
          insertResolutionTask(
            context,
            unwrap(
              prepareResolutionTask(
                taskDraft({
                  resolutionTaskId: "resolution-task-2",
                  candidateResultId: "candidate-result-2",
                  candidateResultReasonId: "candidate-result-reason-2",
                  taskOrdinal: 0
                })
              )
            )
          )
        );
        unwrap(
          insertResolutionAction(context, unwrap(prepareResolutionAction(actionDraft())), 0)
        );
        return ok(undefined);
      })
    );
    const insertAction = database.prepare(
      `INSERT INTO resolution_action (
        resolution_action_id, resolution_task_id, actor_id, action_kind, action_ordinal,
        payload_json, payload_hash, evidence_span_id, dimension_assessment_id, resulting_result_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const hash = "a".repeat(64);
    expect(() =>
      insertAction.run(
        "resolution-action-bad-kind",
        "resolution-task-1",
        "actor-recruiter-1",
        "approve",
        1,
        "{}",
        hash,
        null,
        null,
        null,
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    expect(() =>
      insertAction.run(
        "resolution-action-human-system",
        "resolution-task-1",
        SYSTEM_ACTOR_ID,
        "dismiss",
        1,
        '{"kind":"dismiss","rationale":"no"}',
        hash,
        null,
        null,
        null,
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    expect(() =>
      insertAction.run(
        "resolution-action-missing-evidence",
        "resolution-task-1",
        "actor-recruiter-1",
        "supply_evidence_and_set_level",
        1,
        "{}",
        hash,
        null,
        ASSESSMENT_ID,
        null,
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    expect(() =>
      insertAction.run(
        "resolution-action-bad-json",
        "resolution-task-1",
        "actor-recruiter-1",
        "dismiss",
        1,
        "[]",
        hash,
        null,
        null,
        null,
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    expect(() =>
      insertAction.run(
        "resolution-action-bad-hash",
        "resolution-task-1",
        "actor-recruiter-1",
        "dismiss",
        1,
        "{}",
        "zz",
        null,
        null,
        null,
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    expect(() =>
      insertAction.run(
        "resolution-action-ordinal",
        "resolution-task-1",
        "actor-recruiter-1",
        "dismiss",
        -1,
        "{}",
        hash,
        null,
        null,
        null,
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    const insertReason = database.prepare(
      `INSERT INTO candidate_result_reason (
        candidate_result_reason_id, candidate_result_id, reason_kind, subject_id,
        reason_code, reason_ordinal, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    insertReason.run(
      "candidate-result-reason-ordinal",
      "candidate-result-1",
      "parse_failure",
      null,
      "parse_failure",
      1,
      CREATED_AT
    );
    expect(() =>
      database
        .prepare(
          `INSERT INTO resolution_task (
            resolution_task_id, candidate_result_id, candidate_result_reason_id, task_ordinal, created_at
          ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          "resolution-task-ordinal",
          "candidate-result-1",
          "candidate-result-reason-ordinal",
          -1,
          CREATED_AT
        )
    ).toThrow(/CHECK/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO resolution_task_head (resolution_task_id, current_action_id, version)
           VALUES (?, ?, ?)`
        )
        .run("resolution-task-2", "resolution-action-1", 1)
    ).toThrow(/must belong to the task/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO resolution_task_head (resolution_task_id, current_action_id, version)
           VALUES (?, ?, ?)`
        )
        .run("resolution-task-2", "resolution-action-1", 2)
    ).toThrow(/insert version must be 1|must belong to the task/u);
    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored rows whose payload or identity drifted", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const task = unwrap(prepareResolutionTask(taskDraft()));
    const action = unwrap(prepareResolutionAction(actionDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        seedUnavailableResult(context);
        seedReason(context);
        unwrap(insertResolutionTask(context, task));
        unwrap(insertResolutionAction(context, action, 0));
        return ok(undefined);
      })
    );

    rebuildTableWithoutChecks(database, "resolution_task", RESOLUTION_TASK_COLUMNS);
    database.prepare("UPDATE resolution_task SET task_ordinal = ?").run(-1);
    expect(
      runImmediateTransaction(connection, (context) =>
        readResolutionTask(context, task.resolutionTaskId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored resolution task is invalid" })
    });
    expect(
      runImmediateTransaction(connection, (context) =>
        readResolutionTasks(context, task.candidateResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored resolution task is invalid" })
    });

    rebuildTableWithoutChecks(database, "resolution_action", RESOLUTION_ACTION_COLUMNS, [
      "resolution_action_reject_replace"
    ]);
    database.prepare("UPDATE resolution_action SET payload_json = ?").run("{");
    expect(
      runImmediateTransaction(connection, (context) =>
        readResolutionAction(context, action.resolutionActionId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored resolution action payload is not valid JSON"
      })
    });
    const pretty = '{\n  "kind": "dismiss",\n  "rationale": "Duplicate of 0002"\n}';
    database
      .prepare("UPDATE resolution_action SET payload_json = ?, payload_hash = ?")
      .run(pretty, sha256Hex(pretty));
    expect(
      runImmediateTransaction(connection, (context) =>
        readResolutionAction(context, action.resolutionActionId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored resolution action failed integrity validation"
      })
    });
    expect(
      runImmediateTransaction(connection, (context) =>
        readResolutionActions(context, action.resolutionTaskId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored resolution action failed integrity validation"
      })
    });
    const canonical = action.payloadJson;
    database
      .prepare("UPDATE resolution_action SET payload_json = ?, payload_hash = ?")
      .run(canonical, "b".repeat(64));
    expect(
      runImmediateTransaction(connection, (context) =>
        readResolutionAction(context, action.resolutionActionId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored resolution action failed integrity validation"
      })
    });
    database
      .prepare("UPDATE resolution_action SET payload_json = ?, payload_hash = ?, action_kind = ?")
      .run(canonical, sha256Hex(canonical), "block");
    expect(
      runImmediateTransaction(connection, (context) =>
        readResolutionAction(context, action.resolutionActionId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored resolution action failed integrity validation"
      })
    });
    database
      .prepare(
        "UPDATE resolution_action SET payload_json = ?, payload_hash = ?, action_kind = ?, actor_id = ?"
      )
      .run(canonical, sha256Hex(canonical), "dismiss", SYSTEM_ACTOR_ID);
    expect(
      runImmediateTransaction(connection, (context) =>
        readResolutionAction(context, action.resolutionActionId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored resolution action failed integrity validation"
      })
    });
    database
      .prepare(
        "UPDATE resolution_action SET payload_json = ?, payload_hash = ?, action_kind = ?, actor_id = ?, evidence_span_id = ?"
      )
      .run(canonical, sha256Hex(canonical), "dismiss", "actor-recruiter-1", "evidence-span-1");
    expect(
      runImmediateTransaction(connection, (context) =>
        readResolutionAction(context, action.resolutionActionId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored resolution action failed integrity validation"
      })
    });
    database
      .prepare(
        "UPDATE resolution_action SET payload_json = ?, payload_hash = ?, action_kind = ?, action_ordinal = ?"
      )
      .run(canonical, sha256Hex(canonical), "dismiss", -1);
    expect(
      runImmediateTransaction(connection, (context) =>
        readResolutionAction(context, action.resolutionActionId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored resolution action is invalid" })
    });

    rebuildTableWithoutChecks(database, "resolution_task_head", RESOLUTION_TASK_HEAD_COLUMNS, [
      "resolution_task_head_reject_replace",
      "resolution_task_head_insert_version",
      "resolution_task_head_insert_action_owner",
      "resolution_task_head_update_identity",
      "resolution_task_head_update_version",
      "resolution_task_head_update_action_owner"
    ]);
    database
      .prepare("UPDATE resolution_task_head SET current_action_id = ?")
      .run("x".repeat(150));
    expect(
      runImmediateTransaction(connection, (context) =>
        readResolutionTaskHead(context, task.resolutionTaskId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored resolution task head is invalid" })
    });
    expect(connection.close().ok).toBe(true);
  });

  it("treats a head pointer to a missing action as an integrity failure", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const task = unwrap(prepareResolutionTask(taskDraft()));
    const action = unwrap(prepareResolutionAction(actionDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        seedUnavailableResult(context);
        seedReason(context);
        unwrap(insertResolutionTask(context, task));
        unwrap(insertResolutionAction(context, action, 0));
        return ok(undefined);
      })
    );
    rebuildTableWithoutChecks(database, "resolution_action", RESOLUTION_ACTION_COLUMNS);
    database.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM resolution_action;
      PRAGMA foreign_keys = ON;
    `);
    expect(
      runImmediateTransaction(connection, (context) =>
        readResolutionTaskStatus(context, task.resolutionTaskId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Resolution task head current_action_id must belong to the task"
      })
    });
    expect(connection.close().ok).toBe(true);
  });

  it("surfaces a corrupt task head when deriving status", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const task = unwrap(prepareResolutionTask(taskDraft()));
    const action = unwrap(prepareResolutionAction(actionDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        seedUnavailableResult(context);
        seedReason(context);
        unwrap(insertResolutionTask(context, task));
        unwrap(insertResolutionAction(context, action, 0));
        return ok(undefined);
      })
    );
    rebuildTableWithoutChecks(database, "resolution_task_head", RESOLUTION_TASK_HEAD_COLUMNS, [
      "resolution_task_head_reject_replace",
      "resolution_task_head_insert_version",
      "resolution_task_head_insert_action_owner",
      "resolution_task_head_update_identity",
      "resolution_task_head_update_version",
      "resolution_task_head_update_action_owner"
    ]);
    database
      .prepare("UPDATE resolution_task_head SET current_action_id = ?")
      .run("x".repeat(150));
    expect(
      runImmediateTransaction(connection, (context) =>
        readResolutionTaskStatus(context, task.resolutionTaskId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored resolution task head is invalid" })
    });
    expect(connection.close().ok).toBe(true);
  });

  it("surfaces a corrupt current action when deriving status", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const task = unwrap(prepareResolutionTask(taskDraft()));
    const action = unwrap(prepareResolutionAction(actionDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        seedUnavailableResult(context);
        seedReason(context);
        unwrap(insertResolutionTask(context, task));
        unwrap(insertResolutionAction(context, action, 0));
        return ok(undefined);
      })
    );
    rebuildTableWithoutChecks(database, "resolution_action", RESOLUTION_ACTION_COLUMNS, [
      "resolution_action_reject_replace"
    ]);
    database.prepare("UPDATE resolution_action SET payload_json = ?").run("{");
    expect(
      runImmediateTransaction(connection, (context) =>
        readResolutionTaskStatus(context, task.resolutionTaskId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored resolution action payload is not valid JSON"
      })
    });
    expect(connection.close().ok).toBe(true);
  });
});
