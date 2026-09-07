import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { err, ok, sha256Hex, type Result } from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  CommandEnvelopeSchema,
  executeCommand,
  runImmediateTransaction
} from "../commands/index.js";
import {
  openRuntimeDatabase,
  type RuntimeDatabaseConnection
} from "../db/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import { appendAuditEvent, prepareAuditEvent, readAuditEvent } from "./store.js";
import {
  AuditEventDraftSchema,
  AuditEventNameSchema,
  AuditEventSchema,
  type AuditEventDraft
} from "./schemas.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Reads the migration count from the local journal so adding a migration does
 * not break unrelated idempotency assertions.
 */
function localMigrationCount(): number {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8")
  ) as { entries: readonly unknown[] };
  return journal.entries.length;
}
const temporaryDirectories: string[] = [];
const TestCommandPayloadSchema = z.object({ increment: z.literal(1) }).strict();
const TestCommandResultSchema = z.object({ version: z.number().int().safe() }).strict();

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-audit-test-"));
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
  return (
    connection.database as unknown as { $client: BetterSqlite3.Database }
  ).$client;
}

function fixedClock(timestamp = 1_788_700_000_100) {
  return { now: vi.fn(() => timestamp) };
}

function draft(overrides: Record<string, unknown> = {}): AuditEventDraft {
  return AuditEventDraftSchema.parse({
    auditEventId: "test-audit-event-1",
    commandId: null,
    eventOrdinal: null,
    actorId: "test-actor-1",
    actorDisplayName: "Test Operator",
    eventName: "test.event_recorded",
    eventVersion: 1,
    payload: { zeta: 2, alpha: { second: 2, first: 1 } },
    occurredAt: 1_788_700_000_000,
    ...overrides
  });
}

function prepareDraft(
  clock = fixedClock(),
  input: unknown = draft()
) {
  const prepared = prepareAuditEvent(clock, input);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) {
    throw new Error(prepared.error.message);
  }
  return prepared.value;
}

function createTestAggregate(connection: RuntimeDatabaseConnection): void {
  nativeDatabase(connection).exec(`
    CREATE TABLE test_only_audit_aggregate (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL CHECK (version >= 0)
    ) STRICT;
    INSERT INTO test_only_audit_aggregate (singleton, version) VALUES (1, 1);
  `);
}

function aggregateVersion(connection: RuntimeDatabaseConnection): number {
  return (
    nativeDatabase(connection)
      .prepare("SELECT version FROM test_only_audit_aggregate WHERE singleton = 1")
      .get() as { version: number }
  ).version;
}

function auditCount(connection: RuntimeDatabaseConnection): number {
  return (
    nativeDatabase(connection)
      .prepare("SELECT COUNT(*) AS count FROM audit_event")
      .get() as { count: number }
  ).count;
}

function receiptCount(connection: RuntimeDatabaseConnection): number {
  return (
    nativeDatabase(connection)
      .prepare("SELECT COUNT(*) AS count FROM command_receipt")
      .get() as { count: number }
  ).count;
}

function executeAuditedIncrement(
  connection: RuntimeDatabaseConnection,
  auditEventId: string,
  afterAppend?: () => Result<void, RuntimeError>
) {
  const command = CommandEnvelopeSchema.parse({
    commandId: `command-for-${auditEventId}`,
    actorId: "test-actor-1",
    expectedVersion: 1,
    commandName: "test.increment",
    payload: { increment: 1 }
  });
  const preparedAuditEvent = prepareDraft(
    fixedClock(),
    draft({
      auditEventId,
      commandId: command.commandId,
      eventOrdinal: 0
    })
  );
  return executeCommand({
    connection,
    command,
    completedAt: 1_788_700_000_200,
    payloadSchema: TestCommandPayloadSchema,
    resultSchema: TestCommandResultSchema,
    readVersion: () => ok(aggregateVersion(connection)),
    mutate: (context) => {
      context.nativeDatabase
        .prepare(
          "UPDATE test_only_audit_aggregate SET version = version + 1 WHERE singleton = 1"
        )
        .run();
      const appended = appendAuditEvent(context, preparedAuditEvent);
      if (!appended.ok) {
        return appended;
      }
      const continuation = afterAppend?.();
      if (continuation !== undefined && !continuation.ok) {
        return continuation;
      }
      return ok({ version: aggregateVersion(connection) });
    }
  });
}

function insertRawAuditEvent(
  database: BetterSqlite3.Database,
  values: Readonly<{
    auditEventId: string;
    actorId?: string;
    payloadJson: string;
    payloadHash: string;
  }>
): void {
  database
    .prepare(
      `INSERT INTO audit_event (
        audit_event_id,
        command_id,
        event_ordinal,
        actor_id,
        actor_display_name,
        event_name,
        event_version,
        payload_json,
        payload_hash,
        occurred_at,
        recorded_at
      ) VALUES (?, NULL, NULL, ?, 'Test Operator', 'test.event_recorded', 1, ?, ?, 10, 10)`
    )
    .run(
      values.auditEventId,
      values.actorId ?? "test-actor-1",
      values.payloadJson,
      values.payloadHash
    );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("audit envelope foundation", () => {
  it("appends and reads canonical payload bytes with an internally computed hash", async () => {
    const connection = await openMigratedDatabase();
    const clock = {
      now: vi.fn(() => {
        expect(nativeDatabase(connection).inTransaction).toBe(false);
        return 1_788_700_000_100;
      })
    };
    const prepared = prepareAuditEvent(clock, draft());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error(prepared.error.message);
    }
    const appended = runImmediateTransaction(connection, (context) =>
      appendAuditEvent(context, prepared.value)
    );

    expect(appended).toEqual({
      ok: true,
      value: {
        auditEventId: "test-audit-event-1",
        commandId: null,
        eventOrdinal: null,
        actorId: "test-actor-1",
        actorDisplayName: "Test Operator",
        eventName: "test.event_recorded",
        eventVersion: 1,
        payloadJson: '{"alpha":{"first":1,"second":2},"zeta":2}',
        payloadHash: sha256Hex('{"alpha":{"first":1,"second":2},"zeta":2}'),
        occurredAt: 1_788_700_000_000,
        recordedAt: 1_788_700_000_100
      }
    });
    expect(clock.now).toHaveBeenCalledTimes(1);

    const read = runImmediateTransaction(connection, (context) =>
      readAuditEvent(context, "test-audit-event-1")
    );
    expect(read).toEqual(appended);
    expect(connection.close().ok).toBe(true);
  });

  it("rejects invalid event input, payloads, clocks, and transaction contexts", async () => {
    const connection = await openMigratedDatabase();
    const invalidContext = { nativeDatabase: { inTransaction: false } };
    const prepared = prepareDraft();
    expect(appendAuditEvent(invalidContext, prepared)).toMatchObject({
      ok: false,
      error: { message: "Audit events require an active command transaction" }
    });
    expect(readAuditEvent(invalidContext as never, "test-audit-event-1")).toMatchObject({
      ok: false,
      error: { message: "Audit events require an active command transaction" }
    });
    for (const malformedContext of [null, undefined, 1]) {
      expect(appendAuditEvent(malformedContext, prepared)).toMatchObject({
        ok: false,
        error: { message: "Audit events require an active command transaction" }
      });
      expect(readAuditEvent(malformedContext, "test-audit-event-1")).toMatchObject({
        ok: false,
        error: { message: "Audit events require an active command transaction" }
      });
    }

    expect(prepareAuditEvent(null, draft())).toMatchObject({
      ok: false,
      error: { message: "Invalid audit clock" }
    });
    for (const malformedClock of [undefined, 1, {}]) {
      expect(prepareAuditEvent(malformedClock, draft())).toMatchObject({
        ok: false,
        error: { message: "Invalid audit clock" }
      });
    }
    expect(
      prepareAuditEvent(fixedClock(), { ...draft(), commandId: "command-only" })
    ).toMatchObject({ ok: false, error: { message: "Invalid audit event input" } });
    expect(
      prepareAuditEvent(fixedClock(), {
        ...draft(),
        payload: { unsupported: 1n }
      })
    ).toMatchObject({
      ok: false,
      error: { message: "Audit event payload is not canonical JSON" }
    });
    expect(prepareAuditEvent({ now: () => -1 }, draft())).toMatchObject({
      ok: false,
      error: { message: "Audit clock returned an invalid timestamp" }
    });
    expect(prepareAuditEvent(fixedClock(1), draft())).toMatchObject({
      ok: false,
      error: { message: "Invalid audit event input" }
    });
    expect(
      prepareAuditEvent(
        {
          now: () => {
            throw new Error("test clock failure");
          }
        },
        draft()
      )
    ).toMatchObject({
      ok: false,
      error: { message: "Audit event preparation failed" }
    });
    expect(
      runImmediateTransaction(connection, (context) =>
        appendAuditEvent(context, draft())
      )
    ).toMatchObject({
      ok: false,
      error: { message: "Invalid prepared audit event" }
    });
    expect(connection.close().ok).toBe(true);
  });

  it("rejects update and delete at the SQLite boundary", async () => {
    const connection = await openMigratedDatabase();
    const prepared = prepareDraft();
    expect(
      runImmediateTransaction(connection, (context) =>
        appendAuditEvent(context, prepared)
      ).ok
    ).toBe(true);
    const database = nativeDatabase(connection);

    expect(() =>
      database
        .prepare("UPDATE audit_event SET actor_display_name = 'Changed'")
        .run()
    ).toThrowError("audit_event is append-only");
    expect(() => database.prepare("DELETE FROM audit_event").run()).toThrowError(
      "audit_event is append-only"
    );
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO audit_event
           SELECT
             audit_event_id,
             command_id,
             event_ordinal,
             actor_id,
             'Replacement',
             event_name,
             event_version,
             payload_json,
             payload_hash,
             occurred_at,
             recorded_at
           FROM audit_event`
        )
        .run()
    ).toThrowError("audit_event is append-only");
    expect(auditCount(connection)).toBe(1);
    expect(connection.close().ok).toBe(true);
  });

  it("commits command mutation, audit event, and receipt atomically", async () => {
    const connection = await openMigratedDatabase();
    createTestAggregate(connection);

    const result = executeAuditedIncrement(connection, "test-command-audit-success");

    expect(result).toMatchObject({ ok: true, value: { result: { version: 2 } } });
    expect(aggregateVersion(connection)).toBe(2);
    expect(auditCount(connection)).toBe(1);
    expect(receiptCount(connection)).toBe(1);
    expect(connection.close().ok).toBe(true);
  });

  it("rolls back an appended event when the command mutation fails", async () => {
    const connection = await openMigratedDatabase();
    createTestAggregate(connection);
    const failure = createRuntimeError("persistence_failed", "Test mutation failed", false);

    const result = executeAuditedIncrement(
      connection,
      "test-command-audit-rollback",
      () => err(failure)
    );

    expect(result).toEqual({ ok: false, error: failure });
    expect(aggregateVersion(connection)).toBe(1);
    expect(auditCount(connection)).toBe(0);
    expect(receiptCount(connection)).toBe(0);
    expect(connection.close().ok).toBe(true);
  });

  it("rolls back command success when audit append fails", async () => {
    const connection = await openMigratedDatabase();
    createTestAggregate(connection);
    const prepared = prepareDraft(
      fixedClock(),
      draft({ auditEventId: "test-duplicate-audit-event" })
    );
    expect(
      runImmediateTransaction(connection, (context) =>
        appendAuditEvent(context, prepared)
      ).ok
    ).toBe(true);

    const result = executeAuditedIncrement(connection, "test-duplicate-audit-event");

    expect(result).toMatchObject({
      ok: false,
      error: { message: "Audit event append failed", retryable: false }
    });
    expect(aggregateVersion(connection)).toBe(1);
    expect(auditCount(connection)).toBe(1);
    expect(receiptCount(connection)).toBe(0);
    expect(connection.close().ok).toBe(true);
  });

  it("validates read boundaries and rejects corrupt stored payloads", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    expect(
      runImmediateTransaction(connection, (context) =>
        readAuditEvent(context, "invalid id" as never)
      )
    ).toMatchObject({ ok: false, error: { message: "Invalid audit event ID" } });
    expect(
      runImmediateTransaction(connection, (context) =>
        readAuditEvent(context, "missing-audit-event")
      )
    ).toEqual({ ok: true, value: undefined });

    insertRawAuditEvent(database, {
      auditEventId: "test-invalid-stored-audit",
      actorId: "",
      payloadJson: "{}",
      payloadHash: sha256Hex("{}")
    });
    expect(
      runImmediateTransaction(connection, (context) =>
        readAuditEvent(context, "test-invalid-stored-audit")
      )
    ).toMatchObject({ ok: false, error: { message: "Stored audit event is invalid" } });

    insertRawAuditEvent(database, {
      auditEventId: "test-invalid-json-audit",
      payloadJson: "{",
      payloadHash: sha256Hex("{")
    });
    expect(
      runImmediateTransaction(connection, (context) =>
        readAuditEvent(context, "test-invalid-json-audit")
      )
    ).toMatchObject({
      ok: false,
      error: { message: "Stored audit event payload is not valid JSON" }
    });

    insertRawAuditEvent(database, {
      auditEventId: "test-hash-mismatch-audit",
      payloadJson: "{}",
      payloadHash: "a".repeat(64)
    });
    expect(
      runImmediateTransaction(connection, (context) =>
        readAuditEvent(context, "test-hash-mismatch-audit")
      )
    ).toMatchObject({
      ok: false,
      error: { message: "Stored audit event failed integrity validation" }
    });
    expect(connection.close().ok).toBe(true);
  });

  it("maps hostile JavaScript property access into typed errors", () => {
    const prepared = prepareDraft();
    const hostileContext = Object.defineProperty({}, "nativeDatabase", {
      get() {
        throw new TypeError("test context getter failure");
      }
    });
    const hostileClock = Object.defineProperty({}, "now", {
      get() {
        throw new TypeError("test clock getter failure");
      }
    });
    expect(() => appendAuditEvent(hostileContext, prepared)).not.toThrow();
    expect(appendAuditEvent(hostileContext, prepared)).toMatchObject({
      ok: false,
      error: { message: "Audit event append failed" }
    });
    expect(() => readAuditEvent(hostileContext, "test-audit-event-1")).not.toThrow();
    expect(readAuditEvent(hostileContext, "test-audit-event-1")).toMatchObject({
      ok: false,
      error: { message: "Audit event read failed" }
    });
    expect(() => prepareAuditEvent(hostileClock, draft())).not.toThrow();
    expect(prepareAuditEvent(hostileClock, draft())).toMatchObject({
      ok: false,
      error: { message: "Audit event preparation failed" }
    });

    const context = {
      nativeDatabase: {
        inTransaction: true,
        prepare: () => {
          throw new Error("test read failure");
        }
      }
    };
    expect(readAuditEvent(context as never, "test-audit-event-1")).toMatchObject({
      ok: false,
      error: { message: "Audit event read failed" }
    });
  });

  it("keeps schemas strict and command linkage paired", () => {
    expect(AuditEventNameSchema.safeParse("test.event_recorded").success).toBe(true);
    expect(AuditEventNameSchema.safeParse("Invalid Event").success).toBe(false);
    expect(
      AuditEventDraftSchema.safeParse({ ...draft(), payloadHash: "a".repeat(64) }).success
    ).toBe(false);
    expect(
      AuditEventDraftSchema.safeParse({
        ...draft(),
        commandId: "test-command",
        eventOrdinal: 0
      }).success
    ).toBe(true);
    expect(
      AuditEventSchema.safeParse({
        auditEventId: "test-audit",
        commandId: null,
        eventOrdinal: 0,
        actorId: "test-actor",
        actorDisplayName: "Test Operator",
        eventName: "test.event_recorded",
        eventVersion: 1,
        payloadJson: "{}",
        payloadHash: sha256Hex("{}"),
        occurredAt: 10,
        recordedAt: 10
      }).success
    ).toBe(false);
  });

  it("applies the audit migration idempotently", async () => {
    const connection = await openMigratedDatabase();

    expect(connection.migrate()).toEqual({ ok: true, value: undefined });
    expect(
      nativeDatabase(connection)
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name IN ('audit_event', 'audit_event_reject_replace', 'audit_event_reject_update', 'audit_event_reject_delete')"
        )
        .get()
    ).toEqual({ count: 4 });
    expect(
      nativeDatabase(connection)
        .prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations")
        .get()
    ).toEqual({ count: localMigrationCount() });
    expect(connection.close().ok).toBe(true);
  });
});
