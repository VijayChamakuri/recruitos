import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ok, type Result } from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runImmediateTransaction } from "../commands/index.js";
import { openRuntimeDatabase, type RuntimeDatabaseConnection } from "../db/index.js";
import { insertCandidate, prepareCandidate } from "../entities/index.js";
import { type RuntimeError } from "../errors/index.js";
import {
  insertCandidateApplicationAnswer,
  prepareCandidateApplicationAnswer,
  readCandidateApplicationAnswer,
  readCandidateApplicationAnswerByCandidateQuestion
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const COLLECTED_AT = 1_700_000_000_000;
const TRANSACTION_REQUIRED =
  "Candidate application answers require an active command transaction";

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-application-answers-test-"));
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

function answerDraft(overrides: Record<string, unknown> = {}) {
  return {
    candidateApplicationAnswerId: "candidate-application-answer-1",
    candidateId: "candidate-1",
    questionKey: "work_auth",
    selectedOptionKey: "authorized_us",
    freeText: null,
    collectedBy: "ats",
    formId: "app-form-1",
    questionId: "q-auth",
    collectedAt: COLLECTED_AT,
    createdAt: CREATED_AT,
    ...overrides
  };
}

function seedCandidate(context: Parameters<typeof insertCandidate>[0]): void {
  unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("candidate application answer persistence", () => {
  it("prepares a stored answer, trims keys, and rejects invalid or hostile drafts", () => {
    const record = unwrap(
      prepareCandidateApplicationAnswer(
        answerDraft({
          questionKey: "  work_auth  ",
          selectedOptionKey: "  authorized_us  ",
          collectedBy: "  ats  "
        })
      )
    );
    expect(record).toEqual(answerDraft());
    expect(Object.isFrozen(record)).toBe(true);

    const omittedFreeText = unwrap(
      prepareCandidateApplicationAnswer(answerDraft({ freeText: undefined }))
    );
    expect(omittedFreeText.freeText).toBeNull();

    expect(prepareCandidateApplicationAnswer({ ...answerDraft(), extra: true })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate application answer input" })
    });
    expect(prepareCandidateApplicationAnswer(answerDraft({ questionKey: "   " }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate application answer input" })
    });
    expect(
      prepareCandidateApplicationAnswer(withThrowingGetter(answerDraft(), "questionKey"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Candidate application answer preparation failed"
      })
    });
  });

  it("inserts one answer per candidate and question and reads it back", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedCandidate(context);
        expect(
          unwrap(readCandidateApplicationAnswerByCandidateQuestion(context, "candidate-1", "work_auth"))
        ).toBeUndefined();
        const inserted = unwrap(
          insertCandidateApplicationAnswer(
            context,
            unwrap(prepareCandidateApplicationAnswer(answerDraft({ freeText: "Need start date." })))
          )
        );
        expect(inserted.freeText).toBe("Need start date.");
        expect(unwrap(readCandidateApplicationAnswer(context, "candidate-application-answer-1"))).toEqual(
          inserted
        );
        expect(
          unwrap(readCandidateApplicationAnswerByCandidateQuestion(context, "candidate-1", "work_auth"))
        ).toEqual(inserted);
        expect(
          unwrap(readCandidateApplicationAnswer(context, "candidate-application-answer-missing"))
        ).toBeUndefined();
        expect(
          unwrap(
            readCandidateApplicationAnswerByCandidateQuestion(context, "candidate-missing", "work_auth")
          )
        ).toBeUndefined();

        unwrap(
          insertCandidateApplicationAnswer(
            context,
            unwrap(
              prepareCandidateApplicationAnswer(
                answerDraft({
                  candidateApplicationAnswerId: "candidate-application-answer-2",
                  questionKey: "relocation",
                  selectedOptionKey: "willing"
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

  it("rejects unprepared inserts, missing parents, and a reused candidate question", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(insertCandidateApplicationAnswer(context, answerDraft())).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Invalid prepared candidate application answer"
          })
        });
        expect(
          insertCandidateApplicationAnswer(
            context,
            unwrap(prepareCandidateApplicationAnswer(answerDraft()))
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Candidate application answer insert failed" })
        });
        seedCandidate(context);
        unwrap(
          insertCandidateApplicationAnswer(
            context,
            unwrap(prepareCandidateApplicationAnswer(answerDraft()))
          )
        );
        expect(
          insertCandidateApplicationAnswer(
            context,
            unwrap(
              prepareCandidateApplicationAnswer(
                answerDraft({ candidateApplicationAnswerId: "candidate-application-answer-2" })
              )
            )
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Candidate application answer insert failed" })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("requires an active command transaction for insert and read", () => {
    const prepared = unwrap(prepareCandidateApplicationAnswer(answerDraft()));
    for (const contextInput of [undefined, null, {}, { nativeDatabase: null }]) {
      expect(insertCandidateApplicationAnswer(contextInput, prepared)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readCandidateApplicationAnswer(contextInput, "candidate-application-answer-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(
        readCandidateApplicationAnswerByCandidateQuestion(contextInput, "candidate-1", "work_auth")
      ).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
    }
    expect(insertCandidateApplicationAnswer(failingContext(), prepared)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate application answer insert failed" })
    });
    expect(readCandidateApplicationAnswer(failingContext(), "candidate-application-answer-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate application answer read failed" })
    });
    expect(
      readCandidateApplicationAnswerByCandidateQuestion(failingContext(), "candidate-1", "work_auth")
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate application answer read failed" })
    });
  });

  it("rejects invalid identifiers and invalid stored rows", () => {
    expect(
      readCandidateApplicationAnswer(failingContext(() => ({ get: () => undefined })), "bad id")
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate application answer ID" })
    });
    expect(
      readCandidateApplicationAnswerByCandidateQuestion(
        failingContext(() => ({ get: () => undefined })),
        "bad id",
        "work_auth"
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate ID" })
    });
    expect(
      readCandidateApplicationAnswerByCandidateQuestion(
        failingContext(() => ({ get: () => undefined })),
        "candidate-1",
        "   "
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid application answer question key" })
    });
    expect(
      readCandidateApplicationAnswer(
        failingContext(() => ({ get: () => ({ invalid: true }) })),
        "candidate-application-answer-1"
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored candidate application answer is invalid" })
    });
    expect(
      readCandidateApplicationAnswerByCandidateQuestion(
        failingContext(() => ({ get: () => ({ invalid: true }) })),
        "candidate-1",
        "work_auth"
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored candidate application answer is invalid" })
    });
  });

  it("keeps candidate_application_answer STRICT and immutable", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        const database = nativeDatabase(connection);
        expect(
          database
            .prepare(
              "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'candidate_application_answer'"
            )
            .pluck()
            .get()
        ).toContain("STRICT");
        const triggerNames = (
          database
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'candidate_application_answer_%' ORDER BY name"
            )
            .pluck()
            .all() as string[]
        ).sort();
        expect(triggerNames).toEqual([
          "candidate_application_answer_reject_delete",
          "candidate_application_answer_reject_replace",
          "candidate_application_answer_reject_update"
        ]);

        seedCandidate(context);
        unwrap(
          insertCandidateApplicationAnswer(
            context,
            unwrap(prepareCandidateApplicationAnswer(answerDraft()))
          )
        );
        expect(() =>
          database.exec(
            "UPDATE candidate_application_answer SET selected_option_key = 'needs_sponsor' WHERE candidate_application_answer_id = 'candidate-application-answer-1'"
          )
        ).toThrow(/immutable/u);
        expect(() =>
          database.exec(
            "DELETE FROM candidate_application_answer WHERE candidate_application_answer_id = 'candidate-application-answer-1'"
          )
        ).toThrow(/immutable/u);
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });
});
