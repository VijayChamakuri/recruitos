import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCompositionFromRuntime,
  RuntimeRecruitosComposition
} from "@recruitos/cli";
import { createRuntime, demoCompositionOptions } from "@recruitos/runtime/composition";
import { TEST_IDS } from "../testids.js";
import { handleRequest } from "./handlers.js";
import {
  getServerComposition,
  getServerRuntime,
  resetServerComposition,
  setServerComposition
} from "./composition.js";
import { setCorrectionFixtureMode } from "./correction-mode.js";
import { FIXTURE_CORRECTION_SOURCE_KEY } from "./form-body.js";
import { listAllResolutionTaskSummaries } from "./read-pages.js";

function nativeClient(): {
  prepare: (sql: string) => { get: (...parameters: readonly unknown[]) => { n?: number; id?: string } };
} {
  const runtime = getServerRuntime();
  if (runtime === null) {
    throw new Error("runtime required");
  }
  return (
    runtime.connection.database as {
      $client: {
        prepare: (sql: string) => {
          get: (...parameters: readonly unknown[]) => { n?: number; id?: string };
        };
      };
    }
  ).$client;
}

function countRequestActions(): number {
  return nativeClient()
    .prepare(
      `SELECT COUNT(*) AS n FROM resolution_action WHERE action_kind = 'request_re_extraction'`
    )
    .get().n as number;
}

function countCorrectionAttempts(): number {
  return nativeClient()
    .prepare(`SELECT COUNT(*) AS n FROM triage_attempt WHERE kind = 'candidate_correction'`)
    .get().n as number;
}

function readMainRunAttemptId(): string {
  const id = nativeClient()
    .prepare(`SELECT triage_attempt_id AS id FROM triage_attempt WHERE kind = 'main_run' LIMIT 1`)
    .get().id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("main_run attempt required");
  }
  return id;
}

async function loadRoute4PacketForm(): Promise<{
  candidateId: string;
  taskId: string;
  taskVersion: string;
  candidateVersion: string;
}> {
  const listed = await handleRequest("/api/candidates", new URLSearchParams());
  const candidates = JSON.parse(listed.body) as Array<{
    candidateId: string;
    sourceKey: string;
  }>;
  const route4 = candidates.find((candidate) => candidate.sourceKey === FIXTURE_CORRECTION_SOURCE_KEY);
  expect(route4).toBeDefined();
  if (route4 === undefined) {
    throw new Error("route-4 fixture candidate required");
  }
  const packetPage = await handleRequest(
    `/packet/${route4.candidateId}`,
    new URLSearchParams("theme=light&density=default")
  );
  const taskVersion = /name="expectedTaskHeadVersion" value="([^"]+)"/.exec(packetPage.body)?.[1];
  const candidateVersion = /name="expectedCandidateHeadVersion" value="([^"]+)"/.exec(
    packetPage.body
  )?.[1];
  const taskId = /name="taskId" value="([^"]+)"/.exec(packetPage.body)?.[1];
  expect(taskVersion).toBeDefined();
  expect(candidateVersion).toBeDefined();
  expect(taskId).toBeDefined();
  if (taskVersion === undefined || candidateVersion === undefined || taskId === undefined) {
    throw new Error("route-4 inspector form fields required");
  }
  return {
    candidateId: route4.candidateId,
    taskId,
    taskVersion,
    candidateVersion
  };
}

describe("fixture correction HTTP flow", () => {
  let tempDir = "";

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "recruitos-web-correction-"));
    const databasePath = join(tempDir, "runtime.db");
    const runtime = createRuntime(demoCompositionOptions({ database: { filename: databasePath } }));
    if (!runtime.ok) {
      throw new Error(runtime.error.message);
    }
    const composition = createCompositionFromRuntime(runtime.value, databasePath);
    if (!composition.prepareDemo) {
      throw new Error("prepareDemo is required");
    }
    const prepared = await composition.prepareDemo({});
    if (!prepared.ok) {
      throw new Error(prepared.error.message);
    }
    setServerComposition(composition);
    setCorrectionFixtureMode(true);
  }, 120_000);

  afterAll(async () => {
    const composition = getServerComposition();
    if (composition.ok && composition.value instanceof RuntimeRecruitosComposition) {
      composition.value.runtime.close();
    }
    resetServerComposition();
    setCorrectionFixtureMode(false);
    if (tempDir.length > 0) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a request that pairs the route-4 candidate with another candidate's task", async () => {
    const route4 = await loadRoute4PacketForm();
    const runtime = getServerRuntime();
    expect(runtime).not.toBeNull();
    if (runtime === null) return;
    const tasks = listAllResolutionTaskSummaries(runtime.connection.database);
    expect(tasks.ok).toBe(true);
    if (!tasks.ok) return;
    const otherTask = tasks.value.find((task) => task.candidateId !== route4.candidateId);
    expect(otherTask).toBeDefined();
    if (otherTask === undefined) return;
    const before = countRequestActions();
    const mismatched = await handleRequest(
      "/actions/request-re-extraction",
      new URLSearchParams("theme=light&density=default"),
      {
        method: "POST",
        body: new URLSearchParams({
          candidateId: route4.candidateId,
          taskId: otherTask.resolutionTaskId,
          rationale: "Pair route 4 with another candidate task",
          expectedTaskHeadVersion: route4.taskVersion,
          expectedCandidateHeadVersion: route4.candidateVersion
        })
      }
    );
    expect(mismatched.statusCode).toBe(403);
    expect(mismatched.body).toContain("Posted taskId does not belong to posted candidateId.");
    expect(countRequestActions()).toBe(before);
  });

  it("rejects a complete post that pairs the route-4 candidate with a main_run attempt", async () => {
    const route4 = await loadRoute4PacketForm();
    const beforeRequests = countRequestActions();
    const beforeAttempts = countCorrectionAttempts();
    const mismatched = await handleRequest(
      "/actions/complete-fixture-extraction",
      new URLSearchParams("theme=light&density=default"),
      {
        method: "POST",
        body: new URLSearchParams({
          candidateId: route4.candidateId,
          taskId: route4.taskId,
          triageAttemptId: readMainRunAttemptId(),
          expectedTaskHeadVersion: route4.taskVersion,
          expectedCandidateHeadVersion: route4.candidateVersion
        })
      }
    );
    expect(mismatched.statusCode).toBe(403);
    expect(mismatched.body).toContain("candidate_correction");
    expect(countRequestActions()).toBe(beforeRequests);
    expect(countCorrectionAttempts()).toBe(beforeAttempts);
  });

  it("requests re-extraction, rejects a stale second submit, then completes the fixture overlay", async () => {
    const listed = await handleRequest("/api/candidates", new URLSearchParams());
    const candidates = JSON.parse(listed.body) as Array<{
      candidateId: string;
      sourceKey: string;
    }>;
    const route4 = candidates.find((candidate) => candidate.sourceKey === FIXTURE_CORRECTION_SOURCE_KEY);
    expect(route4).toBeDefined();
    if (!route4) return;

    const packetPage = await handleRequest(
      `/packet/${route4.candidateId}`,
      new URLSearchParams("theme=light&density=default")
    );
    expect(packetPage.statusCode).toBe(200);
    expect(packetPage.body).toContain(`data-testid="${TEST_IDS.TASK_INSPECTOR}"`);
    expect(packetPage.body).toContain(`data-testid="${TEST_IDS.RESOLUTION_FORM}"`);
    expect(packetPage.body).toContain("Request re-extraction");
    expect(packetPage.body).not.toContain("system:runtime");
    const originalResultId = /data-result-id="([^"]+)"/.exec(packetPage.body)?.[1];
    expect(originalResultId).toBeDefined();
    const taskVersion = /name="expectedTaskHeadVersion" value="([^"]+)"/.exec(packetPage.body)?.[1];
    const candidateVersion = /name="expectedCandidateHeadVersion" value="([^"]+)"/.exec(
      packetPage.body
    )?.[1];
    const taskId = /name="taskId" value="([^"]+)"/.exec(packetPage.body)?.[1];
    expect(taskVersion).toBeDefined();
    expect(candidateVersion).toBeDefined();
    expect(taskId).toBeDefined();
    if (taskVersion === undefined || candidateVersion === undefined || taskId === undefined) {
      return;
    }

    const appearance = new URLSearchParams("theme=light&density=default");
    const unknown = await handleRequest("/actions/not-a-real-action", appearance, {
      method: "POST",
      body: new URLSearchParams()
    });
    expect(unknown.statusCode).toBe(404);
    const body = new URLSearchParams({
      candidateId: route4.candidateId,
      taskId,
      rationale: "Need the fixture overlay",
      expectedTaskHeadVersion: taskVersion,
      expectedCandidateHeadVersion: candidateVersion
    });
    const requested = await handleRequest("/actions/request-re-extraction", appearance, {
      method: "POST",
      body
    });
    expect(requested.statusCode).toBe(303);
    const location = requested.headers.Location;
    expect(location).toBeDefined();
    if (location === undefined) return;
    expect(location).toContain("correction_attempt=");
    expect(location).toContain("notice=reextraction_requested");
    expect(countRequestActions()).toBe(1);

    const stale = await handleRequest("/actions/request-re-extraction", appearance, {
      method: "POST",
      body: new URLSearchParams({
        candidateId: route4.candidateId,
        taskId,
        rationale: "Second browser still has this rationale",
        expectedTaskHeadVersion: taskVersion,
        expectedCandidateHeadVersion: candidateVersion
      })
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toContain(`data-testid="${TEST_IDS.CONFLICT_ERROR_BANNER}"`);
    expect(stale.body.toLowerCase()).toContain("stale");
    expect(stale.body).toContain("Second browser still has this rationale");
    expect(stale.body).toContain("There is no Save anyway.");
    expect(stale.body).toContain("packet-conflict-slot");
    expect(countRequestActions()).toBe(1);

    const requestUrl = new URL(location, "http://127.0.0.1");
    const afterRequest = await handleRequest(requestUrl.pathname, requestUrl.searchParams);
    expect(afterRequest.body).toContain(`data-testid="${TEST_IDS.TOAST_SUCCESS}"`);
    expect(afterRequest.body).toContain(`data-testid="${TEST_IDS.COMPLETE_FIXTURE_BTN}"`);
    const attemptId = requestUrl.searchParams.get("correction_attempt");
    const completeTaskVersion = /name="expectedTaskHeadVersion" value="([^"]+)"/.exec(
      afterRequest.body
    )?.[1];
    const completeCandidateVersion = /name="expectedCandidateHeadVersion" value="([^"]+)"/.exec(
      afterRequest.body
    )?.[1];
    expect(attemptId).toBeTruthy();
    expect(completeTaskVersion).toBeDefined();
    expect(completeCandidateVersion).toBeDefined();
    if (
      attemptId === null ||
      completeTaskVersion === undefined ||
      completeCandidateVersion === undefined
    ) {
      return;
    }

    const completed = await handleRequest(
      "/actions/complete-fixture-extraction",
      appearance,
      {
        method: "POST",
        body: new URLSearchParams({
          candidateId: route4.candidateId,
          taskId,
          triageAttemptId: attemptId,
          expectedTaskHeadVersion: completeTaskVersion,
          expectedCandidateHeadVersion: completeCandidateVersion
        })
      }
    );
    expect(completed.statusCode).toBe(303);
    const completeLocation = completed.headers.Location;
    expect(completeLocation).toBeDefined();
    if (completeLocation === undefined) return;
    expect(completeLocation).toContain("prior=");
    expect(completeLocation).toContain("notice=correction_complete");

    const completeUrl = new URL(completeLocation, "http://127.0.0.1");
    const current = await handleRequest(completeUrl.pathname, completeUrl.searchParams);
    expect(current.statusCode).toBe(200);
    expect(current.body).toContain("result kind: correction");
    expect(current.body).toContain("scored");
    expect(current.body).toContain("review_required");
    expect(current.body).toContain(`data-testid="${TEST_IDS.PRIOR_VERSION_LINK}"`);
    expect(current.body).toContain(`data-result-kind="correction"`);

    const priorId = completeUrl.searchParams.get("prior") ?? originalResultId;
    expect(priorId).toBeTruthy();
    if (!priorId) return;
    const historical = await handleRequest(
      `/packet/${route4.candidateId}`,
      new URLSearchParams(`theme=light&density=default&result=${priorId}`)
    );
    expect(historical.body).toContain("Inspecting: historical result");
    expect(historical.body).toContain("escalated");
    expect(historical.body).toContain("assessment_unavailable");
  }, 120_000);
});
