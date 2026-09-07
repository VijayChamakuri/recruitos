import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJsonStringify,
  computeAggregateScore,
  computeConfidence,
  DRAFT_RUBRIC_V1,
  formatRational,
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
  hashCandidateTriageResultContent,
  hashScoreResultContent,
  insertCandidateTriageResult,
  prepareCandidateTriageResult,
  readCandidateTriageResult,
  readCandidateTriageResultByContentHash,
  validateCandidateTriageResultContent,
  type ScoreResult
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const DOCUMENT_TEXT = "ABCDEFGHIJ";
const TRANSACTION_REQUIRED = "Candidate result rows require an active command transaction";
const RUBRIC_DIMENSIONS = DRAFT_RUBRIC_V1.dimensions.map((dimension) => dimension.dimensionId);

const CANDIDATE_TRIAGE_RESULT_COLUMNS = `
  candidate_triage_result_id text PRIMARY KEY NOT NULL,
  candidate_id text NOT NULL,
  kind text NOT NULL,
  availability text NOT NULL,
  status text NOT NULL,
  supersedes_result_id text,
  content_json text NOT NULL,
  content_hash text NOT NULL,
  created_at integer NOT NULL
`;

const SCORE_RESULT_COLUMNS = `
  score_result_id text PRIMARY KEY NOT NULL,
  candidate_result_id text NOT NULL,
  aggregate_text text NOT NULL,
  confidence_text text NOT NULL,
  aggregate_basis_points integer NOT NULL,
  confidence_basis_points integer NOT NULL,
  content_json text NOT NULL,
  content_hash text NOT NULL,
  created_at integer NOT NULL
`;

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-results-test-"));
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

function titlePayload(title = "Staff Engineer") {
  return { kind: "current_title", title };
}

function factDraft(overrides: Record<string, unknown> = {}) {
  return {
    structuredFactId: "structured-fact-1",
    candidateId: "candidate-1",
    payload: titlePayload(),
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

function noneLevelAssessments() {
  return DRAFT_RUBRIC_V1.dimensions.map((dimension) => ({
    dimensionId: dimension.dimensionId,
    level: "none" as const
  }));
}

function placeholderContributions(dimensionIds: readonly string[]) {
  return dimensionIds.map((dimensionId) => ({
    dimensionId,
    level: "none" as const,
    levelValue: "0/1",
    weight: 1,
    weightedValue: "0/1"
  }));
}

function computedScoreDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const computation = unwrap(computeAggregateScore(noneLevelAssessments(), DRAFT_RUBRIC_V1));
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

function resultGapDraft(dimensionId: string) {
  return {
    candidateResultEvidenceGapId: `candidate-result-gap-${dimensionId}`,
    evidenceGapId: `evidence-gap-${dimensionId}`,
    dimensionId
  };
}

function resultAssessmentDraft(dimensionId: string) {
  return {
    candidateResultDimensionAssessmentId: `candidate-result-assessment-${dimensionId}`,
    dimensionAssessmentId: `dimension-assessment-${dimensionId}`,
    dimensionId
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
    status: "scored",
    supersedesResultId: null,
    evidenceSpans: [
      {
        candidateResultEvidenceSpanId: "candidate-result-span-1",
        evidenceSpanId: "evidence-span-1"
      }
    ],
    evidenceGaps: RUBRIC_DIMENSIONS.map(resultGapDraft),
    dimensionAssessments: RUBRIC_DIMENSIONS.map(resultAssessmentDraft),
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

function seedParents(context: ImmediateTransactionContext): void {
  unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
  unwrap(insertSourceDocument(context, unwrap(prepareSourceDocument(sourceDocumentDraft()))));
  unwrap(insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft()))));
  unwrap(insertActor(context, unwrap(prepareActor(actorDraft()))));
}

function seedTwoTitleFacts(context: ImmediateTransactionContext): void {
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
            payload: titlePayload("Principal Engineer"),
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
}

function seedRubricChildren(context: ImmediateTransactionContext): void {
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
}

function seedRichParents(context: ImmediateTransactionContext): void {
  seedTwoTitleFacts(context);
  seedRubricChildren(context);
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

describe("candidate result preparation", () => {
  it("hashes complete-result identity independently of authoring key order", () => {
    const reversedDimensions = [...RUBRIC_DIMENSIONS].reverse();
    const scoreDraft = computedScoreDraft();
    const reversedContributions = Array.isArray(scoreDraft.contributions)
      ? [...scoreDraft.contributions].reverse()
      : [];
    const result = unwrap(
      prepareCandidateTriageResult(
        completeResultDraft({
          evidenceSpans: [
            {
              candidateResultEvidenceSpanId: "candidate-result-span-1",
              evidenceSpanId: "evidence-span-1"
            }
          ],
          evidenceGaps: reversedDimensions.map(resultGapDraft),
          dimensionAssessments: reversedDimensions.map(resultAssessmentDraft),
          score: computedScoreDraft({
            contributions: reversedContributions
          })
        })
      )
    );
    expect(result.availability).toBe("complete");
    expect(result.status).toBe("scored");
    expect(result.score?.aggregateText).toBe("0/1");
    expect(result.score?.confidenceText).toBe("0/1");
    expect(result.score?.aggregateBasisPoints).toBe(0);
    expect(result.score?.confidenceBasisPoints).toBe(0);
    expect(result.contentHash).toBe(
      unwrap(
        hashCandidateTriageResultContent({
          availability: "complete",
          candidateId: "candidate-1",
          dimensionAssessmentIds: result.dimensionAssessments.map(
            (assessment) => assessment.dimensionAssessmentId
          ),
          evidenceGapIds: result.evidenceGaps.map((gap) => gap.evidenceGapId),
          evidenceSpanIds: ["evidence-span-1"],
          factConflictIds: ["fact-conflict-1"],
          hardRequirementAssessmentIds: ["hard-requirement-assessment-1"],
          kind: "initial",
          status: "scored",
          structuredFactIds: ["structured-fact-1"],
          supersedesResultId: null
        })
      )
    );
    expect(result.score).not.toBeNull();
    if (result.score !== null) {
      expect(result.score.contentHash).toBe(unwrap(hashScoreResultContent(result.score.content)));
    }
    const canonical = canonicalJsonStringify(JSON.parse(result.contentJson));
    expect(canonical.ok).toBe(true);
    if (canonical.ok) {
      expect(result.contentJson).toBe(canonical.value);
    }
    expect(Object.isFrozen(result)).toBe(true);
    expect(
      unwrap(
        validateCandidateTriageResultContent({
          availability: "complete",
          candidateId: "candidate-1",
          dimensionAssessmentIds: [
            "dimension-assessment-communication_of_reasoning",
            "dimension-assessment-ambiguity_and_ownership"
          ],
          evidenceGapIds: ["evidence-gap-1", "evidence-gap-1"],
          evidenceSpanIds: ["evidence-span-2", "evidence-span-1"],
          factConflictIds: [],
          hardRequirementAssessmentIds: [],
          kind: "initial",
          status: "scored",
          structuredFactIds: [],
          supersedesResultId: null
        })
      ).evidenceSpanIds
    ).toEqual(["evidence-span-1", "evidence-span-2"]);
  });

  it("rejects lineage, availability, uniqueness, and hostile drafts", () => {
    expect(
      prepareCandidateTriageResult(
        unavailableResultDraft({ kind: "correction", supersedesResultId: null })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message:
          "Correction results require a superseded result and initial results forbid one"
      })
    });
    expect(
      prepareCandidateTriageResult(
        unavailableResultDraft({ kind: "initial", supersedesResultId: "candidate-result-0" })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message:
          "Correction results require a superseded result and initial results forbid one"
      })
    });
    expect(
      prepareCandidateTriageResult(unavailableResultDraft({ status: "scored" }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Unavailable results must be escalated" })
    });
    expect(
      prepareCandidateTriageResult(
        unavailableResultDraft({ score: computedScoreDraft() })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Unavailable results must not include a score"
      })
    });
    expect(
      prepareCandidateTriageResult(completeResultDraft({ score: null }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Complete results require a score" })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          dimensionAssessments: RUBRIC_DIMENSIONS.slice(0, 5).map(resultAssessmentDraft)
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Complete results require six dimension assessments"
      })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          evidenceSpans: [
            {
              candidateResultEvidenceSpanId: "candidate-result-span-1",
              evidenceSpanId: "evidence-span-1"
            },
            {
              candidateResultEvidenceSpanId: "candidate-result-span-2",
              evidenceSpanId: "evidence-span-1"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate result evidence spans must be unique"
      })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          evidenceSpans: [
            {
              candidateResultEvidenceSpanId: "candidate-result-span-1",
              evidenceSpanId: "evidence-span-1"
            },
            {
              candidateResultEvidenceSpanId: "candidate-result-span-1",
              evidenceSpanId: "evidence-span-2"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate result evidence span IDs must be unique"
      })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          evidenceGaps: [
            resultGapDraft("applied_ml_llm_systems"),
            {
              candidateResultEvidenceGapId: "candidate-result-gap-dup",
              evidenceGapId: "evidence-gap-applied_ml_llm_systems",
              dimensionId: "production_software_engineering"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate result evidence gaps must be unique"
      })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          evidenceGaps: [
            resultGapDraft("applied_ml_llm_systems"),
            {
              ...resultGapDraft("production_software_engineering"),
              candidateResultEvidenceGapId: "candidate-result-gap-applied_ml_llm_systems"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate result evidence gap IDs must be unique"
      })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          evidenceGaps: [
            resultGapDraft("applied_ml_llm_systems"),
            {
              candidateResultEvidenceGapId: "candidate-result-gap-other",
              evidenceGapId: "evidence-gap-other",
              dimensionId: "applied_ml_llm_systems"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate result evidence gaps must be unique by dimension"
      })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          dimensionAssessments: [
            ...RUBRIC_DIMENSIONS.slice(0, 5).map(resultAssessmentDraft),
            {
              candidateResultDimensionAssessmentId: "candidate-result-assessment-dup",
              dimensionAssessmentId: `dimension-assessment-${RUBRIC_DIMENSIONS[0]}`,
              dimensionId: RUBRIC_DIMENSIONS[5]!
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate result dimension assessments must be unique"
      })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          dimensionAssessments: [
            ...RUBRIC_DIMENSIONS.slice(0, 5).map(resultAssessmentDraft),
            {
              candidateResultDimensionAssessmentId: `candidate-result-assessment-${RUBRIC_DIMENSIONS[0]}`,
              dimensionAssessmentId: "dimension-assessment-other",
              dimensionId: RUBRIC_DIMENSIONS[5]!
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate result dimension assessment IDs must be unique"
      })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          dimensionAssessments: [
            ...RUBRIC_DIMENSIONS.slice(0, 5).map(resultAssessmentDraft),
            {
              candidateResultDimensionAssessmentId: "candidate-result-assessment-other",
              dimensionAssessmentId: "dimension-assessment-other",
              dimensionId: RUBRIC_DIMENSIONS[0]!
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate result dimension assessments must be unique by dimension"
      })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          structuredFacts: [
            {
              candidateResultStructuredFactId: "candidate-result-fact-1",
              structuredFactId: "structured-fact-1"
            },
            {
              candidateResultStructuredFactId: "candidate-result-fact-2",
              structuredFactId: "structured-fact-1"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate result structured facts must be unique"
      })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          structuredFacts: [
            {
              candidateResultStructuredFactId: "candidate-result-fact-1",
              structuredFactId: "structured-fact-1"
            },
            {
              candidateResultStructuredFactId: "candidate-result-fact-1",
              structuredFactId: "structured-fact-2"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate result structured fact IDs must be unique"
      })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          factConflicts: [
            {
              candidateResultFactConflictId: "candidate-result-conflict-1",
              factConflictId: "fact-conflict-1"
            },
            {
              candidateResultFactConflictId: "candidate-result-conflict-2",
              factConflictId: "fact-conflict-1"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate result fact conflicts must be unique"
      })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          factConflicts: [
            {
              candidateResultFactConflictId: "candidate-result-conflict-1",
              factConflictId: "fact-conflict-1"
            },
            {
              candidateResultFactConflictId: "candidate-result-conflict-1",
              factConflictId: "fact-conflict-2"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate result fact conflict IDs must be unique"
      })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          hardRequirementAssessments: [
            {
              candidateResultHardRequirementAssessmentId: "candidate-result-requirement-1",
              hardRequirementAssessmentId: "hard-requirement-assessment-1"
            },
            {
              candidateResultHardRequirementAssessmentId: "candidate-result-requirement-2",
              hardRequirementAssessmentId: "hard-requirement-assessment-1"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate result hard requirement assessments must be unique"
      })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          hardRequirementAssessments: [
            {
              candidateResultHardRequirementAssessmentId: "candidate-result-requirement-1",
              hardRequirementAssessmentId: "hard-requirement-assessment-1"
            },
            {
              candidateResultHardRequirementAssessmentId: "candidate-result-requirement-1",
              hardRequirementAssessmentId: "hard-requirement-assessment-2"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate result hard requirement assessment IDs must be unique"
      })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          score: computedScoreDraft({
            contributions: placeholderContributions([
              "dim-a",
              "dim-a",
              "dim-c",
              "dim-d",
              "dim-e",
              "dim-f"
            ])
          })
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Score contributions must cover six unique dimensions"
      })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          score: computedScoreDraft({ aggregate: "2/4" })
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid score result content" })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          score: computedScoreDraft({ aggregate: "101/1" })
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid score result content" })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          score: computedScoreDraft({ confidence: "2/1" })
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid score result content" })
    });
    expect(
      prepareCandidateTriageResult(
        completeResultDraft({
          score: computedScoreDraft({
            contributions: placeholderContributions([
              "dim-a",
              "dim-b",
              "dim-c",
              "dim-d",
              "dim-e",
              "dim-f"
            ])
          })
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Score contributions must match the result dimension assessments"
      })
    });
    expect(prepareCandidateTriageResult(withThrowingGetter(unavailableResultDraft(), "kind"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate result preparation failed" })
    });
    expect(prepareCandidateTriageResult({ candidateTriageResultId: "candidate-result-1" })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate result input" })
    });
    expect(validateCandidateTriageResultContent({})).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate result content" })
    });
    expect(hashCandidateTriageResultContent({})).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate result content" })
    });
    expect(hashScoreResultContent({})).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid score result content" })
    });
  });

  it("orders multiple associations by child id", () => {
    const result = unwrap(
      prepareCandidateTriageResult(
        unavailableResultDraft({
          evidenceSpans: [
            {
              candidateResultEvidenceSpanId: "candidate-result-span-2",
              evidenceSpanId: "evidence-span-2"
            },
            {
              candidateResultEvidenceSpanId: "candidate-result-span-1",
              evidenceSpanId: "evidence-span-1"
            }
          ],
          structuredFacts: [
            {
              candidateResultStructuredFactId: "candidate-result-fact-2",
              structuredFactId: "structured-fact-2"
            },
            {
              candidateResultStructuredFactId: "candidate-result-fact-1",
              structuredFactId: "structured-fact-1"
            }
          ],
          factConflicts: [
            {
              candidateResultFactConflictId: "candidate-result-conflict-2",
              factConflictId: "fact-conflict-2"
            },
            {
              candidateResultFactConflictId: "candidate-result-conflict-1",
              factConflictId: "fact-conflict-1"
            }
          ],
          hardRequirementAssessments: [
            {
              candidateResultHardRequirementAssessmentId: "candidate-result-requirement-2",
              hardRequirementAssessmentId: "hard-requirement-assessment-2"
            },
            {
              candidateResultHardRequirementAssessmentId: "candidate-result-requirement-1",
              hardRequirementAssessmentId: "hard-requirement-assessment-1"
            }
          ]
        })
      )
    );
    expect(result.evidenceSpans.map((span) => span.evidenceSpanId)).toEqual([
      "evidence-span-1",
      "evidence-span-2"
    ]);
    expect(result.structuredFacts.map((fact) => fact.structuredFactId)).toEqual([
      "structured-fact-1",
      "structured-fact-2"
    ]);
    expect(result.factConflicts.map((conflict) => conflict.factConflictId)).toEqual([
      "fact-conflict-1",
      "fact-conflict-2"
    ]);
    expect(
      result.hardRequirementAssessments.map(
        (assessment) => assessment.hardRequirementAssessmentId
      )
    ).toEqual(["hard-requirement-assessment-1", "hard-requirement-assessment-2"]);
  });
});

describe("candidate result persistence", () => {
  it("round-trips an unavailable result and looks it up by content hash", async () => {
    const connection = await openMigratedDatabase();
    const result = unwrap(prepareCandidateTriageResult(unavailableResultDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
        unwrap(insertCandidateTriageResult(context, result));
        expect(unwrap(readCandidateTriageResult(context, result.candidateTriageResultId))).toEqual(
          result
        );
        expect(
          unwrap(readCandidateTriageResultByContentHash(context, result.contentHash))
        ).toEqual(result);
        expect(
          unwrap(readCandidateTriageResult(context, "candidate-result-missing"))
        ).toBeUndefined();
        expect(
          unwrap(readCandidateTriageResultByContentHash(context, sha256Hex("missing-result")))
        ).toBeUndefined();
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("round-trips a complete scored result with associations and a derived score", async () => {
    const connection = await openMigratedDatabase();
    const result = unwrap(
      prepareCandidateTriageResult(completeResultDraft({ status: "escalated" }))
    );
    expect(result.status).toBe("escalated");
    expect(result.dimensionAssessments).toHaveLength(6);
    expect(result.score?.content.contributions).toHaveLength(6);
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRichParents(context);
        unwrap(insertCandidateTriageResult(context, result));
        expect(unwrap(readCandidateTriageResult(context, result.candidateTriageResultId))).toEqual(
          result
        );
        expect(
          unwrap(readCandidateTriageResultByContentHash(context, result.contentHash))
        ).toEqual(result);
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("stores a correction that supersedes a prior result for the same candidate", async () => {
    const connection = await openMigratedDatabase();
    const initial = unwrap(prepareCandidateTriageResult(unavailableResultDraft()));
    const correction = unwrap(
      prepareCandidateTriageResult(
        completeResultDraft({
          candidateTriageResultId: "candidate-result-2",
          kind: "correction",
          status: "rejected_hard_requirement",
          supersedesResultId: "candidate-result-1",
          score: computedScoreDraft({ scoreResultId: "score-result-2" })
        })
      )
    );
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRichParents(context);
        unwrap(insertCandidateTriageResult(context, initial));
        unwrap(insertCandidateTriageResult(context, correction));
        const stored = unwrap(
          readCandidateTriageResult(context, correction.candidateTriageResultId)
        );
        expect(stored).toBeDefined();
        if (stored !== undefined) {
          expect(stored.supersedesResultId).toBe(initial.candidateTriageResultId);
        }
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("refuses missing parents, mismatched children, and duplicate identity", async () => {
    const connection = await openMigratedDatabase();
    const complete = unwrap(prepareCandidateTriageResult(completeResultDraft()));
    expect(insertCandidateTriageResult({}, complete)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
    });
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(insertCandidateTriageResult(context, complete)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate result requires a stored candidate"
          })
        });
        unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
        const selfSupersede = unwrap(
          prepareCandidateTriageResult(
            unavailableResultDraft({
              kind: "correction",
              supersedesResultId: "candidate-result-1"
            })
          )
        );
        expect(insertCandidateTriageResult(context, selfSupersede)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate result cannot supersede itself"
          })
        });
        const missingPrior = unwrap(
          prepareCandidateTriageResult(
            unavailableResultDraft({
              candidateTriageResultId: "candidate-result-missing-prior",
              kind: "correction",
              supersedesResultId: "candidate-result-absent"
            })
          )
        );
        expect(insertCandidateTriageResult(context, missingPrior)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Correction results require a stored superseded result"
          })
        });
        unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft({
          candidateId: "candidate-2",
          sourceKey: "tier-one/0002"
        })))));
        unwrap(
          insertCandidateTriageResult(
            context,
            unwrap(
              prepareCandidateTriageResult(
                unavailableResultDraft({
                  candidateTriageResultId: "candidate-result-other",
                  candidateId: "candidate-2"
                })
              )
            )
          )
        );
        const wrongCandidate = unwrap(
          prepareCandidateTriageResult(
            unavailableResultDraft({
              candidateTriageResultId: "candidate-result-wrong-prior",
              kind: "correction",
              supersedesResultId: "candidate-result-other"
            })
          )
        );
        expect(insertCandidateTriageResult(context, wrongCandidate)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Superseded results must belong to the same candidate"
          })
        });
        expect(insertCandidateTriageResult(context, complete)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate result requires stored evidence spans"
          })
        });
        unwrap(insertSourceDocument(context, unwrap(prepareSourceDocument(sourceDocumentDraft()))));
        unwrap(insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft()))));
        expect(insertCandidateTriageResult(context, complete)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate result requires stored evidence gaps"
          })
        });
        unwrap(insertActor(context, unwrap(prepareActor(actorDraft()))));
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
        }
        const mismatchedGap = unwrap(
          prepareCandidateTriageResult(
            completeResultDraft({
              evidenceGaps: RUBRIC_DIMENSIONS.map((dimensionId, index) =>
                index === 0
                  ? { ...resultGapDraft(dimensionId), dimensionId: "other_dimension" }
                  : resultGapDraft(dimensionId)
              )
            })
          )
        );
        expect(insertCandidateTriageResult(context, mismatchedGap)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate result gap dimension does not match the stored gap"
          })
        });
        expect(insertCandidateTriageResult(context, complete)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate result requires stored dimension assessments"
          })
        });
        for (const dimension of DRAFT_RUBRIC_V1.dimensions) {
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
        unwrap(
          insertDimensionAssessment(
            context,
            unwrap(
              prepareDimensionAssessment({
                dimensionAssessmentId: "dimension-assessment-other",
                dimensionId: "production_software_engineering",
                level: "none",
                source: "extracted",
                actorId: null,
                createdAt: CREATED_AT
              })
            )
          )
        );
        const mismatchedAssessment = unwrap(
          prepareCandidateTriageResult(
            completeResultDraft({
              dimensionAssessments: RUBRIC_DIMENSIONS.map((dimensionId, index) =>
                index === 0
                  ? {
                      candidateResultDimensionAssessmentId: `candidate-result-assessment-${dimensionId}`,
                      dimensionAssessmentId: "dimension-assessment-other",
                      dimensionId
                    }
                  : resultAssessmentDraft(dimensionId)
              )
            })
          )
        );
        expect(insertCandidateTriageResult(context, mismatchedAssessment)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate result assessment dimension does not match the stored assessment"
          })
        });
        expect(insertCandidateTriageResult(context, complete)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate result requires stored structured facts"
          })
        });
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
                  structuredFactId: "structured-fact-other",
                  candidateId: "candidate-2",
                  payload: titlePayload("Other Engineer"),
                  evidenceSpans: [
                    {
                      structuredFactEvidenceSpanId: "structured-fact-span-other",
                      evidenceSpanId: "evidence-span-2"
                    }
                  ],
                  provenances: [
                    {
                      structuredFactProvenanceId: "structured-fact-provenance-other",
                      source: "parsed",
                      actorId: null
                    }
                  ]
                })
              )
            )
          )
        );
        const wrongFact = unwrap(
          prepareCandidateTriageResult(
            completeResultDraft({
              structuredFacts: [
                {
                  candidateResultStructuredFactId: "candidate-result-fact-1",
                  structuredFactId: "structured-fact-other"
                }
              ],
              factConflicts: [],
              hardRequirementAssessments: []
            })
          )
        );
        expect(insertCandidateTriageResult(context, wrongFact)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate result facts must belong to the candidate"
          })
        });
        unwrap(
          insertStructuredFact(
            context,
            unwrap(
              prepareStructuredFact(
                factDraft({
                  structuredFactId: "structured-fact-2",
                  payload: titlePayload("Principal Engineer"),
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
        unwrap(
          insertStructuredFact(
            context,
            unwrap(
              prepareStructuredFact(
                factDraft({
                  structuredFactId: "structured-fact-3",
                  candidateId: "candidate-2",
                  payload: titlePayload("Distinguished Engineer"),
                  evidenceSpans: [
                    {
                      structuredFactEvidenceSpanId: "structured-fact-span-3",
                      evidenceSpanId: "evidence-span-2"
                    }
                  ],
                  provenances: [
                    {
                      structuredFactProvenanceId: "structured-fact-provenance-3",
                      source: "parsed",
                      actorId: null
                    }
                  ]
                })
              )
            )
          )
        );
        unwrap(
          insertFactConflict(
            context,
            unwrap(
              prepareFactConflict(
                conflictDraft({
                  factConflictId: "fact-conflict-2",
                  members: [
                    {
                      factConflictMemberId: "fact-conflict-member-3",
                      structuredFactId: "structured-fact-other"
                    },
                    {
                      factConflictMemberId: "fact-conflict-member-4",
                      structuredFactId: "structured-fact-3"
                    }
                  ]
                })
              )
            )
          )
        );
        expect(insertCandidateTriageResult(context, complete)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate result requires stored fact conflicts"
          })
        });
        const wrongConflict = unwrap(
          prepareCandidateTriageResult(
            completeResultDraft({
              factConflicts: [
                {
                  candidateResultFactConflictId: "candidate-result-conflict-1",
                  factConflictId: "fact-conflict-2"
                }
              ],
              hardRequirementAssessments: []
            })
          )
        );
        expect(insertCandidateTriageResult(context, wrongConflict)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate result conflicts must belong to the candidate"
          })
        });
        unwrap(insertFactConflict(context, unwrap(prepareFactConflict(conflictDraft()))));
        expect(insertCandidateTriageResult(context, complete)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate result requires stored hard requirement assessments"
          })
        });
        unwrap(
          insertHardRequirementAssessment(
            context,
            unwrap(
              prepareHardRequirementAssessment(
                requirementDraft({
                  hardRequirementAssessmentId: "hard-requirement-assessment-2",
                  candidateId: "candidate-2",
                  facts: [
                    {
                      hardRequirementAssessmentFactId: "hard-requirement-assessment-fact-2",
                      structuredFactId: "structured-fact-other",
                      polarity: "supporting"
                    }
                  ]
                })
              )
            )
          )
        );
        const wrongRequirement = unwrap(
          prepareCandidateTriageResult(
            completeResultDraft({
              hardRequirementAssessments: [
                {
                  candidateResultHardRequirementAssessmentId: "candidate-result-requirement-1",
                  hardRequirementAssessmentId: "hard-requirement-assessment-2"
                }
              ]
            })
          )
        );
        expect(insertCandidateTriageResult(context, wrongRequirement)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate result requirement assessments must belong to the candidate"
          })
        });
        unwrap(
          insertHardRequirementAssessment(
            context,
            unwrap(prepareHardRequirementAssessment(requirementDraft()))
          )
        );
        unwrap(insertCandidateTriageResult(context, complete));
        expect(
          insertCandidateTriageResult(
            context,
            unwrap(
              prepareCandidateTriageResult(
                completeResultDraft({ candidateTriageResultId: "candidate-result-dup" })
              )
            )
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Candidate result insert failed" })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });
});

describe("candidate result boundary failures", () => {
  it("rejects unprepared records, invalid IDs, and storage faults", () => {
    const result = unwrap(prepareCandidateTriageResult(unavailableResultDraft()));
    const contexts = [undefined, null, {}, { nativeDatabase: null }];
    for (const context of contexts) {
      expect(insertCandidateTriageResult(context, result)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readCandidateTriageResult(context, "candidate-result-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readCandidateTriageResultByContentHash(context, result.contentHash)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
    }
    expect(
      insertCandidateTriageResult({ nativeDatabase: { inTransaction: false } }, result)
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
    });
    expect(insertCandidateTriageResult(failingContext(), result)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate result insert failed" })
    });
    expect(
      insertCandidateTriageResult(failingContext(), { candidateTriageResultId: "candidate-result-1" })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid prepared candidate result" })
    });
    expect(insertCandidateTriageResult(failingContext(), { ...result })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid prepared candidate result" })
    });
    expect(readCandidateTriageResult(failingContext(), "candidate-result-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate result read failed" })
    });
    expect(readCandidateTriageResult(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate result ID" })
    });
    expect(readCandidateTriageResultByContentHash(failingContext(), "not-a-hash")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate result content hash" })
    });
    expect(readCandidateTriageResultByContentHash(failingContext(), result.contentHash)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate result read failed" })
    });
  });

  it("rejects a stored complete result whose attached score belongs to another result", () => {
    const other = unwrap(
      prepareCandidateTriageResult(
        completeResultDraft({ candidateTriageResultId: "other-result" })
      )
    );
    expect(other.score).not.toBeNull();
    const parentContent = {
      availability: "complete",
      candidateId: "candidate-1",
      dimensionAssessmentIds: [],
      evidenceGapIds: [],
      evidenceSpanIds: [],
      factConflictIds: [],
      hardRequirementAssessmentIds: [],
      kind: "initial",
      status: "scored",
      structuredFactIds: [],
      supersedesResultId: null
    };
    const parentJson = JSON.stringify(parentContent);
    const score = other.score as ScoreResult;
    expect(
      readCandidateTriageResult(
        failingContext((sql) => {
          if (sql.includes("FROM candidate_triage_result") && sql.includes("content_json")) {
            return {
              get: () => ({
                candidateTriageResultId: "candidate-result-1",
                candidateId: "candidate-1",
                kind: "initial",
                availability: "complete",
                status: "scored",
                supersedesResultId: null,
                contentJson: parentJson,
                contentHash: sha256Hex(parentJson),
                createdAt: CREATED_AT
              })
            };
          }
          if (sql.includes("FROM score_result")) {
            return { get: () => score };
          }
          return { get: () => undefined, all: () => [] };
        }),
        "candidate-result-1"
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored candidate result failed integrity validation"
      })
    });
  });
});

describe("candidate result schema checks and immutability", () => {
  it("declares result tables STRICT and rejects replace, update, and delete", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const result = unwrap(prepareCandidateTriageResult(unavailableResultDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
        unwrap(insertCandidateTriageResult(context, result));
        return ok(undefined);
      })
    );
    for (const table of [
      "candidate_triage_result",
      "score_result",
      "candidate_result_evidence_span",
      "candidate_result_evidence_gap",
      "candidate_result_dimension_assessment",
      "candidate_result_structured_fact",
      "candidate_result_fact_conflict",
      "candidate_result_hard_requirement_assessment"
    ]) {
      expect(
        database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)
      ).toEqual({ sql: expect.stringContaining("STRICT") });
    }
    expect(() =>
      database
        .prepare(
          `INSERT INTO candidate_triage_result (
            candidate_triage_result_id, candidate_id, kind, availability, status,
            supersedes_result_id, content_json, content_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          result.candidateTriageResultId,
          result.candidateId,
          result.kind,
          result.availability,
          result.status,
          result.supersedesResultId,
          result.contentJson,
          result.contentHash,
          CREATED_AT
        )
    ).toThrow(/immutable/u);
    expect(() =>
      database.prepare("UPDATE candidate_triage_result SET status = status").run()
    ).toThrow(/immutable/u);
    expect(() => database.prepare("DELETE FROM candidate_triage_result").run()).toThrow(
      /immutable/u
    );
    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored results whose denormalized identity drifted", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const result = unwrap(prepareCandidateTriageResult(unavailableResultDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
        unwrap(insertCandidateTriageResult(context, result));
        return ok(undefined);
      })
    );
    database.exec("DROP TRIGGER candidate_triage_result_reject_update");
    database.prepare("UPDATE candidate_triage_result SET availability = ?").run("complete");
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateTriageResult(context, result.candidateTriageResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored candidate result failed integrity validation"
      })
    });
    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored result content that fails integrity or schema validation", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const result = unwrap(prepareCandidateTriageResult(unavailableResultDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
        unwrap(insertCandidateTriageResult(context, result));
        return ok(undefined);
      })
    );
    rebuildTableWithoutChecks(database, "candidate_triage_result", CANDIDATE_TRIAGE_RESULT_COLUMNS);
    database.prepare("UPDATE candidate_triage_result SET content_hash = ?").run("a".repeat(64));
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateTriageResult(context, result.candidateTriageResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored candidate result failed integrity validation"
      })
    });
    database.prepare("UPDATE candidate_triage_result SET content_json = ?").run("not-json");
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateTriageResult(context, result.candidateTriageResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored candidate result content is not valid JSON"
      })
    });
    const pretty = `{\n  "not": "canonical"\n}`;
    database
      .prepare("UPDATE candidate_triage_result SET content_json = ?, content_hash = ?")
      .run(pretty, sha256Hex(pretty));
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateTriageResult(context, result.candidateTriageResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored candidate result failed integrity validation"
      })
    });
    const unsafeNumber = '{"n":9007199254740993}';
    database
      .prepare("UPDATE candidate_triage_result SET content_json = ?, content_hash = ?")
      .run(unsafeNumber, sha256Hex(unsafeNumber));
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateTriageResult(context, result.candidateTriageResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored candidate result failed integrity validation"
      })
    });
    const invalidObject = '{"candidateId":"candidate-1"}';
    database
      .prepare("UPDATE candidate_triage_result SET content_json = ?, content_hash = ?")
      .run(invalidObject, sha256Hex(invalidObject));
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateTriageResult(context, result.candidateTriageResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored candidate result is invalid" })
    });
    database
      .prepare("UPDATE candidate_triage_result SET kind = ?, content_json = ?, content_hash = ?")
      .run("nope", result.contentJson, result.contentHash);
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateTriageResult(context, result.candidateTriageResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored candidate result is invalid" })
    });
    database.prepare("UPDATE candidate_triage_result SET kind = ?").run("initial");
    const mismatched = JSON.stringify({
      availability: "unavailable",
      candidateId: "candidate-1",
      dimensionAssessmentIds: [],
      evidenceGapIds: [],
      evidenceSpanIds: ["evidence-span-missing"],
      factConflictIds: [],
      hardRequirementAssessmentIds: [],
      kind: "initial",
      status: "escalated",
      structuredFactIds: [],
      supersedesResultId: null
    });
    database
      .prepare("UPDATE candidate_triage_result SET content_json = ?, content_hash = ?")
      .run(mismatched, sha256Hex(mismatched));
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateTriageResult(context, result.candidateTriageResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored candidate result failed integrity validation"
      })
    });
    database
      .prepare(
        "UPDATE candidate_triage_result SET content_json = ?, content_hash = ?, availability = ?"
      )
      .run(result.contentJson, result.contentHash, "complete");
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateTriageResult(context, result.candidateTriageResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored candidate result failed integrity validation"
      })
    });
    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored scores that fail integrity and complete results missing a score", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const result = unwrap(prepareCandidateTriageResult(completeResultDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRichParents(context);
        unwrap(insertCandidateTriageResult(context, result));
        return ok(undefined);
      })
    );
    database.exec("DROP TRIGGER score_result_reject_update");
    database.prepare("UPDATE score_result SET aggregate_text = ?").run("1/1");
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateTriageResult(context, result.candidateTriageResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored score result failed integrity validation"
      })
    });
    database.prepare("UPDATE score_result SET aggregate_text = ?").run(result.score!.aggregateText);
    rebuildTableWithoutChecks(database, "score_result", SCORE_RESULT_COLUMNS);
    database.prepare("UPDATE score_result SET content_json = ?").run("not-json");
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateTriageResult(context, result.candidateTriageResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored score result content is not valid JSON"
      })
    });
    const pretty = `{\n  "not": "canonical"\n}`;
    database
      .prepare("UPDATE score_result SET content_json = ?, content_hash = ?")
      .run(pretty, sha256Hex(pretty));
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateTriageResult(context, result.candidateTriageResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored score result failed integrity validation"
      })
    });
    const invalidScore = '{"aggregate":"0/1"}';
    database
      .prepare("UPDATE score_result SET content_json = ?, content_hash = ?")
      .run(invalidScore, sha256Hex(invalidScore));
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateTriageResult(context, result.candidateTriageResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored score result is invalid" })
    });
    const mismatchedScore = JSON.stringify({
      ...result.score!.content,
      candidateTriageResultId: "other-result"
    });
    database
      .prepare("UPDATE score_result SET content_json = ?, content_hash = ?")
      .run(mismatchedScore, sha256Hex(mismatchedScore));
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateTriageResult(context, result.candidateTriageResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored score result failed integrity validation"
      })
    });
    database.exec("DELETE FROM score_result");
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateTriageResult(context, result.candidateTriageResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored candidate result failed integrity validation"
      })
    });
    expect(connection.close().ok).toBe(true);
  });

  it("rejects an unavailable result that gained a score row", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const unavailable = unwrap(prepareCandidateTriageResult(unavailableResultDraft()));
    const scored = unwrap(prepareCandidateTriageResult(completeResultDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
        unwrap(insertCandidateTriageResult(context, unavailable));
        return ok(undefined);
      })
    );
    const score = scored.score as ScoreResult;
    database
      .prepare(
        `INSERT INTO score_result (
          score_result_id, candidate_result_id, aggregate_text, confidence_text,
          aggregate_basis_points, confidence_basis_points, content_json, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        score.scoreResultId,
        unavailable.candidateTriageResultId,
        score.aggregateText,
        score.confidenceText,
        score.aggregateBasisPoints,
        score.confidenceBasisPoints,
        score.contentJson,
        score.contentHash,
        score.createdAt
      );
    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateTriageResult(context, unavailable.candidateTriageResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored candidate result failed integrity validation"
      })
    });
    expect(connection.close().ok).toBe(true);
  });
});
