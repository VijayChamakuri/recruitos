import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntime,
  demoCompositionOptions,
  type RuntimeComposition
} from "../../packages/runtime/src/composition/index.js";
import { DEMO_REVIEWABLE_FAILURE_SOURCE_KEY } from "../../packages/runtime/src/corpus/index.js";
import { listProposals } from "../../packages/runtime/src/read-models/index.js";
import { runExtractionAttempt } from "../../packages/runtime/src/scheduler/index.js";
import { completeReExtraction } from "../../packages/runtime/src/use-cases/complete-re-extraction.js";
import {
  demoPrepare,
  registerDemoCorrectionFixtures
} from "../../packages/runtime/src/use-cases/demo-prepare.js";
import { requestReExtraction } from "../../packages/runtime/src/use-cases/request-re-extraction.js";
import { MIGRATIONS_FOLDER } from "./harness/database.js";
import { unwrap } from "./harness/results.js";

const temporaryDirectories: string[] = [];
const HUMAN_ACTOR_ID = "human:operator";

function nativeClient(runtime: RuntimeComposition): {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
  };
} {
  return (runtime.connection.database as unknown as { $client: ReturnType<typeof nativeClient> })
    .$client;
}

async function demoRuntime(): Promise<RuntimeComposition> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-proposals-integration-"));
  temporaryDirectories.push(directory);
  return unwrap(
    createRuntime(
      demoCompositionOptions({
        database: { filename: join(directory, "runtime.db"), migrationsFolder: MIGRATIONS_FOLDER }
      })
    )
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("proposal persistence and read model integration", () => {
  it("does not list stub rows after demoPrepare, and does not mint a correction shortlist", async () => {
    const runtime = await demoRuntime();
    unwrap(await demoPrepare(runtime));

    const afterDemo = unwrap(listProposals(runtime.connection.database));
    expect(afterDemo.queryCount).toBe(1);
    expect(afterDemo.items).toHaveLength(0);
    expect(afterDemo.nextCursor).toBeUndefined();
    expect(afterDemo.items.some((item) => item.proposalId === "proposal-1")).toBe(false);

    const candidate = nativeClient(runtime)
      .prepare("SELECT candidate_id AS candidateId FROM candidate WHERE source_key = ?")
      .get(DEMO_REVIEWABLE_FAILURE_SOURCE_KEY) as { candidateId: string };
    const head = nativeClient(runtime)
      .prepare(
        `SELECT current_result_id AS resultId, version AS headVersion
         FROM candidate_head WHERE candidate_id = ?`
      )
      .get(candidate.candidateId) as { resultId: string; headVersion: number };
    const task = nativeClient(runtime)
      .prepare(
        `SELECT t.resolution_task_id AS taskId, COALESCE(h.version, 0) AS taskVersion
         FROM resolution_task t
         LEFT JOIN resolution_task_head h ON h.resolution_task_id = t.resolution_task_id
         WHERE t.candidate_result_id = ?
         ORDER BY t.task_ordinal ASC
         LIMIT 1`
      )
      .get(head.resultId) as { taskId: string; taskVersion: number };

    const requested = unwrap(
      requestReExtraction(runtime, {
        actorId: HUMAN_ACTOR_ID,
        resolutionTaskId: task.taskId,
        expectedTaskHeadVersion: task.taskVersion,
        expectedCandidateHeadVersion: head.headVersion
      })
    );
    unwrap(registerDemoCorrectionFixtures(runtime, requested.result.triageAttemptId));
    unwrap(await runExtractionAttempt(runtime, { triageAttemptId: requested.result.triageAttemptId }));
    const completed = unwrap(
      completeReExtraction(runtime, {
        actorId: "system:runtime",
        triageAttemptId: requested.result.triageAttemptId,
        expectedTaskHeadVersion: requested.result.taskHeadVersion,
        expectedCandidateHeadVersion: head.headVersion
      })
    );

    const listed = unwrap(listProposals(runtime.connection.database));
    expect(listed.queryCount).toBe(1);
    expect(listed.items).toHaveLength(0);
    expect(listed.items.some((item) => item.proposalId === "proposal-1")).toBe(false);

    const originalCount = nativeClient(runtime)
      .prepare("SELECT count(*) AS n FROM proposal WHERE candidate_result_id = ?")
      .get(head.resultId) as { n: number };
    const correctionCount = nativeClient(runtime)
      .prepare("SELECT count(*) AS n FROM proposal WHERE candidate_result_id = ?")
      .get(completed.result.resultId) as { n: number };
    expect(originalCount.n).toBe(0);
    expect(correctionCount.n).toBe(0);

    unwrap(runtime.close());
  });
});
