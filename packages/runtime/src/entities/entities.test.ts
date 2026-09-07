import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { err, ok, sha256Hex, type Result } from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import { runImmediateTransaction, type ImmediateTransactionContext } from "../commands/index.js";
import { openRuntimeDatabase, type RuntimeDatabaseConnection } from "../db/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  ActorDraftSchema,
  ActorSchema,
  CandidateDraftSchema,
  CandidateSchema,
  MAXIMUM_NORMALIZED_DOCUMENT_BYTES,
  MAXIMUM_NORMALIZED_DOCUMENT_LENGTH,
  MAXIMUM_RAW_DOCUMENT_BYTES,
  SYSTEM_ACTOR_ID,
  SourceDocumentDraftSchema,
  SourceDocumentSchema
} from "./schemas.js";
import {
  insertActor,
  insertCandidate,
  insertCandidateDocument,
  insertSourceDocument,
  prepareActor,
  prepareCandidate,
  prepareCandidateDocument,
  prepareSourceDocument,
  readActor,
  readCandidate,
  readCandidateDocument,
  readSourceDocument
} from "./store.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-entities-test-"));
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

/** Returns a copy of `base` whose `key` getter throws, as a hostile caller would. */
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

function actorDraft(overrides: Record<string, unknown> = {}) {
  return {
    actorId: "actor-recruiter-1",
    displayName: "Dana Recruiter",
    createdAt: 1_788_700_000_000,
    ...overrides
  };
}

function candidateDraft(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: "candidate-1",
    sourceSystem: "synthetic_corpus",
    sourceKey: "tier-one/0001",
    channel: "inbound",
    corpusTag: "main",
    createdAt: 1_788_700_000_000,
    ...overrides
  };
}

function sourceDocumentDraft(overrides: Record<string, unknown> = {}) {
  return {
    sourceDocumentId: "source-document-1",
    rawText: "Senior  Engineer\r\n\r\nBuilt   evidence pipelines.",
    normalizedText: "Senior Engineer\nBuilt evidence pipelines.",
    createdAt: 1_788_700_000_000,
    ...overrides
  };
}

function candidateDocumentDraft(overrides: Record<string, unknown> = {}) {
  return {
    candidateDocumentId: "candidate-document-1",
    candidateId: "candidate-1",
    sourceDocumentId: "source-document-1",
    documentKind: "resume",
    label: "Resume",
    documentOrdinal: 0,
    createdAt: 1_788_700_000_000,
    ...overrides
  };
}

/** Seeds one candidate plus one source document so document rows have parents. */
function seedCandidateAndDocument(
  context: ImmediateTransactionContext,
  candidateOverrides: Record<string, unknown> = {},
  documentOverrides: Record<string, unknown> = {}
): void {
  const candidate = unwrap(prepareCandidate(candidateDraft(candidateOverrides)));
  unwrap(insertCandidate(context, candidate));
  const document = unwrap(prepareSourceDocument(sourceDocumentDraft(documentOverrides)));
  unwrap(insertSourceDocument(context, document));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("immutable entity preparation", () => {
  it("marks prepared actors as human and refuses the system actor", () => {
    const actor = unwrap(prepareActor(actorDraft()));
    expect(actor).toEqual({
      actorId: "actor-recruiter-1",
      actorKind: "human",
      displayName: "Dana Recruiter",
      createdAt: 1_788_700_000_000
    });
    expect(Object.isFrozen(actor)).toBe(true);

    expect(prepareActor(actorDraft({ actorId: SYSTEM_ACTOR_ID }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid actor input" })
    });
  });

  it("rejects an actor draft that tries to set its own kind", () => {
    expect(prepareActor(actorDraft({ actorKind: "system" }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid actor input" })
    });
  });

  it("forces the synthetic marker on every prepared candidate", () => {
    expect(unwrap(prepareCandidate(candidateDraft()))).toEqual({
      candidateId: "candidate-1",
      sourceSystem: "synthetic_corpus",
      sourceKey: "tier-one/0001",
      channel: "inbound",
      corpusTag: "main",
      isSynthetic: true,
      createdAt: 1_788_700_000_000
    });
    expect(prepareCandidate(candidateDraft({ isSynthetic: false }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate input" })
    });
  });

  it("hashes and measures both document texts before any transaction", () => {
    const draft = sourceDocumentDraft();
    const document = unwrap(prepareSourceDocument(draft));

    expect(document.rawHash).toBe(sha256Hex(draft.rawText));
    expect(document.normalizedHash).toBe(sha256Hex(draft.normalizedText));
    expect(document.rawByteLength).toBe(
      new TextEncoder().encode(draft.rawText).length
    );
    expect(document.normalizedLength).toBe(draft.normalizedText.length);
    expect(Object.isFrozen(document)).toBe(true);
  });

  it("counts astral characters as UTF-16 code units and UTF-8 bytes", () => {
    const document = unwrap(
      prepareSourceDocument(
        sourceDocumentDraft({ rawText: "a\u{1F600}b", normalizedText: "a\u{1F600}b" })
      )
    );

    expect(document.normalizedLength).toBe(4);
    expect(document.normalizedByteLength).toBe(6);
  });

  it("rejects oversized and malformed document text instead of truncating it", () => {
    expect(
      prepareSourceDocument(
        sourceDocumentDraft({ rawText: "a".repeat(MAXIMUM_RAW_DOCUMENT_BYTES + 1) })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Source document raw text exceeds the byte limit"
      })
    });

    expect(
      prepareSourceDocument(
        sourceDocumentDraft({
          normalizedText: "a".repeat(MAXIMUM_NORMALIZED_DOCUMENT_LENGTH + 1)
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Source document normalized text exceeds the length limit"
      })
    });

    expect(
      prepareSourceDocument(sourceDocumentDraft({ normalizedText: "lone \ud800 surrogate" }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Source document text is not well-formed UTF-16"
      })
    });
  });

  it("rejects a document ordinal beyond the four-document limit", () => {
    expect(prepareCandidateDocument(candidateDocumentDraft({ documentOrdinal: 4 }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate document input" })
    });
  });
});

describe("immutable entity persistence", () => {
  it("stores and reads back every immutable entity inside one transaction", async () => {
    const connection = await openMigratedDatabase();

    const stored = unwrap(
      runImmediateTransaction(connection, (context) => {
        const actor = unwrap(insertActor(context, unwrap(prepareActor(actorDraft()))));
        seedCandidateAndDocument(context);
        const candidateDocument = unwrap(
          insertCandidateDocument(
            context,
            unwrap(prepareCandidateDocument(candidateDocumentDraft()))
          )
        );
        return ok({ actor, candidateDocument });
      })
    );

    expect(stored.actor.actorKind).toBe("human");

    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(unwrap(readActor(context, "actor-recruiter-1"))).toEqual(stored.actor);
        expect(unwrap(readCandidate(context, "candidate-1"))?.isSynthetic).toBe(true);
        expect(unwrap(readSourceDocument(context, "source-document-1"))?.rawHash).toBe(
          sha256Hex(sourceDocumentDraft().rawText)
        );
        expect(unwrap(readCandidateDocument(context, "candidate-document-1"))).toEqual(
          stored.candidateDocument
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
        expect(unwrap(readActor(context, "missing-actor"))).toBeUndefined();
        expect(unwrap(readCandidate(context, "missing-candidate"))).toBeUndefined();
        expect(unwrap(readSourceDocument(context, "missing-document"))).toBeUndefined();
        expect(
          unwrap(readCandidateDocument(context, "missing-candidate-document"))
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
        expect(readActor(context, "")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid actor ID" })
        });
        expect(readCandidate(context, 42)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid candidate ID" })
        });
        expect(readSourceDocument(context, "has space")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid source document ID" })
        });
        expect(readCandidateDocument(context, null)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid candidate document ID" })
        });
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("stores the full four documents one candidate is allowed", async () => {
    const connection = await openMigratedDatabase();
    const kinds = ["resume", "cover_letter", "profile", "recruiter_note"] as const;

    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
        for (const [ordinal, documentKind] of kinds.entries()) {
          unwrap(
            insertSourceDocument(
              context,
              unwrap(
                prepareSourceDocument(
                  sourceDocumentDraft({
                    sourceDocumentId: `source-document-${ordinal}`,
                    rawText: `Raw document ${ordinal}.`,
                    normalizedText: `Raw document ${ordinal}.`
                  })
                )
              )
            )
          );
          unwrap(
            insertCandidateDocument(
              context,
              unwrap(
                prepareCandidateDocument(
                  candidateDocumentDraft({
                    candidateDocumentId: `candidate-document-${ordinal}`,
                    sourceDocumentId: `source-document-${ordinal}`,
                    documentKind,
                    label: `Document ${ordinal}`,
                    documentOrdinal: ordinal
                  })
                )
              )
            )
          );
        }
        return ok(undefined);
      })
    );

    expect(
      nativeDatabase(connection)
        .prepare(
          "SELECT count(*) AS total FROM candidate_document WHERE candidate_id = 'candidate-1'"
        )
        .get()
    ).toEqual({ total: 4 });

    expect(connection.close().ok).toBe(true);
  });

  it("seeds exactly one system actor that callers cannot insert", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        const systemActor = unwrap(readActor(context, SYSTEM_ACTOR_ID));
        expect(systemActor).toEqual({
          actorId: SYSTEM_ACTOR_ID,
          actorKind: "system",
          displayName: "RecruitOS Runtime",
          createdAt: 0
        });
        return ok(undefined);
      })
    );

    expect(
      nativeDatabase(connection)
        .prepare("SELECT count(*) AS total FROM actor WHERE actor_kind = 'system'")
        .get()
    ).toEqual({ total: 1 });

    expect(connection.close().ok).toBe(true);
  });

  it("refuses inserts outside an active transaction", async () => {
    const connection = await openMigratedDatabase();
    const actor = unwrap(prepareActor(actorDraft()));

    for (const context of [undefined, null, {}, { nativeDatabase: null }]) {
      expect(insertActor(context, actor)).toEqual({
        ok: false,
        error: expect.objectContaining({
          message: "Immutable entities require an active command transaction"
        })
      });
    }

    expect(connection.close().ok).toBe(true);
  });

  it("refuses records the runtime did not prepare, including cross-entity records", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        const actor = unwrap(prepareActor(actorDraft()));
        const candidate = unwrap(prepareCandidate(candidateDraft()));

        expect(insertActor(context, { ...actor })).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared actor" })
        });
        expect(insertActor(context, candidate)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared actor" })
        });
        expect(insertCandidate(context, actor)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared candidate" })
        });
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("rolls back every immutable row when the command fails", async () => {
    const connection = await openMigratedDatabase();

    const failed = runImmediateTransaction<never>(connection, (context) => {
      seedCandidateAndDocument(context);
      unwrap(
        insertCandidateDocument(
          context,
          unwrap(prepareCandidateDocument(candidateDocumentDraft()))
        )
      );
      return err(createRuntimeError("command_conflict", "Command rejected", false));
    });

    expect(failed).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "command_conflict" })
    });

    for (const table of ["candidate", "source_document", "candidate_document"]) {
      expect(
        nativeDatabase(connection).prepare(`SELECT count(*) AS total FROM ${table}`).get()
      ).toEqual({ total: 0 });
    }

    expect(connection.close().ok).toBe(true);
  });
});

describe("immutable entity database constraints", () => {
  it("rejects a second candidate reusing one source system and key", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedCandidateAndDocument(context);
        return ok(undefined);
      })
    );

    const duplicate = runImmediateTransaction(connection, (context) =>
      insertCandidate(
        context,
        unwrap(prepareCandidate(candidateDraft({ candidateId: "candidate-2" })))
      )
    );

    expect(duplicate).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate insert failed" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a second source document holding identical raw text", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedCandidateAndDocument(context);
        return ok(undefined);
      })
    );

    const duplicate = runImmediateTransaction(connection, (context) =>
      insertSourceDocument(
        context,
        unwrap(prepareSourceDocument(sourceDocumentDraft({ sourceDocumentId: "source-document-2" })))
      )
    );

    expect(duplicate).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Source document insert failed" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a candidate document ordinal reused on one candidate", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedCandidateAndDocument(context);
        unwrap(
          insertSourceDocument(
            context,
            unwrap(
              prepareSourceDocument(
                sourceDocumentDraft({
                  sourceDocumentId: "source-document-2",
                  rawText: "Cover letter raw text.",
                  normalizedText: "Cover letter raw text."
                })
              )
            )
          )
        );
        unwrap(
          insertCandidateDocument(
            context,
            unwrap(prepareCandidateDocument(candidateDocumentDraft()))
          )
        );
        return ok(undefined);
      })
    );

    const duplicate = runImmediateTransaction(connection, (context) =>
      insertCandidateDocument(
        context,
        unwrap(
          prepareCandidateDocument(
            candidateDocumentDraft({
              candidateDocumentId: "candidate-document-2",
              sourceDocumentId: "source-document-2",
              documentKind: "cover_letter",
              label: "Cover letter"
            })
          )
        )
      )
    );

    expect(duplicate).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate document insert failed" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a candidate document whose candidate or document does not exist", async () => {
    const connection = await openMigratedDatabase();

    const orphaned = runImmediateTransaction(connection, (context) =>
      insertCandidateDocument(
        context,
        unwrap(prepareCandidateDocument(candidateDocumentDraft()))
      )
    );

    expect(orphaned).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate document insert failed" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("reports tampered stored document text as an integrity failure", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedCandidateAndDocument(context);
        return ok(undefined);
      })
    );

    // Bypass the immutability triggers the way on-disk corruption would.
    database.exec("DROP TRIGGER source_document_reject_update");
    const tampered = "Senior Engineer\nBuilt evidence pipelinez.";
    database
      .prepare(
        `UPDATE source_document
         SET normalized_text = ?, normalized_byte_length = length(CAST(? AS BLOB))
         WHERE source_document_id = ?`
      )
      .run(tampered, tampered, "source-document-1");

    const read = runImmediateTransaction(connection, (context) =>
      readSourceDocument(context, "source-document-1")
    );

    expect(read).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored source document failed integrity validation"
      })
    });

    expect(connection.close().ok).toBe(true);
  });
});

describe("immutable entity table declarations", () => {
  it("declares every immutable table STRICT", async () => {
    const connection = await openMigratedDatabase();

    for (const table of ["actor", "candidate", "source_document", "candidate_document"]) {
      expect(
        nativeDatabase(connection)
          .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(table)
      ).toEqual({ sql: expect.stringContaining("STRICT") });
    }

    expect(connection.close().ok).toBe(true);
  });
});

describe("immutable entity boundary failures", () => {
  it("converts hostile draft getters into typed preparation errors", () => {
    expect(prepareActor(withThrowingGetter(actorDraft(), "actorId"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Actor preparation failed" })
    });
    expect(
      prepareCandidate(withThrowingGetter(candidateDraft(), "candidateId"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate preparation failed" })
    });
    expect(
      prepareSourceDocument(
        withThrowingGetter(sourceDocumentDraft(), "sourceDocumentId")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Source document preparation failed" })
    });
    expect(
      prepareCandidateDocument(
        withThrowingGetter(candidateDocumentDraft(), "candidateDocumentId")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate document preparation failed"
      })
    });
  });

  it("rejects a source document draft that is not the declared shape", () => {
    const missingIdentity = { rawText: "a", normalizedText: "a", createdAt: 1 };
    expect(prepareSourceDocument(missingIdentity)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid source document input" })
    });
    expect(prepareSourceDocument(sourceDocumentDraft({ unexpected: true }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid source document input" })
    });
  });

  it("converts a failing database read into a typed error", () => {
    // A live transaction whose statements fail, the way a disk error would
    // surface mid-read.
    const failingContext = {
      nativeDatabase: {
        inTransaction: true,
        prepare() {
          throw new Error("disk I/O error");
        }
      }
    };

    expect(readActor(failingContext, "actor-recruiter-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Actor read failed" })
    });
    expect(readCandidate(failingContext, "candidate-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate read failed" })
    });
    expect(readSourceDocument(failingContext, "source-document-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Source document read failed" })
    });
    expect(readCandidateDocument(failingContext, "candidate-document-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate document read failed" })
    });
  });

  it("rejects raw text that is not well-formed UTF-16", () => {
    expect(
      prepareSourceDocument(sourceDocumentDraft({ rawText: "lone \ud800 surrogate" }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Source document text is not well-formed UTF-16"
      })
    });
  });

  it("rejects normalized text over the byte limit while under the length limit", () => {
    // 45000 three-byte characters: 45000 UTF-16 units is inside the length
    // limit, but 135000 UTF-8 bytes is over the byte limit.
    const dense = "一".repeat(45_000);
    expect(dense.length).toBeLessThanOrEqual(MAXIMUM_NORMALIZED_DOCUMENT_LENGTH);
    expect(new TextEncoder().encode(dense).length).toBeGreaterThan(
      MAXIMUM_NORMALIZED_DOCUMENT_BYTES
    );

    expect(prepareSourceDocument(sourceDocumentDraft({ normalizedText: dense }))).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Source document normalized text exceeds the byte limit"
      })
    });
  });

  it("refuses every read and write outside an active transaction", async () => {
    const connection = await openMigratedDatabase();
    const message = "Immutable entities require an active command transaction";
    const contexts = [undefined, null, {}, { nativeDatabase: null }];
    const writes = [
      [insertActor, unwrap(prepareActor(actorDraft()))],
      [insertCandidate, unwrap(prepareCandidate(candidateDraft()))],
      [insertSourceDocument, unwrap(prepareSourceDocument(sourceDocumentDraft()))],
      [
        insertCandidateDocument,
        unwrap(prepareCandidateDocument(candidateDocumentDraft()))
      ]
    ] as const;
    const reads = [readActor, readCandidate, readSourceDocument, readCandidateDocument];

    for (const context of contexts) {
      for (const [insert, prepared] of writes) {
        expect(insert(context, prepared)).toEqual({
          ok: false,
          error: expect.objectContaining({ message })
        });
      }
      for (const read of reads) {
        expect(read(context, "any-id")).toEqual({
          ok: false,
          error: expect.objectContaining({ message })
        });
      }
    }

    expect(connection.close().ok).toBe(true);
  });

  it("refuses unprepared records on every insert", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        const actor = unwrap(prepareActor(actorDraft()));
        const candidate = unwrap(prepareCandidate(candidateDraft()));
        const document = unwrap(prepareSourceDocument(sourceDocumentDraft()));
        const candidateDocument = unwrap(
          prepareCandidateDocument(candidateDocumentDraft())
        );

        // A structural copy is not the registered record, and neither is a
        // record prepared for a different entity.
        expect(insertSourceDocument(context, { ...document })).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared source document" })
        });
        expect(insertSourceDocument(context, candidateDocument)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared source document" })
        });
        expect(insertCandidateDocument(context, { ...candidateDocument })).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Invalid prepared candidate document"
          })
        });
        expect(insertCandidateDocument(context, actor)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Invalid prepared candidate document"
          })
        });
        expect(insertCandidate(context, candidate)).toEqual({ ok: true, value: candidate });
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("reports a duplicate actor insert as a typed failure", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) =>
        insertActor(context, unwrap(prepareActor(actorDraft())))
      )
    );

    expect(
      runImmediateTransaction(connection, (context) =>
        insertActor(context, unwrap(prepareActor(actorDraft({ displayName: "Copy" }))))
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Actor insert failed" })
    });

    expect(connection.close().ok).toBe(true);
  });
});

describe("stored row validation", () => {
  /**
   * SQLite length() counts code points while the domain schemas count UTF-16
   * code units, so a value can satisfy every CHECK and still be out of domain
   * range. Dropping the update trigger reproduces that the way on-disk
   * corruption would.
   */
  const astralOverLimit = "\u{1F600}".repeat(150);

  it("rejects a stored actor whose display name is out of domain range", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) =>
        insertActor(context, unwrap(prepareActor(actorDraft())))
      )
    );

    expect(astralOverLimit.length).toBe(300);
    expect(database.prepare("SELECT length(?) AS n").get(astralOverLimit)).toEqual({
      n: 150
    });

    database.exec("DROP TRIGGER actor_reject_update");
    database
      .prepare("UPDATE actor SET display_name = ? WHERE actor_id = ?")
      .run(astralOverLimit, "actor-recruiter-1");

    expect(
      runImmediateTransaction(connection, (context) =>
        readActor(context, "actor-recruiter-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored actor is invalid" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a stored candidate whose source key is not printable ASCII", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedCandidateAndDocument(context);
        return ok(undefined);
      })
    );

    database.exec("DROP TRIGGER candidate_reject_update");
    database
      .prepare("UPDATE candidate SET source_key = ? WHERE candidate_id = ?")
      .run("\u{1F600}key", "candidate-1");

    expect(
      runImmediateTransaction(connection, (context) => readCandidate(context, "candidate-1"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored candidate is invalid" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a stored document whose normalized length is inside the SQL bound but wrong", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const normalizedText = sourceDocumentDraft().normalizedText;

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedCandidateAndDocument(context);
        return ok(undefined);
      })
    );

    // The CHECK permits length() through 2 * length(); the schema requires the
    // exact UTF-16 count, so a value inside the CHECK still fails the domain.
    const inflated = normalizedText.length + 3;
    database.exec("DROP TRIGGER source_document_reject_update");
    database
      .prepare("UPDATE source_document SET normalized_length = ? WHERE source_document_id = ?")
      .run(inflated, "source-document-1");

    expect(
      runImmediateTransaction(connection, (context) =>
        readSourceDocument(context, "source-document-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored source document is invalid" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a stored candidate document whose label is out of domain range", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedCandidateAndDocument(context);
        unwrap(
          insertCandidateDocument(
            context,
            unwrap(prepareCandidateDocument(candidateDocumentDraft()))
          )
        );
        return ok(undefined);
      })
    );

    database.exec("DROP TRIGGER candidate_document_reject_update");
    database
      .prepare("UPDATE candidate_document SET label = ? WHERE candidate_document_id = ?")
      .run(astralOverLimit, "candidate-document-1");

    expect(
      runImmediateTransaction(connection, (context) =>
        readCandidateDocument(context, "candidate-document-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored candidate document is invalid"
      })
    });

    expect(connection.close().ok).toBe(true);
  });
});

describe("draft schemas imply their entity schemas", () => {
  // prepareActor, prepareCandidate, and prepareSourceDocument parse the entity
  // schema without a failure branch because the draft schema already proves it.
  // These properties are what make that safe; if one fails, restore the branch.
  const printableAscii = fc.stringMatching(/^[\x21-\x7e]{1,64}$/u);

  it("holds for every actor draft", () => {
    fc.assert(
      fc.property(
        fc.record({
          actorId: printableAscii.filter((value) => value !== SYSTEM_ACTOR_ID),
          displayName: fc.string({ minLength: 1, maxLength: 200 }),
          createdAt: fc.nat()
        }),
        (raw) => {
          const draft = ActorDraftSchema.safeParse(raw);
          fc.pre(draft.success);
          return ActorSchema.safeParse({
            actorId: draft.data.actorId,
            actorKind: "human",
            displayName: draft.data.displayName,
            createdAt: draft.data.createdAt
          }).success;
        }
      ),
      { numRuns: 500 }
    );
  });

  it("holds for every candidate draft", () => {
    fc.assert(
      fc.property(
        fc.record({
          candidateId: printableAscii,
          sourceSystem: fc.stringMatching(/^[a-z][a-z0-9]{0,20}$/u),
          sourceKey: printableAscii,
          channel: fc.constantFrom("inbound", "sourced"),
          corpusTag: fc.constantFrom("main", "variant"),
          createdAt: fc.nat()
        }),
        (raw) => {
          const draft = CandidateDraftSchema.safeParse(raw);
          fc.pre(draft.success);
          return CandidateSchema.safeParse({ ...draft.data, isSynthetic: true }).success;
        }
      ),
      { numRuns: 500 }
    );
  });

  it("holds for every source document draft inside the capacity bounds", () => {
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(
        fc.record({
          sourceDocumentId: printableAscii,
          rawText: fc.string({ minLength: 1, maxLength: 200, unit: "grapheme" }),
          normalizedText: fc.string({ minLength: 1, maxLength: 200, unit: "grapheme" }),
          createdAt: fc.nat()
        }),
        (raw) => {
          const draft = SourceDocumentDraftSchema.safeParse(raw);
          fc.pre(draft.success);
          const rawByteLength = encoder.encode(draft.data.rawText).length;
          const normalizedByteLength = encoder.encode(draft.data.normalizedText).length;
          fc.pre(
            rawByteLength <= MAXIMUM_RAW_DOCUMENT_BYTES &&
              normalizedByteLength <= MAXIMUM_NORMALIZED_DOCUMENT_BYTES &&
              draft.data.normalizedText.length <= MAXIMUM_NORMALIZED_DOCUMENT_LENGTH
          );
          return SourceDocumentSchema.safeParse({
            sourceDocumentId: draft.data.sourceDocumentId,
            rawText: draft.data.rawText,
            rawHash: sha256Hex(draft.data.rawText),
            rawByteLength,
            normalizedText: draft.data.normalizedText,
            normalizedHash: sha256Hex(draft.data.normalizedText),
            normalizedLength: draft.data.normalizedText.length,
            normalizedByteLength,
            createdAt: draft.data.createdAt
          }).success;
        }
      ),
      { numRuns: 500 }
    );
  });
});
