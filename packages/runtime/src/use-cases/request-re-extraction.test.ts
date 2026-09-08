import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { type Result } from "@recruitos/core";

import type { AttemptWorkItem } from "../attempts/index.js";
import { runImmediateTransaction } from "../commands/index.js";
import {
  createRuntime,
  demoCompositionOptions,
  type RuntimeComposition
} from "../composition/index.js";
import { DEMO_REVIEWABLE_FAILURE_SOURCE_KEY } from "../corpus/index.js";
import { SYSTEM_ACTOR_ID } from "../entities/index.js";
import type { RuntimeError } from "../errors/index.js";
import type { CandidateDecisionOutput } from "../results/index.js";
import { runExtractionAttempt } from "../scheduler/index.js";
import { completeReExtraction } from "./complete-re-extraction.js";
import { demoPrepare, registerDemoCorrectionFixtures } from "./demo-prepare.js";
import { loadCandidateDocuments, persistCandidateResult } from "./finalize-triage-run.js";
import {
  requestReExtraction,
  selectCorrectionWorkItems,
  type RequestReExtractionInput
} from "./request-re-extraction.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const HUMAN_ACTOR_ID = "human:operator";

function unwrap<T>(result: Result<T, RuntimeError>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function nativeClient(runtime: RuntimeComposition): {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes: number };
  };
} {
  return (runtime.connection.database as unknown as { $client: ReturnType<typeof nativeClient> })
    .$client;
}

async function demoRuntime(): Promise<RuntimeComposition> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-request-reextraction-"));
  temporaryDirectories.push(directory);
  return unwrap(
    createRuntime(
      demoCompositionOptions({
        database: { filename: join(directory, "runtime.db"), migrationsFolder }
      })
    )
  );
}

function route4(runtime: RuntimeComposition): {
  candidateId: string;
  resultId: string;
  headVersion: number;
  taskId: string;
  taskVersion: number;
} {
  const db = nativeClient(runtime);
  const candidate = db
    .prepare("SELECT candidate_id AS candidateId FROM candidate WHERE source_key = ?")
    .get(DEMO_REVIEWABLE_FAILURE_SOURCE_KEY) as { candidateId: string };
  const head = db
    .prepare(
      `SELECT current_result_id AS resultId, version AS headVersion
       FROM candidate_head WHERE candidate_id = ?`
    )
    .get(candidate.candidateId) as { resultId: string; headVersion: number };
  const task = db
    .prepare(
      `SELECT t.resolution_task_id AS taskId, COALESCE(h.version, 0) AS taskVersion
       FROM resolution_task t
       LEFT JOIN resolution_task_head h ON h.resolution_task_id = t.resolution_task_id
       WHERE t.candidate_result_id = ?
       ORDER BY t.task_ordinal ASC
       LIMIT 1`
    )
    .get(head.resultId) as { taskId: string; taskVersion: number };
  return {
    candidateId: candidate.candidateId,
    resultId: head.resultId,
    headVersion: head.headVersion,
    taskId: task.taskId,
    taskVersion: task.taskVersion
  };
}

function count(runtime: RuntimeComposition, sql: string, ...params: unknown[]): number {
  const row = nativeClient(runtime).prepare(sql).get(...params) as { n: number };
  return row.n;
}

function requestInput(
  ids: { taskId: string; taskVersion: number; headVersion: number },
  overrides: Partial<RequestReExtractionInput> = {}
): RequestReExtractionInput {
  return {
    actorId: HUMAN_ACTOR_ID,
    resolutionTaskId: ids.taskId,
    expectedTaskHeadVersion: ids.taskVersion,
    expectedCandidateHeadVersion: ids.headVersion,
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("selectCorrectionWorkItems", () => {
  const item = (overrides: {
    workItemKey: string;
    state: AttemptWorkItem["state"];
    candidateId?: string;
    dimensionId?: string;
  }): AttemptWorkItem =>
    ({
      attemptWorkItemId: `item-${overrides.workItemKey}`,
      triageAttemptId: "attempt-origin",
      workItemKey: overrides.workItemKey,
      manifestOrdinal: 0,
      candidateId: overrides.candidateId ?? "cand-1",
      candidateDocumentId: "doc-1",
      dimensionId: overrides.dimensionId ?? "evaluation_and_measurement",
      extractionSpecId: "spec-1",
      state: overrides.state,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      claimId: null,
      claimedAt: null,
      claimExpiresAt: null,
      extractionArtifactId: null,
      extractionFailureId: null,
      extractionRunId: null
    }) as AttemptWorkItem;

  it("prefers failed work items for the scoped candidate", () => {
    const selected = selectCorrectionWorkItems(
      [
        item({ workItemKey: "other:doc:dim", state: "reviewable_failure", candidateId: "cand-2" }),
        item({ workItemKey: "a:doc:eval", state: "succeeded" }),
        item({ workItemKey: "a:doc:eval-fail", state: "reviewable_failure" }),
        item({ workItemKey: "a:doc:retry", state: "retryable_failure" }),
        item({ workItemKey: "a:doc:block", state: "blocked_failure" })
      ],
      "cand-1",
      "assessment_unavailable"
    );
    expect(selected.map((row) => row.workItemKey)).toEqual([
      "a:doc:eval-fail",
      "a:doc:retry",
      "a:doc:block"
    ]);
  });

  it("falls back to the missing-evidence dimension when nothing failed", () => {
    const selected = selectCorrectionWorkItems(
      [
        item({
          workItemKey: "a:doc:eval",
          state: "succeeded",
          dimensionId: "evaluation_and_measurement"
        }),
        item({
          workItemKey: "a:doc:applied",
          state: "succeeded",
          dimensionId: "applied_ml_llm_systems"
        })
      ],
      "cand-1",
      "missing_evidence:applied_ml_llm_systems"
    );
    expect(selected.map((row) => row.workItemKey)).toEqual(["a:doc:applied"]);
  });

  it("returns every scoped item when the reason is not a missing-evidence dimension", () => {
    const selected = selectCorrectionWorkItems(
      [
        item({ workItemKey: "a:doc:eval", state: "succeeded" }),
        item({ workItemKey: "other", state: "succeeded", candidateId: "cand-2" })
      ],
      "cand-1",
      "assessment_unavailable"
    );
    expect(selected.map((row) => row.workItemKey)).toEqual(["a:doc:eval"]);
  });

  it("returns every scoped item when missing-evidence names no origin dimension", () => {
    const selected = selectCorrectionWorkItems(
      [item({ workItemKey: "a:doc:eval", state: "succeeded" })],
      "cand-1",
      "missing_evidence:not_a_dimension"
    );
    expect(selected.map((row) => row.workItemKey)).toEqual(["a:doc:eval"]);
  });
});

describe("requestReExtraction", () => {
  it("rejects invalid composition and input", () => {
    expect(requestReExtraction({} as RuntimeComposition, requestInput({
      taskId: "t",
      taskVersion: 0,
      headVersion: 1
    }))).toMatchObject({ ok: false, error: { message: "Invalid runtime composition" } });
    expect(
      requestReExtraction(
        { connection: null } as unknown as RuntimeComposition,
        requestInput({
          taskId: "t",
          taskVersion: 0,
          headVersion: 1
        })
      )
    ).toMatchObject({ ok: false, error: { message: "Invalid runtime composition" } });
    expect(
      requestReExtraction(
        { connection: {}, clock: {} } as RuntimeComposition,
        requestInput({ taskId: "t", taskVersion: 0, headVersion: 1 })
      )
    ).toMatchObject({ ok: false, error: { message: "Invalid runtime clock" } });
    expect(
      requestReExtraction(
        { connection: {}, clock: { now: () => 1 }, idGenerator: {} } as RuntimeComposition,
        requestInput({ taskId: "t", taskVersion: 0, headVersion: 1 })
      )
    ).toMatchObject({ ok: false, error: { message: "Invalid runtime id generator" } });
    const runtime = { connection: {}, clock: { now: () => 1 }, idGenerator: { next: () => "x" } };
    expect(requestReExtraction(runtime as RuntimeComposition, null as never)).toMatchObject({
      ok: false,
      error: { message: "Invalid request re-extraction input" }
    });
    expect(
      requestReExtraction(runtime as RuntimeComposition, {
        actorId: "",
        resolutionTaskId: "t",
        expectedTaskHeadVersion: 0,
        expectedCandidateHeadVersion: 1
      })
    ).toMatchObject({ ok: false, error: { message: "Request re-extraction requires an actor id" } });
    expect(
      requestReExtraction(runtime as RuntimeComposition, {
        actorId: "has space",
        resolutionTaskId: "t",
        expectedTaskHeadVersion: 0,
        expectedCandidateHeadVersion: 1
      })
    ).toMatchObject({
      ok: false,
      error: { message: "Request re-extraction requires a valid actor id" }
    });
    expect(
      requestReExtraction(runtime as RuntimeComposition, {
        actorId: SYSTEM_ACTOR_ID,
        resolutionTaskId: "t",
        expectedTaskHeadVersion: 0,
        expectedCandidateHeadVersion: 1
      })
    ).toMatchObject({
      ok: false,
      error: { code: "command_conflict", message: "request_re_extraction is a human action" }
    });
    expect(
      requestReExtraction(runtime as RuntimeComposition, {
        actorId: HUMAN_ACTOR_ID,
        resolutionTaskId: "",
        expectedTaskHeadVersion: 0,
        expectedCandidateHeadVersion: 1
      })
    ).toMatchObject({
      ok: false,
      error: { message: "Request re-extraction requires a resolution task id" }
    });
    expect(
      requestReExtraction(runtime as RuntimeComposition, {
        actorId: HUMAN_ACTOR_ID,
        resolutionTaskId: "t",
        expectedTaskHeadVersion: 1.5,
        expectedCandidateHeadVersion: 1
      })
    ).toMatchObject({
      ok: false,
      error: { message: "expectedTaskHeadVersion must be a nonnegative integer" }
    });
    expect(
      requestReExtraction(runtime as RuntimeComposition, {
        actorId: HUMAN_ACTOR_ID,
        resolutionTaskId: "t",
        expectedTaskHeadVersion: -1,
        expectedCandidateHeadVersion: 1
      })
    ).toMatchObject({
      ok: false,
      error: { message: "expectedTaskHeadVersion must be a nonnegative integer" }
    });
    expect(
      requestReExtraction(runtime as RuntimeComposition, {
        actorId: HUMAN_ACTOR_ID,
        resolutionTaskId: "t",
        expectedTaskHeadVersion: 0,
        expectedCandidateHeadVersion: 1.2
      })
    ).toMatchObject({
      ok: false,
      error: { message: "expectedCandidateHeadVersion must be a nonnegative integer" }
    });
    expect(
      requestReExtraction(runtime as RuntimeComposition, {
        actorId: HUMAN_ACTOR_ID,
        resolutionTaskId: "t",
        expectedTaskHeadVersion: 0,
        expectedCandidateHeadVersion: -1
      })
    ).toMatchObject({
      ok: false,
      error: { message: "expectedCandidateHeadVersion must be a nonnegative integer" }
    });
    expect(
      requestReExtraction(runtime as RuntimeComposition, {
        actorId: HUMAN_ACTOR_ID,
        resolutionTaskId: "t",
        expectedTaskHeadVersion: undefined as never,
        expectedCandidateHeadVersion: 1
      })
    ).toMatchObject({
      ok: false,
      error: { message: "expectedTaskHeadVersion must be a nonnegative integer" }
    });
    expect(
      requestReExtraction(runtime as RuntimeComposition, {
        actorId: HUMAN_ACTOR_ID,
        resolutionTaskId: "t",
        expectedTaskHeadVersion: 0,
        expectedCandidateHeadVersion: undefined as never
      })
    ).toMatchObject({
      ok: false,
      error: { message: "expectedCandidateHeadVersion must be a nonnegative integer" }
    });
  });

  it("opens a candidate_correction attempt without creating a run", async () => {
    const runtime = await demoRuntime();
    unwrap(await demoPrepare(runtime));
    const ids = route4(runtime);
    const runsBefore = count(runtime, "SELECT count(*) AS n FROM triage_run");
    const membersBefore = count(runtime, "SELECT count(*) AS n FROM triage_run_member");

    const result = unwrap(requestReExtraction(runtime, requestInput(ids)));
    expect(result.metadata.replayed).toBe(false);
    expect(result.result.derivedStatus).toBe("open");
    expect(result.result.taskHeadVersion).toBe(ids.taskVersion + 1);
    expect(result.result.workItemCount).toBeGreaterThan(0);

    const attempt = nativeClient(runtime)
      .prepare(
        `SELECT kind, base_result_id AS baseResultId, request_action_id AS requestActionId,
                scope_candidate_id AS scopeCandidateId
         FROM triage_attempt WHERE triage_attempt_id = ?`
      )
      .get(result.result.triageAttemptId) as {
      kind: string;
      baseResultId: string;
      requestActionId: string;
      scopeCandidateId: string;
    };
    expect(attempt.kind).toBe("candidate_correction");
    expect(attempt.baseResultId).toBe(ids.resultId);
    expect(attempt.requestActionId).toBe(result.result.resolutionActionId);
    expect(attempt.scopeCandidateId).toBe(ids.candidateId);

    const scoped = nativeClient(runtime)
      .prepare(
        `SELECT count(*) AS n FROM attempt_work_item
         WHERE triage_attempt_id = ? AND candidate_id != ?`
      )
      .get(result.result.triageAttemptId, ids.candidateId) as { n: number };
    expect(scoped.n).toBe(0);
    expect(count(runtime, "SELECT count(*) AS n FROM triage_run")).toBe(runsBefore);
    expect(count(runtime, "SELECT count(*) AS n FROM triage_run_member")).toBe(membersBefore);
    expect(
      count(runtime, "SELECT version AS n FROM candidate_head WHERE candidate_id = ?", ids.candidateId)
    ).toBe(ids.headVersion);
    unwrap(runtime.close());
  });

  it("rolls back a stale task head without writing an action or attempt", async () => {
    const runtime = await demoRuntime();
    unwrap(await demoPrepare(runtime));
    const ids = route4(runtime);
    const actionsBefore = count(runtime, "SELECT count(*) AS n FROM resolution_action");
    const attemptsBefore = count(runtime, "SELECT count(*) AS n FROM triage_attempt");
    const result = requestReExtraction(
      runtime,
      requestInput(ids, { expectedTaskHeadVersion: ids.taskVersion + 9 })
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "version_conflict" }
    });
    expect(count(runtime, "SELECT count(*) AS n FROM resolution_action")).toBe(actionsBefore);
    expect(count(runtime, "SELECT count(*) AS n FROM triage_attempt")).toBe(attemptsBefore);
    unwrap(runtime.close());
  });

  it("rolls back a stale candidate head without writing an action or attempt", async () => {
    const runtime = await demoRuntime();
    unwrap(await demoPrepare(runtime));
    const ids = route4(runtime);
    const actionsBefore = count(runtime, "SELECT count(*) AS n FROM resolution_action");
    const attemptsBefore = count(runtime, "SELECT count(*) AS n FROM triage_attempt");
    const result = requestReExtraction(
      runtime,
      requestInput(ids, { expectedCandidateHeadVersion: ids.headVersion + 9 })
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "version_conflict" }
    });
    expect(count(runtime, "SELECT count(*) AS n FROM resolution_action")).toBe(actionsBefore);
    expect(count(runtime, "SELECT count(*) AS n FROM triage_attempt")).toBe(attemptsBefore);
    unwrap(runtime.close());
  });

  it("returns a typed conflict when the candidate head no longer points at the task result", async () => {
    const runtime = await demoRuntime();
    unwrap(await demoPrepare(runtime));
    const ids = route4(runtime);
    unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        persistCandidateResult({
          context,
          nextId: () => runtime.idGenerator.next(),
          createdAt: runtime.clock.now(),
          candidateId: ids.candidateId,
          documents: loadCandidateDocuments(context, ids.candidateId),
          artifacts: [],
          extractorVersion: "test",
          decision: {
            dimensionDerivation: {
              availability: "unavailable",
              gaps: [],
              unavailable: [{ dimensionId: "evaluation_and_measurement" }]
            }
          } as unknown as CandidateDecisionOutput,
          resultId: runtime.idGenerator.next(),
          kind: "correction",
          supersedesResultId: ids.resultId,
          expectedCandidateHeadVersion: ids.headVersion,
          skipExistingSpans: true
        })
      )
    );
    const head = nativeClient(runtime)
      .prepare("SELECT version AS headVersion FROM candidate_head WHERE candidate_id = ?")
      .get(ids.candidateId) as { headVersion: number };
    const result = requestReExtraction(
      runtime,
      requestInput(ids, { expectedCandidateHeadVersion: head.headVersion })
    );
    expect(result).toMatchObject({ ok: false, error: { code: "version_conflict" } });
    unwrap(runtime.close());
  });

  it("rejects an unknown task and an in-flight second request", async () => {
    const runtime = await demoRuntime();
    unwrap(await demoPrepare(runtime));
    const ids = route4(runtime);
    expect(
      requestReExtraction(runtime, requestInput(ids, { resolutionTaskId: "task-missing" }))
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    unwrap(requestReExtraction(runtime, requestInput(ids)));
    const second = requestReExtraction(
      runtime,
      requestInput({ ...ids, taskVersion: ids.taskVersion + 1 })
    );
    expect(second).toMatchObject({
      ok: false,
      error: {
        code: "command_conflict",
        message: "A re-extraction request is already in flight for this task"
      }
    });
    unwrap(runtime.close());
  });

  it("replays an identical command and rejects a payload-hash mismatch", async () => {
    const runtime = await demoRuntime();
    unwrap(await demoPrepare(runtime));
    const ids = route4(runtime);
    const first = unwrap(requestReExtraction(runtime, requestInput(ids)));
    const commandId = first.metadata.commandId;
    const replayRuntime = { ...runtime, idGenerator: { next: () => commandId } };
    const replay = unwrap(requestReExtraction(replayRuntime, requestInput(ids)));
    expect(replay.metadata.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
    const mismatch = requestReExtraction(replayRuntime, requestInput(ids, {
      expectedTaskHeadVersion: ids.taskVersion + 1
    }));
    expect(mismatch).toMatchObject({
      ok: false,
      error: {
        code: "command_conflict",
        details: { reason: "command_identity_mismatch" }
      }
    });
    unwrap(runtime.close());
  });

  it("rejects a second request after the original task is no longer open", async () => {
    const runtime = await demoRuntime();
    unwrap(await demoPrepare(runtime));
    const ids = route4(runtime);
    const requested = unwrap(requestReExtraction(runtime, requestInput(ids)));
    unwrap(registerDemoCorrectionFixtures(runtime, requested.result.triageAttemptId));
    unwrap(await runExtractionAttempt(runtime, { triageAttemptId: requested.result.triageAttemptId }));
    unwrap(
      completeReExtraction(runtime, {
        actorId: SYSTEM_ACTOR_ID,
        triageAttemptId: requested.result.triageAttemptId,
        expectedTaskHeadVersion: requested.result.taskHeadVersion,
        expectedCandidateHeadVersion: ids.headVersion
      })
    );
    const again = requestReExtraction(
      runtime,
      requestInput({
        ...ids,
        taskVersion: requested.result.taskHeadVersion + 1,
        headVersion: ids.headVersion + 1
      })
    );
    expect(again).toMatchObject({
      ok: false,
      error: {
        code: "command_conflict",
        message: `Resolution task "${ids.taskId}" is review_required, not open`
      }
    });
    unwrap(runtime.close());
  });

  it("rejects a correction whose origin scope has no work items", async () => {
    const runtime = await demoRuntime();
    const prepared = unwrap(await demoPrepare(runtime));
    const ids = route4(runtime);
    const db = nativeClient(runtime);
    db.prepare("DROP TRIGGER IF EXISTS attempt_work_item_reject_delete").run();
    db.prepare("DELETE FROM attempt_work_item WHERE triage_attempt_id = ? AND candidate_id = ?").run(
      prepared.triageAttemptId,
      ids.candidateId
    );
    const result = requestReExtraction(runtime, requestInput(ids));
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Correction scope produced no work items" }
    });
    unwrap(runtime.close());
  });
});
