import { fileURLToPath } from "node:url";

import { err, ok, type Result } from "@recruitos/core";
import BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate as runDrizzleMigrations } from "drizzle-orm/better-sqlite3/migrator";
import { z } from "zod";

import { createRuntimeError, type RuntimeError } from "../errors/index.js";

const MINIMUM_SQLITE_VERSION = "3.51.3";
const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../drizzle", import.meta.url)
);

export const RuntimeDatabaseOptionsSchema = z
  .object({
    filename: z.string().min(1),
    migrationsFolder: z.string().min(1).optional()
  })
  .strict();

export type RuntimeDatabaseOptions = z.infer<typeof RuntimeDatabaseOptionsSchema>;

function compareVersions(left: string, right: string): number {
  const [leftMajor, leftMinor, leftPatch] = left.split(".").map(Number) as [
    number,
    number,
    number
  ];
  const [rightMajor, rightMinor, rightPatch] = right.split(".").map(Number) as [
    number,
    number,
    number
  ];

  if (leftMajor !== rightMajor) {
    return leftMajor - rightMajor;
  }
  if (leftMinor !== rightMinor) {
    return leftMinor - rightMinor;
  }
  if (leftPatch !== rightPatch) {
    return leftPatch - rightPatch;
  }

  return 0;
}

export const SqliteConfigurationSchema = z
  .object({
    sqliteVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/u)
      .refine(
        (version) => compareVersions(version, MINIMUM_SQLITE_VERSION) >= 0,
        `SQLite ${MINIMUM_SQLITE_VERSION} or newer is required`
      ),
    journalMode: z.literal("wal"),
    foreignKeys: z.literal(true),
    busyTimeoutMilliseconds: z.literal(5000),
    synchronous: z.literal("full"),
    walAutocheckpointPages: z.literal(1000)
  })
  .strict();

export type SqliteConfiguration = z.infer<typeof SqliteConfigurationSchema>;

export type RuntimeDatabaseConnection = Readonly<{
  database: BetterSQLite3Database;
  configuration: SqliteConfiguration;
  isOpen: () => boolean;
  migrate: () => Result<void, RuntimeError>;
  close: () => Result<void, RuntimeError>;
}>;

type SqliteVersionRow = Readonly<{ version: string }>;

const RawSqliteConfigurationSchema = z
  .object({
    sqliteVersion: z.string(),
    journalMode: z.literal("wal"),
    foreignKeys: z.literal(1),
    busyTimeoutMilliseconds: z.literal(5000),
    synchronous: z.literal(2),
    walAutocheckpointPages: z.literal(1000)
  })
  .strict()
  .transform((configuration) => ({
    sqliteVersion: configuration.sqliteVersion,
    journalMode: "wal" as const,
    foreignKeys: true as const,
    busyTimeoutMilliseconds: 5000 as const,
    synchronous: "full" as const,
    walAutocheckpointPages: 1000 as const
  }))
  .pipe(SqliteConfigurationSchema);

function readConfiguration(nativeDatabase: BetterSqlite3.Database): SqliteConfiguration {
  const versionRow = nativeDatabase
    .prepare("SELECT sqlite_version() AS version")
    .get() as SqliteVersionRow;
  const journalMode = nativeDatabase.pragma("journal_mode", { simple: true });
  const foreignKeys = nativeDatabase.pragma("foreign_keys", { simple: true });
  const busyTimeout = nativeDatabase.pragma("busy_timeout", { simple: true });
  const synchronous = nativeDatabase.pragma("synchronous", { simple: true });
  const walAutocheckpoint = nativeDatabase.pragma("wal_autocheckpoint", { simple: true });

  return RawSqliteConfigurationSchema.parse({
    sqliteVersion: versionRow.version,
    journalMode,
    foreignKeys,
    busyTimeoutMilliseconds: busyTimeout,
    synchronous,
    walAutocheckpointPages: walAutocheckpoint
  });
}

function configure(nativeDatabase: BetterSqlite3.Database): SqliteConfiguration {
  nativeDatabase.pragma("journal_mode = WAL");
  nativeDatabase.pragma("foreign_keys = ON");
  nativeDatabase.pragma("busy_timeout = 5000");
  nativeDatabase.pragma("synchronous = FULL");
  nativeDatabase.pragma("wal_autocheckpoint = 1000");

  return readConfiguration(nativeDatabase);
}

function persistenceFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

export function openRuntimeDatabase(
  input: RuntimeDatabaseOptions
): Result<RuntimeDatabaseConnection, RuntimeError> {
  const parsed = RuntimeDatabaseOptionsSchema.safeParse(input);
  if (!parsed.success) {
    return err(persistenceFailure("Invalid runtime database options"));
  }

  if (parsed.data.filename === ":memory:") {
    return err(persistenceFailure("In-memory runtime databases are not supported"));
  }

  let nativeDatabase: BetterSqlite3.Database;

  try {
    nativeDatabase = new BetterSqlite3(parsed.data.filename);
  } catch {
    return err(persistenceFailure("Runtime database open failed"));
  }

  try {
    const configuration = Object.freeze(configure(nativeDatabase));
    const database = drizzle(nativeDatabase);
    const migrationsFolder = parsed.data.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;

    return ok(
      Object.freeze({
        database,
        configuration,
        isOpen: () => nativeDatabase.open,
        migrate: (): Result<void, RuntimeError> => {
          if (!nativeDatabase.open) {
            return err(persistenceFailure("Cannot migrate a closed runtime database"));
          }

          try {
            nativeDatabase.exec(`
              CREATE TABLE IF NOT EXISTS __drizzle_migrations (
                id INTEGER PRIMARY KEY,
                hash TEXT NOT NULL,
                created_at INTEGER
              ) STRICT
            `);
            runDrizzleMigrations(database, { migrationsFolder });
            return ok(undefined);
          } catch {
            return err(persistenceFailure("Runtime database migration failed"));
          }
        },
        close: (): Result<void, RuntimeError> => {
          if (!nativeDatabase.open) {
            return ok(undefined);
          }

          try {
            nativeDatabase.pragma("wal_checkpoint(PASSIVE)");
            nativeDatabase.close();
            return ok(undefined);
          } catch {
            return err(persistenceFailure("Runtime database close failed"));
          }
        }
      })
    );
  } catch {
    if (nativeDatabase.open) {
      nativeDatabase.close();
    }
    return err(persistenceFailure("Runtime database open failed"));
  }
}
