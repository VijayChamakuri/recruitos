import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { err, ok, sha256Hex, type Result } from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runImmediateTransaction, type ImmediateTransactionContext } from "../commands/index.js";
import { openRuntimeDatabase, type RuntimeDatabaseConnection } from "../db/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  MAXIMUM_NORMALIZED_DOCUMENT_LENGTH,
  MAXIMUM_RAW_DOCUMENT_BYTES,
  SYSTEM_ACTOR_ID
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

/**
 * Reads the migration count from the local journal so adding a migration does
 * not break unrelated idempotency assertions.
 */
function localMigrationCount(): number {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8")
  ) as { entries: readonly unknown[] };
  return journal.entries.length;
}

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
  it("rejects updates, deletes, and replacements of stored rows", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedCandidateAndDocument(context);
        return ok(undefined);
      })
    );

    expect(() =>
      database.prepare("UPDATE candidate SET channel = 'sourced' WHERE candidate_id = ?").run("candidate-1")
    ).toThrow(/candidate is immutable/u);
    expect(() =>
      database.prepare("DELETE FROM candidate WHERE candidate_id = ?").run("candidate-1")
    ).toThrow(/candidate is immutable/u);
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO candidate (
            candidate_id, source_system, source_key, channel, corpus_tag, is_synthetic, created_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?)`
        )
        .run("candidate-1", "synthetic_corpus", "tier-one/0001", "sourced", "main", 1)
    ).toThrow(/candidate is immutable/u);
    expect(() =>
      database
        .prepare("UPDATE source_document SET raw_text = 'tampered' WHERE source_document_id = ?")
        .run("source-document-1")
    ).toThrow(/source_document is immutable/u);
    expect(() =>
      database.prepare("DELETE FROM actor WHERE actor_id = ?").run(SYSTEM_ACTOR_ID)
    ).toThrow(/actor is immutable/u);

    expect(connection.close().ok).toBe(true);
  });

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

describe("immutable entity migration", () => {
  it("creates every immutable table and trigger exactly once", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    expect(connection.migrate()).toEqual({ ok: true, value: undefined });

    expect(
      database
        .prepare(
          `SELECT count(*) AS total
           FROM sqlite_schema
           WHERE type = 'table'
             AND name IN ('actor', 'candidate', 'source_document', 'candidate_document')`
        )
        .get()
    ).toEqual({ total: 4 });

    expect(
      database
        .prepare(
          `SELECT count(*) AS total
           FROM sqlite_schema
           WHERE type = 'trigger'
             AND tbl_name IN ('actor', 'candidate', 'source_document', 'candidate_document')`
        )
        .get()
    ).toEqual({ total: 12 });

    expect(
      database.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get()
    ).toEqual({ count: localMigrationCount() });

    expect(connection.close().ok).toBe(true);
  });

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
