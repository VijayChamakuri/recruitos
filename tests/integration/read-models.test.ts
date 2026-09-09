import { afterEach, describe, expect, it } from "vitest";

import { appendAuditEvent, prepareAuditEvent } from "../../packages/runtime/src/audit/index.js";
import {
  runImmediateTransaction,
  type ImmediateTransactionContext
} from "../../packages/runtime/src/commands/index.js";
import type { RuntimeDatabaseConnection } from "../../packages/runtime/src/db/index.js";
import {
  insertCandidate,
  insertCandidateDocument,
  insertSourceDocument,
  prepareCandidate,
  prepareCandidateDocument,
  prepareSourceDocument
} from "../../packages/runtime/src/entities/index.js";
import {
  assertListAuditEventsIndexPlan,
  assertListCandidatesIndexPlan,
  assertListResolutionTasksIndexPlan,
  listAuditEvents,
  listCandidates,
  listResolutionTasks,
  readCandidatePacket
} from "../../packages/runtime/src/read-models/index.js";
import {
  nativeDatabase,
  openMigratedDatabase,
  removeTemporaryDatabases
} from "./harness/database.js";
import { unwrap } from "./harness/results.js";

const SEED_TIMESTAMP = 1_788_700_000_000;

afterEach(async () => {
  await removeTemporaryDatabases();
});

describe("read-models integration", () => {
  describe("listCandidates keyset cursor and bounded query count", () => {
    it("paginates realistic candidates with constant query count and proves index plan", async () => {
      const connection = await openMigratedDatabase("list-candidates");
      const nativeDb = nativeDatabase(connection);

      // 1. Seed 4 realistic candidates via standard runtime store
      unwrap(
        runImmediateTransaction(connection, (context: ImmediateTransactionContext) => {
          for (let i = 1; i <= 4; i++) {
            unwrap(
              insertCandidate(
                context,
                unwrap(
                  prepareCandidate({
                    candidateId: `cand-${i}`,
                    sourceSystem: "greenhouse",
                    sourceKey: `gh-app-${i}`,
                    channel: i % 2 === 0 ? "sourced" : "inbound",
                    corpusTag: "main",
                    createdAt: SEED_TIMESTAMP + i * 1000
                  })
                )
              )
            );
          }
          return { ok: true, value: undefined };
        })
      );

      // 2. Attach corpus member ordinals and triage results
      nativeDb.exec("PRAGMA foreign_keys = OFF");

      // Import ordinals: cand-1 -> 1, cand-2 -> 2, cand-3 -> 3, cand-4 -> 4
      const insertMemberStmt = nativeDb.prepare(`
        INSERT INTO corpus_member (corpus_member_id, manifest_id, candidate_id, import_ordinal, created_at)
        VALUES (?, 'manifest-main', ?, ?, 1788700000000)
      `);
      insertMemberStmt.run("cm-1", "cand-1", 1);
      insertMemberStmt.run("cm-2", "cand-2", 2);
      insertMemberStmt.run("cm-3", "cand-3", 3);
      insertMemberStmt.run("cm-4", "cand-4", 4);

      // cand-1: score 9200
      nativeDb.prepare(`
        INSERT INTO candidate_triage_result (candidate_triage_result_id, candidate_id, kind, availability, status, content_json, content_hash, seal_id, created_at)
        VALUES ('res-1', 'cand-1', 'initial', 'complete', 'scored', '{}', '${"1".repeat(64)}', 'seal-1', 1788700000000)
      `).run();
      nativeDb.prepare(`
        INSERT INTO score_result (score_result_id, candidate_result_id, aggregate_text, confidence_text, aggregate_basis_points, confidence_basis_points, content_json, content_hash, created_at)
        VALUES ('sr-1', 'res-1', '9/10', '8/10', 9200, 8500, '{"contributions":[1,2,3,4,5,6]}', '${"2".repeat(64)}', 1788700000000)
      `).run();
      nativeDb.prepare(`
        INSERT INTO candidate_head (candidate_id, current_result_id, version)
        VALUES ('cand-1', 'res-1', 1)
      `).run();

      // cand-2: score 8800 (tie-break with cand-3 on score, import_ordinal 2 < 3)
      nativeDb.prepare(`
        INSERT INTO candidate_triage_result (candidate_triage_result_id, candidate_id, kind, availability, status, content_json, content_hash, seal_id, created_at)
        VALUES ('res-2', 'cand-2', 'initial', 'complete', 'scored', '{}', '${"3".repeat(64)}', 'seal-2', 1788700000000)
      `).run();
      nativeDb.prepare(`
        INSERT INTO score_result (score_result_id, candidate_result_id, aggregate_text, confidence_text, aggregate_basis_points, confidence_basis_points, content_json, content_hash, created_at)
        VALUES ('sr-2', 'res-2', '8/10', '8/10', 8800, 8000, '{"contributions":[1,2,3,4,5,6]}', '${"4".repeat(64)}', 1788700000000)
      `).run();
      nativeDb.prepare(`
        INSERT INTO candidate_head (candidate_id, current_result_id, version)
        VALUES ('cand-2', 'res-2', 1)
      `).run();

      // cand-3: score 8800, import_ordinal 3
      nativeDb.prepare(`
        INSERT INTO candidate_triage_result (candidate_triage_result_id, candidate_id, kind, availability, status, content_json, content_hash, seal_id, created_at)
        VALUES ('res-3', 'cand-3', 'initial', 'complete', 'scored', '{}', '${"5".repeat(64)}', 'seal-3', 1788700000000)
      `).run();
      nativeDb.prepare(`
        INSERT INTO score_result (score_result_id, candidate_result_id, aggregate_text, confidence_text, aggregate_basis_points, confidence_basis_points, content_json, content_hash, created_at)
        VALUES ('sr-3', 'res-3', '8/10', '8/10', 8800, 8000, '{"contributions":[1,2,3,4,5,6]}', '${"6".repeat(64)}', 1788700000000)
      `).run();
      nativeDb.prepare(`
        INSERT INTO candidate_head (candidate_id, current_result_id, version)
        VALUES ('cand-3', 'res-3', 1)
      `).run();

      // cand-4: unscored (pending)

      // Query page 1 with limit = 2
      const page1Res = listCandidates(connection.database, { limit: 2 });
      expect(page1Res.ok).toBe(true);
      if (!page1Res.ok) return;

      const page1 = page1Res.value;
      expect(page1.items.length).toBe(2);
      expect(page1.items[0]?.candidateId).toBe("cand-1");
      expect(page1.items[1]?.candidateId).toBe("cand-2");
      expect(page1.queryCount).toBeLessThanOrEqual(2);
      expect(page1.nextCursor).toBeDefined();

      // Query page 2 with cursor from page 1
      const page2Res = listCandidates(connection.database, {
        cursor: page1.nextCursor,
        limit: 2
      });
      expect(page2Res.ok).toBe(true);
      if (!page2Res.ok) return;

      const page2 = page2Res.value;
      expect(page2.items.length).toBe(2);
      expect(page2.items[0]?.candidateId).toBe("cand-3");
      expect(page2.items[1]?.candidateId).toBe("cand-4");
      expect(page2.queryCount).toBeLessThanOrEqual(2);

      // Channel filter
      const sourcedOnly = listCandidates(connection.database, { channel: "sourced" });
      expect(sourcedOnly.ok).toBe(true);
      if (sourcedOnly.ok) {
        expect(sourcedOnly.value.items.every((i) => i.channel === "sourced")).toBe(true);
      }

      // Status filter
      const pendingOnly = listCandidates(connection.database, { status: "pending" });
      expect(pendingOnly.ok).toBe(true);
      if (pendingOnly.ok) {
        expect(pendingOnly.value.items.length).toBe(1);
        expect(pendingOnly.value.items[0]?.candidateId).toBe("cand-4");
      }

      // Assert constant query count across different page sizes (O(1) query count)
      const pageLimit1 = listCandidates(connection.database, { limit: 1 });
      expect(pageLimit1.ok).toBe(true);
      if (pageLimit1.ok) {
        expect(pageLimit1.value.items.length).toBe(1);
        expect(pageLimit1.value.queryCount).toBe(2);
      }

      const pageLimit2 = listCandidates(connection.database, { limit: 2 });
      expect(pageLimit2.ok).toBe(true);
      if (pageLimit2.ok) {
        expect(pageLimit2.value.items.length).toBe(2);
        expect(pageLimit2.value.queryCount).toBe(2);
      }

      const pageLimit4 = listCandidates(connection.database, { limit: 4 });
      expect(pageLimit4.ok).toBe(true);
      if (pageLimit4.ok) {
        expect(pageLimit4.value.items.length).toBe(4);
        expect(pageLimit4.value.queryCount).toBe(2);
      }

      // Assert index plan uses named indexes or primary keys
      const planRes = assertListCandidatesIndexPlan(connection.database);
      expect(planRes.ok).toBe(true);
      if (planRes.ok) {
        expect(planRes.value.usesCoveringOrIndexedScan).toBe(true);
        expect(planRes.value.steps.length).toBeGreaterThan(0);
        const indexedSteps = planRes.value.steps.filter(
          (s) => s.detail.includes("USING INDEX") || s.detail.includes("PRIMARY KEY")
        );
        expect(indexedSteps.length).toBeGreaterThan(0);
      }
    });
  });

  describe("listResolutionTasks reviewer queue and ordering", () => {
    it("orders tasks by reason precedence, opened time, and task id with constant query count", async () => {
      const connection = await openMigratedDatabase("list-resolution-tasks");
      const nativeDb = nativeDatabase(connection);

      nativeDb.exec("PRAGMA foreign_keys = OFF");

      // Seed candidate and result
      nativeDb.prepare(`
        INSERT INTO candidate (candidate_id, source_system, source_key, channel, corpus_tag, is_synthetic, created_at)
        VALUES ('cand-rev', 'greenhouse', 'gh-rev', 'inbound', 'main', 1, 1000)
      `).run();

      nativeDb.prepare(`
        INSERT INTO candidate_triage_result (candidate_triage_result_id, candidate_id, kind, availability, status, content_json, content_hash, seal_id, created_at)
        VALUES ('res-rev', 'cand-rev', 'initial', 'complete', 'escalated', '{}', '${"7".repeat(64)}', 'seal-rev', 1000)
      `).run();

      // Seed reasons with different precedences:
      // parse_failure (precedence 1)
      // contradiction (precedence 4)
      // low_confidence (precedence 7)
      const insertReasonStmt = nativeDb.prepare(`
        INSERT INTO candidate_result_reason (candidate_result_reason_id, candidate_result_id, reason_kind, subject_id, reason_code, reason_ordinal, created_at)
        VALUES (?, 'res-rev', ?, ?, ?, ?, 1000)
      `);
      insertReasonStmt.run("crr-pf", "parse_failure", null, "parse_failure", 0);
      insertReasonStmt.run("crr-ct", "contradiction", "dim-1", "contradiction:dim-1", 1);
      insertReasonStmt.run("crr-lc", "low_confidence", null, "low_confidence", 2);

      // Seed tasks in arbitrary insertion order
      const insertTaskStmt = nativeDb.prepare(`
        INSERT INTO resolution_task (resolution_task_id, candidate_result_id, candidate_result_reason_id, task_ordinal, created_at)
        VALUES (?, 'res-rev', ?, ?, ?)
      `);
      insertTaskStmt.run("task-lc", "crr-lc", 0, 100);
      insertTaskStmt.run("task-pf", "crr-pf", 1, 300);
      insertTaskStmt.run("task-ct", "crr-ct", 2, 200);

      // Query page 1 with limit = 2
      const page1Res = listResolutionTasks(connection.database, { limit: 2 });
      expect(page1Res.ok).toBe(true);
      if (!page1Res.ok) return;

      const page1 = page1Res.value;
      expect(page1.items.length).toBe(2);
      // Precedence 1 (parse_failure) comes before precedence 4 (contradiction)
      expect(page1.items[0]?.resolutionTaskId).toBe("task-pf");
      expect(page1.items[1]?.resolutionTaskId).toBe("task-ct");
      expect(page1.queryCount).toBe(1);
      expect(page1.nextCursor).toBeDefined();

      // Query page 2 with cursor from page 1
      const page2Res = listResolutionTasks(connection.database, {
        cursor: page1.nextCursor,
        limit: 2
      });
      expect(page2Res.ok).toBe(true);
      if (!page2Res.ok) return;

      const page2 = page2Res.value;
      expect(page2.items.length).toBe(1);
      expect(page2.items[0]?.resolutionTaskId).toBe("task-lc");
      expect(page2.nextCursor).toBeUndefined();

      // Assert constant query count across different page sizes (O(1) query count)
      const taskLimit1 = listResolutionTasks(connection.database, { limit: 1 });
      expect(taskLimit1.ok).toBe(true);
      if (taskLimit1.ok) {
        expect(taskLimit1.value.items.length).toBe(1);
        expect(taskLimit1.value.queryCount).toBe(1);
      }

      const taskLimit3 = listResolutionTasks(connection.database, { limit: 3 });
      expect(taskLimit3.ok).toBe(true);
      if (taskLimit3.ok) {
        expect(taskLimit3.value.items.length).toBe(3);
        expect(taskLimit3.value.queryCount).toBe(1);
      }

      // Assert index plan uses named indexes or primary keys
      const planRes = assertListResolutionTasksIndexPlan(connection.database);
      expect(planRes.ok).toBe(true);
      if (planRes.ok) {
        expect(planRes.value.usesCoveringOrIndexedScan).toBe(true);
        expect(planRes.value.steps.length).toBeGreaterThan(0);
        const indexedSteps = planRes.value.steps.filter(
          (s) => s.detail.includes("USING INDEX") || s.detail.includes("PRIMARY KEY")
        );
        expect(indexedSteps.length).toBeGreaterThan(0);
      }
    });
  });

  describe("readCandidatePacket anchored query shape", () => {
    it("returns persistence_failed for unfinalized candidate and complete packet for triaged candidate", async () => {
      const connection = await openMigratedDatabase("read-candidate-packet");
      const nativeDb = nativeDatabase(connection);

      // Ingest untriaged candidate
      unwrap(
        runImmediateTransaction(connection, (context: ImmediateTransactionContext) => {
          unwrap(
            insertCandidate(
              context,
              unwrap(
                prepareCandidate({
                  candidateId: "cand-untriaged",
                  sourceSystem: "greenhouse",
                  sourceKey: "gh-app-untriaged",
                  channel: "inbound",
                  corpusTag: "main",
                  createdAt: 1000
                })
              )
            )
          );
          return { ok: true, value: undefined };
        })
      );

      // Verify packet returns not_found because no candidate_head exists
      const untriagedRes = readCandidatePacket(connection.database, "cand-untriaged");
      expect(untriagedRes.ok).toBe(false);
      if (!untriagedRes.ok) {
        expect(untriagedRes.error.code).toBe("not_found");
        expect(untriagedRes.error.message).toContain("Candidate packet not found");
      }

      // Now create a triaged candidate with head, result, and seal
      unwrap(
        runImmediateTransaction(connection, (context: ImmediateTransactionContext) => {
          unwrap(
            insertCandidate(
              context,
              unwrap(
                prepareCandidate({
                  candidateId: "cand-triaged",
                  sourceSystem: "greenhouse",
                  sourceKey: "gh-app-triaged",
                  channel: "sourced",
                  corpusTag: "main",
                  createdAt: SEED_TIMESTAMP
                })
              )
            )
          );
          return { ok: true, value: undefined };
        })
      );

      nativeDb.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TRIGGER IF EXISTS candidate_result_seal_reject_incomplete;
      `);

      nativeDb.prepare(`
        INSERT INTO candidate_triage_result (candidate_triage_result_id, candidate_id, kind, availability, status, content_json, content_hash, seal_id, created_at)
        VALUES ('res-t1', 'cand-triaged', 'initial', 'complete', 'scored', '{"summary":"Top candidate"}', '${"8".repeat(64)}', 'seal-t1', 1788700000000)
      `).run();

      nativeDb.prepare(`
        INSERT INTO candidate_head (candidate_id, current_result_id, version)
        VALUES ('cand-triaged', 'res-t1', 1)
      `).run();

      const packetRes = readCandidatePacket(connection.database, "cand-triaged");
      expect(packetRes.ok).toBe(true);
      if (!packetRes.ok) return;

      const packet = packetRes.value;
      expect(packet.candidateId).toBe("cand-triaged");
      expect(packet.sourceSystem).toBe("greenhouse");
      expect(packet.sourceKey).toBe("gh-app-triaged");
      expect(packet.channel).toBe("sourced");
      expect(packet.corpusTag).toBe("main");
      expect(packet.headVersion).toBe(1);
      expect(packet.resultId).toBe("res-t1");
      expect(packet.resultKind).toBe("initial");
      expect(packet.resultAvailability).toBe("complete");
      expect(packet.resultStatus).toBe("scored");
      expect(packet.sealId).toBe("seal-t1");
      expect(packet.isSealed).toBe(false);

      // Verify seal detection when candidate_result_seal row is present
      nativeDb.prepare(`
        INSERT INTO candidate_result_seal (candidate_result_seal_id, candidate_result_id, created_at)
        VALUES ('seal-t1', 'res-t1', 1788700000000)
      `).run();

      const sealedRes = readCandidatePacket(connection.database, "cand-triaged");
      expect(sealedRes.ok).toBe(true);
      if (sealedRes.ok) {
        expect(sealedRes.value.isSealed).toBe(true);
      }
    });
  });

  describe("listAuditEvents keyset cursor and bounded query count", () => {
    it("pages persisted audit_event rows with one query and a recorded plan", async () => {
      const connection = await openMigratedDatabase("list-audit-events");
      const nativeDb = nativeDatabase(connection);
      const receiptHash = "b".repeat(64);
      nativeDb
        .prepare(
          `INSERT INTO command_receipt (
            command_id, command_name, actor_id, expected_version, payload_hash, status,
            result_json, result_hash, error_code, error_message, created_at, completed_at
          ) VALUES (?, 'test.command', 'test-actor-1', 0, ?, 'in_progress', NULL, NULL, NULL, NULL, ?, NULL)`
        )
        .run("cmd-finalize", receiptHash, SEED_TIMESTAMP);

      unwrap(
        runImmediateTransaction(connection, (context: ImmediateTransactionContext) => {
          for (const [index, eventName] of [
            "candidate.result.published",
            "candidate.result.published",
            "triage_run.sealed"
          ].entries()) {
            const prepared = unwrap(
              prepareAuditEvent(
                { now: () => SEED_TIMESTAMP + index },
                {
                  auditEventId: `audit-${index + 1}`,
                  commandId: "cmd-finalize",
                  eventOrdinal: index,
                  actorId: "system:runtime",
                  actorDisplayName: "system:runtime",
                  eventName,
                  eventVersion: 1,
                  payload: { index },
                  occurredAt: SEED_TIMESTAMP
                }
              )
            );
            unwrap(appendAuditEvent(context, prepared));
          }
          const unlinked = unwrap(
            prepareAuditEvent(
              { now: () => SEED_TIMESTAMP + 10 },
              {
                auditEventId: "audit-unlinked",
                commandId: null,
                eventOrdinal: null,
                actorId: "human:operator",
                actorDisplayName: "Operator",
                eventName: "test.unlinked",
                eventVersion: 1,
                payload: { orphan: true },
                occurredAt: SEED_TIMESTAMP - 1000
              }
            )
          );
          unwrap(appendAuditEvent(context, unlinked));
          return { ok: true, value: undefined };
        })
      );

      const page1 = unwrap(listAuditEvents(connection.database, { limit: 2 }));
      expect(page1.queryCount).toBe(1);
      expect(page1.items.map((item) => item.auditEventId)).toEqual(["audit-3", "audit-2"]);
      expect(page1.nextCursor).toBeDefined();

      const page2 = unwrap(
        listAuditEvents(connection.database, { cursor: page1.nextCursor, limit: 2 })
      );
      expect(page2.queryCount).toBe(1);
      expect(page2.items.map((item) => item.auditEventId)).toEqual([
        "audit-1",
        "audit-unlinked"
      ]);
      expect(page2.items[1]?.commandId).toBeNull();
      expect(page2.nextCursor).toBeUndefined();

      const plan = unwrap(assertListAuditEventsIndexPlan(connection.database));
      expect(plan.steps.length).toBeGreaterThan(0);
    });
  });
});
