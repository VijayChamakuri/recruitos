import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ok, type Result } from "@recruitos/core";

import type {
  CandidateSourceAdapter,
  CandidateSourcePage,
  CandidateSourceRecord
} from "../adapters/index.js";
import {
  createSyntheticCandidateSourceAdapter,
  SYNTHETIC_CANDIDATE_SOURCE_SYSTEM
} from "../adapters/index.js";
import {
  createIncrementingIdGenerator,
  createRuntime,
  fixedClock,
  type IdGenerator,
  type RuntimeComposition
} from "../composition/index.js";
import type { RuntimeError } from "../errors/index.js";
import { importCandidates } from "./import-candidates.js";

const CREATED_AT = 1_788_700_000_000;
const temporaryDirectories: string[] = [];

type NativeStatement = Readonly<{
  get: (...parameters: readonly unknown[]) => unknown;
  all: (...parameters: readonly unknown[]) => unknown[];
}>;
type NativeDatabase = Readonly<{ prepare: (sql: string) => NativeStatement }>;

function nativeDatabase(runtime: RuntimeComposition): NativeDatabase {
  return (runtime.connection.database as unknown as { $client: NativeDatabase }).$client;
}

function scriptedIdGenerator(ids: readonly string[]): IdGenerator {
  let index = 0;
  return Object.freeze({
    next: (): string => {
      const id = ids[index] ?? `overflow-${index}`;
      index += 1;
      return id;
    }
  });
}

async function runtimeWith(
  records: readonly CandidateSourceRecord[],
  overrides: Partial<Parameters<typeof createRuntime>[0]> = {}
): Promise<RuntimeComposition> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-import-"));
  temporaryDirectories.push(directory);
  const result = createRuntime({
    database: { filename: join(directory, "runtime.db") },
    clock: fixedClock(CREATED_AT),
    idGenerator: createIncrementingIdGenerator("test"),
    candidateSource: createSyntheticCandidateSourceAdapter({ records: [...records] }),
    ...overrides
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function document(
  overrides: Partial<CandidateSourceRecord["documents"][number]> = {}
): CandidateSourceRecord["documents"][number] {
  return {
    documentKind: "resume",
    label: "Resume",
    documentOrdinal: 0,
    rawText: "Built retrieval systems at scale.",
    ...overrides
  };
}

function record(overrides: Partial<CandidateSourceRecord> = {}): CandidateSourceRecord {
  return {
    sourceKey: "cand-1",
    channel: "inbound",
    documents: [document()],
    applicationAnswers: { workAuthorization: undefined },
    ...overrides
  };
}

function workAuthorizationAnswer(): NonNullable<
  CandidateSourceRecord["applicationAnswers"]["workAuthorization"]
> {
  return {
    questionKey: "eligible_to_work",
    selectedOptionKey: "authorized_no_sponsorship",
    freeText: undefined,
    provenance: {
      collectedBy: "ats_synthetic",
      formId: "form-1",
      questionId: "q-work-auth",
      collectedAt: CREATED_AT - 1000
    }
  };
}

function unwrap<T>(result: Result<T, RuntimeError>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("importCandidates", () => {
  it("imports candidates with normalized documents and returns their ids", async () => {
    const runtime = await runtimeWith([
      record({
        sourceKey: "cand-1",
        documents: [
          document({ rawText: "﻿Resume line one.\r\nResume line two." }),
          document({
            documentKind: "cover_letter",
            label: "Cover letter",
            documentOrdinal: 1,
            rawText: "I ship evaluation harnesses."
          })
        ]
      }),
      record({ sourceKey: "cand-2", channel: "sourced" })
    ]);

    const execution = unwrap(await importCandidates(runtime, { actorId: "actor-import" }));
    expect(execution.result.imported).toBe(2);
    expect(execution.result.skipped).toBe(0);
    expect(execution.result.candidateIds).toHaveLength(2);

    const candidates = nativeDatabase(runtime)
      .prepare(
        `SELECT source_key AS sourceKey, channel, corpus_tag AS corpusTag
         FROM candidate ORDER BY source_key`
      )
      .all() as ReadonlyArray<{ sourceKey: string; channel: string; corpusTag: string }>;
    expect(candidates).toEqual([
      { sourceKey: "cand-1", channel: "inbound", corpusTag: "main" },
      { sourceKey: "cand-2", channel: "sourced", corpusTag: "main" }
    ]);

    const normalized = nativeDatabase(runtime)
      .prepare(
        `SELECT s.normalized_text AS normalizedText
         FROM source_document s
         JOIN candidate_document cd ON cd.source_document_id = s.source_document_id
         JOIN candidate c ON c.candidate_id = cd.candidate_id
         WHERE c.source_key = 'cand-1' AND cd.document_ordinal = 0`
      )
      .get() as { normalizedText: string };
    expect(normalized.normalizedText).toBe("Resume line one.\nResume line two.");
  });

  it("persists a structured work authorization answer with its provenance", async () => {
    const runtime = await runtimeWith([
      record({
        sourceKey: "cand-wa",
        applicationAnswers: { workAuthorization: workAuthorizationAnswer() }
      })
    ]);

    unwrap(await importCandidates(runtime, { actorId: "actor-import" }));

    const answer = nativeDatabase(runtime)
      .prepare(
        `SELECT question_key AS questionKey, selected_option_key AS selectedOptionKey,
                free_text AS freeText, collected_by AS collectedBy, form_id AS formId,
                question_id AS questionId, collected_at AS collectedAt
         FROM candidate_application_answer`
      )
      .get() as Record<string, unknown>;
    expect(answer).toEqual({
      questionKey: "work_authorization",
      selectedOptionKey: "authorized_no_sponsorship",
      freeText: null,
      collectedBy: "ats_synthetic",
      formId: "form-1",
      questionId: "q-work-auth",
      collectedAt: CREATED_AT - 1000
    });
  });

  it("keeps a supplied free-text answer", async () => {
    const answer = workAuthorizationAnswer();
    const runtime = await runtimeWith([
      record({
        sourceKey: "cand-wa",
        applicationAnswers: {
          workAuthorization: { ...answer, freeText: "TN visa, renewable." }
        }
      })
    ]);
    unwrap(await importCandidates(runtime, { actorId: "actor-import" }));
    const row = nativeDatabase(runtime)
      .prepare("SELECT free_text AS freeText FROM candidate_application_answer")
      .get() as { freeText: string };
    expect(row.freeText).toBe("TN visa, renewable.");
  });

  it("is idempotent: a second import skips every existing candidate", async () => {
    const runtime = await runtimeWith([record({ sourceKey: "cand-1" })]);
    unwrap(await importCandidates(runtime, { actorId: "actor-import" }));
    const again = unwrap(await importCandidates(runtime, { actorId: "actor-import" }));
    expect(again.result).toEqual({ imported: 0, skipped: 1, candidateIds: [] });
    const count = nativeDatabase(runtime)
      .prepare("SELECT count(*) AS n FROM candidate")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("stores identical raw document bytes once and reuses the row", async () => {
    const shared = "Shared recruiter note body.";
    const runtime = await runtimeWith([
      record({ sourceKey: "cand-1", documents: [document({ rawText: shared })] }),
      record({ sourceKey: "cand-2", documents: [document({ rawText: shared })] })
    ]);
    unwrap(await importCandidates(runtime, { actorId: "actor-import" }));
    const docs = nativeDatabase(runtime)
      .prepare("SELECT count(*) AS n FROM source_document")
      .get() as { n: number };
    expect(docs.n).toBe(1);
    const links = nativeDatabase(runtime)
      .prepare("SELECT count(*) AS n FROM candidate_document")
      .get() as { n: number };
    expect(links.n).toBe(2);
  });

  it("walks every source page", async () => {
    const runtime = await runtimeWith([
      record({ sourceKey: "cand-1" }),
      record({ sourceKey: "cand-2" }),
      record({ sourceKey: "cand-3" })
    ]);
    const execution = unwrap(
      await importCandidates(runtime, { actorId: "actor-import", pageSize: 2 })
    );
    expect(execution.result.imported).toBe(3);
  });

  it("imports into the variant corpus when asked", async () => {
    const runtime = await runtimeWith([record({ sourceKey: "cand-1" })]);
    unwrap(
      await importCandidates(runtime, { actorId: "actor-import", corpusTag: "variant" })
    );
    const row = nativeDatabase(runtime)
      .prepare("SELECT corpus_tag AS corpusTag FROM candidate")
      .get() as { corpusTag: string };
    expect(row.corpusTag).toBe("variant");
  });

  it("rejects a candidate whose source key is not printable ascii", async () => {
    const runtime = await runtimeWith([record({ sourceKey: "has space" })]);
    const result = await importCandidates(runtime, { actorId: "actor-import" });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Invalid candidate input" }
    });
  });

  it("rejects an unknown channel", async () => {
    const runtime = await runtimeWith([
      record({ sourceKey: "cand-1", channel: "carrier-pigeon" })
    ]);
    const result = await importCandidates(runtime, { actorId: "actor-import" });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "persistence_failed", message: "Unknown candidate channel: carrier-pigeon" }
    });
  });

  it("rejects an unknown document kind", async () => {
    const runtime = await runtimeWith([
      record({ sourceKey: "cand-1", documents: [document({ documentKind: "transcript" })] })
    ]);
    const result = await importCandidates(runtime, { actorId: "actor-import" });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Unknown candidate document kind: transcript" }
    });
  });

  it("rejects a record with no documents", async () => {
    const runtime = await runtimeWith([record({ sourceKey: "cand-1", documents: [] })]);
    const result = await importCandidates(runtime, { actorId: "actor-import" });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Candidate record carries no documents" }
    });
  });

  it("rejects document text that fails normalization", async () => {
    const runtime = await runtimeWith([
      record({ sourceKey: "cand-1", documents: [document({ rawText: "\uD800" })] })
    ]);
    const result = await importCandidates(runtime, { actorId: "actor-import" });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Candidate document text is invalid: Source text is not well-formed UTF-16" }
    });
  });

  it("rejects a candidate document that exceeds the ordinal bound", async () => {
    const runtime = await runtimeWith([
      record({ sourceKey: "cand-1", documents: [document({ documentOrdinal: 9 })] })
    ]);
    const result = await importCandidates(runtime, { actorId: "actor-import" });
    expect(result).toMatchObject({ ok: false, error: { message: "Invalid candidate document input" } });
  });

  it("rejects a source document that exceeds the byte limit", async () => {
    const runtime = await runtimeWith([
      record({
        sourceKey: "cand-1",
        documents: [document({ rawText: "a".repeat(262_145) })]
      })
    ]);
    const result = await importCandidates(runtime, { actorId: "actor-import" });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Source document raw text exceeds the byte limit" }
    });
  });

  it("rejects an application answer with an invalid provenance field", async () => {
    const answer = workAuthorizationAnswer();
    const runtime = await runtimeWith([
      record({
        sourceKey: "cand-1",
        applicationAnswers: {
          workAuthorization: { ...answer, provenance: { ...answer.provenance, collectedBy: "" } }
        }
      })
    ]);
    const result = await importCandidates(runtime, { actorId: "actor-import" });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Invalid candidate application answer input" }
    });
  });

  it("stops when the source exceeds the import limit", async () => {
    const runtime = await runtimeWith([
      record({ sourceKey: "cand-1" }),
      record({ sourceKey: "cand-2" })
    ]);
    const result = await importCandidates(runtime, {
      actorId: "actor-import",
      maximumCandidates: 1
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Candidate source exceeded the import limit" }
    });
  });

  it("propagates a first-page source failure", async () => {
    const failing: CandidateSourceAdapter = {
      descriptor: {
        adapterId: "failing",
        sourceSystem: SYNTHETIC_CANDIDATE_SOURCE_SYSTEM,
        contractVersion: 1
      },
      listCandidates: (): Promise<Result<CandidateSourcePage, RuntimeError>> =>
        Promise.resolve({
          ok: false,
          error: { code: "persistence_failed", message: "source offline", retryable: false }
        })
    };
    const runtime = await runtimeWith([], { candidateSource: failing });
    const result = await importCandidates(runtime, { actorId: "actor-import" });
    expect(result).toMatchObject({ ok: false, error: { message: "source offline" } });
  });

  it("propagates a later-page source failure", async () => {
    let call = 0;
    const flaky: CandidateSourceAdapter = {
      descriptor: {
        adapterId: "flaky",
        sourceSystem: SYNTHETIC_CANDIDATE_SOURCE_SYSTEM,
        contractVersion: 1
      },
      listCandidates: (): Promise<Result<CandidateSourcePage, RuntimeError>> => {
        call += 1;
        if (call === 1) {
          return Promise.resolve(
            ok({
              descriptor: {
                adapterId: "flaky",
                sourceSystem: SYNTHETIC_CANDIDATE_SOURCE_SYSTEM,
                contractVersion: 1
              },
              records: [record({ sourceKey: "cand-1" })],
              nextCursor: "cand-1"
            })
          );
        }
        return Promise.resolve({
          ok: false,
          error: { code: "persistence_failed", message: "page two failed", retryable: false }
        });
      }
    };
    const runtime = await runtimeWith([], { candidateSource: flaky });
    const result = await importCandidates(runtime, { actorId: "actor-import" });
    expect(result).toMatchObject({ ok: false, error: { message: "page two failed" } });
  });

  // Every scripted sequence below accounts for runUseCaseCommand consuming the
  // first id for the command itself, so index 0 is always the command id.

  it("rolls back and reports when the id generator yields a candidate collision", async () => {
    const runtime = await runtimeWith(
      [record({ sourceKey: "cand-1" }), record({ sourceKey: "cand-2" })],
      { idGenerator: scriptedIdGenerator(["cmd", "DUP", "src-1", "link-1", "DUP"]) }
    );
    const result = await importCandidates(runtime, { actorId: "actor-import" });
    expect(result).toMatchObject({ ok: false, error: { message: "Candidate insert failed" } });
    const count = nativeDatabase(runtime)
      .prepare("SELECT count(*) AS n FROM candidate")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("reports a source document id collision", async () => {
    const runtime = await runtimeWith(
      [
        record({
          sourceKey: "cand-1",
          documents: [
            document({ rawText: "first doc" }),
            document({ documentOrdinal: 1, rawText: "second doc" })
          ]
        })
      ],
      { idGenerator: scriptedIdGenerator(["cmd", "cand", "SRC", "cd-1", "SRC", "cd-2"]) }
    );
    const result = await importCandidates(runtime, { actorId: "actor-import" });
    expect(result).toMatchObject({ ok: false, error: { message: "Source document insert failed" } });
  });

  it("reports a candidate document link collision", async () => {
    const runtime = await runtimeWith(
      [
        record({
          sourceKey: "cand-1",
          documents: [
            document({ rawText: "shared" }),
            document({ documentOrdinal: 1, rawText: "shared" })
          ]
        })
      ],
      { idGenerator: scriptedIdGenerator(["cmd", "cand", "src", "LINK", "LINK"]) }
    );
    const result = await importCandidates(runtime, { actorId: "actor-import" });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Candidate document insert failed" }
    });
  });

  it("reports an application answer id collision", async () => {
    const runtime = await runtimeWith(
      [
        record({
          sourceKey: "cand-1",
          documents: [document({ rawText: "resume one" })],
          applicationAnswers: { workAuthorization: workAuthorizationAnswer() }
        }),
        record({
          sourceKey: "cand-2",
          documents: [document({ rawText: "resume two" })],
          applicationAnswers: { workAuthorization: workAuthorizationAnswer() }
        })
      ],
      {
        idGenerator: scriptedIdGenerator([
          "cmd",
          "c1",
          "s1",
          "l1",
          "ANS",
          "c2",
          "s2",
          "l2",
          "ANS"
        ])
      }
    );
    const result = await importCandidates(runtime, { actorId: "actor-import" });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Candidate application answer insert failed" }
    });
  });

  it("rejects an invalid composition", async () => {
    const result = await importCandidates({} as RuntimeComposition, { actorId: "a" });
    expect(result).toMatchObject({ ok: false, error: { message: "Invalid runtime composition" } });
  });

  it("rejects a missing actor id", async () => {
    const runtime = await runtimeWith([record()]);
    const result = await importCandidates(runtime, { actorId: "" });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Import requires an actor id" }
    });
  });

  it("rejects an invalid page size", async () => {
    const runtime = await runtimeWith([record()]);
    const result = await importCandidates(runtime, { actorId: "a", pageSize: 0 });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Page size must be a positive integer" }
    });
  });

  it("rejects an invalid maximum candidates", async () => {
    const runtime = await runtimeWith([record()]);
    const result = await importCandidates(runtime, {
      actorId: "a",
      maximumCandidates: 1.5
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Maximum candidates must be a positive integer" }
    });
  });

  it("rejects an invalid corpus tag", async () => {
    const runtime = await runtimeWith([record()]);
    const result = await importCandidates(runtime, {
      actorId: "a",
      corpusTag: "archive" as never
    });
    expect(result).toMatchObject({ ok: false, error: { message: "Invalid corpus tag" } });
  });
});
