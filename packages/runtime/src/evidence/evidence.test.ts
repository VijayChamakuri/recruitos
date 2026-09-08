import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_JSON_MAX_NODES,
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
  insertSourceDocument,
  prepareActor,
  prepareSourceDocument,
  SYSTEM_ACTOR_ID
} from "../entities/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  insertExtractionRun,
  prepareExtractionRun,
  readExtractionRun
} from "../extraction/index.js";
import {
  DroppedQuoteSchema,
  insertDimensionAssessment,
  insertDimensionAssessmentEvidenceSpan,
  insertEvidenceGap,
  insertEvidenceSpan,
  MAXIMUM_DROP_REASON_LENGTH,
  MAXIMUM_EXTRACTOR_VERSION_LENGTH,
  MAXIMUM_MODEL_ID_LENGTH,
  MAXIMUM_QUOTED_TEXT_LENGTH,
  prepareDimensionAssessment,
  prepareDimensionAssessmentEvidenceSpan,
  prepareEvidenceGap,
  prepareEvidenceSpan,
  readDimensionAssessment,
  readDimensionAssessmentEvidenceSpan,
  readDimensionAssessmentSpanRefs,
  readEvidenceGap,
  readEvidenceSpan
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const DOCUMENT_TEXT = "ABCDEFGHIJ";
const SURROGATE_DOCUMENT_TEXT = "A\uD83D\uDE00B";
const FIXTURE_KEY = sha256Hex("extraction-fixture-key");
const TRANSACTION_REQUIRED =
  "Evidence and extraction rows require an active command transaction";
const EXTRACTION_TRANSACTION_REQUIRED =
  "Extraction spec rows require an active command transaction";

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-evidence-test-"));
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

function unwrap<T>(result: Result<T, RuntimeError>): T {
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

function droppedQuote(overrides: Record<string, unknown> = {}) {
  return {
    quotedText: "unlocated quote",
    dimensionId: "evaluation_practice",
    reason: "quote was not found in normalized text",
    ...overrides
  };
}

function extractionRunDraft(overrides: Record<string, unknown> = {}) {
  return {
    extractionRunId: "extraction-run-1",
    spansReturned: 3,
    spansLocated: 2,
    droppedQuotes: [droppedQuote()],
    modelId: "test-extractor",
    fixtureKey: FIXTURE_KEY,
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
    dimensionId: "evaluation_practice",
    polarity: "supporting",
    source: "extracted",
    matchQuality: "exact",
    extractorVersion: "extractor-v1",
    createdAt: CREATED_AT,
    ...overrides
  };
}

function evidenceGapDraft(overrides: Record<string, unknown> = {}) {
  return {
    evidenceGapId: "evidence-gap-1",
    dimensionId: "evaluation_practice",
    reasonCode: "missing_evidence:evaluation_practice",
    documentsSearched: ["source-document-1"],
    createdAt: CREATED_AT,
    ...overrides
  };
}

function dimensionAssessmentDraft(overrides: Record<string, unknown> = {}) {
  return {
    dimensionAssessmentId: "dimension-assessment-1",
    dimensionId: "evaluation_practice",
    level: "partial",
    source: "extracted",
    actorId: null,
    createdAt: CREATED_AT,
    ...overrides
  };
}

function associationDraft(overrides: Record<string, unknown> = {}) {
  return {
    dimensionAssessmentEvidenceSpanId: "dimension-assessment-evidence-span-1",
    dimensionAssessmentId: "dimension-assessment-1",
    evidenceSpanId: "evidence-span-1",
    spanOrdinal: 0,
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

function seedDocument(
  context: ImmediateTransactionContext,
  overrides: Record<string, unknown> = {}
): void {
  unwrap(insertSourceDocument(context, unwrap(prepareSourceDocument(sourceDocumentDraft(overrides)))));
}

function seedHumanActor(context: ImmediateTransactionContext): void {
  unwrap(insertActor(context, unwrap(prepareActor(actorDraft()))));
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("evidence and extraction preparation", () => {
  it("hashes dropped quotes and trims extractor identity fields", () => {
    const run = unwrap(
      prepareExtractionRun(
        extractionRunDraft({
          modelId: "  test-extractor  ",
          droppedQuotes: [droppedQuote({ reason: "  quote was not found in normalized text  " })]
        })
      )
    );
    expect(run.modelId).toBe("test-extractor");
    expect(run.droppedQuotes).toEqual([droppedQuote()]);
    expect(run.droppedQuotesJson).toBe(
      '[{"dimensionId":"evaluation_practice","quotedText":"unlocated quote","reason":"quote was not found in normalized text"}]'
    );
    expect(run.droppedQuotesHash).toBe(sha256Hex(run.droppedQuotesJson));
    expect(run.fixtureKey).toBe(FIXTURE_KEY);
    expect(Object.isFrozen(run)).toBe(true);

    const located = unwrap(
      prepareExtractionRun(
        extractionRunDraft({
          spansReturned: 2,
          spansLocated: 2,
          droppedQuotes: [],
          fixtureKey: null
        })
      )
    );
    expect(located.droppedQuotesJson).toBe("[]");
    expect(located.fixtureKey).toBeNull();
  });

  it("rejects extraction counters that cannot reproduce the resolution term", () => {
    expect(prepareExtractionRun(extractionRunDraft({ modelId: "   " }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid extraction run input" })
    });
    expect(
      prepareExtractionRun(extractionRunDraft({ spansReturned: 1, spansLocated: 2 }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Extraction run located spans cannot exceed returned spans"
      })
    });
    expect(
      prepareExtractionRun(
        extractionRunDraft({ spansReturned: 4, spansLocated: 2, droppedQuotes: [droppedQuote()] })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Extraction run dropped quotes must account for every unlocated span"
      })
    });
  });

  it("rejects dropped-quote sets that cannot be canonicalized", () => {
    const oversized = Array.from({ length: Math.ceil(CANONICAL_JSON_MAX_NODES / 4) }, (_, index) =>
      droppedQuote({ quotedText: `quote-${index}` })
    );
    expect(
      prepareExtractionRun(
        extractionRunDraft({
          spansReturned: oversized.length,
          spansLocated: 0,
          droppedQuotes: oversized
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Extraction run dropped quotes are not canonical JSON"
      })
    });
  });

  it("keeps quoted text untrimmed and rejects empty intervals", () => {
    const span = unwrap(
      prepareEvidenceSpan(
        evidenceSpanDraft({ quotedText: " CDE ", extractorVersion: "  extractor-v1  " })
      )
    );
    expect(span.quotedText).toBe(" CDE ");
    expect(span.extractorVersion).toBe("extractor-v1");
    expect(Object.isFrozen(span)).toBe(true);

    expect(prepareEvidenceSpan(evidenceSpanDraft({ polarity: "neutral" }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid evidence span input" })
    });
    expect(prepareEvidenceSpan(evidenceSpanDraft({ start: 4, end: 4, quotedText: "x" }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Evidence span end must exceed its start" })
    });
    expect(prepareEvidenceSpan(evidenceSpanDraft({ start: 5, end: 2, quotedText: "x" }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Evidence span end must exceed its start" })
    });
  });

  it("validates gap reason codes against the closed vocabulary", () => {
    const gap = unwrap(prepareEvidenceGap(evidenceGapDraft()));
    expect(gap.reasonCode).toBe("missing_evidence:evaluation_practice");
    expect(gap.documentsSearchedJson).toBe('["source-document-1"]');
    expect(gap.documentsSearchedHash).toBe(sha256Hex(gap.documentsSearchedJson));
    expect(Object.isFrozen(gap)).toBe(true);

    expect(prepareEvidenceGap(evidenceGapDraft({ reasonCode: "unknown_kind" }))).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Evidence gap reason code is not in the closed vocabulary"
      })
    });
    expect(prepareEvidenceGap(evidenceGapDraft({ documentsSearched: [] }))).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Evidence gap requires at least one searched document"
      })
    });
    expect(
      prepareEvidenceGap(
        evidenceGapDraft({ documentsSearched: ["source-document-1", "source-document-1"] })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Evidence gap searched documents must be unique"
      })
    });
    expect(prepareEvidenceGap(evidenceGapDraft({ evidenceGapId: "has space" }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid evidence gap input" })
    });
  });

  it("rejects searched-document lists that cannot be canonicalized", () => {
    const documentsSearched = Array.from(
      { length: CANONICAL_JSON_MAX_NODES },
      (_, index) => `source-document-${index}`
    );
    expect(
      prepareEvidenceGap(evidenceGapDraft({ documentsSearched }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Evidence gap searched documents are not canonical JSON"
      })
    });
  });

  it("requires a human actor exactly when the assessment source is human", () => {
    const extracted = unwrap(prepareDimensionAssessment(dimensionAssessmentDraft()));
    expect(extracted.actorId).toBeNull();
    expect(Object.isFrozen(extracted)).toBe(true);

    const human = unwrap(
      prepareDimensionAssessment(
        dimensionAssessmentDraft({
          dimensionAssessmentId: "dimension-assessment-human",
          source: "human",
          actorId: "actor-recruiter-1",
          level: "strong"
        })
      )
    );
    expect(human.source).toBe("human");
    expect(human.actorId).toBe("actor-recruiter-1");

    expect(
      prepareDimensionAssessment(dimensionAssessmentDraft({ source: "human", actorId: null }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Dimension assessment actor is required for human source and forbidden otherwise"
      })
    });
    expect(
      prepareDimensionAssessment(
        dimensionAssessmentDraft({ source: "extracted", actorId: "actor-recruiter-1" })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Dimension assessment actor is required for human source and forbidden otherwise"
      })
    });
    expect(prepareDimensionAssessment(dimensionAssessmentDraft({ level: "excellent" }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid dimension assessment input" })
    });
  });

  it("freezes assessment evidence associations", () => {
    const association = unwrap(prepareDimensionAssessmentEvidenceSpan(associationDraft()));
    expect(association.spanOrdinal).toBe(0);
    expect(Object.isFrozen(association)).toBe(true);
    expect(
      prepareDimensionAssessmentEvidenceSpan(associationDraft({ spanOrdinal: -1 }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Invalid dimension assessment evidence span input"
      })
    });
  });

  it("keeps dropped-quote objects strict", () => {
    expect(DroppedQuoteSchema.safeParse(droppedQuote()).success).toBe(true);
    expect(DroppedQuoteSchema.safeParse({ ...droppedQuote(), extra: true }).success).toBe(false);
    expect(
      DroppedQuoteSchema.safeParse(droppedQuote({ quotedText: "a".repeat(MAXIMUM_QUOTED_TEXT_LENGTH + 1) }))
        .success
    ).toBe(false);
    expect(
      DroppedQuoteSchema.safeParse(droppedQuote({ reason: "a".repeat(MAXIMUM_DROP_REASON_LENGTH + 1) }))
        .success
    ).toBe(false);
  });
});

describe("evidence and extraction persistence", () => {
  it("round-trips an extraction run, span, gap, assessment, and span refs", async () => {
    const connection = await openMigratedDatabase();

    const stored = unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        seedHumanActor(context);
        const run = unwrap(insertExtractionRun(context, unwrap(prepareExtractionRun(extractionRunDraft()))));
        const exact = unwrap(
          insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft())))
        );
        const normalized = unwrap(
          insertEvidenceSpan(
            context,
            unwrap(
              prepareEvidenceSpan(
                evidenceSpanDraft({
                  evidenceSpanId: "evidence-span-normalized",
                  start: 0,
                  end: 3,
                  quotedText: "abc",
                  matchQuality: "normalized",
                  polarity: "contradicting",
                  source: "human"
                })
              )
            )
          )
        );
        const gap = unwrap(insertEvidenceGap(context, unwrap(prepareEvidenceGap(evidenceGapDraft()))));
        const extracted = unwrap(
          insertDimensionAssessment(context, unwrap(prepareDimensionAssessment(dimensionAssessmentDraft())))
        );
        const human = unwrap(
          insertDimensionAssessment(
            context,
            unwrap(
              prepareDimensionAssessment(
                dimensionAssessmentDraft({
                  dimensionAssessmentId: "dimension-assessment-human",
                  source: "human",
                  actorId: "actor-recruiter-1",
                  level: "strong"
                })
              )
            )
          )
        );
        unwrap(
          insertDimensionAssessmentEvidenceSpan(
            context,
            unwrap(prepareDimensionAssessmentEvidenceSpan(associationDraft()))
          )
        );
        unwrap(
          insertDimensionAssessmentEvidenceSpan(
            context,
            unwrap(
              prepareDimensionAssessmentEvidenceSpan(
                associationDraft({
                  dimensionAssessmentEvidenceSpanId: "dimension-assessment-evidence-span-2",
                  evidenceSpanId: "evidence-span-normalized",
                  spanOrdinal: 1
                })
              )
            )
          )
        );
        return ok({ run, exact, normalized, gap, extracted, human });
      })
    );

    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(unwrap(readExtractionRun(context, stored.run.extractionRunId))).toEqual(stored.run);
        expect(unwrap(readEvidenceSpan(context, stored.exact.evidenceSpanId))).toEqual(stored.exact);
        expect(unwrap(readEvidenceSpan(context, stored.normalized.evidenceSpanId))).toEqual(
          stored.normalized
        );
        expect(unwrap(readEvidenceGap(context, stored.gap.evidenceGapId))).toEqual(stored.gap);
        expect(unwrap(readDimensionAssessment(context, stored.extracted.dimensionAssessmentId))).toEqual(
          stored.extracted
        );
        expect(unwrap(readDimensionAssessment(context, stored.human.dimensionAssessmentId))).toEqual(
          stored.human
        );
        expect(
          unwrap(readDimensionAssessmentEvidenceSpan(context, "dimension-assessment-evidence-span-1"))
            ?.evidenceSpanId
        ).toBe("evidence-span-1");
        expect(unwrap(readDimensionAssessmentSpanRefs(context, "dimension-assessment-1"))).toEqual([
          "evidence-span-1",
          "evidence-span-normalized"
        ]);
        expect(unwrap(readDimensionAssessmentSpanRefs(context, "dimension-assessment-human"))).toEqual(
          []
        );
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("returns undefined rather than an error for a row that does not exist", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(unwrap(readExtractionRun(context, "missing-run"))).toBeUndefined();
        expect(unwrap(readEvidenceSpan(context, "missing-span"))).toBeUndefined();
        expect(unwrap(readEvidenceGap(context, "missing-gap"))).toBeUndefined();
        expect(unwrap(readDimensionAssessment(context, "missing-assessment"))).toBeUndefined();
        expect(
          unwrap(readDimensionAssessmentEvidenceSpan(context, "missing-association"))
        ).toBeUndefined();
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("rejects malformed identifiers on every read", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(readExtractionRun(context, "")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid extraction run ID" })
        });
        expect(readEvidenceSpan(context, 42)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid evidence span ID" })
        });
        expect(readEvidenceGap(context, "has space")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid evidence gap ID" })
        });
        expect(readDimensionAssessment(context, null)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid dimension assessment ID" })
        });
        expect(readDimensionAssessmentEvidenceSpan(context, "has space")).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Invalid dimension assessment evidence span ID"
          })
        });
        expect(readDimensionAssessmentSpanRefs(context, "")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid dimension assessment ID" })
        });
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("refuses every read and write outside an active transaction", async () => {
    const connection = await openMigratedDatabase();
    const contexts = [undefined, null, {}, { nativeDatabase: null }];
    const extractionWrites = [
      [insertExtractionRun, unwrap(prepareExtractionRun(extractionRunDraft()))]
    ] as const;
    const writes = [
      [insertEvidenceSpan, unwrap(prepareEvidenceSpan(evidenceSpanDraft()))],
      [insertEvidenceGap, unwrap(prepareEvidenceGap(evidenceGapDraft()))],
      [insertDimensionAssessment, unwrap(prepareDimensionAssessment(dimensionAssessmentDraft()))],
      [
        insertDimensionAssessmentEvidenceSpan,
        unwrap(prepareDimensionAssessmentEvidenceSpan(associationDraft()))
      ]
    ] as const;
    const extractionReads = [[readExtractionRun, "extraction-run-1"]] as const;
    const reads = [
      [readEvidenceSpan, "evidence-span-1"],
      [readEvidenceGap, "evidence-gap-1"],
      [readDimensionAssessment, "dimension-assessment-1"],
      [readDimensionAssessmentEvidenceSpan, "dimension-assessment-evidence-span-1"],
      [readDimensionAssessmentSpanRefs, "dimension-assessment-1"]
    ] as const;

    for (const context of contexts) {
      for (const [insert, prepared] of extractionWrites) {
        expect(insert(context, prepared)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: EXTRACTION_TRANSACTION_REQUIRED })
        });
      }
      for (const [insert, prepared] of writes) {
        expect(insert(context, prepared)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
        });
      }
      for (const [read, id] of extractionReads) {
        expect(read(context, id)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: EXTRACTION_TRANSACTION_REQUIRED })
        });
      }
      for (const [read, id] of reads) {
        expect(read(context, id)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
        });
      }
    }

    expect(connection.close().ok).toBe(true);
  });

  it("refuses records the runtime did not prepare, including cross-entity records", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        const run = unwrap(prepareExtractionRun(extractionRunDraft()));
        const span = unwrap(prepareEvidenceSpan(evidenceSpanDraft()));
        const gap = unwrap(prepareEvidenceGap(evidenceGapDraft()));
        const assessment = unwrap(prepareDimensionAssessment(dimensionAssessmentDraft()));
        const association = unwrap(prepareDimensionAssessmentEvidenceSpan(associationDraft()));

        expect(insertExtractionRun(context, { ...run })).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared extraction run" })
        });
        expect(insertExtractionRun(context, span)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared extraction run" })
        });
        expect(insertEvidenceSpan(context, { ...span })).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared evidence span" })
        });
        expect(insertEvidenceSpan(context, run)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared evidence span" })
        });
        expect(insertEvidenceGap(context, { ...gap })).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared evidence gap" })
        });
        expect(insertEvidenceGap(context, assessment)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared evidence gap" })
        });
        expect(insertDimensionAssessment(context, { ...assessment })).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared dimension assessment" })
        });
        expect(insertDimensionAssessment(context, association)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared dimension assessment" })
        });
        expect(insertDimensionAssessmentEvidenceSpan(context, { ...association })).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Invalid prepared dimension assessment evidence span"
          })
        });
        expect(insertDimensionAssessmentEvidenceSpan(context, gap)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Invalid prepared dimension assessment evidence span"
          })
        });
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("rolls back every evidence and extraction row when the command fails", async () => {
    const connection = await openMigratedDatabase();

    const failed = runImmediateTransaction<never>(connection, (context) => {
      seedDocument(context);
      unwrap(insertExtractionRun(context, unwrap(prepareExtractionRun(extractionRunDraft()))));
      unwrap(insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft()))));
      unwrap(insertEvidenceGap(context, unwrap(prepareEvidenceGap(evidenceGapDraft()))));
      unwrap(
        insertDimensionAssessment(context, unwrap(prepareDimensionAssessment(dimensionAssessmentDraft())))
      );
      unwrap(
        insertDimensionAssessmentEvidenceSpan(
          context,
          unwrap(prepareDimensionAssessmentEvidenceSpan(associationDraft()))
        )
      );
      return err(createRuntimeError("command_conflict", "Command rejected", false));
    });

    expect(failed).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "command_conflict" })
    });

    for (const table of [
      "extraction_run",
      "evidence_span",
      "evidence_gap",
      "dimension_assessment",
      "dimension_assessment_evidence_span",
      "source_document"
    ]) {
      expect(
        nativeDatabase(connection).prepare(`SELECT count(*) AS total FROM ${table}`).get()
      ).toEqual({ total: 0 });
    }

    expect(connection.close().ok).toBe(true);
  });
});

describe("evidence and extraction write boundaries", () => {
  it("rejects an exact span whose quote is not a slice of the document", async () => {
    const connection = await openMigratedDatabase();

    expect(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        return insertEvidenceSpan(
          context,
          unwrap(prepareEvidenceSpan(evidenceSpanDraft({ quotedText: "XYZ" })))
        );
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Exact evidence span quote is not a slice of the document"
      })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects span offsets that split a surrogate pair", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context, {
          sourceDocumentId: "source-document-surrogate",
          rawText: SURROGATE_DOCUMENT_TEXT,
          normalizedText: SURROGATE_DOCUMENT_TEXT
        });
        return ok(undefined);
      })
    );

    expect(
      runImmediateTransaction(connection, (context) =>
        insertEvidenceSpan(
          context,
          unwrap(
            prepareEvidenceSpan(
              evidenceSpanDraft({
                documentId: "source-document-surrogate",
                start: 1,
                end: 2,
                quotedText: "\uD83D",
                matchQuality: "fuzzy"
              })
            )
          )
        )
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Evidence span offsets do not address the stored document"
      })
    });

    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(
          insertEvidenceSpan(
            context,
            unwrap(
              prepareEvidenceSpan(
                evidenceSpanDraft({
                  evidenceSpanId: "evidence-span-emoji",
                  documentId: "source-document-surrogate",
                  start: 1,
                  end: 3,
                  quotedText: "\uD83D\uDE00",
                  matchQuality: "exact"
                })
              )
            )
          )
        );
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a span or gap whose source document is not stored", async () => {
    const connection = await openMigratedDatabase();

    expect(
      runImmediateTransaction(connection, (context) =>
        insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft())))
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Evidence span requires a stored source document"
      })
    });

    expect(
      runImmediateTransaction(connection, (context) =>
        insertEvidenceGap(context, unwrap(prepareEvidenceGap(evidenceGapDraft())))
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Evidence gap requires stored searched source documents"
      })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a human assessment whose actor is not stored", async () => {
    const connection = await openMigratedDatabase();

    expect(
      runImmediateTransaction(connection, (context) =>
        insertDimensionAssessment(
          context,
          unwrap(
            prepareDimensionAssessment(
              dimensionAssessmentDraft({
                source: "human",
                actorId: "actor-recruiter-1"
              })
            )
          )
        )
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Dimension assessment insert failed" })
    });

    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(
          insertDimensionAssessment(
            context,
            unwrap(
              prepareDimensionAssessment(
                dimensionAssessmentDraft({
                  source: "human",
                  actorId: SYSTEM_ACTOR_ID
                })
              )
            )
          )
        );
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("rejects assessment evidence that is missing or for a different dimension", async () => {
    const connection = await openMigratedDatabase();

    expect(
      runImmediateTransaction(connection, (context) =>
        insertDimensionAssessmentEvidenceSpan(
          context,
          unwrap(prepareDimensionAssessmentEvidenceSpan(associationDraft()))
        )
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Dimension assessment evidence requires a stored assessment and span"
      })
    });

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        unwrap(insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft()))));
        unwrap(
          insertDimensionAssessment(context, unwrap(prepareDimensionAssessment(dimensionAssessmentDraft())))
        );
        unwrap(
          insertEvidenceSpan(
            context,
            unwrap(
              prepareEvidenceSpan(
                evidenceSpanDraft({
                  evidenceSpanId: "evidence-span-other-dimension",
                  start: 0,
                  end: 3,
                  quotedText: "ABC",
                  dimensionId: "work_authorization"
                })
              )
            )
          )
        );
        return ok(undefined);
      })
    );

    expect(
      runImmediateTransaction(connection, (context) =>
        insertDimensionAssessmentEvidenceSpan(
          context,
          unwrap(prepareDimensionAssessmentEvidenceSpan(associationDraft()))
        )
      )
    ).toMatchObject({ ok: true });

    expect(
      runImmediateTransaction(connection, (context) =>
        insertDimensionAssessmentEvidenceSpan(
          context,
          unwrap(
            prepareDimensionAssessmentEvidenceSpan(
              associationDraft({
                dimensionAssessmentEvidenceSpanId: "dimension-assessment-evidence-span-other",
                evidenceSpanId: "evidence-span-other-dimension",
                spanOrdinal: 1
              })
            )
          )
        )
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Dimension assessment evidence must share the assessed dimension"
      })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a second row that reuses an identity or association key", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        unwrap(insertExtractionRun(context, unwrap(prepareExtractionRun(extractionRunDraft()))));
        unwrap(insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft()))));
        unwrap(insertEvidenceGap(context, unwrap(prepareEvidenceGap(evidenceGapDraft()))));
        unwrap(
          insertDimensionAssessment(context, unwrap(prepareDimensionAssessment(dimensionAssessmentDraft())))
        );
        unwrap(
          insertDimensionAssessmentEvidenceSpan(
            context,
            unwrap(prepareDimensionAssessmentEvidenceSpan(associationDraft()))
          )
        );
        return ok(undefined);
      })
    );

    expect(
      runImmediateTransaction(connection, (context) =>
        insertExtractionRun(
          context,
          unwrap(prepareExtractionRun(extractionRunDraft({ modelId: "other-extractor" })))
        )
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Extraction run insert failed" })
    });
    expect(
      runImmediateTransaction(connection, (context) =>
        insertEvidenceSpan(
          context,
          unwrap(prepareEvidenceSpan(evidenceSpanDraft({ quotedText: "CDE" })))
        )
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Evidence span insert failed" })
    });
    expect(
      runImmediateTransaction(connection, (context) =>
        insertEvidenceGap(
          context,
          unwrap(prepareEvidenceGap(evidenceGapDraft({ reasonCode: "parse_failure" })))
        )
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Evidence gap insert failed" })
    });
    expect(
      runImmediateTransaction(connection, (context) =>
        insertDimensionAssessment(
          context,
          unwrap(prepareDimensionAssessment(dimensionAssessmentDraft({ level: "none" })))
        )
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Dimension assessment insert failed" })
    });
    expect(
      runImmediateTransaction(connection, (context) =>
        insertDimensionAssessmentEvidenceSpan(
          context,
          unwrap(
            prepareDimensionAssessmentEvidenceSpan(
              associationDraft({
                dimensionAssessmentEvidenceSpanId: "dimension-assessment-evidence-span-other",
                spanOrdinal: 0
              })
            )
          )
        )
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Dimension assessment evidence span insert failed"
      })
    });

    expect(connection.close().ok).toBe(true);
  });
});

describe("evidence and extraction database constraints", () => {
  it("rejects updates, deletes, and replacements of stored rows", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        unwrap(insertExtractionRun(context, unwrap(prepareExtractionRun(extractionRunDraft()))));
        unwrap(insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft()))));
        unwrap(insertEvidenceGap(context, unwrap(prepareEvidenceGap(evidenceGapDraft()))));
        unwrap(
          insertDimensionAssessment(context, unwrap(prepareDimensionAssessment(dimensionAssessmentDraft())))
        );
        unwrap(
          insertDimensionAssessmentEvidenceSpan(
            context,
            unwrap(prepareDimensionAssessmentEvidenceSpan(associationDraft()))
          )
        );
        return ok(undefined);
      })
    );

    expect(() =>
      database.prepare("UPDATE extraction_run SET model_id = 'tampered' WHERE extraction_run_id = ?").run(
        "extraction-run-1"
      )
    ).toThrow(/extraction_run is immutable/u);
    expect(() =>
      database.prepare("DELETE FROM extraction_run WHERE extraction_run_id = ?").run("extraction-run-1")
    ).toThrow(/extraction_run is immutable/u);
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO extraction_run (
            extraction_run_id, spans_returned, spans_located, dropped_quotes_json,
            dropped_quotes_hash, model_id, fixture_key, created_at
          ) VALUES (?, 2, 2, '[]', ?, 'other', NULL, 1)`
        )
        .run("extraction-run-1", sha256Hex("[]"))
    ).toThrow(/extraction_run is immutable/u);

    expect(() =>
      database.prepare("UPDATE evidence_span SET polarity = 'contradicting' WHERE evidence_span_id = ?").run(
        "evidence-span-1"
      )
    ).toThrow(/evidence_span is immutable/u);
    expect(() =>
      database.prepare("DELETE FROM evidence_span WHERE evidence_span_id = ?").run("evidence-span-1")
    ).toThrow(/evidence_span is immutable/u);
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO evidence_span (
            evidence_span_id, document_id, start, end, quoted_text, dimension_id,
            polarity, source, match_quality, extractor_version, created_at
          ) VALUES (?, 'source-document-1', 0, 3, 'ABC', 'evaluation_practice',
            'supporting', 'extracted', 'exact', 'extractor-v1', 1)`
        )
        .run("evidence-span-1")
    ).toThrow(/evidence_span is immutable/u);

    expect(() =>
      database.prepare("UPDATE evidence_gap SET reason_code = 'parse_failure' WHERE evidence_gap_id = ?").run(
        "evidence-gap-1"
      )
    ).toThrow(/evidence_gap is immutable/u);
    expect(() =>
      database.prepare("DELETE FROM evidence_gap WHERE evidence_gap_id = ?").run("evidence-gap-1")
    ).toThrow(/evidence_gap is immutable/u);

    expect(() =>
      database
        .prepare("UPDATE dimension_assessment SET level = 'none' WHERE dimension_assessment_id = ?")
        .run("dimension-assessment-1")
    ).toThrow(/dimension_assessment is immutable/u);
    expect(() =>
      database
        .prepare("DELETE FROM dimension_assessment WHERE dimension_assessment_id = ?")
        .run("dimension-assessment-1")
    ).toThrow(/dimension_assessment is immutable/u);

    expect(() =>
      database
        .prepare(
          "UPDATE dimension_assessment_evidence_span SET span_ordinal = 9 WHERE dimension_assessment_evidence_span_id = ?"
        )
        .run("dimension-assessment-evidence-span-1")
    ).toThrow(/dimension_assessment_evidence_span is immutable/u);
    expect(() =>
      database
        .prepare(
          "DELETE FROM dimension_assessment_evidence_span WHERE dimension_assessment_evidence_span_id = ?"
        )
        .run("dimension-assessment-evidence-span-1")
    ).toThrow(/dimension_assessment_evidence_span is immutable/u);
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO dimension_assessment_evidence_span (
            dimension_assessment_evidence_span_id, dimension_assessment_id,
            evidence_span_id, span_ordinal, created_at
          ) VALUES (?, 'dimension-assessment-1', 'evidence-span-1', 0, 1)`
        )
        .run("dimension-assessment-evidence-span-1")
    ).toThrow(/dimension_assessment_evidence_span is immutable/u);

    expect(connection.close().ok).toBe(true);
  });

  it("rejects empty searched documents, empty intervals, and mismatched dropped quotes", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        return ok(undefined);
      })
    );

    expect(() =>
      database
        .prepare(
          `INSERT INTO extraction_run (
            extraction_run_id, spans_returned, spans_located, dropped_quotes_json,
            dropped_quotes_hash, model_id, fixture_key, created_at
          ) VALUES ('extraction-run-mismatch', 2, 0, '[]', ?, 'test-extractor', NULL, ?)`
        )
        .run(sha256Hex("[]"), CREATED_AT)
    ).toThrow(/CHECK constraint failed/u);

    expect(() =>
      database
        .prepare(
          `INSERT INTO evidence_span (
            evidence_span_id, document_id, start, end, quoted_text, dimension_id,
            polarity, source, match_quality, extractor_version, created_at
          ) VALUES ('evidence-span-empty', 'source-document-1', 2, 2, 'x',
            'evaluation_practice', 'supporting', 'extracted', 'exact', 'extractor-v1', ?)`
        )
        .run(CREATED_AT)
    ).toThrow(/CHECK constraint failed/u);

    expect(() =>
      database
        .prepare(
          `INSERT INTO evidence_gap (
            evidence_gap_id, dimension_id, reason_code, documents_searched_json,
            documents_searched_hash, created_at
          ) VALUES ('evidence-gap-empty', 'evaluation_practice', 'parse_failure', '[]', ?, ?)`
        )
        .run(sha256Hex("[]"), CREATED_AT)
    ).toThrow(/CHECK constraint failed/u);

    expect(() =>
      database
        .prepare(
          `INSERT INTO dimension_assessment (
            dimension_assessment_id, dimension_id, level, source, actor_id, created_at
          ) VALUES ('dimension-assessment-human', 'evaluation_practice', 'strong', 'human', NULL, ?)`
        )
        .run(CREATED_AT)
    ).toThrow(/CHECK constraint failed/u);

    expect(connection.close().ok).toBe(true);
  });

  it("keeps parent rows while children exist", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        seedHumanActor(context);
        unwrap(insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft()))));
        unwrap(
          insertDimensionAssessment(
            context,
            unwrap(
              prepareDimensionAssessment(
                dimensionAssessmentDraft({ source: "human", actorId: "actor-recruiter-1" })
              )
            )
          )
        );
        unwrap(
          insertDimensionAssessmentEvidenceSpan(
            context,
            unwrap(prepareDimensionAssessmentEvidenceSpan(associationDraft()))
          )
        );
        return ok(undefined);
      })
    );

    database.exec("DROP TRIGGER source_document_reject_delete");
    expect(() =>
      database.prepare("DELETE FROM source_document WHERE source_document_id = ?").run("source-document-1")
    ).toThrow(/FOREIGN KEY constraint failed/u);

    database.exec("DROP TRIGGER actor_reject_delete");
    expect(() =>
      database.prepare("DELETE FROM actor WHERE actor_id = ?").run("actor-recruiter-1")
    ).toThrow(/FOREIGN KEY constraint failed/u);

    database.exec("DROP TRIGGER evidence_span_reject_delete");
    expect(() =>
      database.prepare("DELETE FROM evidence_span WHERE evidence_span_id = ?").run("evidence-span-1")
    ).toThrow(/FOREIGN KEY constraint failed/u);

    database.exec("DROP TRIGGER dimension_assessment_reject_delete");
    expect(() =>
      database
        .prepare("DELETE FROM dimension_assessment WHERE dimension_assessment_id = ?")
        .run("dimension-assessment-1")
    ).toThrow(/FOREIGN KEY constraint failed/u);

    expect(connection.close().ok).toBe(true);
  });
});

describe("evidence and extraction migration", () => {
  it("creates every evidence and extraction table and trigger exactly once", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    expect(connection.migrate()).toEqual({ ok: true, value: undefined });

    expect(
      database
        .prepare(
          `SELECT count(*) AS total
           FROM sqlite_schema
           WHERE type = 'table'
             AND name IN (
               'extraction_run',
               'evidence_span',
               'evidence_gap',
               'dimension_assessment',
               'dimension_assessment_evidence_span'
             )`
        )
        .get()
    ).toEqual({ total: 5 });

    expect(
      database
        .prepare(
          `SELECT count(*) AS total
           FROM sqlite_schema
           WHERE type = 'trigger'
             AND tbl_name IN (
               'extraction_run',
               'evidence_span',
               'evidence_gap',
               'dimension_assessment',
               'dimension_assessment_evidence_span'
             )`
        )
        .get()
    ).toEqual({ total: 15 });

    expect(connection.close().ok).toBe(true);
  });

  it("declares every evidence and extraction table STRICT", async () => {
    const connection = await openMigratedDatabase();

    for (const table of [
      "extraction_run",
      "evidence_span",
      "evidence_gap",
      "dimension_assessment",
      "dimension_assessment_evidence_span"
    ]) {
      expect(
        nativeDatabase(connection)
          .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(table)
      ).toEqual({ sql: expect.stringContaining("STRICT") });
    }

    expect(connection.close().ok).toBe(true);
  });
});

describe("evidence and extraction boundary failures", () => {
  it("converts hostile draft getters into typed preparation errors", () => {
    expect(prepareExtractionRun(withThrowingGetter(extractionRunDraft(), "extractionRunId"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Extraction run preparation failed" })
    });
    expect(prepareEvidenceSpan(withThrowingGetter(evidenceSpanDraft(), "evidenceSpanId"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Evidence span preparation failed" })
    });
    expect(prepareEvidenceGap(withThrowingGetter(evidenceGapDraft(), "evidenceGapId"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Evidence gap preparation failed" })
    });
    expect(
      prepareDimensionAssessment(withThrowingGetter(dimensionAssessmentDraft(), "dimensionAssessmentId"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Dimension assessment preparation failed" })
    });
    expect(
      prepareDimensionAssessmentEvidenceSpan(
        withThrowingGetter(associationDraft(), "dimensionAssessmentEvidenceSpanId")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Dimension assessment evidence span preparation failed"
      })
    });
  });

  it("converts a failing database read into a typed error", () => {
    const context = failingContext();
    expect(readExtractionRun(context, "extraction-run-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Extraction run read failed" })
    });
    expect(readEvidenceSpan(context, "evidence-span-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Evidence span read failed" })
    });
    expect(readEvidenceGap(context, "evidence-gap-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Evidence gap read failed" })
    });
    expect(readDimensionAssessment(context, "dimension-assessment-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Dimension assessment read failed" })
    });
    expect(readDimensionAssessmentEvidenceSpan(context, "dimension-assessment-evidence-span-1")).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Dimension assessment evidence span read failed"
      })
    });
    expect(readDimensionAssessmentSpanRefs(context, "dimension-assessment-1")).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Dimension assessment evidence span read failed"
      })
    });
  });

  it("converts a failing database write into a typed error", () => {
    const context = failingContext();
    expect(insertExtractionRun(context, unwrap(prepareExtractionRun(extractionRunDraft())))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Extraction run insert failed" })
    });
    expect(insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft())))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Evidence span insert failed" })
    });
    expect(insertEvidenceGap(context, unwrap(prepareEvidenceGap(evidenceGapDraft())))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Evidence gap insert failed" })
    });
    expect(
      insertDimensionAssessment(context, unwrap(prepareDimensionAssessment(dimensionAssessmentDraft())))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Dimension assessment insert failed" })
    });
    expect(
      insertDimensionAssessmentEvidenceSpan(
        context,
        unwrap(prepareDimensionAssessmentEvidenceSpan(associationDraft()))
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Dimension assessment evidence span insert failed"
      })
    });
  });

  it("converts a failing document lookup during span insert into a typed error", () => {
    expect(
      insertEvidenceSpan(
        failingContext((sql) => {
          if (sql.includes("FROM source_document")) {
            throw new Error("disk I/O error");
          }
          return { run() {} };
        }),
        unwrap(prepareEvidenceSpan(evidenceSpanDraft()))
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Evidence span insert failed" })
    });
  });
});

describe("stored evidence and extraction validation", () => {
  it("rejects a stored extraction run whose identity field is out of domain range", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertExtractionRun(context, unwrap(prepareExtractionRun(extractionRunDraft()))));
        return ok(undefined);
      })
    );

    database.exec("DROP TRIGGER extraction_run_reject_update");
    database
      .prepare("UPDATE extraction_run SET model_id = ? WHERE extraction_run_id = ?")
      .run("\u{1F600}".repeat(150), "extraction-run-1");

    expect(
      runImmediateTransaction(connection, (context) => readExtractionRun(context, "extraction-run-1"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored extraction run is invalid" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored dropped quotes that fail integrity validation", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertExtractionRun(context, unwrap(prepareExtractionRun(extractionRunDraft()))));
        return ok(undefined);
      })
    );

    database.exec("DROP TRIGGER extraction_run_reject_update");
    database
      .prepare("UPDATE extraction_run SET dropped_quotes_hash = ? WHERE extraction_run_id = ?")
      .run("a".repeat(64), "extraction-run-1");

    expect(
      runImmediateTransaction(connection, (context) => readExtractionRun(context, "extraction-run-1"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction run failed integrity validation"
      })
    });

    const nonCanonical = "[ 1 ]";
    database
      .prepare(
        `UPDATE extraction_run
         SET dropped_quotes_json = ?, dropped_quotes_hash = ?, spans_returned = 1, spans_located = 0
         WHERE extraction_run_id = ?`
      )
      .run(nonCanonical, sha256Hex(nonCanonical), "extraction-run-1");

    expect(
      runImmediateTransaction(connection, (context) => readExtractionRun(context, "extraction-run-1"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction run failed integrity validation"
      })
    });

    const unsafeNumber = "[9007199254740993]";
    database
      .prepare(
        `UPDATE extraction_run
         SET dropped_quotes_json = ?, dropped_quotes_hash = ?, spans_returned = 1, spans_located = 0
         WHERE extraction_run_id = ?`
      )
      .run(unsafeNumber, sha256Hex(unsafeNumber), "extraction-run-1");

    expect(
      runImmediateTransaction(connection, (context) => readExtractionRun(context, "extraction-run-1"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction run failed integrity validation"
      })
    });

    const malformedQuotes = '["not-an-object"]';
    database
      .prepare(
        `UPDATE extraction_run
         SET dropped_quotes_json = ?, dropped_quotes_hash = ?, spans_returned = 1, spans_located = 0
         WHERE extraction_run_id = ?`
      )
      .run(malformedQuotes, sha256Hex(malformedQuotes), "extraction-run-1");

    expect(
      runImmediateTransaction(connection, (context) => readExtractionRun(context, "extraction-run-1"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored extraction run is invalid" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored dropped quotes that are not valid JSON", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertExtractionRun(context, unwrap(prepareExtractionRun(extractionRunDraft()))));
        return ok(undefined);
      })
    );

    database.exec(`
      CREATE TABLE extraction_run_rebuilt (
        extraction_run_id text PRIMARY KEY NOT NULL,
        spans_returned integer NOT NULL,
        spans_located integer NOT NULL,
        dropped_quotes_json text NOT NULL,
        dropped_quotes_hash text NOT NULL,
        model_id text NOT NULL,
        fixture_key text,
        created_at integer NOT NULL
      ) STRICT;
      INSERT INTO extraction_run_rebuilt SELECT * FROM extraction_run;
      DROP TABLE extraction_run;
      ALTER TABLE extraction_run_rebuilt RENAME TO extraction_run;
    `);
    database
      .prepare("UPDATE extraction_run SET dropped_quotes_json = ?, dropped_quotes_hash = ?")
      .run("{", sha256Hex("{"));

    expect(
      runImmediateTransaction(connection, (context) => readExtractionRun(context, "extraction-run-1"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction run dropped quotes are not valid JSON"
      })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a stored span whose quoted text is out of domain range", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        unwrap(insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft()))));
        return ok(undefined);
      })
    );

    database.exec("DROP TRIGGER evidence_span_reject_update");
    database
      .prepare("UPDATE evidence_span SET quoted_text = ? WHERE evidence_span_id = ?")
      .run("\u{1F600}".repeat(200), "evidence-span-1");

    expect(
      runImmediateTransaction(connection, (context) => readEvidenceSpan(context, "evidence-span-1"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored evidence span is invalid" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a stored gap whose reason code leaves the closed vocabulary", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        unwrap(insertEvidenceGap(context, unwrap(prepareEvidenceGap(evidenceGapDraft()))));
        return ok(undefined);
      })
    );

    database.exec("DROP TRIGGER evidence_gap_reject_update");
    database
      .prepare("UPDATE evidence_gap SET reason_code = ? WHERE evidence_gap_id = ?")
      .run("unknown_kind", "evidence-gap-1");

    expect(
      runImmediateTransaction(connection, (context) => readEvidenceGap(context, "evidence-gap-1"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored evidence gap reason code is outside the closed vocabulary"
      })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored searched documents that fail integrity or domain validation", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        unwrap(insertEvidenceGap(context, unwrap(prepareEvidenceGap(evidenceGapDraft()))));
        return ok(undefined);
      })
    );

    database.exec("DROP TRIGGER evidence_gap_reject_update");
    database
      .prepare("UPDATE evidence_gap SET documents_searched_hash = ? WHERE evidence_gap_id = ?")
      .run("a".repeat(64), "evidence-gap-1");

    expect(
      runImmediateTransaction(connection, (context) => readEvidenceGap(context, "evidence-gap-1"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored evidence gap failed integrity validation"
      })
    });

    const invalidIds = '[""]';
    database
      .prepare(
        `UPDATE evidence_gap
         SET documents_searched_json = ?, documents_searched_hash = ?
         WHERE evidence_gap_id = ?`
      )
      .run(invalidIds, sha256Hex(invalidIds), "evidence-gap-1");

    expect(
      runImmediateTransaction(connection, (context) => readEvidenceGap(context, "evidence-gap-1"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored evidence gap is invalid" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored searched documents that are not valid JSON", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        unwrap(insertEvidenceGap(context, unwrap(prepareEvidenceGap(evidenceGapDraft()))));
        return ok(undefined);
      })
    );

    database.exec(`
      CREATE TABLE evidence_gap_rebuilt (
        evidence_gap_id text PRIMARY KEY NOT NULL,
        dimension_id text NOT NULL,
        reason_code text NOT NULL,
        documents_searched_json text NOT NULL,
        documents_searched_hash text NOT NULL,
        created_at integer NOT NULL
      ) STRICT;
      INSERT INTO evidence_gap_rebuilt SELECT * FROM evidence_gap;
      DROP TABLE evidence_gap;
      ALTER TABLE evidence_gap_rebuilt RENAME TO evidence_gap;
    `);
    database
      .prepare("UPDATE evidence_gap SET documents_searched_json = ?, documents_searched_hash = ?")
      .run("{", sha256Hex("{"));

    expect(
      runImmediateTransaction(connection, (context) => readEvidenceGap(context, "evidence-gap-1"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored evidence gap searched documents are not valid JSON"
      })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a stored assessment whose dimension id is out of domain range", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(
          insertDimensionAssessment(context, unwrap(prepareDimensionAssessment(dimensionAssessmentDraft())))
        );
        return ok(undefined);
      })
    );

    database.exec("DROP TRIGGER dimension_assessment_reject_update");
    database
      .prepare("UPDATE dimension_assessment SET dimension_id = ? WHERE dimension_assessment_id = ?")
      .run("has space", "dimension-assessment-1");

    expect(
      runImmediateTransaction(connection, (context) =>
        readDimensionAssessment(context, "dimension-assessment-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored dimension assessment is invalid" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored assessment evidence whose identifiers or ordinals are invalid", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        unwrap(insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft()))));
        unwrap(
          insertDimensionAssessment(context, unwrap(prepareDimensionAssessment(dimensionAssessmentDraft())))
        );
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
        unwrap(
          insertDimensionAssessmentEvidenceSpan(
            context,
            unwrap(prepareDimensionAssessmentEvidenceSpan(associationDraft()))
          )
        );
        unwrap(
          insertDimensionAssessmentEvidenceSpan(
            context,
            unwrap(
              prepareDimensionAssessmentEvidenceSpan(
                associationDraft({
                  dimensionAssessmentEvidenceSpanId: "dimension-assessment-evidence-span-2",
                  evidenceSpanId: "evidence-span-2",
                  spanOrdinal: 2
                })
              )
            )
          )
        );
        return ok(undefined);
      })
    );

    expect(
      runImmediateTransaction(connection, (context) =>
        readDimensionAssessmentSpanRefs(context, "dimension-assessment-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Dimension assessment span ordinals must be contiguous from 0"
      })
    });

    database.exec("DROP TRIGGER dimension_assessment_evidence_span_reject_update");
    database.exec("DROP INDEX dimension_assessment_evidence_span_unique");
    database
      .prepare(
        `INSERT INTO evidence_span (
          evidence_span_id, document_id, start, end, quoted_text, dimension_id,
          polarity, source, match_quality, extractor_version, created_at
        ) VALUES ('has space', 'source-document-1', 0, 3, 'ABC', 'evaluation_practice',
          'supporting', 'extracted', 'exact', 'extractor-v1', ?)`
      )
      .run(CREATED_AT);
    database
      .prepare(
        "UPDATE dimension_assessment_evidence_span SET evidence_span_id = ? WHERE span_ordinal = 0"
      )
      .run("has space");

    expect(
      runImmediateTransaction(connection, (context) =>
        readDimensionAssessmentEvidenceSpan(context, "dimension-assessment-evidence-span-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored dimension assessment evidence span is invalid"
      })
    });
    expect(
      runImmediateTransaction(connection, (context) =>
        readDimensionAssessmentSpanRefs(context, "dimension-assessment-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored dimension assessment evidence span is invalid"
      })
    });

    expect(connection.close().ok).toBe(true);
  });
});

describe("evidence schema bounds", () => {
  it("rejects drafts that exceed persistence bounds", () => {
    expect(
      prepareEvidenceSpan(
        evidenceSpanDraft({ quotedText: "a".repeat(MAXIMUM_QUOTED_TEXT_LENGTH + 1) })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid evidence span input" })
    });
    expect(
      prepareEvidenceSpan(
        evidenceSpanDraft({ extractorVersion: "a".repeat(MAXIMUM_EXTRACTOR_VERSION_LENGTH + 1) })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid evidence span input" })
    });
    expect(
      prepareExtractionRun(extractionRunDraft({ modelId: "a".repeat(MAXIMUM_MODEL_ID_LENGTH + 1) }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid extraction run input" })
    });
  });
});
