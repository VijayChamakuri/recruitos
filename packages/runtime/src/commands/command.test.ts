import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJsonSha256,
  err,
  ok,
  type Result,
  type Sha256Hex
} from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  openRuntimeDatabase,
  type RuntimeDatabaseConnection
} from "../db/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import { executeCommand } from "./executor.js";
import { CommandEnvelopeSchema } from "./schemas.js";
import { runImmediateTransaction } from "./transaction.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const TestResultSchema = z.object({ version: z.number().int().safe().nonnegative() }).strict();

async function openMigratedDatabase(
  filename?: string
): Promise<Readonly<{ connection: RuntimeDatabaseConnection; filename: string }>> {
  const resolvedFilename = filename ?? (await createDatabaseFilename());
  const opened = openRuntimeDatabase({ filename: resolvedFilename, migrationsFolder });
  expect(opened.ok).toBe(true);
  if (!opened.ok) {
    throw new Error(opened.error.message);
  }
  const migrated = opened.value.migrate();
  expect(migrated.ok).toBe(true);
  if (!migrated.ok) {
    throw new Error(migrated.error.message);
  }
  return { connection: opened.value, filename: resolvedFilename };
}

async function createDatabaseFilename(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-command-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "runtime.db");
}

function nativeDatabase(connection: RuntimeDatabaseConnection): BetterSqlite3.Database {
  return (
    connection.database as unknown as { $client: BetterSqlite3.Database }
  ).$client;
}

function payloadHash(payload: unknown): Sha256Hex {
  const result = canonicalJsonSha256(payload);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function command(overrides: Record<string, unknown> = {}) {
  return CommandEnvelopeSchema.parse({
    commandId: "test-command-1",
    actorId: "test-actor-1",
    expectedVersion: 1,
    commandName: "test.increment",
    payloadHash: payloadHash({ increment: 1 }),
    ...overrides
  });
}

function createTestAggregate(connection: RuntimeDatabaseConnection): void {
  nativeDatabase(connection).exec(`
    CREATE TABLE test_only_aggregate (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version >= 0)
    ) STRICT;
    INSERT INTO test_only_aggregate (singleton, version) VALUES (1, 1);
  `);
}

function readVersion(connection: RuntimeDatabaseConnection): number {
  return (
    nativeDatabase(connection)
      .prepare("SELECT version FROM test_only_aggregate WHERE singleton = 1")
      .get() as { version: number }
  ).version;
}

function executeIncrement(
  connection: RuntimeDatabaseConnection,
  input = command(),
  mutate = vi.fn(
    (context): Result<{ version: number }, RuntimeError> => {
      context.nativeDatabase
        .prepare("UPDATE test_only_aggregate SET version = version + 1 WHERE singleton = 1")
        .run();
      const version = (
        context.nativeDatabase
          .prepare("SELECT version FROM test_only_aggregate WHERE singleton = 1")
          .get() as { version: number }
      ).version;
      return ok({ version });
    }
  )
) {
  return executeCommand({
    connection,
    command: input,
    completedAt: 1_788_700_000_000,
    resultSchema: TestResultSchema,
    readVersion: (context) => {
      expect(context.nativeDatabase.inTransaction).toBe(true);
      return ok(
        (
          context.nativeDatabase
            .prepare("SELECT version FROM test_only_aggregate WHERE singleton = 1")
            .get() as { version: number }
        ).version
      );
    },
    mutate
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("command protocol", () => {
  it("commits with the expected version and replays the stored success", async () => {
    const { connection } = await openMigratedDatabase();
    createTestAggregate(connection);
    const mutate = vi.fn((context) => {
      context.nativeDatabase
        .prepare("UPDATE test_only_aggregate SET version = version + 1 WHERE singleton = 1")
        .run();
      return ok({ version: 2 });
    });

    const first = executeIncrement(connection, command(), mutate);
    const replay = executeIncrement(connection, command(), mutate);

    expect(first).toMatchObject({
      ok: true,
      value: { metadata: { replayed: false, status: "succeeded" }, result: { version: 2 } }
    });
    expect(replay).toMatchObject({
      ok: true,
      value: { metadata: { replayed: true, status: "succeeded" }, result: { version: 2 } }
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(readVersion(connection)).toBe(2);
    expect(
      nativeDatabase(connection)
        .prepare("SELECT COUNT(*) AS count FROM command_receipt")
        .get()
    ).toEqual({ count: 1 });
    expect(
      nativeDatabase(connection)
        .prepare(
          "SELECT status, result_json AS resultJson, result_hash AS resultHash FROM command_receipt"
        )
        .get()
    ).toEqual({
      status: "succeeded",
      resultJson: '{"version":2}',
      resultHash: first.ok ? first.value.metadata.resultHash : "unreachable"
    });
    expect(connection.close().ok).toBe(true);
  });

  it.each([
    ["payload", { payloadHash: payloadHash({ increment: 2 }) }, "payloadHash"],
    ["actor", { actorId: "test-actor-2" }, "actorId"],
    ["command name", { commandName: "test.decrement" }, "commandName"],
    ["expected version", { expectedVersion: 2 }, "expectedVersion"]
  ])("rejects command ID reuse with a different %s", async (_label, override, field) => {
    const { connection } = await openMigratedDatabase();
    createTestAggregate(connection);
    expect(executeIncrement(connection).ok).toBe(true);

    const reused = executeIncrement(connection, command(override));

    expect(reused).toEqual({
      ok: false,
      error: {
        code: "command_conflict",
        message: "Command cannot be applied",
        retryable: false,
        details: { reason: "command_identity_mismatch", mismatchedFields: field }
      }
    });
    expect(readVersion(connection)).toBe(2);
    expect(connection.close().ok).toBe(true);
  });

  it("rejects a stale expected version without mutating or storing a receipt", async () => {
    const { connection } = await openMigratedDatabase();
    createTestAggregate(connection);

    const result = executeIncrement(connection, command({ expectedVersion: 0 }));

    expect(result).toEqual({
      ok: false,
      error: {
        code: "command_conflict",
        message: "Command cannot be applied",
        retryable: false,
        details: {
          reason: "expected_version_mismatch",
          expectedVersion: 0,
          actualVersion: 1
        }
      }
    });
    expect(readVersion(connection)).toBe(1);
    expect(
      nativeDatabase(connection)
        .prepare("SELECT COUNT(*) AS count FROM command_receipt")
        .get()
    ).toEqual({ count: 0 });
    expect(connection.close().ok).toBe(true);
  });

  it("rolls back mutation work and does not store a success receipt", async () => {
    const { connection } = await openMigratedDatabase();
    createTestAggregate(connection);
    const failure = createRuntimeError("persistence_failed", "Test mutation failed", false);

    const result = executeIncrement(
      connection,
      command(),
      vi.fn((context) => {
        context.nativeDatabase
          .prepare("UPDATE test_only_aggregate SET version = version + 1 WHERE singleton = 1")
          .run();
        return err(failure);
      })
    );

    expect(result).toEqual({ ok: false, error: failure });
    expect(readVersion(connection)).toBe(1);
    expect(
      nativeDatabase(connection)
        .prepare("SELECT COUNT(*) AS count FROM command_receipt")
        .get()
    ).toEqual({ count: 0 });
    expect(nativeDatabase(connection).inTransaction).toBe(false);
    expect(connection.close().ok).toBe(true);
  });

  it("fails closed for stored in-progress and failed receipts", async () => {
    const { connection } = await openMigratedDatabase();
    createTestAggregate(connection);
    const database = nativeDatabase(connection);
    const base = command();
    const insert = database.prepare(
      `INSERT INTO command_receipt (
        command_id, command_name, actor_id, expected_version, payload_hash, status,
        result_json, result_hash, error_code, error_message, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 10, ?)`
    );
    insert.run(
      "test-command-1",
      base.commandName,
      base.actorId,
      base.expectedVersion,
      base.payloadHash,
      "in_progress",
      null,
      null,
      null
    );

    expect(executeIncrement(connection)).toMatchObject({
      ok: false,
      error: { code: "command_conflict", details: { reason: "command_in_progress" } }
    });

    database.prepare("DELETE FROM command_receipt").run();
    insert.run(
      "test-command-1",
      base.commandName,
      base.actorId,
      base.expectedVersion,
      base.payloadHash,
      "failed",
      "test_failure",
      "Stored test failure",
      11
    );
    expect(executeIncrement(connection)).toMatchObject({
      ok: false,
      error: { code: "command_conflict", details: { reason: "command_failed" } }
    });
    expect(connection.close().ok).toBe(true);
  });

  it("maps lock contention to a retryable typed persistence error and cleans up", async () => {
    const filename = await createDatabaseFilename();
    const first = await openMigratedDatabase(filename);
    const second = await openMigratedDatabase(filename);
    nativeDatabase(second.connection).pragma("busy_timeout = 1");
    nativeDatabase(first.connection).exec("BEGIN IMMEDIATE");

    const result = runImmediateTransaction(second.connection, (context) => {
      context.nativeDatabase
        .prepare("INSERT INTO runtime_migration_smoke (singleton, applied) VALUES (2, 1)")
        .run();
      return ok(undefined);
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "persistence_failed",
        message: "Runtime database transaction failed",
        retryable: true
      }
    });
    expect(nativeDatabase(second.connection).inTransaction).toBe(false);
    nativeDatabase(first.connection).exec("ROLLBACK");
    expect(first.connection.close().ok).toBe(true);
    expect(second.connection.close().ok).toBe(true);
  });

  it("rolls back thrown persistence failures and leaves the connection usable", async () => {
    const { connection } = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    const result = runImmediateTransaction(connection, (context) => {
      context.nativeDatabase
        .prepare("INSERT INTO runtime_migration_smoke (singleton, applied) VALUES (2, 1)")
        .run();
      throw new Error("test-only failure");
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "persistence_failed",
        message: "Runtime database transaction failed",
        retryable: false
      }
    });
    expect(database.inTransaction).toBe(false);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM runtime_migration_smoke WHERE singleton = 2")
        .get()
    ).toEqual({ count: 0 });
    expect(connection.isOpen()).toBe(true);
    expect(connection.close().ok).toBe(true);
  });

  it("applies the command receipt migration idempotently", async () => {
    const { connection } = await openMigratedDatabase();

    expect(connection.migrate()).toEqual({ ok: true, value: undefined });
    expect(
      nativeDatabase(connection)
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'command_receipt'"
        )
        .get()
    ).toEqual({ count: 1 });
    expect(
      nativeDatabase(connection)
        .prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations")
        .get()
    ).toEqual({ count: 2 });
    expect(connection.close().ok).toBe(true);
  });
});
