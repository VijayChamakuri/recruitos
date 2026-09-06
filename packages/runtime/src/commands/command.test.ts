import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJsonSha256,
  err,
  ok,
  sha256Hex,
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
import { CommandEnvelopeSchema, CommandReceiptSchema } from "./schemas.js";
import { runImmediateTransaction } from "./transaction.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const TestPayloadSchema = z.object({ increment: z.number().int().safe() }).strict();
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

function hashPayload(payload: unknown): Sha256Hex {
  const result = canonicalJsonSha256(payload);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function nativeDatabase(connection: RuntimeDatabaseConnection): BetterSqlite3.Database {
  return (
    connection.database as unknown as { $client: BetterSqlite3.Database }
  ).$client;
}

function command(overrides: Record<string, unknown> = {}) {
  return CommandEnvelopeSchema.parse({
    commandId: "test-command-1",
    actorId: "test-actor-1",
    expectedVersion: 1,
    commandName: "test.increment",
    payload: { increment: 1 },
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
    payloadSchema: TestPayloadSchema,
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

function validExecutionOptions(connection: RuntimeDatabaseConnection) {
  return {
    connection,
    command: command(),
    completedAt: 1_788_700_000_000,
    payloadSchema: TestPayloadSchema,
    resultSchema: TestResultSchema,
    readVersion: () => ok(1),
    mutate: () => ok({ version: 2 })
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("command protocol", () => {
  it.each([
    {
      status: "succeeded",
      resultJson: null,
      resultHash: null,
      errorCode: null,
      errorMessage: null,
      completedAt: null
    },
    {
      status: "in_progress",
      resultJson: "{}",
      resultHash: "a".repeat(64),
      errorCode: null,
      errorMessage: null,
      completedAt: 10
    },
    {
      status: "failed",
      resultJson: null,
      resultHash: null,
      errorCode: null,
      errorMessage: null,
      completedAt: null
    }
  ])("rejects invalid $status receipt terminal metadata", (terminalMetadata) => {
    expect(
      CommandReceiptSchema.safeParse({
        commandId: "test-command",
        actorId: "test-actor",
        expectedVersion: 0,
        commandName: "test.run",
        payloadHash: "a".repeat(64),
        createdAt: 10,
        ...terminalMetadata
      }).success
    ).toBe(false);
  });

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
    [
      "payload",
      {
        payload: { increment: 2 },
        payloadHash: hashPayload({ increment: 1 })
      },
      "payloadHash"
    ],
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
      hashPayload(base.payload),
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
      hashPayload(base.payload),
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

  it("refuses to run inside an existing transaction", async () => {
    const { connection } = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    database.exec("BEGIN DEFERRED");
    const work = vi.fn(() => ok("not-run"));

    const result = runImmediateTransaction(connection, work);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "persistence_failed",
        message: "Cannot start an immediate transaction while another transaction is active",
        retryable: false
      }
    });
    expect(work).not.toHaveBeenCalled();
    expect(database.inTransaction).toBe(true);
    database.exec("ROLLBACK");
    expect(connection.close().ok).toBe(true);
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
    ).toEqual({ count: 3 });
    expect(connection.close().ok).toBe(true);
  });

  it("applies a transforming result schema exactly once on execution and replay", async () => {
    const { connection } = await openMigratedDatabase();
    createTestAggregate(connection);
    const TransformingResultSchema = z
      .object({ version: z.number().int().transform((version) => version + 1) })
      .strict();
    const input = command({ commandId: "test-transform-command" });
    const options = {
      connection,
      command: input,
      completedAt: 1_788_700_000_000,
      payloadSchema: TestPayloadSchema,
      resultSchema: TransformingResultSchema,
      readVersion: () => ok(1),
      mutate: vi.fn(() => ok({ version: 1 }))
    };

    const first = executeCommand(options);
    const replay = executeCommand(options);

    expect(first).toMatchObject({
      ok: true,
      value: { metadata: { replayed: false }, result: { version: 2 } }
    });
    expect(replay).toMatchObject({
      ok: true,
      value: { metadata: { replayed: true }, result: { version: 2 } }
    });
    expect(options.mutate).toHaveBeenCalledTimes(1);
    expect(
      nativeDatabase(connection)
        .prepare("SELECT result_json AS resultJson FROM command_receipt WHERE command_id = ?")
        .get(input.commandId)
    ).toEqual({ resultJson: '{"version":1}' });
    expect(connection.close().ok).toBe(true);
  });

  it.each([null, undefined, 1, "invalid", true])(
    "rejects invalid JavaScript options without throwing: %j",
    (invalidOptions) => {
      expect(() => executeCommand(invalidOptions as never)).not.toThrow();
      expect(executeCommand(invalidOptions as never)).toEqual({
        ok: false,
        error: {
          code: "persistence_failed",
          message: "Invalid command execution input",
          retryable: false
        }
      });
    }
  );

  it.each([
    {},
    { payloadSchema: null },
    { payloadSchema: {}, resultSchema: {} },
    {
      payloadSchema: TestPayloadSchema,
      resultSchema: TestResultSchema,
      readVersion: null,
      mutate: null
    }
  ])("rejects malformed JavaScript option objects", (invalidOptions) => {
    expect(executeCommand(invalidOptions as never)).toEqual({
      ok: false,
      error: {
        code: "persistence_failed",
        message: "Invalid command execution input",
        retryable: false
      }
    });
  });

  it("returns typed errors for invalid command, payload, version, and result boundaries", async () => {
    const { connection } = await openMigratedDatabase();
    createTestAggregate(connection);
    const valid = validExecutionOptions(connection);
    const failure = createRuntimeError("persistence_failed", "Test read failed", false);

    expect(executeCommand({ ...valid, command: null } as never)).toMatchObject({
      ok: false,
      error: { message: "Invalid command execution input" }
    });
    expect(executeCommand({ ...valid, completedAt: -1 })).toMatchObject({
      ok: false,
      error: { message: "Invalid command execution input" }
    });
    expect(
      executeCommand({
        ...valid,
        payloadSchema: z.object({ increment: z.literal(2) }).strict()
      })
    ).toMatchObject({ ok: false, error: { message: "Invalid command payload" } });
    expect(
      executeCommand({
        ...valid,
        command: command({ payload: { increment: 1, unsupported: 1n } }),
        payloadSchema: z.unknown()
      })
    ).toMatchObject({
      ok: false,
      error: { message: "Command payload is not canonical JSON" }
    });
    expect(
      executeCommand({
        ...valid,
        readVersion: () => err(failure)
      })
    ).toEqual({ ok: false, error: failure });
    expect(
      executeCommand({
        ...valid,
        readVersion: () => ok(-1)
      })
    ).toMatchObject({ ok: false, error: { message: "Aggregate version is invalid" } });
    expect(
      executeCommand({
        ...valid,
        command: command({ commandId: "test-noncanonical-result" }),
        resultSchema: z.unknown(),
        mutate: () => ok(1n)
      })
    ).toMatchObject({
      ok: false,
      error: { message: "Command result is not canonical JSON" }
    });
    expect(
      executeCommand({
        ...valid,
        command: command({ commandId: "test-invalid-result" }),
        mutate: () => ok({ version: -1 })
      })
    ).toMatchObject({
      ok: false,
      error: { message: "Command result does not match its schema" }
    });
    expect(connection.close().ok).toBe(true);
  });

  it("converts payload-schema inspection failures into typed invalid input", async () => {
    const { connection } = await openMigratedDatabase();
    const options = validExecutionOptions(connection);
    const throwingSchema = {
      safeParse: () => {
        throw new Error("test-only schema failure");
      }
    };

    expect(
      executeCommand({ ...options, payloadSchema: throwingSchema } as never)
    ).toMatchObject({
      ok: false,
      error: { message: "Invalid command execution input" }
    });
    expect(connection.close().ok).toBe(true);
  });

  it("rejects corrupt stored receipt identity and result bytes", async () => {
    const { connection } = await openMigratedDatabase();
    createTestAggregate(connection);
    const input = command({ commandId: "test-corrupt-receipt" });
    const options = { ...validExecutionOptions(connection), command: input };
    expect(executeCommand(options).ok).toBe(true);
    const database = nativeDatabase(connection);

    database
      .prepare("UPDATE command_receipt SET command_name = '' WHERE command_id = ?")
      .run(input.commandId);
    expect(executeCommand(options)).toMatchObject({
      ok: false,
      error: { message: "Stored command receipt is invalid" }
    });

    database
      .prepare("UPDATE command_receipt SET command_name = ?, result_json = ? WHERE command_id = ?")
      .run(input.commandName, "{", input.commandId);
    expect(executeCommand(options)).toMatchObject({
      ok: false,
      error: { message: "Stored command result is not valid JSON" }
    });

    database
      .prepare("UPDATE command_receipt SET result_json = ?, result_hash = ? WHERE command_id = ?")
      .run('{"version":2}', "a".repeat(64), input.commandId);
    expect(executeCommand(options)).toMatchObject({
      ok: false,
      error: { message: "Stored command result failed integrity validation" }
    });

    database
      .prepare("UPDATE command_receipt SET result_json = ?, result_hash = ? WHERE command_id = ?")
      .run("null", sha256Hex("null"), input.commandId);
    expect(executeCommand(options)).toMatchObject({
      ok: false,
      error: { message: "Stored command result does not match its schema" }
    });
    expect(connection.close().ok).toBe(true);
  });

  it("validates transaction helper JavaScript inputs and closed connections", async () => {
    const work = () => ok(undefined);
    for (const invalidConnection of [null, undefined, 1, "invalid", {}, { isOpen: null }]) {
      expect(runImmediateTransaction(invalidConnection as never, work)).toMatchObject({
        ok: false,
        error: { message: "Invalid runtime database transaction input" }
      });
    }

    const { connection } = await openMigratedDatabase();
    expect(runImmediateTransaction(connection, null as never)).toMatchObject({
      ok: false,
      error: { message: "Invalid runtime database transaction input" }
    });
    expect(connection.close().ok).toBe(true);
    expect(runImmediateTransaction(connection, work)).toMatchObject({
      ok: false,
      error: { message: "Cannot start a transaction on a closed runtime database" }
    });
  });

  it("maps malformed connection objects into typed transaction errors", () => {
    expect(
      runImmediateTransaction(
        {
          isOpen: () => {
            throw new Error("test-only connection failure");
          }
        } as never,
        () => ok(undefined)
      )
    ).toMatchObject({
      ok: false,
      error: { message: "Runtime database transaction failed", retryable: false }
    });
  });
});
