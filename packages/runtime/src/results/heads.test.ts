import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ok, type Result } from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runImmediateTransaction, type ImmediateTransactionContext } from "../commands/index.js";
import { openRuntimeDatabase, type RuntimeDatabaseConnection } from "../db/index.js";
import { insertCandidate, prepareCandidate } from "../entities/index.js";
import { type RuntimeError } from "../errors/index.js";
import {
  insertResolutionTask,
  prepareResolutionTask
} from "../resolution/index.js";
import {
  insertCandidateResultReason,
  insertCandidateResultSeal,
  insertCandidateTriageResult,
  prepareCandidateResultReason,
  prepareCandidateResultSeal,
  prepareCandidateTriageResult,
  readCandidateHead,
  setCandidateHead
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const TRANSACTION_REQUIRED = "Candidate head rows require an active command transaction";

const CANDIDATE_HEAD_COLUMNS = `
  candidate_id text PRIMARY KEY NOT NULL,
  current_result_id text NOT NULL,
  version integer NOT NULL
`;

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-candidate-head-test-"));
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

function unavailableResultDraft(overrides: Record<string, unknown> = {}) {
  const candidateTriageResultId =
    typeof overrides.candidateTriageResultId === "string"
      ? overrides.candidateTriageResultId
      : "candidate-result-1";
  return {
    candidateTriageResultId,
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
    sealId: `candidate-result-seal-${candidateTriageResultId}`,
    createdAt: CREATED_AT,
    ...overrides
  };
}

function headDraft(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: "candidate-1",
    currentResultId: "candidate-result-1",
    ...overrides
  };
}

function seedCandidate(
  context: ImmediateTransactionContext,
  overrides: Record<string, unknown> = {}
): void {
  unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft(overrides)))));
}

function seedResult(
  context: ImmediateTransactionContext,
  overrides: Record<string, unknown> = {}
): void {
  const result = unwrap(prepareCandidateTriageResult(unavailableResultDraft(overrides)));
  unwrap(insertCandidateTriageResult(context, result));
  const reason = unwrap(
    prepareCandidateResultReason({
      candidateResultReasonId: `candidate-result-reason-${result.candidateTriageResultId}`,
      candidateResultId: result.candidateTriageResultId,
      reasonCode: "assessment_unavailable",
      reasonOrdinal: 0,
      createdAt: result.createdAt
    })
  );
  unwrap(insertCandidateResultReason(context, reason));
  unwrap(
    insertResolutionTask(
      context,
      unwrap(
        prepareResolutionTask({
          resolutionTaskId: `resolution-task-${result.candidateTriageResultId}`,
          candidateResultId: result.candidateTriageResultId,
          candidateResultReasonId: reason.candidateResultReasonId,
          taskOrdinal: 0,
          createdAt: result.createdAt
        })
      )
    )
  );
  unwrap(
    insertCandidateResultSeal(
      context,
      unwrap(
        prepareCandidateResultSeal({
          candidateResultSealId: result.sealId,
          candidateResultId: result.candidateTriageResultId,
          createdAt: result.createdAt
        })
      )
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
  extraTriggers: readonly string[] = []
): void {
  const triggerNames = [
    "candidate_head_reject_update",
    "candidate_head_reject_delete",
    "candidate_head_reject_replace",
    "triage_run_seal_reject_incomplete",
    ...extraTriggers
  ];
  database.exec(`
    PRAGMA foreign_keys = OFF;
    ${triggerNames.map((name) => `DROP TRIGGER IF EXISTS ${name};`).join("\n")}
    CREATE TABLE candidate_head_rebuilt (
      ${CANDIDATE_HEAD_COLUMNS}
    ) STRICT;
    INSERT INTO candidate_head_rebuilt SELECT * FROM candidate_head;
    DROP TABLE candidate_head;
    ALTER TABLE candidate_head_rebuilt RENAME TO candidate_head;
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

describe("candidate head persistence", () => {
  it("initializes at version 1 and compare-and-sets the current result pointer", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedCandidate(context);
        seedResult(context);
        seedResult(context, {
          candidateTriageResultId: "candidate-result-2",
          kind: "correction",
          supersedesResultId: "candidate-result-1"
        });
        expect(unwrap(readCandidateHead(context, "candidate-1"))).toBeUndefined();
        expect(setCandidateHead(context, headDraft(), 1)).toEqual({
          ok: false,
          error: expect.objectContaining({
            code: "version_conflict",
            message: "Mutable head version conflict",
            details: expect.objectContaining({
              table: "candidate_head",
              identity: "candidate-1",
              expectedVersion: 1,
              actualVersion: null
            })
          })
        });
        expect(unwrap(setCandidateHead(context, headDraft(), 0))).toEqual({
          candidateId: "candidate-1",
          currentResultId: "candidate-result-1",
          version: 1
        });
        expect(unwrap(readCandidateHead(context, "candidate-1"))).toEqual({
          candidateId: "candidate-1",
          currentResultId: "candidate-result-1",
          version: 1
        });
        expect(
          setCandidateHead(context, headDraft({ currentResultId: "candidate-result-2" }), 0)
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            code: "version_conflict",
            details: expect.objectContaining({
              expectedVersion: 0,
              actualVersion: 1
            })
          })
        });
        expect(
          setCandidateHead(context, headDraft({ currentResultId: "candidate-result-2" }), 2)
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            code: "version_conflict",
            details: expect.objectContaining({
              expectedVersion: 2,
              actualVersion: 1
            })
          })
        });
        expect(
          unwrap(
            setCandidateHead(context, headDraft({ currentResultId: "candidate-result-2" }), 1)
          )
        ).toEqual({
          candidateId: "candidate-1",
          currentResultId: "candidate-result-2",
          version: 2
        });
        expect(unwrap(readCandidateHead(context, "candidate-1"))).toEqual({
          candidateId: "candidate-1",
          currentResultId: "candidate-result-2",
          version: 2
        });
        expect(Object.isFrozen(unwrap(readCandidateHead(context, "candidate-1")))).toBe(true);
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("rejects missing parents, foreign results, and invalid input", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(setCandidateHead(context, headDraft(), 0)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate head requires a stored candidate"
          })
        });
        seedCandidate(context);
        expect(setCandidateHead(context, headDraft(), 0)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate head requires a stored candidate result"
          })
        });
        seedResult(context);
        seedCandidate(context, {
          candidateId: "candidate-2",
          sourceKey: "tier-one/0002"
        });
        seedResult(context, {
          candidateTriageResultId: "candidate-result-other",
          candidateId: "candidate-2"
        });
        expect(
          setCandidateHead(context, headDraft({ currentResultId: "candidate-result-other" }), 0)
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Candidate head current_result_id must belong to the candidate"
          })
        });
        expect(setCandidateHead(context, { ...headDraft(), extra: true }, 0)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid candidate head input" })
        });
        expect(setCandidateHead(context, headDraft(), "1")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid expected head version" })
        });
        expect(setCandidateHead(context, headDraft(), -1)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid expected head version" })
        });
        unwrap(setCandidateHead(context, headDraft(), 0));
        unwrap(
          setCandidateHead(
            context,
            { candidateId: "candidate-2", currentResultId: "candidate-result-other" },
            0
          )
        );
        expect(unwrap(readCandidateHead(context, "candidate-2"))).toEqual({
          candidateId: "candidate-2",
          currentResultId: "candidate-result-other",
          version: 1
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("requires a command transaction", () => {
    expect(setCandidateHead(null, headDraft(), 0)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
    });
    expect(readCandidateHead({}, "candidate-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
    });
    expect(
      setCandidateHead({ nativeDatabase: { inTransaction: false } }, headDraft(), 0)
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
    });
    expect(setCandidateHead(failingContext(), headDraft(), 0)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate head update failed" })
    });
    expect(readCandidateHead(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate ID" })
    });
    expect(readCandidateHead(failingContext(), "candidate-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Mutable head read failed" })
    });
    expect(
      readCandidateHead(
        withThrowingGetter({ nativeDatabase: { inTransaction: true } }, "nativeDatabase"),
        "candidate-1"
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate head read failed" })
    });
    expect(
      setCandidateHead(
        withThrowingGetter({ nativeDatabase: { inTransaction: true } }, "nativeDatabase"),
        headDraft(),
        0
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate head update failed" })
    });
    expect(
      unwrap(
        readCandidateHead(
          {
            nativeDatabase: {
              inTransaction: true,
              prepare() {
                return { get: () => undefined };
              }
            }
          },
          "candidate-1"
        )
      )
    ).toBeUndefined();
  });

  it("surfaces primitive head read, initialize, and update failures", () => {
    expect(
      setCandidateHead(
        failingContext((sql) => {
          if (sql.includes("candidate_head")) {
            throw new Error("head read boom");
          }
          return {
            get: () =>
              sql.includes("candidate_triage_result") ? { candidateId: "candidate-1" } : {}
          };
        }),
        headDraft(),
        0
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Mutable head read failed" })
    });
    expect(
      setCandidateHead(
        failingContext((sql) => {
          if (sql.includes("INSERT INTO") && sql.includes("candidate_head")) {
            throw new Error("head write boom");
          }
          return {
            get: () => {
              if (sql.includes("candidate_head")) {
                return undefined;
              }
              if (sql.includes("candidate_triage_result")) {
                return { candidateId: "candidate-1" };
              }
              return {};
            },
            run: () => ({ changes: 1 })
          };
        }),
        headDraft(),
        0
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Mutable head initialization failed" })
    });
    expect(
      setCandidateHead(
        failingContext((sql) => {
          if (sql.includes("UPDATE") && sql.includes("candidate_head")) {
            throw new Error("head update boom");
          }
          return {
            get: () => {
              if (sql.includes("candidate_head")) {
                return {
                  identity: "candidate-1",
                  pointer: "candidate-result-1",
                  version: 1
                };
              }
              if (sql.includes("candidate_triage_result")) {
                return { candidateId: "candidate-1" };
              }
              return {};
            },
            run: () => ({ changes: 1 })
          };
        }),
        headDraft({ currentResultId: "candidate-result-2" }),
        1
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Mutable head update failed" })
    });
  });
});

describe("candidate head schema checks and mutability rules", () => {
  it("declares STRICT tables and rejects replace, delete, and illegal swings", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedCandidate(context);
        seedResult(context);
        seedResult(context, {
          candidateTriageResultId: "candidate-result-2",
          kind: "correction",
          supersedesResultId: "candidate-result-1"
        });
        seedCandidate(context, {
          candidateId: "candidate-2",
          sourceKey: "tier-one/0002"
        });
        seedResult(context, {
          candidateTriageResultId: "candidate-result-other",
          candidateId: "candidate-2"
        });
        unwrap(setCandidateHead(context, headDraft(), 0));
        return ok(undefined);
      })
    );
    expect(
      database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(
        "candidate_head"
      )
    ).toEqual({ sql: expect.stringContaining("STRICT") });
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO candidate_head (
            candidate_id, current_result_id, version
          ) VALUES (?, ?, ?)`
        )
        .run("candidate-1", "candidate-result-1", 1)
    ).toThrow(/cannot be replaced/u);
    expect(() => database.prepare("DELETE FROM candidate_head").run()).toThrow(
      /cannot be deleted/u
    );
    expect(() =>
      database
        .prepare("UPDATE candidate_head SET version = version WHERE candidate_id = ?")
        .run("candidate-1")
    ).toThrow(/version must increment by 1/u);
    expect(() =>
      database
        .prepare(
          "UPDATE candidate_head SET candidate_id = candidate_id, version = version + 1 WHERE candidate_id = ?"
        )
        .run("candidate-1")
    ).toThrow(/identity is immutable/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO candidate_head (candidate_id, current_result_id, version)
           VALUES (?, ?, ?)`
        )
        .run("candidate-2", "candidate-result-1", 1)
    ).toThrow(/must belong to the candidate/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO candidate_head (candidate_id, current_result_id, version)
           VALUES (?, ?, ?)`
        )
        .run("candidate-2", "candidate-result-other", 2)
    ).toThrow(/insert version must be 1/u);
    expect(() =>
      database
        .prepare(
          "UPDATE candidate_head SET current_result_id = ?, version = version + 1 WHERE candidate_id = ?"
        )
        .run("candidate-result-other", "candidate-1")
    ).toThrow(/must belong to the candidate/u);
    expect(
      database
        .prepare(
          "UPDATE candidate_head SET current_result_id = ?, version = version + 1 WHERE candidate_id = ?"
        )
        .run("candidate-result-2", "candidate-1").changes
    ).toBe(1);
    expect(connection.close().ok).toBe(true);
  });

  it("rejects a stored head whose pointer no longer parses", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedCandidate(context);
        seedResult(context);
        unwrap(setCandidateHead(context, headDraft(), 0));
        return ok(undefined);
      })
    );
    rebuildTableWithoutChecks(database, [
      "candidate_head_reject_replace",
      "candidate_head_insert_version",
      "candidate_head_insert_result_owner",
      "candidate_head_update_identity",
      "candidate_head_update_version",
      "candidate_head_update_result_owner"
    ]);
    database.prepare("UPDATE candidate_head SET current_result_id = ?").run("x".repeat(150));
    expect(
      runImmediateTransaction(connection, (context) => readCandidateHead(context, "candidate-1"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored candidate head is invalid" })
    });
    expect(connection.close().ok).toBe(true);
  });
});
