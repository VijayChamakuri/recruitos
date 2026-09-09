import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ok, type Result } from "@recruitos/core";
import {
  DEFAULT_PAGE_SIZE,
  insertActor,
  insertCandidateResultReason,
  insertResolutionAction,
  insertResolutionTask,
  listResolutionTasks,
  prepareActor,
  prepareCandidateResultReason,
  prepareResolutionAction,
  prepareResolutionTask,
  runImmediateTransaction,
  type RuntimeError
} from "@recruitos/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../cli.js";
import { EXIT_SUCCESS } from "../exit-codes.js";
import {
  createDemoRuntimeComposition,
  loadCandidatePacketSnapshot,
  readCandidatePacketSnapshotParts,
  RuntimeRecruitosComposition
} from "./index.js";

const OUTSTANDING_TASK_ID = "packet-task-outstanding";
const temporaryDirectories: string[] = [];
const requireBetterSqlite = createRequire(
  fileURLToPath(new URL("../../../../packages/runtime/package.json", import.meta.url))
);
const BetterSqlite3 = requireBetterSqlite("better-sqlite3") as {
  new (
    filename: string,
    options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number }
  ): {
    pragma: (source: string) => unknown;
    prepare: (sql: string) => {
      get: (...params: readonly unknown[]) => unknown;
      run: (...params: readonly unknown[]) => unknown;
    };
    close: () => void;
  };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function preparedDemo(): Promise<{
  filename: string;
  composition: RuntimeRecruitosComposition;
}> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-packet-snapshot-"));
  temporaryDirectories.push(directory);
  const filename = join(directory, "runtime.db");
  const created = createDemoRuntimeComposition(filename);
  expect(created.ok).toBe(true);
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  const composition = created.value as RuntimeRecruitosComposition;
  const prepared = await composition.prepareDemo({});
  expect(prepared.ok).toBe(true);
  return { filename, composition };
}

function unwrap<T>(result: Result<T, RuntimeError>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function nativeClient(composition: RuntimeRecruitosComposition): {
  prepare: (sql: string) => {
    get: (...params: readonly unknown[]) => unknown;
    all: (...params: readonly unknown[]) => unknown[];
  };
} {
  const database = composition.runtime.connection.database as {
    $client?: {
      prepare: (sql: string) => {
        get: (...params: readonly unknown[]) => unknown;
        all: (...params: readonly unknown[]) => unknown[];
      };
    };
  };
  if (database.$client === undefined) {
    throw new Error("Native database client is unavailable");
  }
  return database.$client;
}

function candidateForSource(
  composition: RuntimeRecruitosComposition,
  sourceKey: string
): { candidateId: string; resultId: string } {
  const row = nativeClient(composition)
    .prepare(
      `SELECT
         candidate.candidate_id AS candidateId,
         candidate_head.current_result_id AS resultId
       FROM candidate
       JOIN candidate_head ON candidate_head.candidate_id = candidate.candidate_id
       WHERE candidate.source_key = ?`
    )
    .get(sourceKey) as { candidateId: string; resultId: string } | undefined;
  if (row === undefined) {
    throw new Error(`No candidate for ${sourceKey}`);
  }
  return row;
}

function nextOrdinals(
  composition: RuntimeRecruitosComposition,
  resultId: string
): { reasonOrdinal: number; taskOrdinal: number } {
  const row = nativeClient(composition)
    .prepare(
      `SELECT
         COALESCE(
           (SELECT MAX(reason_ordinal) FROM candidate_result_reason WHERE candidate_result_id = ?),
           -1
         ) AS maxReasonOrdinal,
         COALESCE(
           (SELECT MAX(task_ordinal) FROM resolution_task WHERE candidate_result_id = ?),
           -1
         ) AS maxTaskOrdinal`
    )
    .get(resultId, resultId) as { maxReasonOrdinal: number; maxTaskOrdinal: number };
  return {
    reasonOrdinal: row.maxReasonOrdinal + 1,
    taskOrdinal: row.maxTaskOrdinal + 1
  };
}

function seedFiftyDismissedTasksAndOneOutstanding(
  composition: RuntimeRecruitosComposition,
  resultId: string
): void {
  const start = nextOrdinals(composition, resultId);
  const seeded = runImmediateTransaction(composition.runtime.connection, (context) => {
    unwrap(
      insertActor(
        context,
        unwrap(
          prepareActor({
            actorId: "human:packet-page-test",
            displayName: "Packet page test",
            createdAt: 1
          })
        )
      )
    );
    for (let index = 0; index < DEFAULT_PAGE_SIZE; index += 1) {
      const subject = `pad-${String(index).padStart(2, "0")}`;
      const reason = unwrap(
        prepareCandidateResultReason({
          candidateResultReasonId: `packet-reason-${subject}`,
          candidateResultId: resultId,
          reasonCode: `missing_evidence:${subject}`,
          reasonOrdinal: start.reasonOrdinal + index,
          createdAt: 2
        })
      );
      unwrap(insertCandidateResultReason(context, reason));
      const task = unwrap(
        prepareResolutionTask({
          resolutionTaskId: `packet-task-${subject}`,
          candidateResultId: resultId,
          candidateResultReasonId: reason.candidateResultReasonId,
          taskOrdinal: start.taskOrdinal + index,
          createdAt: 2
        })
      );
      unwrap(insertResolutionTask(context, task));
      unwrap(
        insertResolutionAction(
          context,
          unwrap(
            prepareResolutionAction({
              resolutionActionId: `packet-action-${subject}`,
              resolutionTaskId: task.resolutionTaskId,
              actorId: "human:packet-page-test",
              actionOrdinal: 0,
              payload: { kind: "dismiss", rationale: "Filler task for packet page one" },
              createdAt: 3
            })
          ),
          0
        )
      );
    }
    const outstandingReason = unwrap(
      prepareCandidateResultReason({
        candidateResultReasonId: "packet-reason-outstanding",
        candidateResultId: resultId,
        reasonCode: "missing_evidence:outstanding-page-two",
        reasonOrdinal: start.reasonOrdinal + DEFAULT_PAGE_SIZE,
        createdAt: 3
      })
    );
    unwrap(insertCandidateResultReason(context, outstandingReason));
    unwrap(
      insertResolutionTask(
        context,
        unwrap(
          prepareResolutionTask({
            resolutionTaskId: OUTSTANDING_TASK_ID,
            candidateResultId: resultId,
            candidateResultReasonId: outstandingReason.candidateResultReasonId,
            taskOrdinal: start.taskOrdinal + DEFAULT_PAGE_SIZE,
            createdAt: 3
          })
        )
      )
    );
    return ok(undefined);
  });
  unwrap(seeded);
}

function pointHeadAt(
  writer: InstanceType<typeof BetterSqlite3>,
  candidateId: string,
  resultId: string
): void {
  writer
    .prepare(
      "UPDATE candidate_head SET current_result_id = ?, version = version + 1 WHERE candidate_id = ?"
    )
    .run(resultId, candidateId);
}

async function correctRoute4(
  composition: RuntimeRecruitosComposition,
  candidateId: string,
  headVersion: number
): Promise<{ currentResultId: string; historicalResultId: string }> {
  const tasks = unwrap(await composition.listResolutionTasks({ candidateId }));
  const open = tasks.find((task) => task.status === "open");
  if (open === undefined) {
    throw new Error("Route 4 has no open resolution task");
  }
  const requested = unwrap(
    await composition.recordResolutionAction({
      taskId: open.resolutionTaskId,
      actionKind: "request_re_extraction",
      actorId: "human:operator",
      rationale: "Snapshot isolation fixture",
      expectedVersion: open.version,
      expectedCandidateHeadVersion: headVersion,
      commandId: "snapshot-request-1"
    })
  );
  if (requested.triageAttemptId === undefined) {
    throw new Error("request_re_extraction did not return a triage attempt");
  }
  unwrap(
    composition.registerExtractionFixtures(requested.triageAttemptId, { overlay: true })
  );
  unwrap(await composition.extractTriage(requested.triageAttemptId));
  const completed = unwrap(
    await composition.completeReExtraction({
      actorId: "system:runtime",
      triageAttemptId: requested.triageAttemptId,
      expectedTaskHeadVersion: requested.newVersion,
      expectedCandidateHeadVersion: headVersion,
      commandId: "snapshot-complete-1"
    })
  );
  return {
    currentResultId: completed.resultId,
    historicalResultId: completed.baseResultId
  };
}

describe("packet snapshot reads", () => {
  it("includes outstanding work that falls after the first task page", async () => {
    const { filename, composition } = await preparedDemo();
    const scored = candidateForSource(composition, "demo/route-1-scored");
    seedFiftyDismissedTasksAndOneOutstanding(composition, scored.resultId);

    const pageOne = listResolutionTasks(composition.runtime.connection.database, {
      candidateId: scored.candidateId
    });
    expect(pageOne.ok).toBe(true);
    if (!pageOne.ok) {
      return;
    }
    expect(pageOne.value.items).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(pageOne.value.nextCursor).toEqual(expect.any(String));
    expect(
      pageOne.value.items.some((task) => task.resolutionTaskId === OUTSTANDING_TASK_ID)
    ).toBe(false);

    const packet = await composition.getCandidatePacket(scored.candidateId);
    expect(packet.ok).toBe(true);
    if (!packet.ok) {
      return;
    }
    expect(packet.value.tasks.length).toBeGreaterThan(DEFAULT_PAGE_SIZE);
    expect(
      packet.value.tasks.some(
        (task) => task.resolutionTaskId === OUTSTANDING_TASK_ID && task.status === "open"
      )
    ).toBe(true);

    const printed = await runCli(["packet", scored.candidateId, "--db", filename]);
    expect(printed.exitCode).toBe(EXIT_SUCCESS);
    expect(printed.stdout).toContain("Outstanding review: required (open)");
    expect(printed.stdout).toContain(OUTSTANDING_TASK_ID);
  });

  it("keeps packet, head, and tasks on one deferred snapshot", async () => {
    const { filename, composition } = await preparedDemo();
    const route4 = candidateForSource(composition, "demo/route-4-reviewable-failure");
    const before = unwrap(await composition.getCandidatePacket(route4.candidateId));
    const corrected = await correctRoute4(
      composition,
      route4.candidateId,
      before.headVersion ?? 1
    );
    expect(corrected.historicalResultId).toBe(route4.resultId);
    expect(corrected.currentResultId).not.toBe(route4.resultId);

    const writer = new BetterSqlite3(filename, { fileMustExist: true, timeout: 5000 });
    writer.pragma("foreign_keys = ON");
    try {
      const mixed = readCandidatePacketSnapshotParts(
        composition.runtime.connection.database,
        route4.candidateId,
        {
          resultId: corrected.currentResultId,
          afterSelectedRead: () => {
            pointHeadAt(writer, route4.candidateId, corrected.historicalResultId);
          }
        }
      );
      expect(mixed.ok).toBe(true);
      if (!mixed.ok) {
        return;
      }
      expect(mixed.value.selected.resultId).toBe(corrected.currentResultId);
      expect(mixed.value.currentResultId).toBe(corrected.historicalResultId);
      expect(mixed.value.isHistoricalResult).toBe(true);

      pointHeadAt(writer, route4.candidateId, corrected.currentResultId);

      const snapshotted = loadCandidatePacketSnapshot(
        composition.runtime.connection,
        route4.candidateId,
        {
          resultId: corrected.currentResultId,
          afterSelectedRead: () => {
            pointHeadAt(writer, route4.candidateId, corrected.historicalResultId);
          }
        }
      );
      expect(snapshotted.ok).toBe(true);
      if (!snapshotted.ok) {
        return;
      }
      expect(snapshotted.value.selected.resultId).toBe(corrected.currentResultId);
      expect(snapshotted.value.currentResultId).toBe(corrected.currentResultId);
      expect(snapshotted.value.isHistoricalResult).toBe(false);
    } finally {
      writer.close();
    }
  });
});
