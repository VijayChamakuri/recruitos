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
import { SYSTEM_ACTOR_ID } from "../../packages/runtime/src/entities/index.js";
import { readCandidatePacket } from "../../packages/runtime/src/read-models/index.js";
import { runExtractionAttempt } from "../../packages/runtime/src/scheduler/index.js";
import { completeReExtraction } from "../../packages/runtime/src/use-cases/complete-re-extraction.js";
import { demoPrepare, registerDemoCorrectionFixtures, registerDemoFixtures } from "../../packages/runtime/src/use-cases/demo-prepare.js";
import { requestReExtraction } from "../../packages/runtime/src/use-cases/request-re-extraction.js";
import { MIGRATIONS_FOLDER } from "./harness/database.js";
import { unwrap } from "./harness/results.js";

const migrationsFolder = MIGRATIONS_FOLDER;
const temporaryDirectories: string[] = [];
const HUMAN_ACTOR_ID = "human:operator";
const ROUTE_5_SOURCE_KEY = "demo/route-5-missing-evidence";
const APPLIED_DIMENSION_ID = "applied_ml_llm_systems";

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
  const directory = await mkdtemp(join(tmpdir(), "recruitos-correction-integration-"));
  temporaryDirectories.push(directory);
  return unwrap(
    createRuntime(
      demoCompositionOptions({
        database: { filename: join(directory, "runtime.db"), migrationsFolder }
      })
    )
  );
}

function idsForSourceKey(
  runtime: RuntimeComposition,
  sourceKey: string
): {
  candidateId: string;
  resultId: string;
  headVersion: number;
  taskId: string;
  taskVersion: number;
} {
  const db = nativeClient(runtime);
  const candidate = db
    .prepare("SELECT candidate_id AS candidateId FROM candidate WHERE source_key = ?")
    .get(sourceKey) as { candidateId: string };
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

function route4(runtime: RuntimeComposition): ReturnType<typeof idsForSourceKey> {
  return idsForSourceKey(runtime, DEMO_REVIEWABLE_FAILURE_SOURCE_KEY);
}

function count(runtime: RuntimeComposition, sql: string, ...params: unknown[]): number {
  const row = nativeClient(runtime).prepare(sql).get(...params) as { n: number };
  return row.n;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("T10.6 correction and re-extraction integration", () => {
  it("requests, extracts, and completes a proving overlay without creating a run", async () => {
    const runtime = await demoRuntime();
    unwrap(await demoPrepare(runtime));
    const ids = route4(runtime);
    const runsBefore = count(runtime, "SELECT count(*) AS n FROM triage_run");
    const membersBefore = count(runtime, "SELECT count(*) AS n FROM triage_run_member");
    const originalSpans = count(
      runtime,
      "SELECT count(*) AS n FROM candidate_result_evidence_span WHERE candidate_result_id = ?",
      ids.resultId
    );

    let liveCalls = 0;
    const originalExtract = runtime.extraction.extract.bind(runtime.extraction);
    runtime.extraction.extract = async (request) => {
      if (runtime.extraction.descriptor.mode !== "fixture") {
        liveCalls += 1;
      }
      return originalExtract(request);
    };

    const requested = unwrap(
      requestReExtraction(runtime, {
        actorId: HUMAN_ACTOR_ID,
        resolutionTaskId: ids.taskId,
        expectedTaskHeadVersion: ids.taskVersion,
        expectedCandidateHeadVersion: ids.headVersion
      })
    );
    expect(requested.result.derivedStatus).toBe("open");
    expect(
      count(
        runtime,
        "SELECT count(*) AS n FROM triage_attempt WHERE kind = 'candidate_correction' AND triage_attempt_id = ?",
        requested.result.triageAttemptId
      )
    ).toBe(1);

    unwrap(registerDemoCorrectionFixtures(runtime, requested.result.triageAttemptId));
    const extracted = unwrap(
      await runExtractionAttempt(runtime, { triageAttemptId: requested.result.triageAttemptId })
    );
    expect(extracted.blockedFailures).toBe(0);
    expect(extracted.succeeded).toBeGreaterThan(0);
    expect(liveCalls).toBe(0);
    expect(runtime.extraction.descriptor.mode).toBe("fixture");

    const completed = unwrap(
      completeReExtraction(runtime, {
        actorId: SYSTEM_ACTOR_ID,
        triageAttemptId: requested.result.triageAttemptId,
        expectedTaskHeadVersion: requested.result.taskHeadVersion,
        expectedCandidateHeadVersion: ids.headVersion
      })
    );
    expect(completed.result.baseResultId).toBe(ids.resultId);
    expect(completed.result.derivedStatus).toBe("review_required");
    expect(completed.result.candidateHeadVersion).toBe(ids.headVersion + 1);

    const current = unwrap(readCandidatePacket(runtime.connection.database, ids.candidateId));
    expect(current.resultId).toBe(completed.result.resultId);
    expect(current.resultKind).toBe("correction");
    expect(current.resultAvailability).toBe("complete");
    expect(current.resultStatus).toBe("scored");
    expect(current.headVersion).toBe(ids.headVersion + 1);

    const original = unwrap(
      readCandidatePacket(runtime.connection.database, ids.candidateId, { resultId: ids.resultId })
    );
    expect(original.resultId).toBe(ids.resultId);
    expect(original.resultKind).toBe("initial");
    expect(original.resultAvailability).toBe("unavailable");
    expect(original.reasons).toEqual(["assessment_unavailable"]);
    expect(
      count(
        runtime,
        "SELECT count(*) AS n FROM candidate_result_evidence_span WHERE candidate_result_id = ?",
        ids.resultId
      )
    ).toBe(originalSpans);

    const task = nativeClient(runtime)
      .prepare(
        `SELECT ra.action_kind AS actionKind
         FROM resolution_task_head h
         JOIN resolution_action ra ON ra.resolution_action_id = h.current_action_id
         WHERE h.resolution_task_id = ?`
      )
      .get(ids.taskId) as { actionKind: string };
    expect(task.actionKind).toBe("reextraction_completed");
    expect(count(runtime, "SELECT count(*) AS n FROM triage_run")).toBe(runsBefore);
    expect(count(runtime, "SELECT count(*) AS n FROM triage_run_member")).toBe(membersBefore);
    expect(
      count(runtime, "SELECT version AS n FROM candidate_head WHERE candidate_id = ?", ids.candidateId)
    ).toBe(ids.headVersion + 1);
    unwrap(runtime.close());
  });

  it("reuses unscoped dimension assessment ids on a route-5 correction", async () => {
    const runtime = await demoRuntime();
    unwrap(await demoPrepare(runtime));
    const ids = idsForSourceKey(runtime, ROUTE_5_SOURCE_KEY);
    const original = nativeClient(runtime)
      .prepare(
        `SELECT dimension_id AS dimensionId, dimension_assessment_id AS dimensionAssessmentId
         FROM candidate_result_dimension_assessment
         WHERE candidate_result_id = ?`
      )
      .all(ids.resultId) as Array<{ dimensionId: string; dimensionAssessmentId: string }>;
    expect(original).toHaveLength(6);
    const requested = unwrap(
      requestReExtraction(runtime, {
        actorId: HUMAN_ACTOR_ID,
        resolutionTaskId: ids.taskId,
        expectedTaskHeadVersion: ids.taskVersion,
        expectedCandidateHeadVersion: ids.headVersion
      })
    );
    unwrap(registerDemoFixtures(runtime, requested.result.triageAttemptId));
    unwrap(
      await runExtractionAttempt(runtime, { triageAttemptId: requested.result.triageAttemptId })
    );
    const completed = unwrap(
      completeReExtraction(runtime, {
        actorId: SYSTEM_ACTOR_ID,
        triageAttemptId: requested.result.triageAttemptId,
        expectedTaskHeadVersion: requested.result.taskHeadVersion,
        expectedCandidateHeadVersion: ids.headVersion
      })
    );
    const correction = nativeClient(runtime)
      .prepare(
        `SELECT dimension_id AS dimensionId, dimension_assessment_id AS dimensionAssessmentId
         FROM candidate_result_dimension_assessment
         WHERE candidate_result_id = ?`
      )
      .all(completed.result.resultId) as Array<{
      dimensionId: string;
      dimensionAssessmentId: string;
    }>;
    expect(correction).toHaveLength(6);
    const originalByDimension = new Map(
      original.map((row) => [row.dimensionId, row.dimensionAssessmentId])
    );
    const correctionByDimension = new Map(
      correction.map((row) => [row.dimensionId, row.dimensionAssessmentId])
    );
    expect(correctionByDimension.get(APPLIED_DIMENSION_ID)).not.toBe(
      originalByDimension.get(APPLIED_DIMENSION_ID)
    );
    for (const [dimensionId, assessmentId] of originalByDimension) {
      if (dimensionId === APPLIED_DIMENSION_ID) {
        continue;
      }
      expect(correctionByDimension.get(dimensionId)).toBe(assessmentId);
    }
    unwrap(runtime.close());
  });
});
