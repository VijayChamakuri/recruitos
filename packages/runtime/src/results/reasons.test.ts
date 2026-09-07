import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeAggregateScore,
  computeConfidence,
  DRAFT_RUBRIC_V1,
  formatRational,
  ok,
  type Result
} from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runImmediateTransaction, type ImmediateTransactionContext } from "../commands/index.js";
import { openRuntimeDatabase, type RuntimeDatabaseConnection } from "../db/index.js";
import {
  insertActor,
  insertCandidate,
  insertSourceDocument,
  prepareActor,
  prepareCandidate,
  prepareSourceDocument
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
  insertCandidateTriageResult,
  prepareCandidateResultReason,
  prepareCandidateTriageResult,
  readCandidateResultReason,
  readCandidateResultReasons
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const DOCUMENT_TEXT = "ABCDEFGHIJ";
const TRANSACTION_REQUIRED =
  "Candidate result reason rows require an active command transaction";
const RUBRIC_DIMENSIONS = DRAFT_RUBRIC_V1.dimensions.map((dimension) => dimension.dimensionId);

const CANDIDATE_RESULT_REASON_COLUMNS = `
  candidate_result_reason_id text PRIMARY KEY NOT NULL,
  candidate_result_id text NOT NULL,
  reason_kind text NOT NULL,
  subject_id text,
  reason_code text NOT NULL,
  reason_ordinal integer NOT NULL,
  created_at integer NOT NULL
`;

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-reasons-test-"));
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
      DRAFT_RUBRIC_V1.dimensions.map((dimension) => ({
        dimensionId: dimension.dimensionId,
        level: "none" as const
      })),
      DRAFT_RUBRIC_V1
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

function unavailableResultDraft(overrides: Record<string, unknown> = {}) {
  return {
    candidateTriageResultId: "candidate-result-1",
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
    createdAt: CREATED_AT,
    ...overrides
  };
}

function completeResultDraft(overrides: Record<string, unknown> = {}) {
  return {
    candidateTriageResultId: "candidate-result-1",
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
    createdAt: CREATED_AT,
    ...overrides
  };
}

function reasonDraft(overrides: Record<string, unknown> = {}) {
  return {
    candidateResultReasonId: "candidate-result-reason-1",
    candidateResultId: "candidate-result-1",
    reasonCode: "parse_failure",
    reasonOrdinal: 0,
    createdAt: CREATED_AT,
    ...overrides
  };
}

function seedParents(context: ImmediateTransactionContext): void {
  unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
  unwrap(insertSourceDocument(context, unwrap(prepareSourceDocument(sourceDocumentDraft()))));
  unwrap(insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft()))));
  unwrap(insertActor(context, unwrap(prepareActor(actorDraft()))));
}

function seedRichParents(context: ImmediateTransactionContext): void {
  seedParents(context);
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
  for (const dimension of DRAFT_RUBRIC_V1.dimensions) {
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
  columns: string
): void {
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS ${table}_reject_update;
    DROP TRIGGER IF EXISTS ${table}_reject_delete;
    DROP TRIGGER IF EXISTS ${table}_reject_replace;
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

describe("candidate result reason preparation", () => {
  it("denormalizes kind and subject from the closed formatted string", () => {
    const parameterized = unwrap(
      prepareCandidateResultReason(
        reasonDraft({ reasonCode: "missing_evidence:evaluation_and_measurement" })
      )
    );
    expect(parameterized.reasonKind).toBe("missing_evidence");
    expect(parameterized.subjectId).toBe("evaluation_and_measurement");
    expect(parameterized.reasonCode).toBe("missing_evidence:evaluation_and_measurement");
    expect(Object.isFrozen(parameterized)).toBe(true);

    const unavailable = unwrap(
      prepareCandidateResultReason(reasonDraft({ reasonCode: "assessment_unavailable" }))
    );
    expect(unavailable.reasonKind).toBe("assessment_unavailable");
    expect(unavailable.subjectId).toBeNull();
  });

  it("rejects unknown codes, extra keys, and hostile drafts", () => {
    expect(prepareCandidateResultReason(reasonDraft({ reasonCode: "unknown_kind" }))).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate result reason code is not in the closed vocabulary"
      })
    });
    expect(prepareCandidateResultReason(reasonDraft({ reasonCode: "missing_evidence" }))).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate result reason code is not in the closed vocabulary"
      })
    });
    expect(prepareCandidateResultReason({ ...reasonDraft(), extra: true })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate result reason input" })
    });
    expect(prepareCandidateResultReason(withThrowingGetter(reasonDraft(), "reasonCode"))).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate result reason preparation failed"
      })
    });
  });
});

describe("candidate result reason persistence", () => {
  it("stores an unavailable diagnostic and lists complete reasons by precedence", async () => {
    const connection = await openMigratedDatabase();
    const unavailable = unwrap(
      prepareCandidateResultReason(reasonDraft({ reasonCode: "assessment_unavailable" }))
    );
    const storedUnavailable = unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
        unwrap(
          insertCandidateTriageResult(
            context,
            unwrap(prepareCandidateTriageResult(unavailableResultDraft()))
          )
        );
        unwrap(insertCandidateResultReason(context, unavailable));
        return readCandidateResultReason(context, unavailable.candidateResultReasonId);
      })
    );
    expect(storedUnavailable).toEqual(unavailable);
    expect(
      unwrap(
        runImmediateTransaction(connection, (context) =>
          readCandidateResultReasons(context, "candidate-result-1")
        )
      )
    ).toEqual([unavailable]);

    const connectionComplete = await openMigratedDatabase();
    const lowConfidence = unwrap(
      prepareCandidateResultReason(
        reasonDraft({
          candidateResultReasonId: "candidate-result-reason-low",
          reasonCode: "low_confidence",
          reasonOrdinal: 0,
          createdAt: CREATED_AT + 2
        })
      )
    );
    const missingLater = unwrap(
      prepareCandidateResultReason(
        reasonDraft({
          candidateResultReasonId: "candidate-result-reason-missing-b",
          reasonCode: "missing_evidence:work_authorization",
          reasonOrdinal: 1,
          createdAt: CREATED_AT + 5
        })
      )
    );
    const missingEarlier = unwrap(
      prepareCandidateResultReason(
        reasonDraft({
          candidateResultReasonId: "candidate-result-reason-missing-a",
          reasonCode: "missing_evidence:evaluation_and_measurement",
          reasonOrdinal: 2,
          createdAt: CREATED_AT + 1
        })
      )
    );
    const listed = unwrap(
      runImmediateTransaction(connectionComplete, (context) => {
        seedRichParents(context);
        unwrap(
          insertCandidateTriageResult(
            context,
            unwrap(prepareCandidateTriageResult(completeResultDraft()))
          )
        );
        unwrap(insertCandidateResultReason(context, lowConfidence));
        unwrap(insertCandidateResultReason(context, missingLater));
        unwrap(insertCandidateResultReason(context, missingEarlier));
        return readCandidateResultReasons(context, "candidate-result-1");
      })
    );
    expect(listed.map((reason) => reason.reasonCode)).toEqual([
      "missing_evidence:evaluation_and_measurement",
      "missing_evidence:work_authorization",
      "low_confidence"
    ]);
    expect(connection.close().ok).toBe(true);
    expect(connectionComplete.close().ok).toBe(true);
  });

  it("rejects availability mismatches, missing parents, and duplicates", async () => {
    const connection = await openMigratedDatabase();
    const unavailableReason = unwrap(
      prepareCandidateResultReason(reasonDraft({ reasonCode: "assessment_unavailable" }))
    );
    const parseFailure = unwrap(prepareCandidateResultReason(reasonDraft()));
    const duplicateKind = unwrap(
      prepareCandidateResultReason(
        reasonDraft({
          candidateResultReasonId: "candidate-result-reason-2",
          reasonOrdinal: 1
        })
      )
    );
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(insertCandidateResultReason(context, parseFailure)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate result reason requires a stored candidate result"
          })
        });
        unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
        unwrap(
          insertCandidateTriageResult(
            context,
            unwrap(prepareCandidateTriageResult(unavailableResultDraft()))
          )
        );
        expect(insertCandidateResultReason(context, parseFailure)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Unavailable results only accept the assessment_unavailable reason"
          })
        });
        unwrap(insertCandidateResultReason(context, unavailableReason));
        return ok(undefined);
      })
    );

    const connectionComplete = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connectionComplete, (context) => {
        seedRichParents(context);
        unwrap(
          insertCandidateTriageResult(
            context,
            unwrap(prepareCandidateTriageResult(completeResultDraft()))
          )
        );
        expect(insertCandidateResultReason(context, unavailableReason)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "assessment_unavailable is only valid on unavailable results"
          })
        });
        unwrap(insertCandidateResultReason(context, parseFailure));
        expect(insertCandidateResultReason(context, duplicateKind)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate result reason insert failed"
          })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
    expect(connectionComplete.close().ok).toBe(true);
  });

  it("requires a command transaction and prepared records", () => {
    const prepared = unwrap(prepareCandidateResultReason(reasonDraft()));
    expect(insertCandidateResultReason({}, prepared)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
    });
    expect(insertCandidateResultReason({ nativeDatabase: null }, prepared)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
    });
    expect(
      insertCandidateResultReason(
        { nativeDatabase: { inTransaction: false } },
        prepared
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
    });
    expect(readCandidateResultReason({}, "candidate-result-reason-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
    });
    expect(readCandidateResultReasons({}, "candidate-result-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
    });
    expect(insertCandidateResultReason(failingContext(), prepared)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate result reason insert failed" })
    });
    expect(
      insertCandidateResultReason(failingContext(), { candidateResultReasonId: "x" })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Invalid prepared candidate result reason"
      })
    });
    expect(readCandidateResultReason(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate result reason ID" })
    });
    expect(readCandidateResultReason(failingContext(), "candidate-result-reason-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate result reason read failed" })
    });
    expect(readCandidateResultReasons(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate result ID" })
    });
    expect(readCandidateResultReasons(failingContext(), "candidate-result-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate result reason read failed" })
    });
  });

  it("returns undefined or an empty list when no reason row exists", async () => {
    const connection = await openMigratedDatabase();
    const missing = unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
        unwrap(
          insertCandidateTriageResult(
            context,
            unwrap(prepareCandidateTriageResult(unavailableResultDraft()))
          )
        );
        return readCandidateResultReason(context, "candidate-result-reason-1");
      })
    );
    expect(missing).toBeUndefined();
    expect(
      unwrap(
        runImmediateTransaction(connection, (context) =>
          readCandidateResultReasons(context, "candidate-result-1")
        )
      )
    ).toEqual([]);
    expect(connection.close().ok).toBe(true);
  });
});

describe("candidate result reason schema checks and immutability", () => {
  it("declares the reason table STRICT and rejects replace, update, and delete", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const reason = unwrap(
      prepareCandidateResultReason(reasonDraft({ reasonCode: "assessment_unavailable" }))
    );
    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
        unwrap(
          insertCandidateTriageResult(
            context,
            unwrap(prepareCandidateTriageResult(unavailableResultDraft()))
          )
        );
        unwrap(insertCandidateResultReason(context, reason));
        return ok(undefined);
      })
    );
    expect(
      database
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("candidate_result_reason")
    ).toEqual({ sql: expect.stringContaining("STRICT") });
    expect(() =>
      database
        .prepare(
          `INSERT INTO candidate_result_reason (
            candidate_result_reason_id, candidate_result_id, reason_kind, subject_id,
            reason_code, reason_ordinal, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          reason.candidateResultReasonId,
          reason.candidateResultId,
          reason.reasonKind,
          reason.subjectId,
          reason.reasonCode,
          reason.reasonOrdinal,
          CREATED_AT
        )
    ).toThrow(/immutable/u);
    expect(() =>
      database.prepare("UPDATE candidate_result_reason SET reason_code = reason_code").run()
    ).toThrow(/immutable/u);
    expect(() => database.prepare("DELETE FROM candidate_result_reason").run()).toThrow(
      /immutable/u
    );
    expect(connection.close().ok).toBe(true);
  });

  it("enforces kind, subject, and reason-code CHECKs", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
        unwrap(
          insertCandidateTriageResult(
            context,
            unwrap(prepareCandidateTriageResult(unavailableResultDraft()))
          )
        );
        return ok(undefined);
      })
    );
    const insert = database.prepare(
      `INSERT INTO candidate_result_reason (
        candidate_result_reason_id, candidate_result_id, reason_kind, subject_id,
        reason_code, reason_ordinal, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    expect(() =>
      insert.run(
        "candidate-result-reason-bad-kind",
        "candidate-result-1",
        "not_a_reason",
        null,
        "not_a_reason",
        0,
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    expect(() =>
      insert.run(
        "candidate-result-reason-subject",
        "candidate-result-1",
        "parse_failure",
        "extra",
        "parse_failure:extra",
        0,
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    expect(() =>
      insert.run(
        "candidate-result-reason-missing-subject",
        "candidate-result-1",
        "missing_evidence",
        null,
        "missing_evidence",
        0,
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    expect(() =>
      insert.run(
        "candidate-result-reason-code-mismatch",
        "candidate-result-1",
        "assessment_unavailable",
        null,
        "parse_failure",
        0,
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    expect(() =>
      insert.run(
        "candidate-result-reason-ordinal",
        "candidate-result-1",
        "assessment_unavailable",
        null,
        "assessment_unavailable",
        -1,
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored reasons whose denormalized identity drifted", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const reason = unwrap(
      prepareCandidateResultReason(reasonDraft({ reasonCode: "assessment_unavailable" }))
    );
    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
        unwrap(
          insertCandidateTriageResult(
            context,
            unwrap(prepareCandidateTriageResult(unavailableResultDraft()))
          )
        );
        unwrap(insertCandidateResultReason(context, reason));
        return ok(undefined);
      })
    );
    rebuildTableWithoutChecks(
      database,
      "candidate_result_reason",
      CANDIDATE_RESULT_REASON_COLUMNS
    );
    database
      .prepare("UPDATE candidate_result_reason SET reason_code = ?")
      .run("unknown_kind");
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateResultReason(context, reason.candidateResultReasonId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored candidate result reason is invalid"
      })
    });
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateResultReasons(context, reason.candidateResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored candidate result reason is invalid"
      })
    });
    database
      .prepare("UPDATE candidate_result_reason SET reason_code = ?, reason_kind = ?")
      .run("parse_failure", "low_confidence");
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateResultReason(context, reason.candidateResultReasonId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored candidate result reason failed integrity validation"
      })
    });
    database
      .prepare(
        "UPDATE candidate_result_reason SET reason_code = ?, reason_kind = ?, subject_id = ?"
      )
      .run("missing_evidence:evaluation_and_measurement", "missing_evidence", "other_subject");
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateResultReason(context, reason.candidateResultReasonId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored candidate result reason failed integrity validation"
      })
    });
    database
      .prepare(
        "UPDATE candidate_result_reason SET reason_code = ?, reason_kind = ?, subject_id = ?, reason_ordinal = ?"
      )
      .run("assessment_unavailable", "assessment_unavailable", null, -1);
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateResultReason(context, reason.candidateResultReasonId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored candidate result reason is invalid"
      })
    });
    expect(connection.close().ok).toBe(true);
  });
});
