import { spawn } from "node:child_process";
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import BetterSqlite3 from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteConfigurationSchema,
  openRuntimeDatabase
} from "./connection.js";

const temporaryDirectories: string[] = [];
const bundledMigrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url)
);

type DatabaseFixture = Readonly<{
  filename: string;
  migrationsFolder: string;
}>;

type WorkerResult = Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
}>;

async function createDatabaseFilename(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-runtime-"));
  temporaryDirectories.push(directory);
  return join(directory, "runtime.db");
}

async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-runtime-"));
  const migrationsFolder = join(directory, "drizzle");
  temporaryDirectories.push(directory);
  await cp(bundledMigrationsFolder, migrationsFolder, { recursive: true });
  return {
    filename: join(directory, "runtime.db"),
    migrationsFolder
  };
}

function getNativeDatabase(
  connection: ReturnType<typeof openRuntimeDatabase> & { ok: true }
): BetterSqlite3.Database {
  return (
    connection.value.database as unknown as { $client: BetterSqlite3.Database }
  ).$client;
}

function expectedMigrationRequired(reason: string): object {
  return {
    ok: false,
    error: {
      code: "migration_required",
      message: "Runtime database migration history does not match local migrations",
      retryable: false,
      details: { reason }
    }
  };
}

async function addSecondTestMigration(migrationsFolder: string): Promise<number> {
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: Array<{
      idx: number;
      version: string;
      when: number;
      tag: string;
      breakpoints: boolean;
    }>;
  };
  const firstEntry = journal.entries[0]!;
  const secondTimestamp = firstEntry.when + 1;
  journal.entries.push({
    idx: 1,
    version: firstEntry.version,
    when: secondTimestamp,
    tag: "0001_runtime_foundation_test",
    breakpoints: true
  });
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  await writeFile(
    join(migrationsFolder, "0001_runtime_foundation_test.sql"),
    "CREATE TABLE `runtime_migration_second_smoke` (`singleton` integer PRIMARY KEY) STRICT;\n",
    "utf8"
  );
  return secondTimestamp;
}

async function runMigrationWorker(
  moduleUrl: string,
  filename: string,
  startAt: number
): Promise<WorkerResult> {
  const workerSource = `
    const [moduleUrl, filename, startAtValue] = process.argv.slice(1);
    const { openRuntimeDatabase } = await import(moduleUrl);
    await new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, Number(startAtValue) - Date.now()));
    });
    const opened = openRuntimeDatabase({ filename });
    let result = opened;
    if (opened.ok) {
      const migrated = opened.value.migrate();
      const closed = opened.value.close();
      result = migrated.ok ? closed : migrated;
    }
    process.stdout.write(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        workerSource,
        moduleUrl,
        filename,
        String(startAt)
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
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

  it("rejects a changed hash for an already applied migration", async () => {
    const fixture = await createDatabaseFixture();
    const result = openRuntimeDatabase(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.migrate()).toEqual({ ok: true, value: undefined });
    await appendFile(
      join(fixture.migrationsFolder, "0000_runtime_foundation.sql"),
      "\nCREATE TABLE `runtime_migration_hash_drift` (`id` integer PRIMARY KEY) STRICT;\n",
      "utf8"
    );

    expect(result.value.migrate()).toEqual(
      expectedMigrationRequired("hash_mismatch")
    );
    expect(result.value.close().ok).toBe(true);
  });

  it("rejects malformed applied migration history", async () => {
    const fixture = await createDatabaseFixture();
    const result = openRuntimeDatabase(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.migrate()).toEqual({ ok: true, value: undefined });
    getNativeDatabase(result)
      .prepare("UPDATE __drizzle_migrations SET hash = 'invalid'")
      .run();

    expect(result.value.migrate()).toEqual(
      expectedMigrationRequired("invalid_applied_history")
    );
    expect(result.value.close().ok).toBe(true);
  });

  it("rejects malformed local migration history", async () => {
    const fixture = await createDatabaseFixture();
    const journalPath = join(fixture.migrationsFolder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: Array<{ when: unknown }>;
    };
    journal.entries[0]!.when = "invalid";
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    const result = openRuntimeDatabase(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.migrate()).toEqual(
      expectedMigrationRequired("invalid_local_history")
    );
    expect(result.value.close().ok).toBe(true);
  });

  it("rejects non-increasing local migration order", async () => {
    const fixture = await createDatabaseFixture();
    await addSecondTestMigration(fixture.migrationsFolder);
    const journalPath = join(fixture.migrationsFolder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: Array<{ when: number }>;
    };
    journal.entries[1]!.when = journal.entries[0]!.when;
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    const result = openRuntimeDatabase(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.migrate()).toEqual(
      expectedMigrationRequired("invalid_local_history")
    );
    expect(result.value.close().ok).toBe(true);
  });

  it("rejects applied history whose local migration file is missing", async () => {
    const fixture = await createDatabaseFixture();
    const result = openRuntimeDatabase(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.migrate()).toEqual({ ok: true, value: undefined });
    await unlink(join(fixture.migrationsFolder, "0000_runtime_foundation.sql"));

    expect(result.value.migrate()).toEqual(
      expectedMigrationRequired("missing_local_migration")
    );
    expect(result.value.close().ok).toBe(true);
  });

  it("rejects an applied timestamp absent from local history", async () => {
    const fixture = await createDatabaseFixture();
    const result = openRuntimeDatabase(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.migrate()).toEqual({ ok: true, value: undefined });
    getNativeDatabase(result)
      .prepare("UPDATE __drizzle_migrations SET created_at = created_at + 10")
      .run();

    expect(result.value.migrate()).toEqual(
      expectedMigrationRequired("missing_local_migration")
    );
    expect(result.value.close().ok).toBe(true);
  });

  it("rejects an unknown future migration in the database", async () => {
    const fixture = await createDatabaseFixture();
    const result = openRuntimeDatabase(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.migrate()).toEqual({ ok: true, value: undefined });
    const nativeDatabase = getNativeDatabase(result);
    const latest = nativeDatabase
      .prepare("SELECT max(created_at) AS createdAt FROM __drizzle_migrations")
      .get() as { createdAt: number };
    nativeDatabase
      .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
      .run("f".repeat(64), latest.createdAt + 1);

    expect(result.value.migrate()).toEqual(
      expectedMigrationRequired("unknown_applied_migration")
    );
    expect(result.value.close().ok).toBe(true);
  });

  it("rejects missing applied migration history", async () => {
    const fixture = await createDatabaseFixture();
    await addSecondTestMigration(fixture.migrationsFolder);
    const result = openRuntimeDatabase(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.migrate()).toEqual({ ok: true, value: undefined });
    getNativeDatabase(result)
      .prepare(
        "DELETE FROM __drizzle_migrations WHERE id = (SELECT min(id) FROM __drizzle_migrations)"
      )
      .run();

    expect(result.value.migrate()).toEqual(
      expectedMigrationRequired("missing_applied_migration")
    );
    expect(result.value.close().ok).toBe(true);
  });

  it("rejects out-of-order applied migration history", async () => {
    const fixture = await createDatabaseFixture();
    await addSecondTestMigration(fixture.migrationsFolder);
    const result = openRuntimeDatabase(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.migrate()).toEqual({ ok: true, value: undefined });
    getNativeDatabase(result)
      .prepare(
        "UPDATE __drizzle_migrations SET id = 3 WHERE id = (SELECT min(id) FROM __drizzle_migrations)"
      )
      .run();

    expect(result.value.migrate()).toEqual(
      expectedMigrationRequired("out_of_order_history")
    );
    expect(result.value.close().ok).toBe(true);
  });

  it("rolls back when the completed ledger does not contain every migration", async () => {
    const fixture = await createDatabaseFixture();
    const result = openRuntimeDatabase(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const nativeDatabase = getNativeDatabase(result);
    nativeDatabase.exec(`
      CREATE TABLE __drizzle_migrations (
        id INTEGER PRIMARY KEY,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TRIGGER discard_migration_history
      AFTER INSERT ON __drizzle_migrations
      BEGIN
        DELETE FROM __drizzle_migrations WHERE id = NEW.id;
      END;
    `);

    expect(result.value.migrate()).toEqual(
      expectedMigrationRequired("missing_applied_migration")
    );
    const migratedTable = nativeDatabase
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'runtime_migration_smoke'"
      )
      .get() as { count: number };
    expect(migratedTable.count).toBe(0);
    expect(result.value.close().ok).toBe(true);
  });

  it("serializes concurrent first migration across processes", async () => {
    const filename = await createDatabaseFilename();
    const moduleUrl = new URL("../../dist/index.js", import.meta.url).href;
    const startAt = Date.now() + 750;
    const results = await Promise.all([
      runMigrationWorker(moduleUrl, filename, startAt),
      runMigrationWorker(moduleUrl, filename, startAt)
    ]);

    expect(results).toEqual([
      { code: 0, stdout: '{"ok":true}', stderr: "" },
      { code: 0, stdout: '{"ok":true}', stderr: "" }
    ]);

    const opened = openRuntimeDatabase({ filename });
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }
    expect(opened.value.migrate()).toEqual({ ok: true, value: undefined });
    expect(opened.value.close().ok).toBe(true);
  }, 15_000);

  it("retries WAL negotiation during transient contention", async () => {
    const filename = await createDatabaseFilename();
    const originalPragma = BetterSqlite3.prototype.pragma;
    let walAttempts = 0;
    BetterSqlite3.prototype.pragma = function patchedPragma(
      this: BetterSqlite3.Database,
      source: string,
      options?: BetterSqlite3.PragmaOptions
    ): unknown {
      if (source === "journal_mode = WAL" && walAttempts === 0) {
        walAttempts += 1;
        throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
      }
      if (source === "journal_mode = WAL") {
        walAttempts += 1;
      }
      return originalPragma.call(this, source, options);
    } as typeof BetterSqlite3.prototype.pragma;

    try {
      const result = openRuntimeDatabase({ filename });
      expect(walAttempts).toBe(2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.close().ok).toBe(true);
      }
    } finally {
      BetterSqlite3.prototype.pragma = originalPragma;
    }
  });

  it("marks exhausted WAL negotiation contention as retryable", async () => {
    const filename = await createDatabaseFilename();
    const originalPragma = BetterSqlite3.prototype.pragma;
    let walAttempts = 0;
    BetterSqlite3.prototype.pragma = function patchedPragma(
      this: BetterSqlite3.Database,
      source: string,
      options?: BetterSqlite3.PragmaOptions
    ): unknown {
      if (source === "journal_mode = WAL") {
        walAttempts += 1;
        throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
      }
      return originalPragma.call(this, source, options);
    } as typeof BetterSqlite3.prototype.pragma;

    try {
      expect(openRuntimeDatabase({ filename })).toEqual({
        ok: false,
        error: {
          code: "persistence_failed",
          message: "Runtime database open failed",
          retryable: true
        }
      });
      expect(walAttempts).toBe(50);
    } finally {
      BetterSqlite3.prototype.pragma = originalPragma;
    }
  });

  it("marks transient migration contention as retryable", async () => {
    const filename = await createDatabaseFilename();
    const result = openRuntimeDatabase({ filename });
    const competingDatabase = new BetterSqlite3(filename);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      competingDatabase.close();
      return;
    }

    const nativeDatabase = getNativeDatabase(result);
    nativeDatabase.pragma("busy_timeout = 0");
    competingDatabase.exec("BEGIN IMMEDIATE");
    expect(result.value.migrate()).toEqual({
      ok: false,
      error: {
        code: "persistence_failed",
        message: "Runtime database migration failed",
        retryable: true
      }
    });
    competingDatabase.exec("ROLLBACK");
    competingDatabase.close();
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

  it("closes successfully when the best-effort checkpoint fails", async () => {
    const result = openRuntimeDatabase({ filename: await createDatabaseFilename() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const nativeDatabase = getNativeDatabase(result);
    Object.defineProperty(nativeDatabase, "pragma", {
      configurable: true,
      value: () => {
        throw new Error("checkpoint failed");
      }
    });

    expect(result.value.close()).toEqual({ ok: true, value: undefined });
    expect(result.value.isOpen()).toBe(false);
  });

  it("returns a typed failure when the native close fails", async () => {
    const result = openRuntimeDatabase({ filename: await createDatabaseFilename() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const nativeDatabase = getNativeDatabase(result);
    const originalClose = nativeDatabase.close;
    Object.defineProperty(nativeDatabase, "pragma", {
      configurable: true,
      value: () => undefined
    });
    Object.defineProperty(nativeDatabase, "close", {
      configurable: true,
      value: () => {
        throw new Error("close failed");
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
    expect(result.value.isOpen()).toBe(true);

    Object.defineProperty(nativeDatabase, "close", {
      configurable: true,
      value: originalClose
    });
    expect(result.value.close().ok).toBe(true);
  });
});
