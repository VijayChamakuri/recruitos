import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { err, ok, type Result } from "@recruitos/core";
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
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  MAIN_DEMO_CORPUS_MEMBER_COUNT,
  hashCorpusManifestContent,
  insertCorpusManifest,
  insertCorpusManifestSeal,
  insertCorpusMember,
  insertCorpusMemberDocument,
  prepareCorpusManifest,
  prepareCorpusManifestSeal,
  prepareCorpusMember,
  prepareCorpusMemberDocument,
  readCorpusManifest,
  readCorpusManifestSeal,
  readCorpusMember,
  readCorpusMemberDocument,
  validateCorpusManifestContent,
  type CorpusManifest
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-corpus-test-"));
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

function contentMember(
  index: number,
  documentCount = 1
): {
  candidateId: string;
  importOrdinal: number;
  documents: Array<{ candidateDocumentId: string; documentOrdinal: number }>;
} {
  return {
    candidateId: `candidate-${index + 1}`,
    importOrdinal: index,
    documents: Array.from({ length: documentCount }, (_, documentOrdinal) => ({
      candidateDocumentId: `candidate-document-${index + 1}-${documentOrdinal}`,
      documentOrdinal
    }))
  };
}

function variantContent(memberCount = 1, documentCount = 1) {
  return {
    kind: "variant" as const,
    members: Array.from({ length: memberCount }, (_, index) =>
      contentMember(index, documentCount)
    )
  };
}

function manifestDraft(overrides: Record<string, unknown> = {}) {
  const contentOverride = overrides["content"] as
    | ReturnType<typeof variantContent>
    | undefined;
  const content = contentOverride ?? variantContent();
  return {
    corpusManifestId: "corpus-manifest-1",
    kind: content.kind,
    sealId: "corpus-manifest-seal-1",
    createdAt: 1_788_700_000_000,
    ...overrides,
    content
  };
}

function memberDraft(overrides: Record<string, unknown> = {}) {
  return {
    corpusMemberId: "corpus-member-1",
    manifestId: "corpus-manifest-1",
    candidateId: "candidate-1",
    importOrdinal: 0,
    createdAt: 1_788_700_000_000,
    ...overrides
  };
}

function memberDocumentDraft(overrides: Record<string, unknown> = {}) {
  return {
    corpusMemberDocumentId: "corpus-member-document-1",
    corpusMemberId: "corpus-member-1",
    candidateDocumentId: "candidate-document-1-0",
    documentOrdinal: 0,
    createdAt: 1_788_700_000_000,
    ...overrides
  };
}

function sealDraft(overrides: Record<string, unknown> = {}) {
  return {
    corpusManifestSealId: "corpus-manifest-seal-1",
    manifestId: "corpus-manifest-1",
    createdAt: 1_788_700_000_000,
    ...overrides
  };
}

/** Seeds one candidate and one owned document for corpus membership tests. */
function seedCandidateBundle(
  context: ImmediateTransactionContext,
  index: number,
  documentCount = 1
): void {
  const candidateId = `candidate-${index + 1}`;
  unwrap(
    insertCandidate(
      context,
      unwrap(
        prepareCandidate({
          candidateId,
          sourceSystem: "synthetic_corpus",
          sourceKey: `tier-one/${String(index + 1).padStart(4, "0")}`,
          channel: "inbound",
          corpusTag: "variant",
          createdAt: 1_788_700_000_000
        })
      )
    )
  );

  for (let documentOrdinal = 0; documentOrdinal < documentCount; documentOrdinal += 1) {
    const sourceDocumentId = `source-document-${index + 1}-${documentOrdinal}`;
    const rawText = `Candidate ${index + 1} document ${documentOrdinal} raw.`;
    unwrap(
      insertSourceDocument(
        context,
        unwrap(
          prepareSourceDocument({
            sourceDocumentId,
            rawText,
            normalizedText: rawText,
            createdAt: 1_788_700_000_000
          })
        )
      )
    );
    unwrap(
      insertCandidateDocument(
        context,
        unwrap(
          prepareCandidateDocument({
            candidateDocumentId: `candidate-document-${index + 1}-${documentOrdinal}`,
            candidateId,
            sourceDocumentId,
            documentKind: "resume",
            label: `Document ${documentOrdinal}`,
            documentOrdinal,
            createdAt: 1_788_700_000_000
          })
        )
      )
    );
  }
}

function publishVariantCorpus(
  context: ImmediateTransactionContext,
  memberCount = 1,
  documentCount = 1
): { manifest: CorpusManifest } {
  const content = variantContent(memberCount, documentCount);
  for (let index = 0; index < memberCount; index += 1) {
    seedCandidateBundle(context, index, documentCount);
  }

  const manifest = unwrap(prepareCorpusManifest(manifestDraft({ content, kind: content.kind })));
  unwrap(insertCorpusManifest(context, manifest));

  for (let index = 0; index < memberCount; index += 1) {
    const member = unwrap(
      prepareCorpusMember(
        memberDraft({
          corpusMemberId: `corpus-member-${index + 1}`,
          candidateId: `candidate-${index + 1}`,
          importOrdinal: index
        })
      )
    );
    unwrap(insertCorpusMember(context, member));
    for (let documentOrdinal = 0; documentOrdinal < documentCount; documentOrdinal += 1) {
      unwrap(
        insertCorpusMemberDocument(
          context,
          unwrap(
            prepareCorpusMemberDocument(
              memberDocumentDraft({
                corpusMemberDocumentId: `corpus-member-document-${index + 1}-${documentOrdinal}`,
                corpusMemberId: `corpus-member-${index + 1}`,
                candidateDocumentId: `candidate-document-${index + 1}-${documentOrdinal}`,
                documentOrdinal
              })
            )
          )
        )
      );
    }
  }

  unwrap(
    insertCorpusManifestSeal(context, unwrap(prepareCorpusManifestSeal(sealDraft())))
  );

  return { manifest };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("corpus manifest content hashing", () => {
  it("hashes membership independently of authoring order", () => {
    const left = unwrap(
      hashCorpusManifestContent({
        kind: "variant",
        members: [contentMember(1), contentMember(0)]
      })
    );
    const right = unwrap(
      hashCorpusManifestContent({
        kind: "variant",
        members: [contentMember(0), contentMember(1)]
      })
    );
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects incomplete or noncontiguous membership before hashing", () => {
    expect(
      validateCorpusManifestContent({
        kind: "main",
        members: [contentMember(0)]
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: `Main corpus manifests require exactly ${MAIN_DEMO_CORPUS_MEMBER_COUNT} members`
      })
    });

    expect(
      validateCorpusManifestContent({
        kind: "variant",
        members: [contentMember(1)]
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Corpus member import ordinals must start at 0"
      })
    });

    expect(
      validateCorpusManifestContent({
        kind: "variant",
        members: [contentMember(0), contentMember(2)]
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Corpus member import ordinals must be contiguous"
      })
    });

    expect(
      validateCorpusManifestContent({
        kind: "variant",
        members: [
          {
            candidateId: "candidate-1",
            importOrdinal: 0,
            documents: [contentMember(0).documents[0]!]
          },
          {
            candidateId: "candidate-1",
            importOrdinal: 1,
            documents: [
              {
                candidateDocumentId: "candidate-document-2-0",
                documentOrdinal: 0
              }
            ]
          }
        ]
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Corpus members must use unique candidate IDs"
      })
    });

    expect(
      validateCorpusManifestContent({
        kind: "variant",
        members: [
          {
            candidateId: "candidate-1",
            importOrdinal: 0,
            documents: [
              {
                candidateDocumentId: "candidate-document-1-0",
                documentOrdinal: 1
              }
            ]
          }
        ]
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Corpus member document ordinals must start at 0"
      })
    });

    expect(
      validateCorpusManifestContent({
        kind: "variant",
        members: [
          {
            candidateId: "candidate-1",
            importOrdinal: 0,
            documents: [
              {
                candidateDocumentId: "candidate-document-1-0",
                documentOrdinal: 0
              },
              {
                candidateDocumentId: "candidate-document-1-1",
                documentOrdinal: 2
              }
            ]
          }
        ]
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Corpus member document ordinals must be contiguous"
      })
    });

    expect(
      validateCorpusManifestContent({
        kind: "variant",
        members: [
          {
            candidateId: "candidate-1",
            importOrdinal: 0,
            documents: [
              {
                candidateDocumentId: "candidate-document-1-0",
                documentOrdinal: 0
              },
              {
                candidateDocumentId: "candidate-document-1-0",
                documentOrdinal: 1
              }
            ]
          }
        ]
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Corpus member documents must use unique candidate documents"
      })
    });

    expect(validateCorpusManifestContent({ kind: "variant", members: [] })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid corpus manifest content" })
    });
  });
});

describe("corpus manifest preparation", () => {
  it("computes the content hash before any transaction opens", () => {
    const content = variantContent(2, 2);
    const expected = unwrap(hashCorpusManifestContent(content));
    const manifest = unwrap(
      prepareCorpusManifest(manifestDraft({ content, kind: content.kind }))
    );
    expect(manifest.contentHash).toBe(expected);
    expect(manifest.kind).toBe("variant");
  });

  it("rejects drafts whose kind and content kind disagree", () => {
    expect(
      prepareCorpusManifest(
        manifestDraft({
          kind: "main",
          content: variantContent()
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid corpus manifest input" })
    });
  });

  it("rejects poisoned preparation inputs without throwing", () => {
    expect(prepareCorpusManifest(withThrowingGetter(manifestDraft(), "sealId"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Corpus manifest preparation failed" })
    });
    expect(prepareCorpusMember(withThrowingGetter(memberDraft(), "candidateId"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Corpus member preparation failed" })
    });
    expect(
      prepareCorpusMemberDocument(withThrowingGetter(memberDocumentDraft(), "documentOrdinal"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Corpus member document preparation failed"
      })
    });
    expect(
      prepareCorpusManifestSeal(withThrowingGetter(sealDraft(), "manifestId"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Corpus manifest seal preparation failed"
      })
    });
  });

  it("rejects invalid member and seal drafts", () => {
    expect(prepareCorpusMember(memberDraft({ importOrdinal: -1 }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid corpus member input" })
    });
    expect(
      prepareCorpusMemberDocument(memberDocumentDraft({ documentOrdinal: 4 }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid corpus member document input" })
    });
    expect(prepareCorpusManifestSeal(sealDraft({ createdAt: -1 }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid corpus manifest seal input" })
    });
  });
});

describe("corpus manifest persistence", () => {
  it("stores and reads a sealed variant corpus inside one transaction", async () => {
    const connection = await openMigratedDatabase();

    const stored = unwrap(
      runImmediateTransaction(connection, (context) => {
        const published = publishVariantCorpus(context, 2, 2);
        return ok(published.manifest);
      })
    );

    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(unwrap(readCorpusManifest(context, "corpus-manifest-1"))).toEqual(stored);
        expect(unwrap(readCorpusMember(context, "corpus-member-1"))?.importOrdinal).toBe(0);
        expect(
          unwrap(readCorpusMemberDocument(context, "corpus-member-document-1-1"))
            ?.documentOrdinal
        ).toBe(1);
        expect(unwrap(readCorpusManifestSeal(context, "corpus-manifest-seal-1"))).toEqual({
          corpusManifestSealId: "corpus-manifest-seal-1",
          manifestId: "corpus-manifest-1",
          createdAt: 1_788_700_000_000
        });
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("returns undefined rather than an error for missing rows", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(unwrap(readCorpusManifest(context, "missing-manifest"))).toBeUndefined();
        expect(unwrap(readCorpusMember(context, "missing-member"))).toBeUndefined();
        expect(
          unwrap(readCorpusMemberDocument(context, "missing-member-document"))
        ).toBeUndefined();
        expect(unwrap(readCorpusManifestSeal(context, "missing-seal"))).toBeUndefined();
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("rejects malformed identifiers on every read", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(readCorpusManifest(context, "")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid corpus manifest ID" })
        });
        expect(readCorpusMember(context, "")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid corpus member ID" })
        });
        expect(readCorpusMemberDocument(context, "")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid corpus member document ID" })
        });
        expect(readCorpusManifestSeal(context, "")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid corpus manifest seal ID" })
        });
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("refuses inserts outside an active transaction", async () => {
    const connection = await openMigratedDatabase();
    const manifest = unwrap(prepareCorpusManifest(manifestDraft()));
    const member = unwrap(prepareCorpusMember(memberDraft()));
    const document = unwrap(prepareCorpusMemberDocument(memberDocumentDraft()));
    const seal = unwrap(prepareCorpusManifestSeal(sealDraft()));

    for (const result of [
      insertCorpusManifest({ nativeDatabase: null }, manifest),
      insertCorpusMember(null, member),
      insertCorpusMemberDocument(undefined, document),
      insertCorpusManifestSeal({ nativeDatabase: { inTransaction: false } }, seal)
    ]) {
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          message: "Corpus manifests require an active command transaction"
        })
      });
    }

    expect(connection.close().ok).toBe(true);
  });

  it("refuses records the runtime did not prepare", async () => {
    const connection = await openMigratedDatabase();
    const manifest = unwrap(prepareCorpusManifest(manifestDraft()));

    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(insertCorpusManifest(context, { ...manifest })).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared corpus manifest" })
        });
        expect(insertCorpusMember(context, { ...unwrap(prepareCorpusMember(memberDraft())) })).toEqual(
          {
            ok: false,
            error: expect.objectContaining({ message: "Invalid prepared corpus member" })
          }
        );
        expect(
          insertCorpusMemberDocument(context, {
            ...unwrap(prepareCorpusMemberDocument(memberDocumentDraft()))
          })
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Invalid prepared corpus member document"
          })
        });
        expect(
          insertCorpusManifestSeal(context, {
            ...unwrap(prepareCorpusManifestSeal(sealDraft()))
          })
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Invalid prepared corpus manifest seal"
          })
        });
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("rolls back the cyclic manifest pair when the command fails", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    const failed = runImmediateTransaction(connection, (context) => {
      publishVariantCorpus(context);
      return err(createRuntimeError("command_conflict", "Command rejected", false));
    });
    expect(failed.ok).toBe(false);

    expect(
      database.prepare("SELECT count(*) AS total FROM corpus_manifest").get()
    ).toEqual({ total: 0 });
    expect(
      database.prepare("SELECT count(*) AS total FROM corpus_manifest_seal").get()
    ).toEqual({ total: 0 });

    expect(connection.close().ok).toBe(true);
  });
});

describe("corpus manifest boundary failures", () => {
  it("surfaces invalid content through hashing and preparation", () => {
    expect(hashCorpusManifestContent({ kind: "variant", members: [] })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid corpus manifest content" })
    });

    expect(
      prepareCorpusManifest(
        manifestDraft({
          kind: "main",
          content: {
            kind: "main",
            members: [contentMember(0)]
          }
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: `Main corpus manifests require exactly ${MAIN_DEMO_CORPUS_MEMBER_COUNT} members`
      })
    });
  });

  it("rejects membership that exceeds the canonical JSON node budget", () => {
    // Validated membership is only strings and integers, so the remaining
    // hash failure mode is the canonicalizer's node ceiling.
    const members = Array.from({ length: 1_500 }, (_, index) => contentMember(index));
    expect(hashCorpusManifestContent({ kind: "variant", members })).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Corpus manifest content hashing failed"
      })
    });
  });

  it("refuses every read and write outside an active transaction", () => {
    const message = "Corpus manifests require an active command transaction";
    const contexts = [undefined, null, {}, { nativeDatabase: null }];
    const manifest = unwrap(prepareCorpusManifest(manifestDraft()));
    const member = unwrap(prepareCorpusMember(memberDraft()));
    const document = unwrap(prepareCorpusMemberDocument(memberDocumentDraft()));
    const seal = unwrap(prepareCorpusManifestSeal(sealDraft()));
    const writes = [
      [insertCorpusManifest, manifest],
      [insertCorpusMember, member],
      [insertCorpusMemberDocument, document],
      [insertCorpusManifestSeal, seal]
    ] as const;
    const reads = [
      readCorpusManifest,
      readCorpusMember,
      readCorpusMemberDocument,
      readCorpusManifestSeal
    ];

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
  });

  it("converts a failing database statement into a typed error", () => {
    const failingContext = {
      nativeDatabase: {
        inTransaction: true,
        prepare() {
          throw new Error("disk I/O error");
        }
      }
    };

    expect(
      insertCorpusManifest(
        failingContext,
        unwrap(prepareCorpusManifest(manifestDraft()))
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Corpus manifest insert failed" })
    });
    expect(
      insertCorpusMember(failingContext, unwrap(prepareCorpusMember(memberDraft())))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Corpus member insert failed" })
    });
    expect(
      insertCorpusMemberDocument(
        failingContext,
        unwrap(prepareCorpusMemberDocument(memberDocumentDraft()))
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Corpus member document insert failed" })
    });
    expect(
      insertCorpusManifestSeal(
        failingContext,
        unwrap(prepareCorpusManifestSeal(sealDraft()))
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Corpus manifest seal insert failed" })
    });
    expect(readCorpusManifest(failingContext, "corpus-manifest-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Corpus manifest read failed" })
    });
    expect(readCorpusMember(failingContext, "corpus-member-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Corpus member read failed" })
    });
    expect(readCorpusMemberDocument(failingContext, "corpus-member-document-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Corpus member document read failed" })
    });
    expect(readCorpusManifestSeal(failingContext, "corpus-manifest-seal-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Corpus manifest seal read failed" })
    });
  });

  it("rejects stored corpus rows that leave the domain while still fitting SQL", () => {
    const invalidRowContext = {
      nativeDatabase: {
        inTransaction: true,
        prepare() {
          return {
            get() {
              return {
                corpusManifestId: "corpus-manifest-1",
                kind: "variant",
                contentHash: "not-a-sha256-digest",
                sealId: "corpus-manifest-seal-1",
                createdAt: -1,
                corpusMemberId: "corpus-member-1",
                manifestId: "corpus-manifest-1",
                candidateId: "candidate-1",
                importOrdinal: -1,
                corpusMemberDocumentId: "corpus-member-document-1",
                candidateDocumentId: "candidate-document-1-0",
                documentOrdinal: -1,
                corpusManifestSealId: "corpus-manifest-seal-1"
              };
            }
          };
        }
      }
    };

    expect(readCorpusManifest(invalidRowContext, "corpus-manifest-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored corpus manifest is invalid" })
    });
    expect(readCorpusMember(invalidRowContext, "corpus-member-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored corpus member is invalid" })
    });
    expect(readCorpusMemberDocument(invalidRowContext, "corpus-member-document-1")).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored corpus member document is invalid"
      })
    });
    expect(readCorpusManifestSeal(invalidRowContext, "corpus-manifest-seal-1")).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored corpus manifest seal is invalid"
      })
    });
  });

  it("rejects a second seal insert after the first seal succeeds", async () => {
    const connection = await openMigratedDatabase();

    const duplicate = runImmediateTransaction(connection, (context) => {
      publishVariantCorpus(context);
      return insertCorpusManifestSeal(
        context,
        unwrap(prepareCorpusManifestSeal(sealDraft()))
      );
    });

    expect(duplicate).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Corpus manifest seal insert failed" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects sealing when membership exceeds the canonical JSON node budget", async () => {
    const connection = await openMigratedDatabase();
    const memberCount = 1_500;

    const oversized = runImmediateTransaction(connection, (context) => {
      const database = context.nativeDatabase;
      database
        .prepare(
          `INSERT INTO corpus_manifest (
            corpus_manifest_id, kind, content_hash, seal_id, created_at
          ) VALUES (?, 'variant', ?, ?, ?)`
        )
        .run(
          "corpus-manifest-huge",
          "2".repeat(64),
          "corpus-manifest-seal-huge",
          1_788_700_000_000
        );

      const insertCandidate = database.prepare(
        `INSERT INTO candidate (
          candidate_id, source_system, source_key, channel, corpus_tag, is_synthetic, created_at
        ) VALUES (?, 'synthetic_corpus', ?, 'inbound', 'variant', 1, ?)`
      );
      const insertSource = database.prepare(
        `INSERT INTO source_document (
          source_document_id, raw_text, raw_hash, raw_byte_length,
          normalized_text, normalized_hash, normalized_length, normalized_byte_length, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertCandidateDocument = database.prepare(
        `INSERT INTO candidate_document (
          candidate_document_id, candidate_id, source_document_id,
          document_kind, label, document_ordinal, created_at
        ) VALUES (?, ?, ?, 'resume', 'Resume', 0, ?)`
      );
      const insertMember = database.prepare(
        `INSERT INTO corpus_member (
          corpus_member_id, manifest_id, candidate_id, import_ordinal, created_at
        ) VALUES (?, 'corpus-manifest-huge', ?, ?, ?)`
      );
      const insertMemberDocument = database.prepare(
        `INSERT INTO corpus_member_document (
          corpus_member_document_id, corpus_member_id, candidate_document_id,
          document_ordinal, created_at
        ) VALUES (?, ?, ?, 0, ?)`
      );

      for (let index = 0; index < memberCount; index += 1) {
        const candidateId = `candidate-huge-${index}`;
        const sourceDocumentId = `source-huge-${index}`;
        const candidateDocumentId = `candidate-document-huge-${index}`;
        const corpusMemberId = `corpus-member-huge-${index}`;
        const text = `huge-${index}`;
        // Distinct content-addressed raw hashes: a deterministic unique
        // lowercase hex derived from the index rather than hashing each row.
        const uniqueHash = index.toString(16).padStart(64, "0");
        insertCandidate.run(candidateId, `huge/${index}`, 1_788_700_000_000);
        insertSource.run(
          sourceDocumentId,
          text,
          uniqueHash,
          Buffer.byteLength(text, "utf8"),
          text,
          uniqueHash,
          text.length,
          Buffer.byteLength(text, "utf8"),
          1_788_700_000_000
        );
        insertCandidateDocument.run(
          candidateDocumentId,
          candidateId,
          sourceDocumentId,
          1_788_700_000_000
        );
        insertMember.run(corpusMemberId, candidateId, index, 1_788_700_000_000);
        insertMemberDocument.run(
          `corpus-member-document-huge-${index}`,
          corpusMemberId,
          candidateDocumentId,
          1_788_700_000_000
        );
      }

      return insertCorpusManifestSeal(
        context,
        unwrap(
          prepareCorpusManifestSeal(
            sealDraft({
              corpusManifestSealId: "corpus-manifest-seal-huge",
              manifestId: "corpus-manifest-huge"
            })
          )
        )
      );
    });

    expect(oversized).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Corpus manifest content hashing failed"
      })
    });

    expect(connection.close().ok).toBe(true);
  });
});

describe("corpus manifest database constraints", () => {
  it("rejects updates, deletes, and replacements of stored corpus rows", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        publishVariantCorpus(context);
        return ok(undefined);
      })
    );

    expect(() =>
      database
        .prepare("UPDATE corpus_manifest SET kind = 'main' WHERE corpus_manifest_id = ?")
        .run("corpus-manifest-1")
    ).toThrow(/corpus_manifest is immutable/u);
    expect(() =>
      database
        .prepare("DELETE FROM corpus_manifest WHERE corpus_manifest_id = ?")
        .run("corpus-manifest-1")
    ).toThrow(/corpus_manifest is immutable/u);
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO corpus_manifest (
            corpus_manifest_id, kind, content_hash, seal_id, created_at
          ) VALUES (?, 'variant', ?, ?, ?)`
        )
        .run(
          "corpus-manifest-1",
          "a".repeat(64).replace(/a/gu, "0"),
          "corpus-manifest-seal-1",
          1
        )
    ).toThrow(/corpus_manifest is immutable/u);

    expect(() =>
      database
        .prepare("UPDATE corpus_member SET import_ordinal = 1 WHERE corpus_member_id = ?")
        .run("corpus-member-1")
    ).toThrow(/corpus_member is immutable/u);
    expect(() =>
      database.prepare("DELETE FROM corpus_member WHERE corpus_member_id = ?").run("corpus-member-1")
    ).toThrow(/corpus_member is immutable/u);

    expect(() =>
      database
        .prepare(
          "UPDATE corpus_member_document SET document_ordinal = 1 WHERE corpus_member_document_id = ?"
        )
        .run("corpus-member-document-1-0")
    ).toThrow(/corpus_member_document is immutable/u);
    expect(() =>
      database
        .prepare("DELETE FROM corpus_member_document WHERE corpus_member_document_id = ?")
        .run("corpus-member-document-1-0")
    ).toThrow(/corpus_member_document is immutable/u);

    expect(() =>
      database
        .prepare("UPDATE corpus_manifest_seal SET created_at = 0 WHERE corpus_manifest_seal_id = ?")
        .run("corpus-manifest-seal-1")
    ).toThrow(/corpus_manifest_seal is immutable/u);
    expect(() =>
      database
        .prepare("DELETE FROM corpus_manifest_seal WHERE corpus_manifest_seal_id = ?")
        .run("corpus-manifest-seal-1")
    ).toThrow(/corpus_manifest_seal is immutable/u);

    expect(connection.close().ok).toBe(true);
  });

  it("rejects sealing an empty or noncontiguous membership", async () => {
    const connection = await openMigratedDatabase();

    const empty = runImmediateTransaction(connection, (context) => {
      seedCandidateBundle(context, 0);
      const content = variantContent();
      const manifest = unwrap(
        prepareCorpusManifest(manifestDraft({ content, kind: content.kind }))
      );
      unwrap(insertCorpusManifest(context, manifest));
      return insertCorpusManifestSeal(
        context,
        unwrap(prepareCorpusManifestSeal(sealDraft()))
      );
    });
    expect(empty).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Invalid corpus manifest content"
      })
    });

    const mismatchedDocument = runImmediateTransaction(connection, (context) => {
      seedCandidateBundle(context, 0);
      seedCandidateBundle(context, 1);
      const content = variantContent(1);
      const manifest = unwrap(
        prepareCorpusManifest(
          manifestDraft({
            corpusManifestId: "corpus-manifest-2",
            sealId: "corpus-manifest-seal-2",
            content,
            kind: content.kind
          })
        )
      );
      unwrap(insertCorpusManifest(context, manifest));
      unwrap(
        insertCorpusMember(
          context,
          unwrap(
            prepareCorpusMember(
              memberDraft({
                corpusMemberId: "corpus-member-2",
                manifestId: "corpus-manifest-2"
              })
            )
          )
        )
      );
      return insertCorpusMemberDocument(
        context,
        unwrap(
          prepareCorpusMemberDocument(
            memberDocumentDraft({
              corpusMemberDocumentId: "corpus-member-document-2",
              corpusMemberId: "corpus-member-2",
              candidateDocumentId: "candidate-document-2-0"
            })
          )
        )
      );
    });
    expect(mismatchedDocument).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Corpus member document insert failed"
      })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a seal whose ID does not match the manifest seal_id", async () => {
    const connection = await openMigratedDatabase();

    const mismatched = runImmediateTransaction(connection, (context) => {
      seedCandidateBundle(context, 0);
      const content = variantContent();
      const manifest = unwrap(
        prepareCorpusManifest(manifestDraft({ content, kind: content.kind }))
      );
      unwrap(insertCorpusManifest(context, manifest));
      unwrap(
        insertCorpusMember(context, unwrap(prepareCorpusMember(memberDraft())))
      );
      unwrap(
        insertCorpusMemberDocument(
          context,
          unwrap(prepareCorpusMemberDocument(memberDocumentDraft()))
        )
      );
      return insertCorpusManifestSeal(
        context,
        unwrap(
          prepareCorpusManifestSeal(
            sealDraft({ corpusManifestSealId: "corpus-manifest-seal-other" })
          )
        )
      );
    });

    expect(mismatched).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Corpus manifest seal ID does not match the manifest seal_id"
      })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a seal when relational rows no longer match the content hash", async () => {
    const connection = await openMigratedDatabase();

    const drifted = runImmediateTransaction(connection, (context) => {
      seedCandidateBundle(context, 0);
      const content = variantContent(1);
      const realHash = unwrap(hashCorpusManifestContent(content));
      const wrongHash = realHash === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);

      // Write a manifest whose stored hash cannot match the membership rows
      // that follow, then prove seal refuses the pair inside one transaction.
      context.nativeDatabase
        .prepare(
          `INSERT INTO corpus_manifest (
            corpus_manifest_id, kind, content_hash, seal_id, created_at
          ) VALUES (?, 'variant', ?, ?, ?)`
        )
        .run(
          "corpus-manifest-1",
          wrongHash,
          "corpus-manifest-seal-1",
          1_788_700_000_000
        );
      unwrap(
        insertCorpusMember(context, unwrap(prepareCorpusMember(memberDraft())))
      );
      unwrap(
        insertCorpusMemberDocument(
          context,
          unwrap(prepareCorpusMemberDocument(memberDocumentDraft()))
        )
      );
      return insertCorpusManifestSeal(
        context,
        unwrap(prepareCorpusManifestSeal(sealDraft()))
      );
    });

    expect(drifted).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Corpus manifest relational rows do not match the content hash"
      })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects sealing a main corpus that is not exactly 140 members", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    const rejected = runImmediateTransaction(connection, (context) => {
      seedCandidateBundle(context, 0);
      // Bypass prepare's main-size guard the way a raw SQL writer would, then
      // prove the seal trigger still refuses an undersized main corpus.
      context.nativeDatabase
        .prepare(
          `INSERT INTO corpus_manifest (
            corpus_manifest_id, kind, content_hash, seal_id, created_at
          ) VALUES (?, 'main', ?, ?, ?)`
        )
        .run(
          "corpus-manifest-main",
          "b".repeat(64).replace(/b/gu, "1"),
          "corpus-manifest-seal-main",
          1_788_700_000_000
        );
      context.nativeDatabase
        .prepare(
          `INSERT INTO corpus_member (
            corpus_member_id, manifest_id, candidate_id, import_ordinal, created_at
          ) VALUES (?, ?, ?, 0, ?)`
        )
        .run(
          "corpus-member-main-1",
          "corpus-manifest-main",
          "candidate-1",
          1_788_700_000_000
        );
      context.nativeDatabase
        .prepare(
          `INSERT INTO corpus_member_document (
            corpus_member_document_id, corpus_member_id, candidate_document_id,
            document_ordinal, created_at
          ) VALUES (?, ?, ?, 0, ?)`
        )
        .run(
          "corpus-member-document-main-1",
          "corpus-member-main-1",
          "candidate-document-1-0",
          1_788_700_000_000
        );
      return insertCorpusManifestSeal(
        context,
        unwrap(
          prepareCorpusManifestSeal(
            sealDraft({
              corpusManifestSealId: "corpus-manifest-seal-main",
              manifestId: "corpus-manifest-main"
            })
          )
        )
      );
    });

    expect(rejected).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: `Main corpus manifests require exactly ${MAIN_DEMO_CORPUS_MEMBER_COUNT} members`
      })
    });
    expect(
      database.prepare("SELECT count(*) AS total FROM corpus_manifest_seal").get()
    ).toEqual({ total: 0 });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a seal for a missing manifest", async () => {
    const connection = await openMigratedDatabase();

    const missing = runImmediateTransaction(connection, (context) =>
      insertCorpusManifestSeal(context, unwrap(prepareCorpusManifestSeal(sealDraft())))
    );

    expect(missing).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Corpus manifest seal requires a stored manifest"
      })
    });

    expect(connection.close().ok).toBe(true);
  });
});
