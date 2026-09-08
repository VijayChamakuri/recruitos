import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ok, RUBRIC_V1, sha256Hex, type LockedRubric, type Result } from "@recruitos/core";

import { createFixtureExtractionAdapter } from "../adapters/index.js";
import {
  claimAttemptWorkItem,
  failAttemptWorkItem,
  readAttemptWorkItems
} from "../attempts/index.js";
import { runImmediateTransaction } from "../commands/index.js";
import {
  createRuntime,
  demoCompositionOptions,
  type RuntimeComposition
} from "../composition/index.js";
import { DEMO_REVIEWABLE_FAILURE_SOURCE_KEY } from "../corpus/index.js";
import { SYSTEM_ACTOR_ID } from "../entities/index.js";
import type { RuntimeError } from "../errors/index.js";
import {
  insertExtractionFailure,
  prepareExtractionFailure
} from "../extraction/index.js";
import { readCandidatePacket } from "../read-models/index.js";
import { runExtractionAttempt } from "../scheduler/index.js";
import { demoPrepare, registerDemoCorrectionFixtures, registerDemoFixtures } from "./demo-prepare.js";
import { completeReExtraction, type CompleteReExtractionInput } from "./complete-re-extraction.js";
import { requestReExtraction } from "./request-re-extraction.js";

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
  const directory = await mkdtemp(join(tmpdir(), "recruitos-complete-reextraction-"));
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

async function requestedCorrection(runtime: RuntimeComposition): Promise<{
  ids: ReturnType<typeof route4>;
  triageAttemptId: string;
  taskHeadVersion: number;
}> {
  unwrap(await demoPrepare(runtime));
  const ids = route4(runtime);
  const requested = unwrap(
    requestReExtraction(runtime, {
      actorId: HUMAN_ACTOR_ID,
      resolutionTaskId: ids.taskId,
      expectedTaskHeadVersion: ids.taskVersion,
      expectedCandidateHeadVersion: ids.headVersion
    })
  );
  return {
    ids,
    triageAttemptId: requested.result.triageAttemptId,
    taskHeadVersion: requested.result.taskHeadVersion
  };
}

function completeInput(
  triageAttemptId: string,
  taskHeadVersion: number,
  candidateHeadVersion: number,
  overrides: Partial<CompleteReExtractionInput> = {}
): CompleteReExtractionInput {
  return {
    actorId: SYSTEM_ACTOR_ID,
    triageAttemptId,
    expectedTaskHeadVersion: taskHeadVersion,
    expectedCandidateHeadVersion: candidateHeadVersion,
    ...overrides
  };
}

function markRetryable(runtime: RuntimeComposition, triageAttemptId: string): void {
  unwrap(
    runImmediateTransaction(runtime.connection, (context) => {
      const items = unwrap(readAttemptWorkItems(context, triageAttemptId));
      const now = runtime.clock.now();
      for (const [index, item] of items.entries()) {
        const claimed = unwrap(
          claimAttemptWorkItem(context, {
            attemptWorkItemId: item.attemptWorkItemId,
            claimId: `claim-retry-${index}`,
            claimedAt: now,
            claimExpiresAt: now + 60_000,
            expectedVersion: item.version
          })
        );
        const source = context.nativeDatabase
          .prepare(
            `SELECT cd.source_document_id AS sourceDocumentId
             FROM attempt_work_item wi
             JOIN candidate_document cd ON cd.candidate_document_id = wi.candidate_document_id
             WHERE wi.attempt_work_item_id = ?`
          )
          .get(item.attemptWorkItemId) as { sourceDocumentId: string };
        const body = `retryable-correction-${index}-${item.attemptWorkItemId}`;
        const prepared = unwrap(
          prepareExtractionFailure({
            extractionFailureId: `failure-retry-${index}`,
            specId: item.extractionSpecId,
            sourceDocumentId: source.sourceDocumentId,
            errorClass: "structurally_invalid",
            responseHash: sha256Hex(body),
            responseByteLength: new TextEncoder().encode(body).length,
            diagnostic: { summary: "forced retryable failure", details: [] },
            createdAt: now
          })
        );
        unwrap(insertExtractionFailure(context, prepared));
        unwrap(
          failAttemptWorkItem(context, {
            attemptWorkItemId: item.attemptWorkItemId,
            state: "retryable_failure",
            extractionFailureId: prepared.extractionFailureId,
            failedAt: now,
            expectedVersion: claimed.version
          })
        );
      }
      return ok(undefined);
    })
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("completeReExtraction", () => {
  it("rejects invalid composition, input, humans, and non-v1 rubrics", () => {
    expect(completeReExtraction({} as RuntimeComposition, completeInput("a", 1, 1))).toMatchObject({
      ok: false,
      error: { message: "Invalid runtime composition" }
    });
    expect(
      completeReExtraction(
        { connection: null } as unknown as RuntimeComposition,
        completeInput("a", 1, 1)
      )
    ).toMatchObject({ ok: false, error: { message: "Invalid runtime composition" } });
    expect(
      completeReExtraction(
        { connection: {}, clock: {} } as RuntimeComposition,
        completeInput("a", 1, 1)
      )
    ).toMatchObject({ ok: false, error: { message: "Invalid runtime clock" } });
    expect(
      completeReExtraction(
        { connection: {}, clock: { now: () => 1 }, idGenerator: {} } as RuntimeComposition,
        completeInput("a", 1, 1)
      )
    ).toMatchObject({ ok: false, error: { message: "Invalid runtime id generator" } });
    const runtime = { connection: {}, clock: { now: () => 1 }, idGenerator: { next: () => "x" } };
    expect(completeReExtraction(runtime as RuntimeComposition, null as never)).toMatchObject({
      ok: false,
      error: { message: "Invalid complete re-extraction input" }
    });
    expect(
      completeReExtraction(runtime as RuntimeComposition, completeInput("a", 1, 1, { actorId: "" }))
    ).toMatchObject({
      ok: false,
      error: { message: "Complete re-extraction requires an actor id" }
    });
    expect(
      completeReExtraction(
        runtime as RuntimeComposition,
        completeInput("a", 1, 1, { actorId: "has space" })
      )
    ).toMatchObject({
      ok: false,
      error: { message: "Complete re-extraction requires a valid actor id" }
    });
    expect(
      completeReExtraction(
        runtime as RuntimeComposition,
        completeInput("a", 1, 1, { actorId: HUMAN_ACTOR_ID })
      )
    ).toMatchObject({
      ok: false,
      error: { code: "command_conflict", message: "reextraction_completed is a system-only action" }
    });
    expect(
      completeReExtraction(runtime as RuntimeComposition, completeInput("", 1, 1))
    ).toMatchObject({
      ok: false,
      error: { message: "Complete re-extraction requires a triage attempt id" }
    });
    expect(
      completeReExtraction(runtime as RuntimeComposition, completeInput("a", -1, 1))
    ).toMatchObject({
      ok: false,
      error: { message: "expectedTaskHeadVersion must be a nonnegative integer" }
    });
    expect(
      completeReExtraction(runtime as RuntimeComposition, completeInput("a", 1.4, 1))
    ).toMatchObject({
      ok: false,
      error: { message: "expectedTaskHeadVersion must be a nonnegative integer" }
    });
    expect(
      completeReExtraction(runtime as RuntimeComposition, completeInput("a", 1, -1))
    ).toMatchObject({
      ok: false,
      error: { message: "expectedCandidateHeadVersion must be a nonnegative integer" }
    });
    expect(
      completeReExtraction(runtime as RuntimeComposition, completeInput("a", 1, 1.4))
    ).toMatchObject({
      ok: false,
      error: { message: "expectedCandidateHeadVersion must be a nonnegative integer" }
    });
    expect(
      completeReExtraction(
        runtime as RuntimeComposition,
        completeInput("a", 1, 1, { rubric: { ...RUBRIC_V1 } as LockedRubric })
      )
    ).toMatchObject({
      ok: false,
      error: { message: "completeReExtraction requires RUBRIC_V1" }
    });
    expect(
      completeReExtraction(
        runtime as RuntimeComposition,
        completeInput("a", undefined as never, 1)
      )
    ).toMatchObject({
      ok: false,
      error: { message: "expectedTaskHeadVersion must be a nonnegative integer" }
    });
    expect(
      completeReExtraction(
        runtime as RuntimeComposition,
        completeInput("a", 1, undefined as never)
      )
    ).toMatchObject({
      ok: false,
      error: { message: "expectedCandidateHeadVersion must be a nonnegative integer" }
    });
  });

  it("seals a proving overlay correction and leaves the original packet readable", async () => {
    const runtime = await demoRuntime();
    const { ids, triageAttemptId, taskHeadVersion } = await requestedCorrection(runtime);
    const runsBefore = count(runtime, "SELECT count(*) AS n FROM triage_run");
    const membersBefore = count(runtime, "SELECT count(*) AS n FROM triage_run_member");
    const originalSpans = count(
      runtime,
      "SELECT count(*) AS n FROM candidate_result_evidence_span WHERE candidate_result_id = ?",
      ids.resultId
    );

    let extractCalls = 0;
    const adapter = runtime.extraction;
    const originalExtract = adapter.extract.bind(adapter);
    adapter.extract = async (request) => {
      extractCalls += 1;
      return originalExtract(request);
    };
    expect(adapter.descriptor.mode).toBe("fixture");
    unwrap(registerDemoCorrectionFixtures(runtime, triageAttemptId));
    const extracted = unwrap(await runExtractionAttempt(runtime, { triageAttemptId }));
    expect(extracted.blockedFailures).toBe(0);
    expect(extracted.succeeded).toBeGreaterThan(0);
    expect(extractCalls).toBe(extracted.processed);

    const completed = unwrap(
      completeReExtraction(
        runtime,
        completeInput(triageAttemptId, taskHeadVersion, ids.headVersion, { rubric: RUBRIC_V1 })
      )
    );
    expect(completed.result.derivedStatus).toBe("review_required");
    expect(completed.result.baseResultId).toBe(ids.resultId);
    expect(completed.result.candidateHeadVersion).toBe(ids.headVersion + 1);
    expect(completed.result.resultId).not.toBe(ids.resultId);

    const head = nativeClient(runtime)
      .prepare(
        `SELECT current_result_id AS resultId, version AS headVersion, kind
         FROM candidate_head
         JOIN candidate_triage_result r ON r.candidate_triage_result_id = current_result_id
         WHERE candidate_head.candidate_id = ?`
      )
      .get(ids.candidateId) as { resultId: string; headVersion: number; kind: string };
    expect(head.resultId).toBe(completed.result.resultId);
    expect(head.headVersion).toBe(ids.headVersion + 1);
    expect(head.kind).toBe("correction");

    const correction = unwrap(
      readCandidatePacket(runtime.connection.database, ids.candidateId)
    );
    expect(correction.resultId).toBe(completed.result.resultId);
    expect(correction.resultKind).toBe("correction");
    expect(correction.resultAvailability).toBe("complete");
    expect(correction.resultStatus).toBe("scored");
    expect(correction.headVersion).toBe(ids.headVersion + 1);

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
    unwrap(runtime.close());
  });

  it("creates a superseding zero-delta result when re-extraction is identical", async () => {
    const runtime = await demoRuntime();
    const { ids, triageAttemptId, taskHeadVersion } = await requestedCorrection(runtime);
    unwrap(registerDemoFixtures(runtime, triageAttemptId));
    unwrap(await runExtractionAttempt(runtime, { triageAttemptId }));
    const completed = unwrap(
      completeReExtraction(runtime, completeInput(triageAttemptId, taskHeadVersion, ids.headVersion))
    );
    expect(completed.result.resultId).not.toBe(ids.resultId);
    expect(completed.result.baseResultId).toBe(ids.resultId);
    const packet = unwrap(readCandidatePacket(runtime.connection.database, ids.candidateId));
    expect(packet.resultKind).toBe("correction");
    expect(packet.resultAvailability).toBe("unavailable");
    expect(packet.reasons).toEqual(["assessment_unavailable"]);
    const original = unwrap(
      readCandidatePacket(runtime.connection.database, ids.candidateId, { resultId: ids.resultId })
    );
    expect(original.resultId).toBe(ids.resultId);
    unwrap(runtime.close());
  });

  it("refuses pending, blocked, and retryable work, and the scheduler resumes retryable only", async () => {
    const runtime = await demoRuntime();
    const pending = await requestedCorrection(runtime);
    expect(
      completeReExtraction(
        runtime,
        completeInput(pending.triageAttemptId, pending.taskHeadVersion, pending.ids.headVersion)
      )
    ).toMatchObject({
      ok: false,
      error: { message: /is pending/ }
    });

    const blockedRuntime = await demoRuntime();
    const blocked = await requestedCorrection(blockedRuntime);
    const blockedExtract = unwrap(
      await runExtractionAttempt(
        { ...blockedRuntime, extraction: createFixtureExtractionAdapter() },
        { triageAttemptId: blocked.triageAttemptId }
      )
    );
    expect(blockedExtract.blockedFailures).toBeGreaterThan(0);
    expect(
      completeReExtraction(
        blockedRuntime,
        completeInput(blocked.triageAttemptId, blocked.taskHeadVersion, blocked.ids.headVersion)
      )
    ).toMatchObject({
      ok: false,
      error: { message: /blocked_failure/ }
    });
    const skipped = unwrap(
      await runExtractionAttempt(blockedRuntime, { triageAttemptId: blocked.triageAttemptId })
    );
    expect(skipped.processed).toBe(0);
    unwrap(blockedRuntime.close());

    const retryRuntime = await demoRuntime();
    const retry = await requestedCorrection(retryRuntime);
    markRetryable(retryRuntime, retry.triageAttemptId);
    expect(
      completeReExtraction(
        retryRuntime,
        completeInput(retry.triageAttemptId, retry.taskHeadVersion, retry.ids.headVersion)
      )
    ).toMatchObject({
      ok: false,
      error: { message: /retryable_failure/ }
    });
    unwrap(registerDemoCorrectionFixtures(retryRuntime, retry.triageAttemptId));
    const resumed = unwrap(
      await runExtractionAttempt(retryRuntime, { triageAttemptId: retry.triageAttemptId })
    );
    expect(resumed.processed).toBeGreaterThan(0);
    expect(resumed.blockedFailures).toBe(0);
    unwrap(
      completeReExtraction(
        retryRuntime,
        completeInput(retry.triageAttemptId, retry.taskHeadVersion, retry.ids.headVersion)
      )
    );
    unwrap(retryRuntime.close());
    unwrap(runtime.close());
  });

  it("rolls back stale task and candidate heads without writing a correction result", async () => {
    const runtime = await demoRuntime();
    const { ids, triageAttemptId, taskHeadVersion } = await requestedCorrection(runtime);
    unwrap(registerDemoCorrectionFixtures(runtime, triageAttemptId));
    unwrap(await runExtractionAttempt(runtime, { triageAttemptId }));
    const resultsBefore = count(runtime, "SELECT count(*) AS n FROM candidate_triage_result");
    expect(
      completeReExtraction(runtime, completeInput(triageAttemptId, taskHeadVersion + 9, ids.headVersion))
    ).toMatchObject({ ok: false, error: { code: "version_conflict" } });
    expect(
      completeReExtraction(runtime, completeInput(triageAttemptId, taskHeadVersion, ids.headVersion + 9))
    ).toMatchObject({ ok: false, error: { code: "version_conflict" } });
    expect(count(runtime, "SELECT count(*) AS n FROM candidate_triage_result")).toBe(resultsBefore);
    expect(
      count(runtime, "SELECT version AS n FROM candidate_head WHERE candidate_id = ?", ids.candidateId)
    ).toBe(ids.headVersion);
    unwrap(runtime.close());
  });

  it("rejects a non-correction attempt and a missing attempt", async () => {
    const runtime = await demoRuntime();
    const prepared = unwrap(await demoPrepare(runtime));
    expect(
      completeReExtraction(runtime, completeInput(prepared.triageAttemptId, 0, 1))
    ).toMatchObject({
      ok: false,
      error: {
        code: "command_conflict",
        message: "completeReExtraction requires a candidate_correction attempt"
      }
    });
    expect(completeReExtraction(runtime, completeInput("attempt-missing", 0, 1))).toMatchObject({
      ok: false,
      error: { code: "not_found" }
    });
    unwrap(runtime.close());
  });

  it("replays an identical completion and rejects a payload-hash mismatch", async () => {
    const runtime = await demoRuntime();
    const { ids, triageAttemptId, taskHeadVersion } = await requestedCorrection(runtime);
    unwrap(registerDemoCorrectionFixtures(runtime, triageAttemptId));
    unwrap(await runExtractionAttempt(runtime, { triageAttemptId }));
    const first = unwrap(
      completeReExtraction(runtime, completeInput(triageAttemptId, taskHeadVersion, ids.headVersion))
    );
    const commandId = first.metadata.commandId;
    const replayRuntime = { ...runtime, idGenerator: { next: () => commandId } };
    const replay = unwrap(
      completeReExtraction(
        replayRuntime,
        completeInput(triageAttemptId, taskHeadVersion, ids.headVersion)
      )
    );
    expect(replay.metadata.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
    const mismatch = completeReExtraction(
      replayRuntime,
      completeInput(triageAttemptId, taskHeadVersion + 1, ids.headVersion)
    );
    expect(mismatch).toMatchObject({
      ok: false,
      error: {
        code: "command_conflict",
        details: { reason: "command_identity_mismatch" }
      }
    });
    unwrap(runtime.close());
  });

  it("rejects a stale plan when work item identities change after planning", async () => {
    const runtime = await demoRuntime();
    const { ids, triageAttemptId, taskHeadVersion } = await requestedCorrection(runtime);
    unwrap(registerDemoCorrectionFixtures(runtime, triageAttemptId));
    unwrap(await runExtractionAttempt(runtime, { triageAttemptId }));
    const inner = runtime.idGenerator;
    let calls = 0;
    const hooked: RuntimeComposition = {
      ...runtime,
      idGenerator: {
        next: () => {
          calls += 1;
          if (calls === 3) {
            nativeClient(runtime)
              .prepare("UPDATE attempt_work_item SET version = version + 1 WHERE triage_attempt_id = ?")
              .run(triageAttemptId);
          }
          return inner.next();
        }
      }
    };
    const result = completeReExtraction(
      hooked,
      completeInput(triageAttemptId, taskHeadVersion, ids.headVersion)
    );
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Complete plan is stale: work item identities changed" }
    });
    unwrap(runtime.close());
  });

  it("rejects a stale plan when the attempt version changes after planning", async () => {
    const runtime = await demoRuntime();
    const { ids, triageAttemptId, taskHeadVersion } = await requestedCorrection(runtime);
    unwrap(registerDemoCorrectionFixtures(runtime, triageAttemptId));
    unwrap(await runExtractionAttempt(runtime, { triageAttemptId }));
    const inner = runtime.idGenerator;
    let calls = 0;
    const hooked: RuntimeComposition = {
      ...runtime,
      idGenerator: {
        next: () => {
          calls += 1;
          if (calls === 3) {
            nativeClient(runtime)
              .prepare("UPDATE triage_attempt SET version = version + 1 WHERE triage_attempt_id = ?")
              .run(triageAttemptId);
          }
          return inner.next();
        }
      }
    };
    const result = completeReExtraction(
      hooked,
      completeInput(triageAttemptId, taskHeadVersion, ids.headVersion)
    );
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Complete plan is stale: attempt version changed" }
    });
    unwrap(runtime.close());
  });

  it("refuses completion while correction work items stay claimed", async () => {
    const runtime = await demoRuntime();
    const { ids, triageAttemptId, taskHeadVersion } = await requestedCorrection(runtime);
    unwrap(
      runImmediateTransaction(runtime.connection, (context) => {
        const items = unwrap(readAttemptWorkItems(context, triageAttemptId));
        const now = runtime.clock.now();
        for (const [index, item] of items.entries()) {
          unwrap(
            claimAttemptWorkItem(context, {
              attemptWorkItemId: item.attemptWorkItemId,
              claimId: `claim-held-${index}`,
              claimedAt: now,
              claimExpiresAt: now + 60_000,
              expectedVersion: item.version
            })
          );
        }
        return ok(undefined);
      })
    );
    expect(
      completeReExtraction(runtime, completeInput(triageAttemptId, taskHeadVersion, ids.headVersion))
    ).toMatchObject({
      ok: false,
      error: { message: /is claimed/ }
    });
    unwrap(runtime.close());
  });
});
