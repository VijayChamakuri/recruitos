import { fileURLToPath } from "node:url";

import { err, ok, type Result } from "@recruitos/core";
import BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import { z } from "zod";

import { createRuntimeError, type RuntimeError } from "../errors/index.js";

const MINIMUM_SQLITE_VERSION = "3.51.3";
const BUSY_TIMEOUT_MILLISECONDS = 5000;
const CONFIGURATION_RETRY_ATTEMPTS = 50;
const CONFIGURATION_RETRY_DELAY_MILLISECONDS = 10;
const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../drizzle", import.meta.url)
);
const MIGRATION_HISTORY_MESSAGE =
  "Runtime database migration history does not match local migrations";

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

const MigrationHashSchema = z.string().regex(/^[0-9a-f]{64}$/u);

const LocalMigrationSchema = z
  .object({
    sql: z.array(z.string()),
    folderMillis: z.number().int().safe().nonnegative(),
    hash: MigrationHashSchema,
    bps: z.boolean()
  })
  .strict();

const AppliedMigrationSchema = z
  .object({
    id: z.number().int().safe().positive(),
    hash: MigrationHashSchema,
    createdAt: z.number().int().safe().nonnegative()
  })
  .strict();

type AppliedMigration = z.infer<typeof AppliedMigrationSchema>;

class MigrationHistoryMismatch extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(MIGRATION_HISTORY_MESSAGE);
    this.name = "MigrationHistoryMismatch";
    this.reason = reason;
  }
}

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

function enableWalWithRetry(
  nativeDatabase: BetterSqlite3.Database,
  remainingAttempts = CONFIGURATION_RETRY_ATTEMPTS
): void {
  try {
    nativeDatabase.pragma("journal_mode = WAL");
  } catch (error) {
    if (!isSqliteContention(error) || remainingAttempts === 1) {
      throw error;
    }
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
      0,
      0,
      CONFIGURATION_RETRY_DELAY_MILLISECONDS
    );
    enableWalWithRetry(nativeDatabase, remainingAttempts - 1);
  }
}

function configure(nativeDatabase: BetterSqlite3.Database): SqliteConfiguration {
  nativeDatabase.pragma(`busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS}`);
  enableWalWithRetry(nativeDatabase);
  nativeDatabase.pragma("foreign_keys = ON");
  nativeDatabase.pragma("synchronous = FULL");
  nativeDatabase.pragma("wal_autocheckpoint = 1000");

  return readConfiguration(nativeDatabase);
}

function isSqliteContention(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" && /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/u.test(code)
  );
}

function persistenceFailure(message: string, retryable = false): RuntimeError {
  return createRuntimeError("persistence_failed", message, retryable);
}

function migrationRequired(reason: string): RuntimeError {
  return createRuntimeError(
    "migration_required",
    MIGRATION_HISTORY_MESSAGE,
    false,
    { reason }
  );
}

function validateMigrationHistory(
  appliedInput: readonly unknown[],
  localInput: readonly MigrationMeta[],
  requireComplete: boolean
): string | undefined {
  const appliedResult = z.array(AppliedMigrationSchema).safeParse(appliedInput);
  if (!appliedResult.success) {
    return "invalid_applied_history";
  }

  const localResult = z.array(LocalMigrationSchema).safeParse(localInput);
  if (!localResult.success) {
    return "invalid_local_history";
  }

  const applied = appliedResult.data;
  const local = localResult.data;

  for (let index = 1; index < local.length; index += 1) {
    const previous = local[index - 1]!;
    const current = local[index]!;
    if (previous.folderMillis >= current.folderMillis) {
      return "invalid_local_history";
    }
  }

  for (let index = 1; index < applied.length; index += 1) {
    const previous = applied[index - 1]!;
    const current = applied[index]!;
    if (previous.createdAt >= current.createdAt) {
      return "out_of_order_history";
    }
  }

  if (applied.length > local.length) {
    return "unknown_applied_migration";
  }

  for (let index = 0; index < applied.length; index += 1) {
    const appliedMigration = applied[index]!;
    const localMigration = local[index]!;

    if (appliedMigration.createdAt !== localMigration.folderMillis) {
      const matchingLocalIndex = local.findIndex(
        (migration) => migration.folderMillis === appliedMigration.createdAt
      );
      if (matchingLocalIndex === -1) {
        return "missing_local_migration";
      }
      return "missing_applied_migration";
    }

    if (appliedMigration.hash !== localMigration.hash) {
      return "hash_mismatch";
    }
  }

  if (requireComplete && applied.length !== local.length) {
    return "missing_applied_migration";
  }

  return undefined;
}

function readAppliedMigrations(
  nativeDatabase: BetterSqlite3.Database
): AppliedMigration[] {
  return nativeDatabase
    .prepare(
      "SELECT id, hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY id ASC"
    )
    .all() as AppliedMigration[];
}

function migrateDatabase(
  nativeDatabase: BetterSqlite3.Database,
  migrationsFolder: string
): Result<void, RuntimeError> {
  let localMigrations: MigrationMeta[] | undefined;
  try {
    localMigrations = readMigrationFiles({ migrationsFolder });
  } catch {
    localMigrations = undefined;
  }

  try {
    const runMigration = nativeDatabase.transaction((): void => {
      nativeDatabase.exec(`
        CREATE TABLE IF NOT EXISTS __drizzle_migrations (
          id INTEGER PRIMARY KEY,
          hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT
      `);

      const appliedBefore = readAppliedMigrations(nativeDatabase);
      if (localMigrations === undefined) {
        if (appliedBefore.length > 0) {
          throw new MigrationHistoryMismatch("missing_local_migration");
        }
        throw new Error("Runtime database migration files unavailable");
      }

      const historyError = validateMigrationHistory(
        appliedBefore,
        localMigrations,
        false
      );
      if (historyError !== undefined) {
        throw new MigrationHistoryMismatch(historyError);
      }

      const insertMigration = nativeDatabase.prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)"
      );
      for (const migration of localMigrations.slice(appliedBefore.length)) {
        for (const statement of migration.sql) {
          nativeDatabase.exec(statement);
        }
        insertMigration.run(migration.hash, migration.folderMillis);
      }

      const completedHistoryError = validateMigrationHistory(
        readAppliedMigrations(nativeDatabase),
        localMigrations,
        true
      );
      if (completedHistoryError !== undefined) {
        throw new MigrationHistoryMismatch(completedHistoryError);
      }
    });

    runMigration.immediate();
    return ok(undefined);
  } catch (error) {
    if (error instanceof MigrationHistoryMismatch) {
      return err(migrationRequired(error.reason));
    }
    return err(
      persistenceFailure(
        "Runtime database migration failed",
        isSqliteContention(error)
      )
    );
  }
}

function checkpointWalBestEffort(nativeDatabase: BetterSqlite3.Database): void {
  try {
    nativeDatabase.pragma("wal_checkpoint(PASSIVE)");
  } catch {
    return;
  }
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
    nativeDatabase = new BetterSqlite3(parsed.data.filename, {
      timeout: BUSY_TIMEOUT_MILLISECONDS
    });
  } catch (error) {
    return err(
      persistenceFailure("Runtime database open failed", isSqliteContention(error))
    );
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

          return migrateDatabase(nativeDatabase, migrationsFolder);
        },
        close: (): Result<void, RuntimeError> => {
          if (!nativeDatabase.open) {
            return ok(undefined);
          }

          checkpointWalBestEffort(nativeDatabase);
          try {
            nativeDatabase.close();
            return ok(undefined);
          } catch {
            return err(persistenceFailure("Runtime database close failed"));
          }
        }
      })
    );
  } catch (error) {
    if (nativeDatabase.open) {
      nativeDatabase.close();
    }
    return err(
      persistenceFailure("Runtime database open failed", isSqliteContention(error))
    );
  }
}
