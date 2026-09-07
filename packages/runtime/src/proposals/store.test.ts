import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeAggregateScore,
  computeConfidence,
  createDomainError,
  DRAFT_RUBRIC_V1,
  err,
  formatRational,
  ok,
  sha256Hex,
  type Result
} from "@recruitos/core";
import * as core from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runImmediateTransaction, type ImmediateTransactionContext } from "../commands/index.js";
import { openRuntimeDatabase, type RuntimeDatabaseConnection } from "../db/index.js";
import {
  insertActor,
  insertCandidate,
  insertSourceDocument,
  prepareActor,
  prepareCandidate,
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
  insertCandidateTriageResult,
  prepareCandidateTriageResult
} from "../results/index.js";
import {
  insertProposal,
  insertReviewDecision,
  prepareProposal,
  prepareReviewDecision,
  ProposalSchema,
  readProposal,
  readProposalHead,
  readProposals,
  readProposalStatus,
  readReviewDecision,
  readReviewDecisions,
  ReviewDecisionSchema
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const DOCUMENT_TEXT = "ABCDEFGHIJ";
const PROPOSAL_TRANSACTION_REQUIRED = "Proposal rows require an active command transaction";
const DECISION_TRANSACTION_REQUIRED =
  "Review decision rows require an active command transaction";
const HEAD_TRANSACTION_REQUIRED = "Proposal head rows require an active command transaction";
const RUBRIC_DIMENSIONS = DRAFT_RUBRIC_V1.dimensions.map((dimension) => dimension.dimensionId);

const PROPOSAL_COLUMNS = `
  proposal_id text PRIMARY KEY NOT NULL,
  candidate_result_id text NOT NULL,
  proposal_kind text NOT NULL,
  proposal_ordinal integer NOT NULL,
  payload_json text NOT NULL,
  payload_hash text NOT NULL,
  created_at integer NOT NULL
`;

const PROPOSAL_EVIDENCE_SPAN_COLUMNS = `
  proposal_evidence_span_id text PRIMARY KEY NOT NULL,
  proposal_id text NOT NULL,
  evidence_span_id text NOT NULL,
  span_ordinal integer NOT NULL,
  created_at integer NOT NULL
`;

const REVIEW_DECISION_COLUMNS = `
  review_decision_id text PRIMARY KEY NOT NULL,
  proposal_id text NOT NULL,
  actor_id text NOT NULL,
  decision_kind text NOT NULL,
  decision_ordinal integer NOT NULL,
  payload_json text NOT NULL,
  payload_hash text NOT NULL,
  created_at integer NOT NULL
`;

const PROPOSAL_HEAD_COLUMNS = `
  proposal_id text PRIMARY KEY NOT NULL,
  current_decision_id text NOT NULL,
  version integer NOT NULL
`;

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-proposal-test-"));
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

function proposalDraft(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: "proposal-1",
    candidateResultId: "candidate-result-1",
    proposalOrdinal: 0,
    payload: {
      kind: "follow_up_draft",
      body: "Please send a work-authorization document."
    },
    evidenceSpans: [],
    createdAt: CREATED_AT,
    ...overrides
  };
}

function decisionDraft(overrides: Record<string, unknown> = {}) {
  return {
    reviewDecisionId: "review-decision-1",
    proposalId: "proposal-1",
    actorId: "actor-recruiter-1",
    decisionOrdinal: 0,
    payload: { kind: "approve" },
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
  unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
  unwrap(insertSourceDocument(context, unwrap(prepareSourceDocument(sourceDocumentDraft()))));
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

function seedCompleteResult(context: ImmediateTransactionContext): void {
  unwrap(
    insertCandidateTriageResult(
      context,
      unwrap(prepareCandidateTriageResult(completeResultDraft()))
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
  if (table === "review_decision" || table === "proposal") {
    triggerNames.push(
      "proposal_head_insert_decision_owner",
      "proposal_head_update_decision_owner"
    );
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    ${triggerNames.map((name) => `DROP TRIGGER IF EXISTS ${name};`).join("\n")}
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

describe("proposal and review-decision preparation", () => {
  it("freezes proposals, assigns span ordinals, and denormalizes decision kind", () => {
    const followUp = unwrap(prepareProposal(proposalDraft()));
    expect(followUp.proposalKind).toBe("follow_up_draft");
    expect(followUp.payloadHash).toBe(sha256Hex(followUp.payloadJson));
    expect(followUp.evidenceSpans).toEqual([]);
    expect(Object.isFrozen(followUp)).toBe(true);

    const withSpan = unwrap(
      prepareProposal(
        proposalDraft({
          evidenceSpans: [
            {
              proposalEvidenceSpanId: "proposal-span-1",
              evidenceSpanId: "evidence-span-1"
            }
          ]
        })
      )
    );
    expect(withSpan.evidenceSpans).toEqual([
      {
        proposalEvidenceSpanId: "proposal-span-1",
        evidenceSpanId: "evidence-span-1",
        spanOrdinal: 0,
        createdAt: CREATED_AT
      }
    ]);
    expect(Object.isFrozen(withSpan.evidenceSpans[0])).toBe(true);

    expect(
      unwrap(prepareProposal(proposalDraft({ payload: { kind: "shortlist_inclusion" } })))
        .proposalKind
    ).toBe("shortlist_inclusion");
    expect(
      unwrap(
        prepareProposal(
          proposalDraft({ payload: { kind: "ats_stage_change", targetStage: "interview" } })
        )
      ).proposalKind
    ).toBe("ats_stage_change");
    expect(
      unwrap(
        prepareProposal(
          proposalDraft({
            payload: { kind: "rejection", rationale: "Failed work authorization." }
          })
        )
      ).proposalKind
    ).toBe("rejection");

    const approve = unwrap(prepareReviewDecision(decisionDraft()));
    expect(approve.decisionKind).toBe("approve");
    expect(Object.isFrozen(approve)).toBe(true);
    expect(
      unwrap(
        prepareReviewDecision(
          decisionDraft({
            payload: {
              kind: "edit",
              editedPayload: {
                kind: "follow_up_draft",
                body: "Please send the document by Friday."
              }
            }
          })
        )
      ).decisionKind
    ).toBe("edit");
    expect(
      unwrap(
        prepareReviewDecision(
          decisionDraft({ payload: { kind: "reject", rationale: "Duplicate candidate." } })
        )
      ).decisionKind
    ).toBe("reject");
    expect(
      unwrap(
        prepareReviewDecision(
          decisionDraft({
            payload: { kind: "request_evidence", rationale: "Need the missing document." }
          })
        )
      ).decisionKind
    ).toBe("request_evidence");
  });

  it("rejects extra keys, hostile drafts, uniqueness collisions, and system actors", () => {
    expect(prepareProposal({ ...proposalDraft(), extra: true })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid proposal input" })
    });
    expect(prepareProposal(withThrowingGetter(proposalDraft(), "proposalId"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Proposal preparation failed" })
    });
    expect(
      prepareProposal(
        proposalDraft({
          evidenceSpans: [
            { proposalEvidenceSpanId: "proposal-span-1", evidenceSpanId: "evidence-span-1" },
            { proposalEvidenceSpanId: "proposal-span-2", evidenceSpanId: "evidence-span-1" }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Proposal evidence spans must be unique" })
    });
    expect(
      prepareProposal(
        proposalDraft({
          evidenceSpans: [
            { proposalEvidenceSpanId: "proposal-span-1", evidenceSpanId: "evidence-span-1" },
            { proposalEvidenceSpanId: "proposal-span-1", evidenceSpanId: "evidence-span-2" }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Proposal evidence span IDs must be unique" })
    });
    const stringifyProposal = vi.spyOn(core, "canonicalJsonStringify").mockReturnValueOnce(
      err(createDomainError("invalid_input", "Value is not canonical JSON"))
    );
    expect(prepareProposal(proposalDraft())).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Proposal payload is not canonical JSON" })
    });
    stringifyProposal.mockRestore();
    const parseProposal = vi.spyOn(ProposalSchema, "safeParse").mockReturnValueOnce({
      success: false,
      error: { issues: [] }
    } as never);
    expect(prepareProposal(proposalDraft())).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid proposal input" })
    });
    parseProposal.mockRestore();

    expect(prepareReviewDecision({ ...decisionDraft(), extra: true })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid review decision input" })
    });
    expect(prepareReviewDecision(withThrowingGetter(decisionDraft(), "payload"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Review decision preparation failed" })
    });
    expect(prepareReviewDecision(decisionDraft({ actorId: SYSTEM_ACTOR_ID }))).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Review decision actor must be a human actor"
      })
    });
    const stringifyDecision = vi.spyOn(core, "canonicalJsonStringify").mockReturnValueOnce(
      err(createDomainError("invalid_input", "Value is not canonical JSON"))
    );
    expect(prepareReviewDecision(decisionDraft())).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Review decision payload is not canonical JSON"
      })
    });
    stringifyDecision.mockRestore();
    const parseDecision = vi.spyOn(ReviewDecisionSchema, "safeParse").mockReturnValueOnce({
      success: false,
      error: { issues: [] }
    } as never);
    expect(prepareReviewDecision(decisionDraft())).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid review decision input" })
    });
    parseDecision.mockRestore();
  });
});

describe("proposal persistence", () => {
  it("stores proposals, evidence spans, and lists by ordinal", async () => {
    const connection = await openMigratedDatabase();
    const first = unwrap(
      prepareProposal(
        proposalDraft({
          evidenceSpans: [
            {
              proposalEvidenceSpanId: "proposal-span-1",
              evidenceSpanId: "evidence-span-1"
            }
          ]
        })
      )
    );
    const second = unwrap(
      prepareProposal(
        proposalDraft({
          proposalId: "proposal-2",
          proposalOrdinal: 1,
          payload: { kind: "rejection", rationale: "Failed work authorization." },
          createdAt: CREATED_AT + 1
        })
      )
    );
    const listed = unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRichParents(context);
        seedCompleteResult(context);
        unwrap(insertProposal(context, first));
        unwrap(insertProposal(context, second));
        expect(unwrap(readProposal(context, first.proposalId))).toEqual(first);
        expect(unwrap(readProposalStatus(context, first.proposalId))).toBe("pending");
        expect(unwrap(readProposalHead(context, first.proposalId))).toBeUndefined();
        return readProposals(context, "candidate-result-1");
      })
    );
    expect(listed.map((proposal) => proposal.proposalId)).toEqual(["proposal-1", "proposal-2"]);
    expect(listed[0]?.evidenceSpans).toEqual(first.evidenceSpans);
    expect(connection.close().ok).toBe(true);
  });

  it("rejects missing parents, unowned spans, score-based unavailable proposals, and uniqueness collisions", async () => {
    const connection = await openMigratedDatabase();
    const followUp = unwrap(prepareProposal(proposalDraft()));
    const shortlist = unwrap(
      prepareProposal(
        proposalDraft({
          proposalId: "proposal-shortlist",
          payload: { kind: "shortlist_inclusion" }
        })
      )
    );
    const withMissingSpan = unwrap(
      prepareProposal(
        proposalDraft({
          proposalId: "proposal-missing-span",
          evidenceSpans: [
            {
              proposalEvidenceSpanId: "proposal-span-missing",
              evidenceSpanId: "evidence-span-missing"
            }
          ]
        })
      )
    );
    const withUnownedSpan = unwrap(
      prepareProposal(
        proposalDraft({
          proposalId: "proposal-unowned-span",
          evidenceSpans: [
            {
              proposalEvidenceSpanId: "proposal-span-2",
              evidenceSpanId: "evidence-span-2"
            }
          ]
        })
      )
    );
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(insertProposal(context, followUp)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Proposal requires a stored candidate result"
          })
        });
        seedRichParents(context);
        seedUnavailableResult(context);
        expect(insertProposal(context, shortlist)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Score-based proposals are not valid on unavailable results"
          })
        });
        unwrap(insertProposal(context, followUp));
        expect(
          insertProposal(
            context,
            unwrap(
              prepareProposal(
                proposalDraft({
                  proposalId: "proposal-dup-ordinal",
                  payload: { kind: "ats_stage_change", targetStage: "screen" }
                })
              )
            )
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Proposal insert failed" })
        });
        expect(insertProposal(context, withMissingSpan)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Proposal requires a stored evidence span"
          })
        });
        expect(insertProposal(context, withUnownedSpan)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Proposal evidence span must belong to the candidate result"
          })
        });
        return ok(undefined);
      })
    );

    const complete = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(complete, (context) => {
        seedRichParents(context);
        seedCompleteResult(context);
        unwrap(
          insertProposal(
            context,
            unwrap(
              prepareProposal(
                proposalDraft({ payload: { kind: "shortlist_inclusion" } })
              )
            )
          )
        );
        expect(
          insertProposal(
            context,
            unwrap(
              prepareProposal(
                proposalDraft({
                  proposalId: "proposal-shortlist-2",
                  proposalOrdinal: 1,
                  payload: { kind: "shortlist_inclusion" }
                })
              )
            )
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Proposal insert failed" })
        });
        expect(insertProposal(context, withUnownedSpan)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Proposal evidence span must belong to the candidate result"
          })
        });
        unwrap(
          insertProposal(
            context,
            unwrap(
              prepareProposal(
                proposalDraft({
                  proposalId: "proposal-owned-span",
                  proposalOrdinal: 2,
                  evidenceSpans: [
                    {
                      proposalEvidenceSpanId: "proposal-span-owned",
                      evidenceSpanId: "evidence-span-1"
                    }
                  ]
                })
              )
            )
          )
        );
        expect(unwrap(readProposal(context, "proposal-owned-span"))?.evidenceSpans).toHaveLength(1);
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
    expect(complete.close().ok).toBe(true);
  });

  it("requires a command transaction and prepared records", () => {
    const prepared = unwrap(prepareProposal(proposalDraft()));
    expect(insertProposal(null, prepared)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: PROPOSAL_TRANSACTION_REQUIRED })
    });
    expect(insertProposal(undefined, prepared)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: PROPOSAL_TRANSACTION_REQUIRED })
    });
    expect(insertProposal({}, prepared)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: PROPOSAL_TRANSACTION_REQUIRED })
    });
    expect(insertProposal({ nativeDatabase: null }, prepared)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: PROPOSAL_TRANSACTION_REQUIRED })
    });
    expect(
      insertProposal({ nativeDatabase: { inTransaction: false } }, prepared)
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: PROPOSAL_TRANSACTION_REQUIRED })
    });
    expect(readProposal({}, "proposal-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: PROPOSAL_TRANSACTION_REQUIRED })
    });
    expect(readProposals({}, "candidate-result-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: PROPOSAL_TRANSACTION_REQUIRED })
    });
    expect(insertProposal(failingContext(), prepared)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Proposal insert failed" })
    });
    expect(insertProposal(failingContext(), { proposalId: "x" })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid prepared proposal" })
    });
    expect(readProposal(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid proposal ID" })
    });
    expect(readProposal(failingContext(), "proposal-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Proposal read failed" })
    });
    expect(readProposals(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate result ID" })
    });
    expect(readProposals(failingContext(), "candidate-result-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Proposal read failed" })
    });
    expect(
      insertProposal(
        withThrowingGetter({ nativeDatabase: { inTransaction: true } }, "nativeDatabase"),
        prepared
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Proposal insert failed" })
    });
  });

  it("returns undefined or an empty list when no proposal row exists", async () => {
    const connection = await openMigratedDatabase();
    const missing = unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        seedUnavailableResult(context);
        expect(unwrap(readProposalStatus(context, "proposal-1"))).toBeUndefined();
        return readProposal(context, "proposal-1");
      })
    );
    expect(missing).toBeUndefined();
    expect(
      unwrap(
        runImmediateTransaction(connection, (context) =>
          readProposals(context, "candidate-result-1")
        )
      )
    ).toEqual([]);
    expect(connection.close().ok).toBe(true);
  });
});

describe("review decision persistence and proposal heads", () => {
  it("initializes the head on the first decision and compare-and-sets later decisions", async () => {
    const connection = await openMigratedDatabase();
    const proposal = unwrap(prepareProposal(proposalDraft()));
    const first = unwrap(
      prepareReviewDecision(
        decisionDraft({
          payload: { kind: "request_evidence", rationale: "Need the missing document." }
        })
      )
    );
    const second = unwrap(
      prepareReviewDecision(
        decisionDraft({
          reviewDecisionId: "review-decision-2",
          decisionOrdinal: 1,
          payload: {
            kind: "edit",
            editedPayload: {
              kind: "follow_up_draft",
              body: "Please send the document by Friday."
            }
          }
        })
      )
    );
    const third = unwrap(
      prepareReviewDecision(
        decisionDraft({
          reviewDecisionId: "review-decision-3",
          decisionOrdinal: 2,
          payload: { kind: "approve" }
        })
      )
    );
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        seedUnavailableResult(context);
        unwrap(insertProposal(context, proposal));
        expect(insertReviewDecision(context, first, 1)).toEqual({
          ok: false,
          error: expect.objectContaining({
            code: "version_conflict",
            details: expect.objectContaining({
              expectedVersion: 1,
              actualVersion: null
            })
          })
        });
        unwrap(insertReviewDecision(context, first, 0));
        expect(unwrap(readReviewDecision(context, first.reviewDecisionId))).toEqual(first);
        expect(unwrap(readProposalHead(context, proposal.proposalId))).toEqual({
          proposalId: proposal.proposalId,
          currentDecisionId: first.reviewDecisionId,
          version: 1
        });
        expect(unwrap(readProposalStatus(context, proposal.proposalId))).toBe(
          "evidence_requested"
        );
        expect(insertReviewDecision(context, second, 0)).toEqual({
          ok: false,
          error: expect.objectContaining({
            code: "version_conflict",
            details: expect.objectContaining({
              expectedVersion: 0,
              actualVersion: 1
            })
          })
        });
        unwrap(insertReviewDecision(context, second, 1));
        expect(unwrap(readProposalStatus(context, proposal.proposalId))).toBe("edited");
        unwrap(insertReviewDecision(context, third, 2));
        expect(unwrap(readProposalHead(context, proposal.proposalId))).toEqual({
          proposalId: proposal.proposalId,
          currentDecisionId: third.reviewDecisionId,
          version: 3
        });
        expect(unwrap(readProposalStatus(context, proposal.proposalId))).toBe("approved");
        expect(
          unwrap(readReviewDecisions(context, proposal.proposalId)).map(
            (decision) => decision.reviewDecisionId
          )
        ).toEqual(["review-decision-1", "review-decision-2", "review-decision-3"]);
        expect(unwrap(readProposal(context, proposal.proposalId))).toEqual(proposal);
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("derives rejected status and keeps the original proposal after edit", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        seedUnavailableResult(context);
        unwrap(insertProposal(context, unwrap(prepareProposal(proposalDraft()))));
        unwrap(
          insertReviewDecision(
            context,
            unwrap(
              prepareReviewDecision(
                decisionDraft({ payload: { kind: "reject", rationale: "Duplicate candidate." } })
              )
            ),
            0
          )
        );
        expect(unwrap(readProposalStatus(context, "proposal-1"))).toBe("rejected");
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("rejects missing decision parents, kind mismatches, and a stale head version", async () => {
    const connection = await openMigratedDatabase();
    const decision = unwrap(prepareReviewDecision(decisionDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(insertReviewDecision(context, decision, "1")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid expected head version" })
        });
        expect(insertReviewDecision(context, decision, 0)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Review decision requires a stored proposal"
          })
        });
        seedParents(context);
        seedUnavailableResult(context);
        unwrap(insertProposal(context, unwrap(prepareProposal(proposalDraft()))));
        expect(
          insertReviewDecision(
            context,
            unwrap(prepareReviewDecision(decisionDraft({ actorId: "actor-missing" }))),
            0
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Review decision requires a stored actor"
          })
        });
        expect(
          insertReviewDecision(
            context,
            unwrap(
              prepareReviewDecision(
                decisionDraft({
                  payload: {
                    kind: "edit",
                    editedPayload: { kind: "shortlist_inclusion" }
                  }
                })
              )
            ),
            0
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Edited payload kind must match the stored proposal kind"
          })
        });
        unwrap(insertReviewDecision(context, decision, 0));
        expect(
          insertReviewDecision(
            context,
            unwrap(
              prepareReviewDecision(
                decisionDraft({
                  reviewDecisionId: "review-decision-stale",
                  decisionOrdinal: 1,
                  payload: { kind: "reject", rationale: "Not a fit." }
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
          insertReviewDecision(
            context,
            unwrap(
              prepareReviewDecision(
                decisionDraft({
                  reviewDecisionId: "review-decision-dup",
                  payload: { kind: "reject", rationale: "Not a fit." }
                })
              )
            ),
            1
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Review decision insert failed" })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("requires a command transaction and prepared decision records", () => {
    const prepared = unwrap(prepareReviewDecision(decisionDraft()));
    expect(insertReviewDecision(null, prepared, 0)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: DECISION_TRANSACTION_REQUIRED })
    });
    expect(readReviewDecision({}, "review-decision-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: DECISION_TRANSACTION_REQUIRED })
    });
    expect(readReviewDecisions({}, "proposal-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: DECISION_TRANSACTION_REQUIRED })
    });
    expect(readProposalHead({}, "proposal-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: HEAD_TRANSACTION_REQUIRED })
    });
    expect(readProposalStatus({}, "proposal-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: PROPOSAL_TRANSACTION_REQUIRED })
    });
    expect(insertReviewDecision(failingContext(), prepared, 0)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Review decision insert failed" })
    });
    const laterDecision = unwrap(
      prepareReviewDecision(
        decisionDraft({
          reviewDecisionId: "review-decision-2",
          decisionOrdinal: 1
        })
      )
    );
    expect(
      insertReviewDecision(
        failingContext((sql) => {
          if (sql.includes("UPDATE") && sql.includes("proposal_head")) {
            throw new Error("head update boom");
          }
          return {
            get: () =>
              sql.includes("proposal_head")
                ? { identity: "proposal-1", pointer: "review-decision-1", version: 1 }
                : { proposalKind: "follow_up_draft" },
            run: () => ({ changes: 1 })
          };
        }),
        laterDecision,
        1
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Mutable head update failed" })
    });
    expect(
      insertReviewDecision(
        failingContext((sql) => {
          if (sql.includes("proposal_head")) {
            throw new Error("head read boom");
          }
          return { get: () => ({ proposalKind: "follow_up_draft" }) };
        }),
        prepared,
        0
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Mutable head read failed" })
    });
    expect(
      insertReviewDecision(
        failingContext((sql) => {
          if (sql.includes("INSERT INTO") && sql.includes("proposal_head")) {
            throw new Error("head write boom");
          }
          return {
            get: () =>
              sql.includes("proposal_head") ? undefined : { proposalKind: "follow_up_draft" },
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
    expect(insertReviewDecision(failingContext(), { reviewDecisionId: "x" }, 0)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid prepared review decision" })
    });
    expect(insertReviewDecision(failingContext(), prepared, -1)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid expected head version" })
    });
    expect(readReviewDecision(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid review decision ID" })
    });
    expect(readReviewDecision(failingContext(), "review-decision-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Review decision read failed" })
    });
    expect(readReviewDecisions(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid proposal ID" })
    });
    expect(readReviewDecisions(failingContext(), "proposal-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Review decision read failed" })
    });
    expect(readProposalHead(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid proposal ID" })
    });
    expect(readProposalHead(failingContext(), "proposal-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Mutable head read failed" })
    });
    expect(
      readProposalHead(
        withThrowingGetter({ nativeDatabase: { inTransaction: true } }, "nativeDatabase"),
        "proposal-1"
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Proposal head read failed" })
    });
    expect(
      unwrap(
        readReviewDecision(
          {
            nativeDatabase: {
              inTransaction: true,
              prepare() {
                return { get: () => undefined };
              }
            }
          },
          "review-decision-1"
        )
      )
    ).toBeUndefined();
    expect(
      unwrap(
        readReviewDecisions(
          {
            nativeDatabase: {
              inTransaction: true,
              prepare() {
                return { all: () => [] };
              }
            }
          },
          "proposal-1"
        )
      )
    ).toEqual([]);
  });
});

describe("proposal schema checks and immutability", () => {
  it("declares STRICT tables and rejects replace, update, and delete", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const proposal = unwrap(
      prepareProposal(
        proposalDraft({
          evidenceSpans: [
            {
              proposalEvidenceSpanId: "proposal-span-1",
              evidenceSpanId: "evidence-span-1"
            }
          ]
        })
      )
    );
    const decision = unwrap(prepareReviewDecision(decisionDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRichParents(context);
        seedCompleteResult(context);
        unwrap(insertProposal(context, proposal));
        unwrap(insertReviewDecision(context, decision, 0));
        return ok(undefined);
      })
    );
    for (const table of [
      "proposal",
      "proposal_evidence_span",
      "review_decision",
      "proposal_head"
    ]) {
      expect(
        database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(
          table
        )
      ).toEqual({ sql: expect.stringContaining("STRICT") });
    }
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO proposal (
            proposal_id, candidate_result_id, proposal_kind, proposal_ordinal,
            payload_json, payload_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          proposal.proposalId,
          proposal.candidateResultId,
          proposal.proposalKind,
          proposal.proposalOrdinal,
          proposal.payloadJson,
          proposal.payloadHash,
          CREATED_AT
        )
    ).toThrow(/immutable/u);
    expect(() =>
      database.prepare("UPDATE proposal SET proposal_ordinal = proposal_ordinal").run()
    ).toThrow(/immutable/u);
    expect(() => database.prepare("DELETE FROM proposal").run()).toThrow(/immutable/u);
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO proposal_evidence_span (
            proposal_evidence_span_id, proposal_id, evidence_span_id, span_ordinal, created_at
          ) VALUES (?, ?, ?, ?, ?)`
        )
        .run("proposal-span-1", "proposal-1", "evidence-span-1", 0, CREATED_AT)
    ).toThrow(/immutable/u);
    expect(() =>
      database.prepare("UPDATE proposal_evidence_span SET span_ordinal = span_ordinal").run()
    ).toThrow(/immutable/u);
    expect(() => database.prepare("DELETE FROM proposal_evidence_span").run()).toThrow(
      /immutable/u
    );
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO review_decision (
            review_decision_id, proposal_id, actor_id, decision_kind, decision_ordinal,
            payload_json, payload_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          decision.reviewDecisionId,
          decision.proposalId,
          decision.actorId,
          decision.decisionKind,
          decision.decisionOrdinal,
          decision.payloadJson,
          decision.payloadHash,
          CREATED_AT
        )
    ).toThrow(/immutable/u);
    expect(() =>
      database.prepare("UPDATE review_decision SET decision_kind = decision_kind").run()
    ).toThrow(/immutable/u);
    expect(() => database.prepare("DELETE FROM review_decision").run()).toThrow(/immutable/u);
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO proposal_head (
            proposal_id, current_decision_id, version
          ) VALUES (?, ?, ?)`
        )
        .run(proposal.proposalId, decision.reviewDecisionId, 1)
    ).toThrow(/cannot be replaced/u);
    expect(() => database.prepare("DELETE FROM proposal_head").run()).toThrow(
      /cannot be deleted/u
    );
    expect(() =>
      database
        .prepare("UPDATE proposal_head SET version = version WHERE proposal_id = ?")
        .run(proposal.proposalId)
    ).toThrow(/version must increment by 1/u);
    expect(() =>
      database
        .prepare(
          "UPDATE proposal_head SET proposal_id = proposal_id, version = version + 1 WHERE proposal_id = ?"
        )
        .run(proposal.proposalId)
    ).toThrow(/identity is immutable/u);
    expect(connection.close().ok).toBe(true);
  });

  it("enforces kind, actor, payload, and head ownership CHECKs", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        seedUnavailableResult(context);
        unwrap(insertProposal(context, unwrap(prepareProposal(proposalDraft()))));
        unwrap(
          insertProposal(
            context,
            unwrap(
              prepareProposal(
                proposalDraft({
                  proposalId: "proposal-2",
                  proposalOrdinal: 1,
                  payload: { kind: "rejection", rationale: "Failed the title screen." }
                })
              )
            )
          )
        );
        unwrap(insertReviewDecision(context, unwrap(prepareReviewDecision(decisionDraft())), 0));
        return ok(undefined);
      })
    );
    const insertProposalRow = database.prepare(
      `INSERT INTO proposal (
        proposal_id, candidate_result_id, proposal_kind, proposal_ordinal,
        payload_json, payload_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertDecision = database.prepare(
      `INSERT INTO review_decision (
        review_decision_id, proposal_id, actor_id, decision_kind, decision_ordinal,
        payload_json, payload_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const hash = "a".repeat(64);
    expect(() =>
      insertProposalRow.run(
        "proposal-bad-kind",
        "candidate-result-1",
        "email",
        2,
        "{}",
        hash,
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    expect(() =>
      insertProposalRow.run(
        "proposal-bad-json",
        "candidate-result-1",
        "rejection",
        2,
        "[]",
        hash,
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    expect(() =>
      insertProposalRow.run(
        "proposal-bad-hash",
        "candidate-result-1",
        "rejection",
        2,
        "{}",
        "zz",
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    expect(() =>
      insertProposalRow.run(
        "proposal-ordinal",
        "candidate-result-1",
        "rejection",
        -1,
        "{}",
        hash,
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    expect(() =>
      insertDecision.run(
        "review-decision-bad-kind",
        "proposal-1",
        "actor-recruiter-1",
        "dismiss",
        1,
        "{}",
        hash,
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    expect(() =>
      insertDecision.run(
        "review-decision-system",
        "proposal-1",
        SYSTEM_ACTOR_ID,
        "approve",
        1,
        '{"kind":"approve"}',
        hash,
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    expect(() =>
      insertDecision.run(
        "review-decision-ordinal",
        "proposal-1",
        "actor-recruiter-1",
        "approve",
        -1,
        "{}",
        hash,
        CREATED_AT
      )
    ).toThrow(/CHECK/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO proposal_head (proposal_id, current_decision_id, version)
           VALUES (?, ?, ?)`
        )
        .run("proposal-2", "review-decision-1", 1)
    ).toThrow(/must belong to the proposal/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO proposal_head (proposal_id, current_decision_id, version)
           VALUES (?, ?, ?)`
        )
        .run("proposal-2", "review-decision-1", 2)
    ).toThrow(/insert version must be 1|must belong to the proposal/u);
    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored rows whose payload or identity drifted", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const proposal = unwrap(
      prepareProposal(
        proposalDraft({
          evidenceSpans: [
            {
              proposalEvidenceSpanId: "proposal-span-1",
              evidenceSpanId: "evidence-span-1"
            }
          ]
        })
      )
    );
    const decision = unwrap(prepareReviewDecision(decisionDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRichParents(context);
        seedCompleteResult(context);
        unwrap(insertProposal(context, proposal));
        unwrap(insertReviewDecision(context, decision, 0));
        return ok(undefined);
      })
    );

    rebuildTableWithoutChecks(database, "proposal", PROPOSAL_COLUMNS);
    database.prepare("UPDATE proposal SET proposal_ordinal = ?").run(-1);
    expect(
      runImmediateTransaction(connection, (context) =>
        readProposalStatus(context, proposal.proposalId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored proposal is invalid" })
    });
    expect(
      runImmediateTransaction(connection, (context) => readProposal(context, proposal.proposalId))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored proposal is invalid" })
    });
    expect(
      runImmediateTransaction(connection, (context) =>
        readProposals(context, proposal.candidateResultId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored proposal is invalid" })
    });
    database.prepare("UPDATE proposal SET proposal_ordinal = ?").run(0);
    database.prepare("UPDATE proposal SET payload_json = ?").run("{");
    expect(
      runImmediateTransaction(connection, (context) => readProposal(context, proposal.proposalId))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored proposal payload is not valid JSON"
      })
    });
    const pretty = '{\n  "body": "Please send a work-authorization document.",\n  "kind": "follow_up_draft"\n}';
    database
      .prepare("UPDATE proposal SET payload_json = ?, payload_hash = ?")
      .run(pretty, sha256Hex(pretty));
    expect(
      runImmediateTransaction(connection, (context) => readProposal(context, proposal.proposalId))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored proposal failed integrity validation"
      })
    });
    const canonical = proposal.payloadJson;
    database
      .prepare("UPDATE proposal SET payload_json = ?, payload_hash = ?")
      .run(canonical, "b".repeat(64));
    expect(
      runImmediateTransaction(connection, (context) => readProposal(context, proposal.proposalId))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored proposal failed integrity validation"
      })
    });
    database
      .prepare("UPDATE proposal SET payload_json = ?, payload_hash = ?, proposal_kind = ?")
      .run(canonical, sha256Hex(canonical), "rejection");
    expect(
      runImmediateTransaction(connection, (context) => readProposal(context, proposal.proposalId))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored proposal failed integrity validation"
      })
    });

    rebuildTableWithoutChecks(database, "proposal_evidence_span", PROPOSAL_EVIDENCE_SPAN_COLUMNS);
    database.prepare("UPDATE proposal_evidence_span SET span_ordinal = ?").run(-1);
    database
      .prepare("UPDATE proposal SET payload_json = ?, payload_hash = ?, proposal_kind = ?")
      .run(canonical, sha256Hex(canonical), "follow_up_draft");
    expect(
      runImmediateTransaction(connection, (context) => readProposal(context, proposal.proposalId))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored proposal evidence span is invalid" })
    });

    rebuildTableWithoutChecks(database, "review_decision", REVIEW_DECISION_COLUMNS, [
      "review_decision_reject_replace"
    ]);
    database.prepare("UPDATE review_decision SET payload_json = ?").run("{");
    expect(
      runImmediateTransaction(connection, (context) =>
        readReviewDecision(context, decision.reviewDecisionId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored review decision payload is not valid JSON"
      })
    });
    expect(
      runImmediateTransaction(connection, (context) =>
        readReviewDecisions(context, decision.proposalId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored review decision payload is not valid JSON"
      })
    });
    const prettyDecision = '{\n  "kind": "approve"\n}';
    database
      .prepare("UPDATE review_decision SET payload_json = ?, payload_hash = ?")
      .run(prettyDecision, sha256Hex(prettyDecision));
    expect(
      runImmediateTransaction(connection, (context) =>
        readReviewDecision(context, decision.reviewDecisionId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored review decision failed integrity validation"
      })
    });
    const canonicalDecision = decision.payloadJson;
    database
      .prepare("UPDATE review_decision SET payload_json = ?, payload_hash = ?")
      .run(canonicalDecision, "b".repeat(64));
    expect(
      runImmediateTransaction(connection, (context) =>
        readReviewDecision(context, decision.reviewDecisionId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored review decision failed integrity validation"
      })
    });
    database
      .prepare("UPDATE review_decision SET payload_json = ?, payload_hash = ?, decision_kind = ?")
      .run(canonicalDecision, sha256Hex(canonicalDecision), "reject");
    expect(
      runImmediateTransaction(connection, (context) =>
        readReviewDecision(context, decision.reviewDecisionId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored review decision failed integrity validation"
      })
    });
    database
      .prepare(
        "UPDATE review_decision SET payload_json = ?, payload_hash = ?, decision_kind = ?, actor_id = ?"
      )
      .run(canonicalDecision, sha256Hex(canonicalDecision), "approve", SYSTEM_ACTOR_ID);
    expect(
      runImmediateTransaction(connection, (context) =>
        readReviewDecision(context, decision.reviewDecisionId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored review decision failed integrity validation"
      })
    });
    database
      .prepare(
        "UPDATE review_decision SET payload_json = ?, payload_hash = ?, decision_kind = ?, actor_id = ?, decision_ordinal = ?"
      )
      .run(canonicalDecision, sha256Hex(canonicalDecision), "approve", "actor-recruiter-1", -1);
    expect(
      runImmediateTransaction(connection, (context) =>
        readReviewDecision(context, decision.reviewDecisionId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored review decision is invalid" })
    });

    rebuildTableWithoutChecks(database, "proposal_head", PROPOSAL_HEAD_COLUMNS, [
      "proposal_head_reject_replace",
      "proposal_head_insert_version",
      "proposal_head_insert_decision_owner",
      "proposal_head_update_identity",
      "proposal_head_update_version",
      "proposal_head_update_decision_owner"
    ]);
    database.prepare("UPDATE proposal_head SET current_decision_id = ?").run("x".repeat(150));
    expect(
      runImmediateTransaction(connection, (context) =>
        readProposalHead(context, proposal.proposalId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored proposal head is invalid" })
    });
    expect(connection.close().ok).toBe(true);
  });

  it("treats a head pointer to a missing decision as an integrity failure", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const proposal = unwrap(prepareProposal(proposalDraft()));
    const decision = unwrap(prepareReviewDecision(decisionDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        seedUnavailableResult(context);
        unwrap(insertProposal(context, proposal));
        unwrap(insertReviewDecision(context, decision, 0));
        return ok(undefined);
      })
    );
    rebuildTableWithoutChecks(database, "review_decision", REVIEW_DECISION_COLUMNS);
    database.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM review_decision;
      PRAGMA foreign_keys = ON;
    `);
    expect(
      runImmediateTransaction(connection, (context) =>
        readProposalStatus(context, proposal.proposalId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Proposal head current_decision_id must belong to the proposal"
      })
    });
    expect(connection.close().ok).toBe(true);
  });

  it("surfaces a corrupt proposal head when deriving status", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const proposal = unwrap(prepareProposal(proposalDraft()));
    const decision = unwrap(prepareReviewDecision(decisionDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        seedUnavailableResult(context);
        unwrap(insertProposal(context, proposal));
        unwrap(insertReviewDecision(context, decision, 0));
        return ok(undefined);
      })
    );
    rebuildTableWithoutChecks(database, "proposal_head", PROPOSAL_HEAD_COLUMNS, [
      "proposal_head_reject_replace",
      "proposal_head_insert_version",
      "proposal_head_insert_decision_owner",
      "proposal_head_update_identity",
      "proposal_head_update_version",
      "proposal_head_update_decision_owner"
    ]);
    database.prepare("UPDATE proposal_head SET current_decision_id = ?").run("x".repeat(150));
    expect(
      runImmediateTransaction(connection, (context) =>
        readProposalStatus(context, proposal.proposalId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored proposal head is invalid" })
    });
    expect(connection.close().ok).toBe(true);
  });

  it("surfaces a corrupt current decision when deriving status", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const proposal = unwrap(prepareProposal(proposalDraft()));
    const decision = unwrap(prepareReviewDecision(decisionDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        seedUnavailableResult(context);
        unwrap(insertProposal(context, proposal));
        unwrap(insertReviewDecision(context, decision, 0));
        return ok(undefined);
      })
    );
    rebuildTableWithoutChecks(database, "review_decision", REVIEW_DECISION_COLUMNS, [
      "review_decision_reject_replace"
    ]);
    database.prepare("UPDATE review_decision SET payload_json = ?").run("{");
    expect(
      runImmediateTransaction(connection, (context) =>
        readProposalStatus(context, proposal.proposalId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored review decision payload is not valid JSON"
      })
    });
    expect(connection.close().ok).toBe(true);
  });
});
