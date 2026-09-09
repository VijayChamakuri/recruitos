import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RUBRIC_V1,
  computeAggregateScore,
  computeConfidence,
  formatRational,
  ok,
  type Result
} from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  runImmediateTransaction,
  type ImmediateTransactionContext
} from "../commands/index.js";
import { openRuntimeDatabase, type RuntimeDatabaseConnection } from "../db/index.js";
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
  insertDimensionAssessment,
  insertEvidenceSpan,
  prepareDimensionAssessment,
  prepareEvidenceSpan
} from "../evidence/index.js";
import {
  insertCandidateResultSeal,
  insertCandidateTriageResult,
  prepareCandidateResultSeal,
  prepareCandidateTriageResult
} from "../results/index.js";
import { persistDerivedShortlistProposals } from "./persist-shortlist.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const PAYLOAD = Object.freeze({ kind: "shortlist_inclusion" as const });
const CONFLICT_MESSAGE =
  "Persisted shortlist proposal history conflict for candidate result candidate-result-1";

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-persist-shortlist-"));
  temporaryDirectories.push(directory);
  const opened = openRuntimeDatabase({
    filename: join(directory, "runtime.db"),
    migrationsFolder
  });
  if (!opened.ok) {
    throw new Error(opened.error.message);
  }
  const migrated = opened.value.migrate();
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function computedScoreDraft() {
  const computation = unwrap(
    computeAggregateScore(
      RUBRIC_V1.dimensions.map((dimension) => ({
        dimensionId: dimension.dimensionId,
        level: "none" as const
      })),
      RUBRIC_V1
    )
  );
  const confidenceInput = {
    contradictionCount: 0,
    dimensionsWithLocatedSpan: 0,
    requiredFieldsMissing: 0,
    spansLocated: 0,
    spansReturned: 0,
    totalDimensions: 6,
    totalRequiredFields: 4
  };
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
    }))
  };
}

function seedScoredResult(
  context: ImmediateTransactionContext,
  resultId = "candidate-result-1"
): Result<void, RuntimeError> {
  const candidate = prepareCandidate({
    candidateId: "candidate-1",
    sourceSystem: "synthetic_corpus",
    sourceKey: "tier-one/0001",
    channel: "inbound",
    corpusTag: "main",
    createdAt: CREATED_AT
  });
  if (!candidate.ok) return candidate;
  const insertedCandidate = insertCandidate(context, candidate.value);
  if (!insertedCandidate.ok) return insertedCandidate;
  const source = prepareSourceDocument({
    sourceDocumentId: "source-document-1",
    rawText: "ABCDEFGHIJ",
    normalizedText: "ABCDEFGHIJ",
    createdAt: CREATED_AT
  });
  if (!source.ok) return source;
  const insertedSource = insertSourceDocument(context, source.value);
  if (!insertedSource.ok) return insertedSource;
  const document = prepareCandidateDocument({
    candidateDocumentId: "candidate-document-1",
    candidateId: "candidate-1",
    sourceDocumentId: "source-document-1",
    documentKind: "resume",
    label: "Resume",
    documentOrdinal: 0,
    createdAt: CREATED_AT
  });
  if (!document.ok) return document;
  const insertedDocument = insertCandidateDocument(context, document.value);
  if (!insertedDocument.ok) return insertedDocument;
  const firstSpan = prepareEvidenceSpan({
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
    createdAt: CREATED_AT
  });
  if (!firstSpan.ok) return firstSpan;
  const insertedFirstSpan = insertEvidenceSpan(context, firstSpan.value);
  if (!insertedFirstSpan.ok) return insertedFirstSpan;
  const secondSpan = prepareEvidenceSpan({
    evidenceSpanId: "evidence-span-2",
    documentId: "source-document-1",
    start: 6,
    end: 9,
    quotedText: "GHI",
    dimensionId: "applied_ml_llm_systems",
    polarity: "supporting",
    source: "extracted",
    matchQuality: "exact",
    extractorVersion: "extractor-v1",
    createdAt: CREATED_AT
  });
  if (!secondSpan.ok) return secondSpan;
  const insertedSecondSpan = insertEvidenceSpan(context, secondSpan.value);
  if (!insertedSecondSpan.ok) return insertedSecondSpan;
  const dimensionAssessments: Array<{
    candidateResultDimensionAssessmentId: string;
    dimensionAssessmentId: string;
    dimensionId: string;
  }> = [];
  for (const dimension of RUBRIC_V1.dimensions) {
    const preparedAssessment = prepareDimensionAssessment({
      dimensionAssessmentId: `dimension-assessment-${dimension.dimensionId}`,
      dimensionId: dimension.dimensionId,
      level: "none",
      source: "extracted",
      actorId: null,
      createdAt: CREATED_AT
    });
    if (!preparedAssessment.ok) return preparedAssessment;
    const insertedAssessment = insertDimensionAssessment(context, preparedAssessment.value);
    if (!insertedAssessment.ok) return insertedAssessment;
    dimensionAssessments.push({
      candidateResultDimensionAssessmentId: `candidate-result-assessment-${dimension.dimensionId}`,
      dimensionAssessmentId: `dimension-assessment-${dimension.dimensionId}`,
      dimensionId: dimension.dimensionId
    });
  }
  const result = prepareCandidateTriageResult({
    candidateTriageResultId: resultId,
    candidateId: "candidate-1",
    kind: "initial",
    availability: "complete",
    status: "scored",
    supersedesResultId: null,
    evidenceSpans: [
      {
        candidateResultEvidenceSpanId: "candidate-result-span-1",
        evidenceSpanId: "evidence-span-1"
      },
      {
        candidateResultEvidenceSpanId: "candidate-result-span-2",
        evidenceSpanId: "evidence-span-2"
      }
    ],
    evidenceGaps: [],
    dimensionAssessments,
    structuredFacts: [],
    factConflicts: [],
    hardRequirementAssessments: [],
    score: computedScoreDraft(),
    sealId: `candidate-result-seal-${resultId}`,
    createdAt: CREATED_AT
  });
  if (!result.ok) return result;
  const insertedResult = insertCandidateTriageResult(context, result.value);
  if (!insertedResult.ok) return insertedResult;
  return ok(undefined);
}

function sealSeededResult(
  context: ImmediateTransactionContext,
  resultId = "candidate-result-1"
): Result<void, RuntimeError> {
  const prepared = prepareCandidateResultSeal({
    candidateResultSealId: `candidate-result-seal-${resultId}`,
    candidateResultId: resultId,
    createdAt: CREATED_AT
  });
  if (!prepared.ok) return prepared;
  const insertedSeal = insertCandidateResultSeal(context, prepared.value);
  if (!insertedSeal.ok) return insertedSeal;
  return ok(undefined);
}

function persistArgs(
  context: ImmediateTransactionContext,
  overrides: {
    resultId?: string;
    nextId?: () => string;
    proposals?: Parameters<typeof persistDerivedShortlistProposals>[0]["proposals"];
  } = {}
) {
  let counter = 0;
  return {
    context,
    nextId: overrides.nextId ?? (() => `id-${(counter += 1)}`),
    createdAt: CREATED_AT,
    resultId: overrides.resultId ?? "candidate-result-1",
    proposals:
      overrides.proposals ??
      [
        {
          payload: PAYLOAD,
          evidenceSpanIds: ["evidence-span-1"]
        }
      ]
  };
}

describe("persistDerivedShortlistProposals", () => {
  it("inserts one pending shortlist proposal at ordinal 0 with evidence spans and no head", async () => {
    const connection = await openMigratedDatabase();
    try {
      unwrap(
        runImmediateTransaction(connection, (context) => {
          const seeded = seedScoredResult(context);
          if (!seeded.ok) {
            return seeded;
          }
          const persisted = persistDerivedShortlistProposals(persistArgs(context));
          if (!persisted.ok) {
            return persisted;
          }
          return sealSeededResult(context);
        })
      );

      const database = nativeDatabase(connection);
      const proposal = database
        .prepare(
          `SELECT proposal_id AS proposalId, proposal_kind AS kind, proposal_ordinal AS ordinal
           FROM proposal WHERE candidate_result_id = ?`
        )
        .get("candidate-result-1") as {
        proposalId: string;
        kind: string;
        ordinal: number;
      };
      expect(proposal.proposalId).toBe("id-1");
      expect(proposal.kind).toBe("shortlist_inclusion");
      expect(proposal.ordinal).toBe(0);
      const spans = database
        .prepare(
          `SELECT evidence_span_id AS evidenceSpanId
           FROM proposal_evidence_span
           WHERE proposal_id = ?
           ORDER BY span_ordinal ASC`
        )
        .all(proposal.proposalId) as Array<{ evidenceSpanId: string }>;
      expect(spans.map((span) => span.evidenceSpanId)).toEqual(["evidence-span-1"]);
      const heads = database
        .prepare("SELECT count(*) AS count FROM proposal_head WHERE proposal_id = ?")
        .get(proposal.proposalId) as { count: number };
      expect(heads.count).toBe(0);
    } finally {
      connection.close();
    }
  });

  it("is a no-op when the derivation has no shortlist proposals", async () => {
    const connection = await openMigratedDatabase();
    try {
      unwrap(
        runImmediateTransaction(connection, (context) => {
          const seeded = seedScoredResult(context);
          if (!seeded.ok) {
            return seeded;
          }
          unwrap(
            persistDerivedShortlistProposals(
              persistArgs(context, {
                proposals: [
                  {
                    payload: {
                      kind: "follow_up_draft",
                      body: "Please send a work-authorization document."
                    },
                    evidenceSpanIds: []
                  }
                ]
              })
            )
          );
          unwrap(persistDerivedShortlistProposals(persistArgs(context, { proposals: [] })));
          return sealSeededResult(context);
        })
      );
      const count = nativeDatabase(connection)
        .prepare("SELECT count(*) AS count FROM proposal")
        .get() as { count: number };
      expect(count.count).toBe(0);
    } finally {
      connection.close();
    }
  });

  it("replays identical content without inserting a second row even when ids change", async () => {
    const connection = await openMigratedDatabase();
    try {
      unwrap(
        runImmediateTransaction(connection, (context) => {
          const seeded = seedScoredResult(context);
          if (!seeded.ok) {
            return seeded;
          }
          let counter = 0;
          const nextId = () => `id-${(counter += 1)}`;
          unwrap(persistDerivedShortlistProposals(persistArgs(context, { nextId })));
          unwrap(persistDerivedShortlistProposals(persistArgs(context, { nextId })));
          return sealSeededResult(context);
        })
      );
      const rows = nativeDatabase(connection)
        .prepare("SELECT proposal_id AS proposalId FROM proposal")
        .all() as Array<{ proposalId: string }>;
      expect(rows).toEqual([{ proposalId: "id-1" }]);
    } finally {
      connection.close();
    }
  });

  it("fails closed when replayed spans or payload hash diverge from the stored shortlist", async () => {
    const connection = await openMigratedDatabase();
    try {
      const emptySpans = runImmediateTransaction(connection, (context) => {
        const seeded = seedScoredResult(context);
        if (!seeded.ok) {
          return seeded;
        }
        unwrap(persistDerivedShortlistProposals(persistArgs(context)));
        return persistDerivedShortlistProposals(
          persistArgs(context, {
            proposals: [{ payload: PAYLOAD, evidenceSpanIds: [] }]
          })
        );
      });
      expect(emptySpans).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "persistence_failed",
          message: CONFLICT_MESSAGE
        })
      });
    } finally {
      connection.close();
    }

    const ordered = await openMigratedDatabase();
    try {
      const reordered = runImmediateTransaction(ordered, (context) => {
        const seeded = seedScoredResult(context);
        if (!seeded.ok) {
          return seeded;
        }
        unwrap(
          persistDerivedShortlistProposals(
            persistArgs(context, {
              proposals: [
                { payload: PAYLOAD, evidenceSpanIds: ["evidence-span-1", "evidence-span-2"] }
              ]
            })
          )
        );
        return persistDerivedShortlistProposals(
          persistArgs(context, {
            proposals: [
              { payload: PAYLOAD, evidenceSpanIds: ["evidence-span-2", "evidence-span-1"] }
            ]
          })
        );
      });
      expect(reordered).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "persistence_failed",
          message: CONFLICT_MESSAGE
        })
      });
    } finally {
      ordered.close();
    }

    const hashed = await openMigratedDatabase();
    try {
      const mismatch = runImmediateTransaction(hashed, (context) => {
        const seeded = seedScoredResult(context);
        if (!seeded.ok) {
          return seeded;
        }
        context.nativeDatabase
          .prepare(
            `INSERT INTO proposal (
               proposal_id, candidate_result_id, proposal_kind, proposal_ordinal,
               payload_json, payload_hash, created_at
             ) VALUES (?, ?, 'shortlist_inclusion', 0, ?, ?, ?)`
          )
          .run(
            "stored-shortlist-1",
            "candidate-result-1",
            '{"kind":"shortlist_inclusion"}',
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            CREATED_AT
          );
        return persistDerivedShortlistProposals(
          persistArgs(context, {
            proposals: [{ payload: PAYLOAD, evidenceSpanIds: [] }]
          })
        );
      });
      expect(mismatch).toEqual({
        ok: false,
        error: expect.objectContaining({
          code: "persistence_failed",
          message: CONFLICT_MESSAGE
        })
      });
    } finally {
      hashed.close();
    }
  });

  it("rejects more than one shortlist_inclusion derivation for one result", async () => {
    const connection = await openMigratedDatabase();
    try {
      const result = runImmediateTransaction(connection, (context) => {
        const seeded = seedScoredResult(context);
        if (!seeded.ok) {
          return seeded;
        }
        return persistDerivedShortlistProposals(
          persistArgs(context, {
            proposals: [
              { payload: PAYLOAD, evidenceSpanIds: ["evidence-span-1"] },
              { payload: PAYLOAD, evidenceSpanIds: ["evidence-span-1"] }
            ]
          })
        );
      });
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          message: "A candidate result may persist at most one shortlist_inclusion proposal"
        })
      });
    } finally {
      connection.close();
    }
  });

  it("rejects duplicate evidence span ids and spans not owned by the result", async () => {
    const connection = await openMigratedDatabase();
    try {
      const duplicate = runImmediateTransaction(connection, (context) => {
        const seeded = seedScoredResult(context);
        if (!seeded.ok) {
          return seeded;
        }
        return persistDerivedShortlistProposals(
          persistArgs(context, {
            proposals: [
              {
                payload: PAYLOAD,
                evidenceSpanIds: ["evidence-span-1", "evidence-span-1"]
              }
            ]
          })
        );
      });
      expect(duplicate).toEqual({
        ok: false,
        error: expect.objectContaining({
          message: "Shortlist proposal evidence spans must be unique"
        })
      });

      const unowned = runImmediateTransaction(connection, (context) => {
        return persistDerivedShortlistProposals(
          persistArgs(context, {
            proposals: [{ payload: PAYLOAD, evidenceSpanIds: ["evidence-span-missing"] }]
          })
        );
      });
      expect(unowned).toEqual({
        ok: false,
        error: expect.objectContaining({
          message: "Shortlist proposal evidence span is not associated with the candidate result"
        })
      });
    } finally {
      connection.close();
    }
  });

  it("returns the insert error when no matching shortlist exists after a failed insert", async () => {
    const connection = await openMigratedDatabase();
    try {
      const result = runImmediateTransaction(connection, (context) => {
        const seeded = seedScoredResult(context);
        if (!seeded.ok) {
          return seeded;
        }
        return persistDerivedShortlistProposals(
          persistArgs(context, {
            resultId: "missing-result",
            proposals: [{ payload: PAYLOAD, evidenceSpanIds: [] }]
          })
        );
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected insert failure");
      }
      expect(result.error.message).toMatch(/Proposal insert failed|stored candidate result/u);
    } finally {
      connection.close();
    }
  });

  it("rejects missing context, result id, and id generator", async () => {
    const connection = await openMigratedDatabase();
    try {
      expect(
        persistDerivedShortlistProposals(
          persistArgs(null as unknown as ImmediateTransactionContext)
        )
      ).toEqual({
        ok: false,
        error: expect.objectContaining({
          message: "Proposal rows require an active command transaction"
        })
      });
      expect(
        persistDerivedShortlistProposals({
          context: { nativeDatabase: null } as unknown as ImmediateTransactionContext,
          nextId: () => "id-1",
          createdAt: CREATED_AT,
          resultId: "candidate-result-1",
          proposals: []
        })
      ).toEqual({
        ok: false,
        error: expect.objectContaining({
          message: "Proposal rows require an active command transaction"
        })
      });
      expect(
        persistDerivedShortlistProposals({
          context: {
            nativeDatabase: { inTransaction: false }
          } as unknown as ImmediateTransactionContext,
          nextId: () => "id-1",
          createdAt: CREATED_AT,
          resultId: "candidate-result-1",
          proposals: []
        })
      ).toEqual({
        ok: false,
        error: expect.objectContaining({
          message: "Proposal rows require an active command transaction"
        })
      });

      unwrap(
        runImmediateTransaction(connection, (context) => {
          expect(
            persistDerivedShortlistProposals(persistArgs(context, { resultId: "" }))
          ).toEqual({
            ok: false,
            error: expect.objectContaining({
              message: "Shortlist persistence requires a candidate result id"
            })
          });
          expect(
            persistDerivedShortlistProposals(
              persistArgs(context, { resultId: 1 as unknown as string })
            )
          ).toEqual({
            ok: false,
            error: expect.objectContaining({
              message: "Shortlist persistence requires a candidate result id"
            })
          });
          expect(
            persistDerivedShortlistProposals(
              persistArgs(context, { nextId: "nope" as unknown as () => string })
            )
          ).toEqual({
            ok: false,
            error: expect.objectContaining({
              message: "Shortlist persistence requires an id generator"
            })
          });
          expect(
            persistDerivedShortlistProposals(
              persistArgs(context, {
                nextId: () => "not a valid id",
                proposals: [{ payload: PAYLOAD, evidenceSpanIds: [] }]
              })
            )
          ).toEqual({
            ok: false,
            error: expect.objectContaining({ message: "Invalid proposal input" })
          });
          return { ok: true as const, value: undefined };
        })
      );
    } finally {
      connection.close();
    }
  });

  it("returns a query error when owned-span or stored-shortlist reads fail", async () => {
    const throwingContext = {
      nativeDatabase: {
        inTransaction: true,
        prepare() {
          throw new Error("select failed");
        }
      }
    } as unknown as ImmediateTransactionContext;

    expect(persistDerivedShortlistProposals(persistArgs(throwingContext, { proposals: [] }))).toEqual(
      { ok: true, value: undefined }
    );
    expect(persistDerivedShortlistProposals(persistArgs(throwingContext))).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: expect.stringContaining("Failed to read candidate result evidence spans")
      })
    });

    const connection = await openMigratedDatabase();
    try {
      const result = runImmediateTransaction(connection, (context) => {
        const seeded = seedScoredResult(context);
        if (!seeded.ok) {
          return seeded;
        }
        unwrap(persistDerivedShortlistProposals(persistArgs(context)));
        const originalPrepare = context.nativeDatabase.prepare.bind(context.nativeDatabase);
        Object.defineProperty(context.nativeDatabase, "prepare", {
          configurable: true,
          value: (sql: string) => {
            if (sql.includes("FROM proposal") && sql.includes("shortlist_inclusion")) {
              throw new Error("replay select failed");
            }
            return originalPrepare(sql);
          }
        });
        return persistDerivedShortlistProposals(persistArgs(context));
      });
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          message: expect.stringContaining("Failed to read persisted shortlist proposal")
        })
      });
    } finally {
      connection.close();
    }
  });
});
