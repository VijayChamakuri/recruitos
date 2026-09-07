import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ok, type Result } from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runImmediateTransaction } from "../commands/index.js";
import { openRuntimeDatabase, type RuntimeDatabaseConnection } from "../db/index.js";
import { CandidateDraftSchema } from "../entities/schemas.js";
import {
  insertCandidate,
  prepareCandidate
} from "../entities/index.js";
import { type RuntimeError } from "../errors/index.js";
import {
  CANDIDATE_RACE_ETHNICITIES,
  CANDIDATE_SEXES,
  insertCandidateDemographics,
  prepareCandidateDemographics,
  readCandidateDemographics,
  readCandidateDemographicsByCandidate
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const TRANSACTION_REQUIRED = "Candidate demographics require an active command transaction";

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-demographics-test-"));
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

function demographicsDraft(overrides: Record<string, unknown> = {}) {
  return {
    candidateDemographicsId: "candidate-demographics-1",
    candidateId: "candidate-1",
    sex: "female",
    raceEthnicity: "asian",
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

describe("candidate demographics isolation", () => {
  it("keeps the NYC LL144 closed sets and stays off scoring imports", () => {
    expect(CANDIDATE_SEXES).toEqual(["female", "male", "not_specified"]);
    expect(CANDIDATE_RACE_ETHNICITIES).toEqual([
      "hispanic_or_latino",
      "white",
      "black_or_african_american",
      "asian",
      "native_hawaiian_or_other_pacific_islander",
      "american_indian_or_alaska_native",
      "two_or_more_races",
      "not_specified"
    ]);
    expect(
      CandidateDraftSchema.safeParse({
        ...candidateDraft(),
        sex: "female",
        raceEthnicity: "asian"
      }).success
    ).toBe(false);

    const isolatedSources = [
      join(here, "../entities/schemas.ts"),
      join(here, "../entities/store.ts"),
      join(here, "../snapshots/schemas.ts"),
      join(here, "../snapshots/store.ts"),
      join(here, "../results/schemas.ts"),
      join(here, "../results/store.ts"),
      join(here, "../../../core/src/scoring/score.ts"),
      join(here, "../../../core/src/scoring/shortlist.ts")
    ];
    for (const path of isolatedSources) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/candidate_demographics|raceEthnicity|demographics\//u);
    }
  });
});

describe("candidate demographics persistence", () => {
  it("prepares an audit-only record and rejects invalid or hostile drafts", () => {
    const record = unwrap(prepareCandidateDemographics(demographicsDraft()));
    expect(record).toEqual(demographicsDraft());
    expect(Object.isFrozen(record)).toBe(true);
    expect(prepareCandidateDemographics({ ...demographicsDraft(), extra: true })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate demographics input" })
    });
    expect(prepareCandidateDemographics(demographicsDraft({ sex: "unknown" }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate demographics input" })
    });
    expect(
      prepareCandidateDemographics(demographicsDraft({ raceEthnicity: "other" }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate demographics input" })
    });
    expect(
      prepareCandidateDemographics(withThrowingGetter(demographicsDraft(), "sex"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate demographics preparation failed" })
    });
  });

  it("inserts one demographics row per candidate and leaves scoring imports untouched", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedCandidate(context);
        expect(unwrap(readCandidateDemographicsByCandidate(context, "candidate-1"))).toBeUndefined();
        const inserted = unwrap(
          insertCandidateDemographics(context, unwrap(prepareCandidateDemographics(demographicsDraft())))
        );
        expect(inserted).toEqual(demographicsDraft());
        expect(unwrap(readCandidateDemographics(context, "candidate-demographics-1"))).toEqual(
          demographicsDraft()
        );
        expect(unwrap(readCandidateDemographicsByCandidate(context, "candidate-1"))).toEqual(
          demographicsDraft()
        );
        expect(unwrap(readCandidateDemographics(context, "candidate-demographics-missing"))).toBeUndefined();
        expect(
          unwrap(readCandidateDemographicsByCandidate(context, "candidate-missing"))
        ).toBeUndefined();
        expect(
          nativeDatabase(connection)
            .prepare("SELECT COUNT(*) FROM candidate WHERE candidate_id = 'candidate-1'")
            .pluck()
            .get()
        ).toBe(1);
        expect(
          nativeDatabase(connection)
            .prepare(
              "SELECT sex, race_ethnicity FROM candidate_demographics WHERE candidate_id = 'candidate-1'"
            )
            .get()
        ).toEqual({ sex: "female", race_ethnicity: "asian" });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("rejects unprepared inserts, missing parents, and a second row for the same candidate", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(insertCandidateDemographics(context, demographicsDraft())).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared candidate demographics" })
        });
        expect(
          insertCandidateDemographics(
            context,
            unwrap(prepareCandidateDemographics(demographicsDraft()))
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Candidate demographics insert failed" })
        });
        seedCandidate(context);
        unwrap(
          insertCandidateDemographics(
            context,
            unwrap(prepareCandidateDemographics(demographicsDraft()))
          )
        );
        expect(
          insertCandidateDemographics(
            context,
            unwrap(
              prepareCandidateDemographics(
                demographicsDraft({ candidateDemographicsId: "candidate-demographics-2" })
              )
            )
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Candidate demographics insert failed" })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("requires an active command transaction for insert and read", () => {
    const prepared = unwrap(prepareCandidateDemographics(demographicsDraft()));
    for (const contextInput of [undefined, null, {}, { nativeDatabase: null }]) {
      expect(insertCandidateDemographics(contextInput, prepared)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readCandidateDemographics(contextInput, "candidate-demographics-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readCandidateDemographicsByCandidate(contextInput, "candidate-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
    }
    expect(insertCandidateDemographics(failingContext(), prepared)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate demographics insert failed" })
    });
    expect(readCandidateDemographics(failingContext(), "candidate-demographics-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate demographics read failed" })
    });
    expect(readCandidateDemographicsByCandidate(failingContext(), "candidate-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Candidate demographics read failed" })
    });
  });

  it("rejects invalid IDs and invalid stored rows", () => {
    expect(readCandidateDemographics(failingContext(() => ({ get: () => undefined })), "bad id")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate demographics ID" })
    });
    expect(
      readCandidateDemographicsByCandidate(failingContext(() => ({ get: () => undefined })), "bad id")
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid candidate ID" })
    });
    expect(
      readCandidateDemographics(failingContext(() => ({ get: () => ({ invalid: true }) })), "candidate-demographics-1")
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored candidate demographics are invalid" })
    });
    expect(
      readCandidateDemographicsByCandidate(
        failingContext(() => ({ get: () => ({ invalid: true }) })),
        "candidate-1"
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored candidate demographics are invalid" })
    });
  });

  it("keeps candidate_demographics STRICT and immutable", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        const database = nativeDatabase(connection);
        expect(
          database
            .prepare(
              "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'candidate_demographics'"
            )
            .pluck()
            .get()
        ).toContain("STRICT");
        const triggerNames = (
          database
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'candidate_demographics_%' ORDER BY name"
            )
            .pluck()
            .all() as string[]
        ).sort();
        expect(triggerNames).toEqual([
          "candidate_demographics_reject_delete",
          "candidate_demographics_reject_replace",
          "candidate_demographics_reject_update"
        ]);

        seedCandidate(context);
        unwrap(
          insertCandidateDemographics(
            context,
            unwrap(prepareCandidateDemographics(demographicsDraft()))
          )
        );
        expect(() =>
          database.exec(
            "UPDATE candidate_demographics SET sex = 'male' WHERE candidate_demographics_id = 'candidate-demographics-1'"
          )
        ).toThrow(/immutable/u);
        expect(() =>
          database.exec(
            "DELETE FROM candidate_demographics WHERE candidate_demographics_id = 'candidate-demographics-1'"
          )
        ).toThrow(/immutable/u);
        expect(() =>
          database.exec(
            `INSERT INTO candidate_demographics (
              candidate_demographics_id, candidate_id, sex, race_ethnicity, created_at
            ) VALUES (
              'candidate-demographics-2', 'candidate-1', 'unknown', 'asian', ${CREATED_AT}
            )`
          )
        ).toThrow(/CHECK|immutable/u);
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });
});
