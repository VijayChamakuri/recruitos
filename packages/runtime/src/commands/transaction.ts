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

export function runImmediateTransaction<TResult>(
  connection: RuntimeDatabaseConnection,
  work: (context: ImmediateTransactionContext) => Result<TResult, RuntimeError>
): Result<TResult, RuntimeError> {
  if (!connection.isOpen()) {
    return err(
      createRuntimeError(
        "persistence_failed",
        "Cannot start a transaction on a closed runtime database",
        false
      )
    );
  }

  const nativeDatabase = (
    connection.database as unknown as { $client: BetterSqlite3.Database }
  ).$client;
  const context = Object.freeze({ database: connection.database, nativeDatabase });

  try {
    const transaction = nativeDatabase.transaction((): TResult => {
      const result = work(context);
      if (!result.ok) {
        throw new TransactionResultError(result.error);
      }
      return result.value;
    });
    return ok(transaction.immediate());
  } catch (error) {
    if (error instanceof TransactionResultError) {
      return err(error.runtimeError);
    }
    return err(persistenceFailure(error));
  }
}
