import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type BetterSqlite3 from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteConfigurationSchema,
  openRuntimeDatabase
} from "./connection.js";

const temporaryDirectories: string[] = [];

async function createDatabaseFilename(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-runtime-"));
  temporaryDirectories.push(directory);
  return join(directory, "runtime.db");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("openRuntimeDatabase", () => {
  it("opens and closes an isolated SQLite database", async () => {
    const result = openRuntimeDatabase({ filename: await createDatabaseFilename() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.isOpen()).toBe(true);
    expect(result.value.close()).toEqual({ ok: true, value: undefined });
    expect(result.value.isOpen()).toBe(false);
    expect(result.value.close()).toEqual({ ok: true, value: undefined });
  });

  it("applies and verifies the required SQLite configuration", async () => {
    const result = openRuntimeDatabase({ filename: await createDatabaseFilename() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.configuration).toMatchObject({
      journalMode: "wal",
      foreignKeys: true,
      busyTimeoutMilliseconds: 5000,
      synchronous: "full",
      walAutocheckpointPages: 1000
    });
    expect(result.value.configuration.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(Object.isFrozen(result.value.configuration)).toBe(true);
    expect(result.value.close().ok).toBe(true);
  });

  it("rejects SQLite versions older than the pinned minimum", () => {
    const configuration = {
      journalMode: "wal",
      foreignKeys: true,
      busyTimeoutMilliseconds: 5000,
      synchronous: "full",
      walAutocheckpointPages: 1000
    } as const;

    expect(
      SqliteConfigurationSchema.safeParse({
        ...configuration,
        sqliteVersion: "3.51.2"
      }).success
    ).toBe(false);
    expect(
      SqliteConfigurationSchema.safeParse({
        ...configuration,
        sqliteVersion: "3.51.3"
      }).success
    ).toBe(true);
    expect(
      SqliteConfigurationSchema.safeParse({
        ...configuration,
        sqliteVersion: "4.0.0"
      }).success
    ).toBe(true);
  });

  it("applies the neutral migration exactly once", async () => {
    const result = openRuntimeDatabase({ filename: await createDatabaseFilename() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.migrate()).toEqual({ ok: true, value: undefined });
    expect(result.value.migrate()).toEqual({ ok: true, value: undefined });

    const rows = result.value.database.all<{ singleton: number; applied: number }>(
      sql`SELECT singleton, applied FROM runtime_migration_smoke`
    );
    expect(rows).toEqual([{ singleton: 1, applied: 1 }]);

    const tableModes = result.value.database.all<{ name: string; strict: number }>(
      sql`SELECT name, strict FROM pragma_table_list WHERE name IN ('__drizzle_migrations', 'runtime_migration_smoke') ORDER BY name`
    );
    expect(tableModes).toEqual([
      { name: "__drizzle_migrations", strict: 1 },
      { name: "runtime_migration_smoke", strict: 1 }
    ]);
    expect(result.value.close().ok).toBe(true);
  });

  it("rejects in-memory databases through the typed error channel", () => {
    expect(openRuntimeDatabase({ filename: ":memory:" })).toEqual({
      ok: false,
      error: {
        code: "persistence_failed",
        message: "In-memory runtime databases are not supported",
        retryable: false
      }
    });
  });

  it("rejects invalid options and database files through typed errors", async () => {
    expect(openRuntimeDatabase({ filename: "" })).toEqual({
      ok: false,
      error: {
        code: "persistence_failed",
        message: "Invalid runtime database options",
        retryable: false
      }
    });

    const directory = await mkdtemp(join(tmpdir(), "recruitos-runtime-"));
    temporaryDirectories.push(directory);
    const invalidDatabase = join(directory, "invalid.db");
    await writeFile(invalidDatabase, "not a sqlite database", "utf8");

    expect(openRuntimeDatabase({ filename: invalidDatabase })).toEqual({
      ok: false,
      error: {
        code: "persistence_failed",
        message: "Runtime database open failed",
        retryable: false
      }
    });

    expect(openRuntimeDatabase({ filename: join(directory, "missing", "runtime.db") })).toEqual({
      ok: false,
      error: {
        code: "persistence_failed",
        message: "Runtime database open failed",
        retryable: false
      }
    });
  });

  it("returns typed failures for invalid migration lifecycle calls", async () => {
    const filename = await createDatabaseFilename();
    const missingMigrations = openRuntimeDatabase({
      filename,
      migrationsFolder: join(filename, "missing")
    });

    expect(missingMigrations.ok).toBe(true);
    if (!missingMigrations.ok) {
      return;
    }

    expect(missingMigrations.value.migrate()).toEqual({
      ok: false,
      error: {
        code: "persistence_failed",
        message: "Runtime database migration failed",
        retryable: false
      }
    });
    expect(missingMigrations.value.close().ok).toBe(true);
    expect(missingMigrations.value.migrate()).toEqual({
      ok: false,
      error: {
        code: "persistence_failed",
        message: "Cannot migrate a closed runtime database",
        retryable: false
      }
    });
  });

  it("returns a typed failure when controlled shutdown cannot checkpoint", async () => {
    const result = openRuntimeDatabase({ filename: await createDatabaseFilename() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const nativeDatabase = (
      result.value.database as unknown as { $client: BetterSqlite3.Database }
    ).$client;
    const originalPragma = nativeDatabase.pragma;
    Object.defineProperty(nativeDatabase, "pragma", {
      configurable: true,
      value: () => {
        throw new Error("checkpoint failed");
      }
    });

    expect(result.value.close()).toEqual({
      ok: false,
      error: {
        code: "persistence_failed",
        message: "Runtime database close failed",
        retryable: false
      }
    });

    Object.defineProperty(nativeDatabase, "pragma", {
      configurable: true,
      value: originalPragma
    });
    expect(result.value.close().ok).toBe(true);
  });
});
