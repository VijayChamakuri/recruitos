import { err, ok, type Result } from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import type { RuntimeDatabaseConnection } from "../db/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";

export type ImmediateTransactionContext = Readonly<{
  database: BetterSQLite3Database;
  nativeDatabase: BetterSqlite3.Database;
}>;

class TransactionResultError extends Error {
  readonly runtimeError: RuntimeError;

  constructor(runtimeError: RuntimeError) {
    super(runtimeError.message);
    this.name = "TransactionResultError";
    this.runtimeError = runtimeError;
  }
}

function isSqliteContention(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/u.test(code);
}

function persistenceFailure(error: unknown): RuntimeError {
  return createRuntimeError(
    "persistence_failed",
    "Runtime database transaction failed",
    isSqliteContention(error)
  );
}

type SqliteTransactionKind = "immediate" | "deferred";

function runSqliteTransaction<TResult>(
  connection: RuntimeDatabaseConnection,
  work: (context: ImmediateTransactionContext) => Result<TResult, RuntimeError>,
  kind: SqliteTransactionKind
): Result<TResult, RuntimeError> {
  if (
    typeof connection !== "object" ||
    connection === null ||
    typeof connection.isOpen !== "function" ||
    typeof work !== "function"
  ) {
    return err(
      createRuntimeError(
        "persistence_failed",
        "Invalid runtime database transaction input",
        false
      )
    );
  }

  let nativeDatabase: BetterSqlite3.Database;
  try {
    if (!connection.isOpen()) {
      return err(
        createRuntimeError(
          "persistence_failed",
          "Cannot start a transaction on a closed runtime database",
          false
        )
      );
    }
    nativeDatabase = (
      connection.database as unknown as { $client: BetterSqlite3.Database }
    ).$client;
  } catch (error) {
    return err(persistenceFailure(error));
  }

  if (nativeDatabase.inTransaction) {
    return err(
      createRuntimeError(
        "persistence_failed",
        kind === "immediate"
          ? "Cannot start an immediate transaction while another transaction is active"
          : "Cannot start a deferred transaction while another transaction is active",
        false
      )
    );
  }

  const context = Object.freeze({ database: connection.database, nativeDatabase });

  try {
    const transaction = nativeDatabase.transaction((): TResult => {
      // Do not set PRAGMA defer_foreign_keys here. That pragma defers every
      // FK, including restrict parents, so a missing-parent insert would
      // succeed and only fail at COMMIT with a generic transaction error.
      // Cyclic seals use table-level DEFERRABLE INITIALLY DEFERRED instead.
      const result = work(context);
      if (!result.ok) {
        throw new TransactionResultError(result.error);
      }
      return result.value;
    });
    return ok(kind === "immediate" ? transaction.immediate() : transaction.deferred());
  } catch (error) {
    if (error instanceof TransactionResultError) {
      return err(error.runtimeError);
    }
    return err(persistenceFailure(error));
  }
}

export function runImmediateTransaction<TResult>(
  connection: RuntimeDatabaseConnection,
  work: (context: ImmediateTransactionContext) => Result<TResult, RuntimeError>
): Result<TResult, RuntimeError> {
  return runSqliteTransaction(connection, work, "immediate");
}

export function runDeferredTransaction<TResult>(
  connection: RuntimeDatabaseConnection,
  work: (context: ImmediateTransactionContext) => Result<TResult, RuntimeError>
): Result<TResult, RuntimeError> {
  return runSqliteTransaction(connection, work, "deferred");
}
