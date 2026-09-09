import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { appendAuditEvent, prepareAuditEvent } from "../audit/index.js";
import { runImmediateTransaction } from "../commands/index.js";
import { openRuntimeDatabase, type RuntimeDatabaseConnection } from "../db/index.js";
import {
  assertListAuditEventsIndexPlan,
  assertListCandidatesIndexPlan,
  assertListProposalsIndexPlan,
  assertListResolutionTasksIndexPlan,
  decodeCursor,
  encodeCursor,
  listAuditEvents,
  listCandidates,
  listProposals,
  listResolutionTasks,
  readCandidatePacket
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];

function getNativeClient(connection: { database: unknown }): BetterSqlite3.Database {
  return (connection.database as unknown as { $client: BetterSqlite3.Database }).$client;
}

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-read-models-test-"));
  temporaryDirectories.push(directory);
  const opened = openRuntimeDatabase({
    filename: join(directory, "runtime.db"),
    migrationsFolder
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Keyset Cursor Encode / Decode", () => {
  it("encodes and decodes valid keyset cursor payload", () => {
    const payload = {
      score: 8500,
      importOrdinal: 12,
      candidateId: "cand-001"
    };

    const encoded = encodeCursor(payload);
    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = decodeCursor<typeof payload>(encoded, [
      "score",
      "importOrdinal",
      "candidateId"
    ]);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.score).toBe(8500);
    expect(decoded.value.importOrdinal).toBe(12);
    expect(decoded.value.candidateId).toBe("cand-001");
  });

  it("fails to decode non-string or empty cursor", () => {
    const emptyResult = decodeCursor("", ["score"]);
    expect(emptyResult.ok).toBe(false);

    const wsResult = decodeCursor("   ", ["score"]);
    expect(wsResult.ok).toBe(false);
  });

  it("fails to decode malformed base64 or non-JSON", () => {
    const malformed = decodeCursor("not-valid-base64url!", ["score"]);
    expect(malformed.ok).toBe(false);
  });

  it("fails when required fields are missing", () => {
    const encoded = encodeCursor({ score: 50 });
    const result = decodeCursor(encoded, ["score", "missingKey"]);
    expect(result.ok).toBe(false);
  });

  it("fails when decoded payload is not an object or unsupported version", () => {
    const arrayCursor = Buffer.from(JSON.stringify([1, 2, 3]), "utf8").toString("base64url");
    expect(decodeCursor(arrayCursor, ["score"]).ok).toBe(false);

    const nullCursor = Buffer.from(JSON.stringify(null), "utf8").toString("base64url");
    expect(decodeCursor(nullCursor, ["score"]).ok).toBe(false);

    const wrongVersion = Buffer.from(JSON.stringify({ v: 99, score: 100 }), "utf8").toString("base64url");
    expect(decodeCursor(wrongVersion, ["score"]).ok).toBe(false);
  });
});

describe("listCandidates Read Model", () => {
  it("returns empty page on clean database with queryCount = 1", async () => {
    const connection = await openMigratedDatabase();
    try {
      const result = listCandidates(connection.database);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.items.length).toBe(0);
      expect(result.value.nextCursor).toBeUndefined();
      expect(result.value.queryCount).toBe(1);
    } finally {
      connection.close();
    }
  });

  it("paginates candidates using keyset cursor and respects score descending, ordinal ascending, id ascending", async () => {
    const connection = await openMigratedDatabase();
    const nativeDb = getNativeClient(connection);

    try {
      nativeDb.pragma("foreign_keys = OFF");

      // 1. Insert 5 candidates
      const insertCandidateStmt = nativeDb.prepare(`
        INSERT INTO candidate (candidate_id, source_system, source_key, channel, corpus_tag, is_synthetic, created_at)
        VALUES (?, 'greenhouse', ?, ?, 'main', 1, 1788700000000)
      `);
      insertCandidateStmt.run("cand-1", "key-1", "inbound");
      insertCandidateStmt.run("cand-2", "key-2", "sourced");
      insertCandidateStmt.run("cand-3", "key-3", "inbound");
      insertCandidateStmt.run("cand-4", "key-4", "sourced");
      insertCandidateStmt.run("cand-5", "key-5", "inbound");

      // 2. Insert member ordinals
      const insertMemberStmt = nativeDb.prepare(`
        INSERT INTO corpus_member (corpus_member_id, manifest_id, candidate_id, import_ordinal, created_at)
        VALUES (?, 'manifest-1', ?, ?, 1788700000000)
      `);
      insertMemberStmt.run("mem-1", "cand-1", 1);
      insertMemberStmt.run("mem-2", "cand-2", 2);
      insertMemberStmt.run("mem-3", "cand-3", 3);
      insertMemberStmt.run("mem-4", "cand-4", 4);
      insertMemberStmt.run("mem-5", "cand-5", 5);

      // 3. Insert results and scores for cand-1, cand-2, cand-3
      const insertResultStmt = nativeDb.prepare(`
        INSERT INTO candidate_triage_result (candidate_triage_result_id, candidate_id, kind, availability, status, content_json, content_hash, seal_id, created_at)
        VALUES (?, ?, 'initial', 'complete', 'scored', '{}', ?, ?, 1788700000000)
      `);
      const insertScoreStmt = nativeDb.prepare(`
        INSERT INTO score_result (score_result_id, candidate_result_id, aggregate_text, confidence_text, aggregate_basis_points, confidence_basis_points, content_json, content_hash, created_at)
        VALUES (?, ?, '9/10', '8/10', ?, 8000, '{"contributions":[1,2,3,4,5,6]}', ?, 1788700000000)
      `);
      const insertHeadStmt = nativeDb.prepare(`
        INSERT INTO candidate_head (candidate_id, current_result_id, version)
        VALUES (?, ?, 1)
      `);

      // cand-1: score 9000
      insertResultStmt.run("res-1", "cand-1", "a".repeat(64), "seal-1");
      insertScoreStmt.run("score-1", "res-1", 9000, "b".repeat(64));
      insertHeadStmt.run("cand-1", "res-1");
      nativeDb.prepare(`
        INSERT INTO candidate_result_reason (candidate_result_reason_id, candidate_result_id, reason_kind, subject_id, reason_code, reason_ordinal, created_at)
        VALUES ('crr-c1', 'res-1', 'low_confidence', null, 'low_confidence', 0, 1788700000000)
      `).run();

      // cand-2: score 8500, ordinal 2, rejected_hard_requirement
      const insertRejectedStmt = nativeDb.prepare(`
        INSERT INTO candidate_triage_result (candidate_triage_result_id, candidate_id, kind, availability, status, content_json, content_hash, seal_id, created_at)
        VALUES ('res-2', 'cand-2', 'initial', 'complete', 'rejected_hard_requirement', '{}', ?, 'seal-2', 1788700000000)
      `);
      insertRejectedStmt.run("c".repeat(64));
      insertScoreStmt.run("score-2", "res-2", 8500, "d".repeat(64));
      insertHeadStmt.run("cand-2", "res-2");

      // cand-3: score 8500, ordinal 3, escalated
      const insertEscalatedStmt = nativeDb.prepare(`
        INSERT INTO candidate_triage_result (candidate_triage_result_id, candidate_id, kind, availability, status, content_json, content_hash, seal_id, created_at)
        VALUES ('res-3', 'cand-3', 'initial', 'complete', 'escalated', '{}', ?, 'seal-3', 1788700000000)
      `);
      insertEscalatedStmt.run("e".repeat(64));
      insertScoreStmt.run("score-3", "res-3", 8500, "f".repeat(64));
      insertHeadStmt.run("cand-3", "res-3");

      // Page 1 with limit = 2
      const page1Result = listCandidates(connection.database, { limit: 2 });
      expect(page1Result.ok).toBe(true);
      if (!page1Result.ok) return;

      const page1 = page1Result.value;
      expect(page1.items.length).toBe(2);
      expect(page1.items[0]?.candidateId).toBe("cand-1");
      expect(page1.items[1]?.candidateId).toBe("cand-2");
      expect(page1.nextCursor).toBeDefined();

      // Page 2 using nextCursor
      const page2Result = listCandidates(connection.database, {
        cursor: page1.nextCursor,
        limit: 2
      });
      expect(page2Result.ok).toBe(true);
      if (!page2Result.ok) return;

      const page2 = page2Result.value;
      expect(page2.items.length).toBe(2);
      expect(page2.items[0]?.candidateId).toBe("cand-3");
      expect(page2.items[1]?.candidateId).toBe("cand-4");
      expect(page2.nextCursor).toBeDefined();

      // Page 3
      const page3Result = listCandidates(connection.database, {
        cursor: page2.nextCursor,
        limit: 2
      });
      expect(page3Result.ok).toBe(true);
      if (!page3Result.ok) return;

      const page3 = page3Result.value;
      expect(page3.items.length).toBe(1);
      expect(page3.items[0]?.candidateId).toBe("cand-5");
      expect(page3.nextCursor).toBeUndefined();

      expect(page1.queryCount).toBe(2);

      // Filters
      const inboundOnly = listCandidates(connection.database, { channel: "inbound" });
      expect(inboundOnly.ok).toBe(true);
      if (inboundOnly.ok) {
        expect(inboundOnly.value.items.every((i) => i.channel === "inbound")).toBe(true);
      }

      const mainOnly = listCandidates(connection.database, { corpusTag: "main" });
      expect(mainOnly.ok).toBe(true);

      const pendingOnly = listCandidates(connection.database, { status: "pending" });
      expect(pendingOnly.ok).toBe(true);

      const scoredOnly = listCandidates(connection.database, { status: "scored" });
      expect(scoredOnly.ok).toBe(true);
    } finally {
      connection.close();
    }
  });

  it("handles client errors, bad cursors, and query errors in listCandidates", async () => {
    const badClientDb = {};
    expect(listCandidates(badClientDb).ok).toBe(false);
    expect(assertListCandidatesIndexPlan(badClientDb).ok).toBe(false);

    const connection = await openMigratedDatabase();
    try {
      const badCursorResult = listCandidates(connection.database, { cursor: "invalid" });
      expect(badCursorResult.ok).toBe(false);

      const throwingDb = {
        $client: {
          prepare() {
            throw new Error("Simulated query failure");
          }
        }
      };
      expect(listCandidates(throwingDb).ok).toBe(false);
      expect(assertListCandidatesIndexPlan(throwingDb).ok).toBe(false);

      const partialThrowingDb = {
        $client: {
          prepare(sql: string) {
            if (sql.includes("candidate_result_reason")) {
              throw new Error("Simulated reasons query failure");
            }
            return {
              all: () => [
                {
                  candidateId: "c1",
                  currentResultId: "r1",
                  sortScore: 10,
                  sortImportOrdinal: 0
                }
              ]
            };
          }
        }
      };
      expect(listCandidates(partialThrowingDb).ok).toBe(false);
    } finally {
      connection.close();
    }
  });

  it("asserts index plan for listCandidates query", async () => {
    const connection = await openMigratedDatabase();
    try {
      const planResult = assertListCandidatesIndexPlan(connection.database);
      expect(planResult.ok).toBe(true);
      if (!planResult.ok) return;

      expect(planResult.value.steps.length).toBeGreaterThan(0);
      expect(planResult.value.usesCoveringOrIndexedScan).toBe(true);
    } finally {
      connection.close();
    }
  });
});

describe("listResolutionTasks Read Model", () => {
  it("returns empty page on clean database", async () => {
    const connection = await openMigratedDatabase();
    try {
      const result = listResolutionTasks(connection.database);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.items.length).toBe(0);
      expect(result.value.nextCursor).toBeUndefined();
      expect(result.value.queryCount).toBe(1);
    } finally {
      connection.close();
    }
  });

  it("orders reviewer queue by reason precedence, opened timestamp, and task ID", async () => {
    const connection = await openMigratedDatabase();
    const nativeDb = getNativeClient(connection);

    try {
      // 1. Seed candidate and result
      nativeDb.prepare(`
        INSERT INTO candidate (candidate_id, source_system, source_key, channel, corpus_tag, is_synthetic, created_at)
        VALUES ('cand-1', 'system', 'k1', 'inbound', 'main', 1, 1000)
      `).run();

      nativeDb.pragma("foreign_keys = OFF");
      nativeDb.prepare(`
        INSERT INTO candidate_triage_result (candidate_triage_result_id, candidate_id, kind, availability, status, content_json, content_hash, seal_id, created_at)
        VALUES ('res-1', 'cand-1', 'initial', 'complete', 'escalated', '{}', '1111222233334444555566667777888811112222333344445555666677778888', 'seal-1', 1000)
      `).run();

      // 2. Insert reasons
      const insertReasonStmt = nativeDb.prepare(`
        INSERT INTO candidate_result_reason (candidate_result_reason_id, candidate_result_id, reason_kind, subject_id, reason_code, reason_ordinal, created_at)
        VALUES (?, 'res-1', ?, ?, ?, ?, 1000)
      `);
      insertReasonStmt.run("crr-low", "low_confidence", null, "low_confidence", 0);
      insertReasonStmt.run("crr-unavail", "assessment_unavailable", null, "assessment_unavailable", 1);
      insertReasonStmt.run("crr-missing", "missing_evidence", "dim-1", "missing_evidence:dim-1", 2);

      // 3. Insert resolution tasks
      const insertTaskStmt = nativeDb.prepare(`
        INSERT INTO resolution_task (resolution_task_id, candidate_result_id, candidate_result_reason_id, task_ordinal, created_at)
        VALUES (?, 'res-1', ?, ?, ?)
      `);
      insertTaskStmt.run("task-1", "crr-low", 0, 200);
      insertTaskStmt.run("task-2", "crr-unavail", 1, 500);
      insertTaskStmt.run("task-3", "crr-missing", 2, 100);

      // Query tasks with limit = 2
      const page1Result = listResolutionTasks(connection.database, { limit: 2 });
      expect(page1Result.ok).toBe(true);
      if (!page1Result.ok) return;

      const page1 = page1Result.value;
      expect(page1.items.length).toBe(2);
      expect(page1.items[0]?.resolutionTaskId).toBe("task-2"); // precedence 0
      expect(page1.items[1]?.resolutionTaskId).toBe("task-3"); // precedence 5
      expect(page1.nextCursor).toBeDefined();

      // Page 2
      const page2Result = listResolutionTasks(connection.database, {
        cursor: page1.nextCursor,
        limit: 2
      });
      expect(page2Result.ok).toBe(true);
      if (!page2Result.ok) return;

      const page2 = page2Result.value;
      expect(page2.items.length).toBe(1);
      expect(page2.items[0]?.resolutionTaskId).toBe("task-1"); // precedence 7
      expect(page2.nextCursor).toBeUndefined();

      expect(page1.queryCount).toBe(1);

      // Filters
      const forCandidate = listResolutionTasks(connection.database, { candidateId: "cand-1" });
      expect(forCandidate.ok).toBe(true);
      if (forCandidate.ok) {
        expect(forCandidate.value.items.length).toBe(3);
      }

      const openOnly = listResolutionTasks(connection.database, { status: "open" });
      expect(openOnly.ok).toBe(true);
    } finally {
      connection.close();
    }
  });

  it("handles client errors, bad cursors, and query errors in listResolutionTasks", async () => {
    const badClientDb = {};
    expect(listResolutionTasks(badClientDb).ok).toBe(false);
    expect(assertListResolutionTasksIndexPlan(badClientDb).ok).toBe(false);

    const connection = await openMigratedDatabase();
    try {
      const badCursorResult = listResolutionTasks(connection.database, { cursor: "invalid" });
      expect(badCursorResult.ok).toBe(false);

      const throwingDb = {
        $client: {
          prepare() {
            throw new Error("Simulated query failure");
          }
        }
      };
      expect(listResolutionTasks(throwingDb).ok).toBe(false);
      expect(assertListResolutionTasksIndexPlan(throwingDb).ok).toBe(false);
    } finally {
      connection.close();
    }
  });

  it("asserts index plan for listResolutionTasks", async () => {
    const connection = await openMigratedDatabase();
    try {
      const planResult = assertListResolutionTasksIndexPlan(connection.database);
      expect(planResult.ok).toBe(true);
      if (!planResult.ok) return;

      expect(planResult.value.steps.length).toBeGreaterThan(0);
      expect(planResult.value.usesCoveringOrIndexedScan).toBe(true);
    } finally {
      connection.close();
    }
  });
});

const AUDIT_PAYLOAD_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function insertCommandReceipt(
  nativeDb: BetterSqlite3.Database,
  commandId: string
): void {
  nativeDb
    .prepare(
      `INSERT INTO command_receipt (
        command_id, command_name, actor_id, expected_version, payload_hash, status,
        result_json, result_hash, error_code, error_message, created_at, completed_at
      ) VALUES (?, 'test.command', 'test-actor-1', 0, ?, 'in_progress', NULL, NULL, NULL, NULL, 1000, NULL)`
    )
    .run(commandId, AUDIT_PAYLOAD_HASH);
}

function appendTestAuditEvent(
  connection: RuntimeDatabaseConnection,
  input: {
    readonly auditEventId: string;
    readonly commandId?: string | null;
    readonly eventOrdinal?: number | null;
    readonly actorId?: string;
    readonly eventName?: string;
    readonly occurredAt: number;
    readonly payload?: unknown;
  }
): void {
  const prepared = prepareAuditEvent(
    { now: () => input.occurredAt },
    {
      auditEventId: input.auditEventId,
      commandId: input.commandId === undefined ? null : input.commandId,
      eventOrdinal: input.eventOrdinal === undefined ? null : input.eventOrdinal,
      actorId: input.actorId ?? "test-actor-1",
      actorDisplayName: "Test Operator",
      eventName: input.eventName ?? "test.event_recorded",
      eventVersion: 1,
      payload: input.payload ?? { id: input.auditEventId },
      occurredAt: input.occurredAt
    }
  );
  if (!prepared.ok) {
    throw new Error(prepared.error.message);
  }
  const appended = runImmediateTransaction(connection, (context) =>
    appendAuditEvent(context, prepared.value)
  );
  if (!appended.ok) {
    throw new Error(appended.error.message);
  }
}

describe("listAuditEvents Read Model", () => {
  it("returns empty page on clean database with queryCount = 1", async () => {
    const connection = await openMigratedDatabase();
    try {
      const result = listAuditEvents(connection.database);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.items.length).toBe(0);
      expect(result.value.nextCursor).toBeUndefined();
      expect(result.value.queryCount).toBe(1);
    } finally {
      connection.close();
    }
  });

  it("orders by timestamp, command id, ordinal, and event id descending", async () => {
    const connection = await openMigratedDatabase();
    const nativeDb = getNativeClient(connection);
    try {
      insertCommandReceipt(nativeDb, "cmd-b");
      insertCommandReceipt(nativeDb, "cmd-a");
      insertCommandReceipt(nativeDb, "cmd-old");

      appendTestAuditEvent(connection, {
        auditEventId: "evt-old",
        commandId: "cmd-old",
        eventOrdinal: 0,
        occurredAt: 1000,
        eventName: "test.older"
      });
      appendTestAuditEvent(connection, {
        auditEventId: "evt-unlinked-z",
        occurredAt: 2000,
        eventName: "test.unlinked_z"
      });
      appendTestAuditEvent(connection, {
        auditEventId: "evt-unlinked-a",
        occurredAt: 2000,
        eventName: "test.unlinked_a"
      });
      appendTestAuditEvent(connection, {
        auditEventId: "evt-cmdb-1",
        commandId: "cmd-b",
        eventOrdinal: 1,
        occurredAt: 2000,
        eventName: "test.cmd_b_one"
      });
      appendTestAuditEvent(connection, {
        auditEventId: "evt-cmdb-0",
        commandId: "cmd-b",
        eventOrdinal: 0,
        occurredAt: 2000,
        eventName: "test.cmd_b_zero"
      });
      appendTestAuditEvent(connection, {
        auditEventId: "evt-cmda-0",
        commandId: "cmd-a",
        eventOrdinal: 0,
        occurredAt: 2000,
        eventName: "test.cmd_a"
      });

      const listed = listAuditEvents(connection.database);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.queryCount).toBe(1);
      expect(listed.value.items.map((item) => item.auditEventId)).toEqual([
        "evt-cmdb-1",
        "evt-cmdb-0",
        "evt-cmda-0",
        "evt-unlinked-z",
        "evt-unlinked-a",
        "evt-old"
      ]);
      expect(listed.value.items[0]?.commandId).toBe("cmd-b");
      expect(listed.value.items[0]?.eventOrdinal).toBe(1);
      expect(listed.value.items[3]?.commandId).toBeNull();
      expect(listed.value.items[3]?.eventOrdinal).toBeNull();
    } finally {
      connection.close();
    }
  });

  it("paginates with a keyset cursor over the same tuple", async () => {
    const connection = await openMigratedDatabase();
    const nativeDb = getNativeClient(connection);
    try {
      insertCommandReceipt(nativeDb, "cmd-page");
      for (let ordinal = 0; ordinal < 4; ordinal += 1) {
        appendTestAuditEvent(connection, {
          auditEventId: `evt-page-${ordinal}`,
          commandId: "cmd-page",
          eventOrdinal: ordinal,
          occurredAt: 3000,
          eventName: "test.paged"
        });
      }

      const page1 = listAuditEvents(connection.database, { limit: 2 });
      expect(page1.ok).toBe(true);
      if (!page1.ok) return;
      expect(page1.value.items.map((item) => item.auditEventId)).toEqual([
        "evt-page-3",
        "evt-page-2"
      ]);
      expect(page1.value.nextCursor).toBeDefined();
      expect(page1.value.queryCount).toBe(1);

      const page2 = listAuditEvents(connection.database, {
        cursor: page1.value.nextCursor,
        limit: 2
      });
      expect(page2.ok).toBe(true);
      if (!page2.ok) return;
      expect(page2.value.items.map((item) => item.auditEventId)).toEqual([
        "evt-page-1",
        "evt-page-0"
      ]);
      expect(page2.value.nextCursor).toBeUndefined();
      expect(page2.value.queryCount).toBe(1);
    } finally {
      connection.close();
    }
  });

  it("handles client errors, bad cursors, and query errors", async () => {
    const badClientDb = {};
    expect(listAuditEvents(badClientDb).ok).toBe(false);
    expect(assertListAuditEventsIndexPlan(badClientDb).ok).toBe(false);

    const connection = await openMigratedDatabase();
    try {
      const badCursorResult = listAuditEvents(connection.database, { cursor: "invalid" });
      expect(badCursorResult.ok).toBe(false);

      const throwingDb = {
        $client: {
          prepare() {
            throw new Error("Simulated query failure");
          }
        }
      };
      expect(listAuditEvents(throwingDb).ok).toBe(false);
      expect(assertListAuditEventsIndexPlan(throwingDb).ok).toBe(false);
    } finally {
      connection.close();
    }
  });

  it("reports the index plan without requiring a covering scan", async () => {
    const connection = await openMigratedDatabase();
    try {
      const planResult = assertListAuditEventsIndexPlan(connection.database);
      expect(planResult.ok).toBe(true);
      if (!planResult.ok) return;
      expect(planResult.value.steps.length).toBeGreaterThan(0);
      expect(planResult.value.query).toContain("FROM audit_event");
    } finally {
      connection.close();
    }
  });
});

describe("readCandidatePacket Read Model", () => {
  it("returns not_found when candidate does not exist", async () => {
    const connection = await openMigratedDatabase();
    try {
      const result = readCandidatePacket(connection.database, "cand-nonexistent");
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("not_found");
      expect(result.error.message).toContain("Candidate packet not found");
    } finally {
      connection.close();
    }
  });

  it("returns not_found when candidate exists but decision pipeline has not triaged it (no candidate_head)", async () => {
    const connection = await openMigratedDatabase();
    const nativeDb = getNativeClient(connection);
    try {
      nativeDb.prepare(`
        INSERT INTO candidate (candidate_id, source_system, source_key, channel, corpus_tag, is_synthetic, created_at)
        VALUES ('cand-unprocessed', 'greenhouse', 'key-u', 'inbound', 'main', 1, 1000)
      `).run();

      const result = readCandidatePacket(connection.database, "cand-unprocessed");
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("not_found");
      expect(result.error.message).toContain("no triage result head written");
    } finally {
      connection.close();
    }
  });

  it("returns minimal candidate packet anchored to CandidateHead.currentResultId", async () => {
    const connection = await openMigratedDatabase();
    const nativeDb = getNativeClient(connection);

    try {
      // 1. Seed candidate
      nativeDb.prepare(`
        INSERT INTO candidate (candidate_id, source_system, source_key, channel, corpus_tag, is_synthetic, created_at)
        VALUES ('cand-1', 'system', 'k1', 'inbound', 'main', 1, 1000)
      `).run();

      // 2. Seed result
      nativeDb.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TRIGGER IF EXISTS candidate_result_seal_reject_incomplete;
      `);
      nativeDb.prepare(`
        INSERT INTO candidate_triage_result (candidate_triage_result_id, candidate_id, kind, availability, status, content_json, content_hash, seal_id, created_at)
        VALUES ('res-1', 'cand-1', 'initial', 'complete', 'scored', '{"summary":"test"}', 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', 'seal-1', 1000)
      `).run();
      nativeDb.prepare(`
        INSERT INTO candidate_head (candidate_id, current_result_id, version)
        VALUES ('cand-1', 'res-1', 1)
      `).run();

      const packetResult = readCandidatePacket(connection.database, "cand-1");
      expect(packetResult.ok).toBe(true);
      if (!packetResult.ok) return;

      const packet = packetResult.value;
      expect(packet.candidateId).toBe("cand-1");
      expect(packet.resultId).toBe("res-1");
      expect(packet.headVersion).toBe(1);
      expect(packet.resultStatus).toBe("scored");
      expect(packet.isSealed).toBe(false);
      expect(packet.scoreAggregateText).toBeNull();
      expect(packet.scoreConfidenceText).toBeNull();
      expect(packet.scoreAggregateBasisPoints).toBeNull();
      expect(packet.scoreConfidenceBasisPoints).toBeNull();
      expect(packet.confidenceInput).toBeNull();
      expect(packet.reasons).toEqual([]);

      nativeDb.prepare(`
        INSERT INTO score_result (
          score_result_id, candidate_result_id, aggregate_text, confidence_text,
          aggregate_basis_points, confidence_basis_points, content_json, content_hash, created_at
        ) VALUES (
          'score-valid', 'res-1', '1/2', '3/4', 5000, 7500,
          '{"contributions":[1,2,3,4,5,6],"confidenceInput":{"contradictionCount":0,"dimensionsWithLocatedSpan":6,"requiredFieldsMissing":2,"spansLocated":6,"spansReturned":6,"totalDimensions":6,"totalRequiredFields":4}}',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          1000
        )
      `).run();

      const scoredPacket = readCandidatePacket(connection.database, "cand-1");
      expect(scoredPacket.ok).toBe(true);
      if (scoredPacket.ok) {
        expect(scoredPacket.value.scoreAggregateText).toBe("1/2");
        expect(scoredPacket.value.scoreConfidenceText).toBe("3/4");
        expect(scoredPacket.value.scoreAggregateBasisPoints).toBe(5000);
        expect(scoredPacket.value.scoreConfidenceBasisPoints).toBe(7500);
        expect(scoredPacket.value.confidenceInput).toEqual({
          contradictionCount: 0,
          dimensionsWithLocatedSpan: 6,
          requiredFieldsMissing: 2,
          spansLocated: 6,
          spansReturned: 6,
          totalDimensions: 6,
          totalRequiredFields: 4
        });
      }

      nativeDb.exec("DROP TRIGGER IF EXISTS score_result_reject_update");
      const validScoreJson =
        '{"contributions":[1,2,3,4,5,6],"confidenceInput":{"contradictionCount":0,"dimensionsWithLocatedSpan":6,"requiredFieldsMissing":2,"spansLocated":6,"spansReturned":6,"totalDimensions":6,"totalRequiredFields":4}}';

      function expectConfidenceIntegrityFailure(contentJson: string): void {
        nativeDb.prepare(
          "UPDATE score_result SET content_json = ? WHERE score_result_id = 'score-valid'"
        ).run(contentJson);
        const packet = readCandidatePacket(connection.database, "cand-1");
        expect(packet.ok).toBe(false);
        if (packet.ok) return;
        expect(packet.error.code).toBe("persistence_failed");
        expect(packet.error.message).toBe("Stored score confidence input failed integrity validation");
      }

      expectConfidenceIntegrityFailure('{"contributions":[1,2,3,4,5,6]}');
      expectConfidenceIntegrityFailure('{"contributions":[1,2,3,4,5,6],"confidenceInput":null}');
      expectConfidenceIntegrityFailure('{"contributions":[1,2,3,4,5,6],"confidenceInput":[]}');
      expectConfidenceIntegrityFailure('{"contributions":[1,2,3,4,5,6],"confidenceInput":5}');
      expectConfidenceIntegrityFailure(
        '{"contributions":[1,2,3,4,5,6],"confidenceInput":{"contradictionCount":0}}'
      );
      expectConfidenceIntegrityFailure(
        '{"contributions":[1,2,3,4,5,6],"confidenceInput":{"contradictionCount":-1,"dimensionsWithLocatedSpan":6,"requiredFieldsMissing":2,"spansLocated":6,"spansReturned":6,"totalDimensions":6,"totalRequiredFields":4}}'
      );
      expectConfidenceIntegrityFailure(
        '{"contributions":[1,2,3,4,5,6],"confidenceInput":{"contradictionCount":0,"dimensionsWithLocatedSpan":6,"requiredFieldsMissing":2,"spansLocated":1.5,"spansReturned":6,"totalDimensions":6,"totalRequiredFields":4}}'
      );
      expectConfidenceIntegrityFailure(
        '{"contributions":[1,2,3,4,5,6],"confidenceInput":{"contradictionCount":0,"dimensionsWithLocatedSpan":6,"requiredFieldsMissing":2,"spansLocated":7,"spansReturned":6,"totalDimensions":6,"totalRequiredFields":4}}'
      );

      nativeDb.prepare(
        "UPDATE score_result SET content_json = ? WHERE score_result_id = 'score-valid'"
      ).run(validScoreJson);

      nativeDb.prepare(`
        INSERT INTO candidate_result_reason (
          candidate_result_reason_id, candidate_result_id, reason_kind, subject_id,
          reason_code, reason_ordinal, created_at
        ) VALUES (
          'reason-1', 'res-1', 'missing_evidence', 'years_experience',
          'missing_evidence:years_experience', 0, 1000
        )
      `).run();
      const withReasons = readCandidatePacket(connection.database, "cand-1");
      expect(withReasons.ok && withReasons.value.reasons).toEqual(["missing_evidence:years_experience"]);

      // Now seal the result and verify isSealed is true
      nativeDb.prepare(`
        INSERT INTO candidate_result_seal (candidate_result_seal_id, candidate_result_id, created_at)
        VALUES ('seal-1', 'res-1', 1000)
      `).run();

      const sealedResult = readCandidatePacket(connection.database, "cand-1");
      expect(sealedResult.ok).toBe(true);
      if (sealedResult.ok) {
        expect(sealedResult.value.isSealed).toBe(true);
      }
    } finally {
      connection.close();
    }
  });

  it("handles client errors, bad inputs, and missing candidate/result rows in readCandidatePacket", () => {
    // Bad candidateId
    const badIdEmpty = readCandidatePacket({}, "");
    expect(badIdEmpty.ok).toBe(false);
    if (!badIdEmpty.ok) {
      expect(badIdEmpty.error.code).toBe("persistence_failed");
    }

    const badIdWhitespace = readCandidatePacket({}, "   ");
    expect(badIdWhitespace.ok).toBe(false);
    if (!badIdWhitespace.ok) {
      expect(badIdWhitespace.error.code).toBe("persistence_failed");
    }

    // Bad database
    const badDbNull = readCandidatePacket(null, "cand-1");
    expect(badDbNull.ok).toBe(false);
    if (!badDbNull.ok) {
      expect(badDbNull.error.code).toBe("persistence_failed");
    }

    const badDbEmpty = readCandidatePacket({}, "cand-1");
    expect(badDbEmpty.ok).toBe(false);
    if (!badDbEmpty.ok) {
      expect(badDbEmpty.error.code).toBe("persistence_failed");
    }

    const badDbClientNull = readCandidatePacket({ $client: null }, "cand-1");
    expect(badDbClientNull.ok).toBe(false);
    if (!badDbClientNull.ok) {
      expect(badDbClientNull.error.code).toBe("persistence_failed");
    }

    const throwingDb = {
      $client: {
        prepare() {
          throw new Error("Simulated query failure");
        }
      }
    };
    const throwingRes = readCandidatePacket(throwingDb, "cand-1");
    expect(throwingRes.ok).toBe(false);
    if (!throwingRes.ok) {
      expect(throwingRes.error.code).toBe("persistence_failed");
    }

    // Mock where candidate/head query returns undefined
    const missingCandDb = {
      $client: {
        prepare() {
          return { get: () => undefined };
        }
      }
    };
    const missingCandRes = readCandidatePacket(missingCandDb, "c1");
    expect(missingCandRes.ok).toBe(false);
    if (!missingCandRes.ok) {
      expect(missingCandRes.error.code).toBe("not_found");
    }

    // Mock where candidate exists but head is null
    const missingHeadDb = {
      $client: {
        prepare() {
          return {
            get: () => ({
              candidateId: "c1",
              sourceSystem: "s",
              sourceKey: "k",
              channel: "inbound",
              corpusTag: "main",
              isSynthetic: 1,
              createdAt: 1000,
              headVersion: null,
              currentResultId: null
            })
          };
        }
      }
    };
    const missingHeadRes = readCandidatePacket(missingHeadDb, "c1");
    expect(missingHeadRes.ok).toBe(false);
    if (!missingHeadRes.ok) {
      expect(missingHeadRes.error.code).toBe("not_found");
    }

    // Mock where head and cand exist, but triage result returns undefined
    const missingResultDb = {
      $client: {
        prepare(sql: string) {
          if (sql.includes("FROM candidate c")) {
            return {
              get: () => ({
                candidateId: "c1",
                sourceSystem: "s",
                sourceKey: "k",
                channel: "inbound",
                corpusTag: "main",
                isSynthetic: 1,
                createdAt: 1000,
                headVersion: 1,
                currentResultId: "r1"
              })
            };
          }
          if (sql.includes("FROM candidate_triage_result")) {
            return { get: () => undefined };
          }
          return { get: () => ({ count: 0 }) };
        }
      }
    };
    const missingResultRes = readCandidatePacket(missingResultDb, "c1");
    expect(missingResultRes.ok).toBe(false);
    if (!missingResultRes.ok) {
      expect(missingResultRes.error.code).toBe("not_found");
    }
  });

  it("reads a historical result for the same candidate and rejects a foreign result", async () => {
    const connection = await openMigratedDatabase();
    const nativeDb = getNativeClient(connection);
    try {
      nativeDb.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TRIGGER IF EXISTS candidate_result_seal_reject_incomplete;
      `);
      nativeDb.prepare(`
        INSERT INTO candidate (candidate_id, source_system, source_key, channel, corpus_tag, is_synthetic, created_at)
        VALUES ('cand-hist', 'system', 'kh', 'inbound', 'main', 1, 1000),
               ('cand-other', 'system', 'ko', 'inbound', 'main', 1, 1000)
      `).run();
      nativeDb.prepare(`
        INSERT INTO candidate_triage_result (
          candidate_triage_result_id, candidate_id, kind, availability, status,
          supersedes_result_id, content_json, content_hash, seal_id, created_at
        )
        VALUES
          ('res-original', 'cand-hist', 'initial', 'unavailable', 'escalated', NULL, '{"summary":"original"}', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'seal-orig', 1000),
          ('res-correction', 'cand-hist', 'correction', 'complete', 'scored', 'res-original', '{"summary":"correction"}', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'seal-corr', 1100),
          ('res-foreign', 'cand-other', 'initial', 'complete', 'scored', NULL, '{"summary":"other"}', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'seal-other', 1000)
      `).run();
      nativeDb.prepare(`
        INSERT INTO candidate_head (candidate_id, current_result_id, version)
        VALUES ('cand-hist', 'res-correction', 1)
      `).run();

      const current = readCandidatePacket(connection.database, "cand-hist");
      expect(current.ok).toBe(true);
      if (current.ok) {
        expect(current.value.resultId).toBe("res-correction");
        expect(current.value.resultKind).toBe("correction");
        expect(current.value.headVersion).toBe(1);
      }

      const original = readCandidatePacket(connection.database, "cand-hist", {
        resultId: "res-original"
      });
      expect(original.ok).toBe(true);
      if (original.ok) {
        expect(original.value.resultId).toBe("res-original");
        expect(original.value.resultKind).toBe("initial");
        expect(original.value.resultAvailability).toBe("unavailable");
        expect(original.value.headVersion).toBe(1);
      }

      const foreign = readCandidatePacket(connection.database, "cand-hist", {
        resultId: "res-foreign"
      });
      expect(foreign.ok).toBe(false);
      if (!foreign.ok) {
        expect(foreign.error.code).toBe("not_found");
        expect(foreign.error.message).toContain("does not belong to candidate");
      }
    } finally {
      connection.close();
    }
  });
});

const PROPOSAL_PAYLOAD_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function seedProposalRow(
  nativeDb: BetterSqlite3.Database,
  input: {
    readonly proposalId: string;
    readonly candidateId: string;
    readonly resultId: string;
    readonly createdAt: number;
    readonly kind?: string;
    readonly ordinal?: number;
    readonly decisionKind?: string | null;
  }
): void {
  nativeDb
    .prepare(
      `INSERT INTO candidate (candidate_id, source_system, source_key, channel, corpus_tag, is_synthetic, created_at)
       VALUES (?, 'system', ?, 'inbound', 'main', 1, 1000)`
    )
    .run(input.candidateId, `key-${input.candidateId}`);
  nativeDb
    .prepare(
      `INSERT INTO candidate_triage_result (
         candidate_triage_result_id, candidate_id, kind, availability, status,
         content_json, content_hash, seal_id, created_at
       ) VALUES (?, ?, 'initial', 'complete', 'scored', '{}', ?, ?, 1000)`
    )
    .run(
      input.resultId,
      input.candidateId,
      `${input.resultId.replace(/[^0-9a-f]/gu, "a").padEnd(64, "a").slice(0, 64)}`,
      `seal-${input.resultId}`
    );
  nativeDb
    .prepare(
      `INSERT INTO proposal (
         proposal_id, candidate_result_id, proposal_kind, proposal_ordinal,
         payload_json, payload_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.proposalId,
      input.resultId,
      input.kind ?? "shortlist_inclusion",
      input.ordinal ?? 0,
      `{"kind":"${input.kind ?? "shortlist_inclusion"}"}`,
      PROPOSAL_PAYLOAD_HASH,
      input.createdAt
    );
  if (input.decisionKind) {
    nativeDb
      .prepare(
        `INSERT INTO review_decision (
           review_decision_id, proposal_id, actor_id, decision_kind, decision_ordinal,
           payload_json, payload_hash, created_at
         ) VALUES (?, ?, 'actor-1', ?, 0, ?, ?, ?)`
      )
      .run(
        `decision-${input.proposalId}`,
        input.proposalId,
        input.decisionKind,
        `{"kind":"${input.decisionKind}"}`,
        PROPOSAL_PAYLOAD_HASH,
        input.createdAt
      );
    nativeDb
      .prepare(
        `INSERT INTO proposal_head (proposal_id, current_decision_id, version)
         VALUES (?, ?, 1)`
      )
      .run(input.proposalId, `decision-${input.proposalId}`);
  }
}

describe("listProposals Read Model", () => {
  it("returns empty page on clean database with queryCount = 1", async () => {
    const connection = await openMigratedDatabase();
    try {
      const result = listProposals(connection.database);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.items.length).toBe(0);
      expect(result.value.nextCursor).toBeUndefined();
      expect(result.value.queryCount).toBe(1);
    } finally {
      connection.close();
    }
  });

  it("orders by createdAt then proposalId and paginates with a keyset cursor", async () => {
    const connection = await openMigratedDatabase();
    const nativeDb = getNativeClient(connection);
    try {
      nativeDb.pragma("foreign_keys = OFF");
      seedProposalRow(nativeDb, {
        proposalId: "prop-b",
        candidateId: "cand-1",
        resultId: "res-1",
        createdAt: 1000
      });
      seedProposalRow(nativeDb, {
        proposalId: "prop-a",
        candidateId: "cand-2",
        resultId: "res-2",
        createdAt: 1000
      });
      seedProposalRow(nativeDb, {
        proposalId: "prop-c",
        candidateId: "cand-3",
        resultId: "res-3",
        createdAt: 2000,
        decisionKind: "approve"
      });

      const page1 = listProposals(connection.database, { limit: 2 });
      expect(page1.ok).toBe(true);
      if (!page1.ok) return;
      expect(page1.value.queryCount).toBe(1);
      expect(page1.value.items.map((item) => item.proposalId)).toEqual(["prop-a", "prop-b"]);
      expect(page1.value.items[0]?.status).toBe("pending");
      expect(page1.value.items[0]?.version).toBe(0);
      expect(page1.value.items[0]?.proposedChange).toBe("shortlist_inclusion");
      expect(page1.value.nextCursor).toBeDefined();

      const page2 = listProposals(connection.database, {
        cursor: page1.value.nextCursor,
        limit: 2
      });
      expect(page2.ok).toBe(true);
      if (!page2.ok) return;
      expect(page2.value.items.map((item) => item.proposalId)).toEqual(["prop-c"]);
      expect(page2.value.items[0]?.status).toBe("approved");
      expect(page2.value.items[0]?.version).toBe(1);
      expect(page2.value.nextCursor).toBeUndefined();

      const forCandidate = listProposals(connection.database, { candidateId: "cand-1" });
      expect(forCandidate.ok).toBe(true);
      if (forCandidate.ok) {
        expect(forCandidate.value.items.map((item) => item.proposalId)).toEqual(["prop-b"]);
      }

      const pendingOnly = listProposals(connection.database, { status: "pending" });
      expect(pendingOnly.ok).toBe(true);
      if (pendingOnly.ok) {
        expect(pendingOnly.value.items.map((item) => item.proposalId)).toEqual([
          "prop-a",
          "prop-b"
        ]);
      }

      const approvedOnly = listProposals(connection.database, { status: "approved" });
      expect(approvedOnly.ok).toBe(true);
      if (approvedOnly.ok) {
        expect(approvedOnly.value.items.map((item) => item.proposalId)).toEqual(["prop-c"]);
      }
    } finally {
      connection.close();
    }
  });

  it("derives edited, rejected, and evidence_requested from the current review decision", async () => {
    const connection = await openMigratedDatabase();
    const nativeDb = getNativeClient(connection);
    try {
      nativeDb.pragma("foreign_keys = OFF");
      seedProposalRow(nativeDb, {
        proposalId: "prop-edit",
        candidateId: "cand-edit",
        resultId: "res-edit",
        createdAt: 3000,
        decisionKind: "edit"
      });
      seedProposalRow(nativeDb, {
        proposalId: "prop-reject",
        candidateId: "cand-reject",
        resultId: "res-reject",
        createdAt: 4000,
        decisionKind: "reject"
      });
      seedProposalRow(nativeDb, {
        proposalId: "prop-evidence",
        candidateId: "cand-evidence",
        resultId: "res-evidence",
        createdAt: 5000,
        decisionKind: "request_evidence"
      });

      const edited = listProposals(connection.database, { status: "edited" });
      expect(edited.ok).toBe(true);
      if (edited.ok) {
        expect(edited.value.items.map((item) => [item.proposalId, item.status])).toEqual([
          ["prop-edit", "edited"]
        ]);
        expect(edited.value.items[0]?.version).toBe(1);
      }

      const rejected = listProposals(connection.database, { status: "rejected" });
      expect(rejected.ok).toBe(true);
      if (rejected.ok) {
        expect(rejected.value.items.map((item) => [item.proposalId, item.status])).toEqual([
          ["prop-reject", "rejected"]
        ]);
      }

      const evidence = listProposals(connection.database, { status: "evidence_requested" });
      expect(evidence.ok).toBe(true);
      if (evidence.ok) {
        expect(evidence.value.items.map((item) => [item.proposalId, item.status])).toEqual([
          ["prop-evidence", "evidence_requested"]
        ]);
      }
    } finally {
      connection.close();
    }
  });

  it("handles client errors, bad cursors, invalid status, query errors, and unknown decision kinds", async () => {
    const badClientDb = {};
    expect(listProposals(badClientDb).ok).toBe(false);
    expect(assertListProposalsIndexPlan(badClientDb).ok).toBe(false);

    const connection = await openMigratedDatabase();
    try {
      const badCursorResult = listProposals(connection.database, { cursor: "invalid" });
      expect(badCursorResult.ok).toBe(false);

      const invalidStatus = listProposals(connection.database, {
        status: "not-a-status" as never
      });
      expect(invalidStatus.ok).toBe(false);

      const throwingDb = {
        $client: {
          prepare() {
            throw new Error("Simulated query failure");
          }
        }
      };
      expect(listProposals(throwingDb).ok).toBe(false);
      expect(assertListProposalsIndexPlan(throwingDb).ok).toBe(false);

      const unknownKindDb = {
        $client: {
          prepare() {
            return {
              all: () => [
                {
                  proposalId: "prop-unknown",
                  candidateId: "cand-1",
                  candidateResultId: "res-1",
                  proposalOrdinal: 0,
                  proposalKind: "shortlist_inclusion",
                  createdAt: 1,
                  currentDecisionKind: "not-a-kind",
                  headVersion: 0
                }
              ]
            };
          }
        }
      };
      const unknownKind = listProposals(unknownKindDb);
      expect(unknownKind.ok).toBe(true);
      if (unknownKind.ok) {
        expect(unknownKind.value.items[0]?.status).toBe("pending");
      }
    } finally {
      connection.close();
    }
  });

  it("asserts the index plan for listProposals", async () => {
    const connection = await openMigratedDatabase();
    try {
      const planResult = assertListProposalsIndexPlan(connection.database);
      expect(planResult.ok).toBe(true);
      if (!planResult.ok) return;
      expect(planResult.value.steps.length).toBeGreaterThan(0);
      expect(planResult.value.query).toContain("FROM proposal");
    } finally {
      connection.close();
    }
  });
});
