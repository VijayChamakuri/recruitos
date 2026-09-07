import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  openRuntimeDatabase,
  type RuntimeDatabaseConnection
} from "../../../packages/runtime/src/db/index.js";

/**
 * The integration lane owns assertions that only mean something against a real
 * SQLite file: what the committed migrations actually build, and what the DDL
 * triggers actually refuse. Everything here goes through the production
 * connection factory rather than opening a driver handle directly, so a
 * regression in PRAGMA setup or migration bookkeeping fails these tests too.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../../packages/runtime/drizzle", import.meta.url)
);

/**
 * Minimal structural view of the driver handle. Declaring it here keeps the
 * integration lane free of a direct `better-sqlite3` type dependency it would
 * otherwise have to install at the repository root.
 */
export type NativeStatement = Readonly<{
  run: (...parameters: readonly unknown[]) => { changes: number };
  get: (...parameters: readonly unknown[]) => unknown;
  all: (...parameters: readonly unknown[]) => unknown[];
}>;

export type NativeDatabase = Readonly<{
  inTransaction: boolean;
  exec: (sql: string) => void;
  prepare: (sql: string) => NativeStatement;
}>;

const temporaryDirectories: string[] = [];

/**
 * Reads the migration count from the local journal so adding a migration does
 * not break unrelated idempotency assertions.
 */
export function localMigrationCount(): number {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")
  ) as { entries: readonly unknown[] };
  return journal.entries.length;
}

/**
 * Opens a fresh on-disk database under a temporary directory and runs every
 * committed migration through the production factory. The caller closes the
 * connection; `removeTemporaryDatabases` reclaims the directories.
 */
export async function openMigratedDatabase(
  label: string
): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), `recruitos-${label}-integration-`));
  temporaryDirectories.push(directory);

  const opened = openRuntimeDatabase({
    filename: join(directory, "runtime.db"),
    migrationsFolder: MIGRATIONS_FOLDER
  });
  if (!opened.ok) {
    throw new Error(opened.error.message);
  }

  const migrated = opened.value.migrate();
  if (!migrated.ok) {
    throw new Error(migrated.error.message);
  }

  return opened.value;
}

export function nativeDatabase(connection: RuntimeDatabaseConnection): NativeDatabase {
  return (connection.database as unknown as { $client: NativeDatabase }).$client;
}

export function countRow(database: NativeDatabase, sql: string): number {
  return (database.prepare(sql).get() as { total: number }).total;
}

export async function removeTemporaryDatabases(): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
}
