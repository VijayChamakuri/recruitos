import { afterEach, describe, expect, it } from "vitest";
import { err, ok } from "@recruitos/core";
import type {
  CandidatePacket,
  RecruitosComposition,
  ResolutionTaskDetail
} from "@recruitos/cli";
import {
  completeFixtureReExtractionAction,
  readCorrectionAttemptBinding,
  readCorrectionAttemptId,
  requestReExtractionAction,
  staleConflictCopy
} from "./correction-actions.js";
import { setCorrectionFixtureMode } from "./correction-mode.js";
import { FIXTURE_CORRECTION_SOURCE_KEY } from "./form-body.js";

function fixturePacket(sourceKey = FIXTURE_CORRECTION_SOURCE_KEY): CandidatePacket {
  return {
    candidateId: "cand-1",
    sourceKey,
    channel: "inbound",
    corpusTag: "main",
    roleId: "role-default",
    roleTitle: "Staff Software Engineer",
    status: "escalated",
    score: null,
    confidence: null,
    scoreText: null,
    confidenceText: null,
    confidenceInput: null,
    reasons: ["assessment_unavailable"],
    contentHash: "abc",
    sealed: false,
    createdAt: 1,
    arithmeticTerms: [],
    evidenceSpans: [],
    evidenceGaps: [],
    documents: [],
    tasks: [],
    isHistoricalResult: false,
    resultId: "result-1",
    headVersion: 1
  };
}

function fixtureTask(candidateId = "cand-1"): ResolutionTaskDetail {
  return {
    resolutionTaskId: "task-1",
    candidateId,
    candidateResultId: "result-1",
    reasonCode: "assessment_unavailable",
    status: "open",
    taskOrdinal: 1,
    version: 1,
    createdAt: 1,
    actions: []
  };
}

function matchingAttemptDatabase(
  overrides: Partial<{
    kind: string;
    scopeCandidateId: string | null;
    requestTaskId: string | null;
  }> = {}
): { prepare: () => { get: () => Record<string, unknown> } } {
  return {
    prepare: () => ({
      get: () => ({
        kind: overrides.kind ?? "candidate_correction",
        scopeCandidateId: overrides.scopeCandidateId ?? "cand-1",
        requestTaskId: overrides.requestTaskId ?? "task-1"
      })
    })
  };
}

function composition(
  overrides: Partial<RecruitosComposition> = {}
): RecruitosComposition {
  return {
    getCandidatePacket: async () => ok(fixturePacket()),
    getResolutionTask: async () => ok(fixtureTask()),
    recordResolutionAction: async () =>
      ok({
        actionId: "action-1",
        newVersion: 2,
        derivedStatus: "open",
        triageAttemptId: "attempt-1",
        commandId: "command-1"
      }),
    extractTriage: async () =>
      ok({
        triageAttemptId: "attempt-1",
        totalWorkItems: 1,
        alreadySucceeded: 0,
        processed: 1,
        succeeded: 1,
        reviewableFailures: 0,
        blockedFailures: 0,
        reusedArtifacts: 0,
        spansReturned: 1,
        spansLocated: 1,
        droppedQuoteCount: 0
      }),
    registerExtractionFixtures: () => ok(undefined),
    completeReExtraction: async () =>
      ok({
        commandId: "complete-1",
        triageAttemptId: "attempt-1",
        resolutionTaskId: "task-1",
        resolutionActionId: "action-2",
        resultId: "result-2",
        baseResultId: "result-1",
        candidateHeadVersion: 2,
        taskHeadVersion: 3,
        derivedStatus: "review_required"
      }),
    ...overrides
  } as RecruitosComposition;
}

const requestBody = new URLSearchParams({
  candidateId: "cand-1",
  taskId: "task-1",
  rationale: "Need the fixture overlay",
  expectedTaskHeadVersion: "1",
  expectedCandidateHeadVersion: "1"
});

const completeBody = new URLSearchParams({
  candidateId: "cand-1",
  taskId: "task-1",
  triageAttemptId: "attempt-1",
  expectedTaskHeadVersion: "2",
  expectedCandidateHeadVersion: "1"
});

describe("correction actions", () => {
  afterEach(() => {
    setCorrectionFixtureMode(false);
  });

  it("fails closed when fixture mode is off", async () => {
    const requested = await requestReExtractionAction(composition(), requestBody);
    expect(requested.ok).toBe(false);
    if (requested.ok) return;
    expect(requested.error.httpStatus).toBe(403);
    const completed = await completeFixtureReExtractionAction(
      composition(),
      completeBody,
      matchingAttemptDatabase()
    );
    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.error.httpStatus).toBe(403);
  });

  it("rejects extracted facts, the system actor, and non-fixture candidates", async () => {
    setCorrectionFixtureMode(true);
    const facts = new URLSearchParams(requestBody);
    facts.set("evidenceText", "not allowed");
    const factResult = await requestReExtractionAction(composition(), facts);
    expect(factResult.ok).toBe(false);
    if (factResult.ok) return;
    expect(factResult.error.message).toContain("extracted facts");

    const system = new URLSearchParams(requestBody);
    system.set("actorId", "system:runtime");
    const actorResult = await requestReExtractionAction(composition(), system);
    expect(actorResult.ok).toBe(false);
    if (actorResult.ok) return;
    expect(actorResult.error.message).toContain("system actor");

    const other = await requestReExtractionAction(
      composition({
        getCandidatePacket: async () => ok(fixturePacket("demo/route-1-scored"))
      }),
      requestBody
    );
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(other.error.httpStatus).toBe(403);
  });

  it("records request_re_extraction as human:operator and returns the attempt id", async () => {
    setCorrectionFixtureMode(true);
    let seenActor: string | undefined;
    const requested = await requestReExtractionAction(
      composition({
        recordResolutionAction: async (input) => {
          seenActor = input.actorId;
          expect(input.actionKind).toBe("request_re_extraction");
          expect(input.expectedVersion).toBe(1);
          expect(input.expectedCandidateHeadVersion).toBe(1);
          return ok({
            actionId: "action-1",
            newVersion: 2,
            derivedStatus: "open",
            triageAttemptId: "attempt-1",
            commandId: "command-1"
          });
        }
      }),
      requestBody
    );
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    expect(seenActor).toBe("human:operator");
    expect(requested.value.triageAttemptId).toBe("attempt-1");
  });

  it("maps a version conflict to HTTP 409 with stale copy", async () => {
    setCorrectionFixtureMode(true);
    const requested = await requestReExtractionAction(
      composition({
        recordResolutionAction: async () =>
          err({
            code: "version_conflict",
            message: "Mutable head version conflict",
            retryable: false,
            details: { expectedVersion: 1, actualVersion: 2, table: "resolution_task_head" }
          })
      }),
      requestBody
    );
    expect(requested.ok).toBe(false);
    if (requested.ok) return;
    expect(requested.error.httpStatus).toBe(409);
    expect(staleConflictCopy(requested.error)).toContain("stale");
    expect(staleConflictCopy(requested.error)).toContain("v1");
    expect(staleConflictCopy(requested.error)).toContain("v2");
  });

  it("completes through overlay, scheduler, and system-only completeReExtraction", async () => {
    setCorrectionFixtureMode(true);
    let overlay = false;
    let extracted = false;
    let completeActor: string | undefined;
    const completed = await completeFixtureReExtractionAction(
      composition({
        registerExtractionFixtures: (_attempt, options) => {
          overlay = options?.overlay === true;
          return ok(undefined);
        },
        extractTriage: async () => {
          extracted = true;
          return ok({
            triageAttemptId: "attempt-1",
            totalWorkItems: 1,
            alreadySucceeded: 0,
            processed: 1,
            succeeded: 1,
            reviewableFailures: 0,
            blockedFailures: 0,
            reusedArtifacts: 0,
            spansReturned: 1,
            spansLocated: 1,
            droppedQuoteCount: 0
          });
        },
        completeReExtraction: async (input) => {
          completeActor = input.actorId;
          expect(input.expectedTaskHeadVersion).toBe(2);
          expect(input.expectedCandidateHeadVersion).toBe(1);
          return ok({
            commandId: "complete-1",
            triageAttemptId: input.triageAttemptId,
            resolutionTaskId: "task-1",
            resolutionActionId: "action-2",
            resultId: "result-2",
            baseResultId: "result-1",
            candidateHeadVersion: 2,
            taskHeadVersion: 3,
            derivedStatus: "review_required"
          });
        }
      }),
      completeBody,
      matchingAttemptDatabase()
    );
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(overlay).toBe(true);
    expect(extracted).toBe(true);
    expect(completeActor).toBe("system:runtime");
    expect(completed.value.baseResultId).toBe("result-1");
    expect(completed.value.derivedStatus).toBe("review_required");
  });

  it("rejects missing fields and non-request action kinds", async () => {
    setCorrectionFixtureMode(true);
    const missing = await requestReExtractionAction(composition(), new URLSearchParams());
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.httpStatus).toBe(400);

    const wrongKind = new URLSearchParams(requestBody);
    wrongKind.set("actionKind", "supply_evidence");
    const wrong = await requestReExtractionAction(composition(), wrongKind);
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error.message).toContain("request_re_extraction");
  });

  it("fails when completeReExtraction is missing or extractTriage fails", async () => {
    setCorrectionFixtureMode(true);
    const missingComplete = await completeFixtureReExtractionAction(
      composition({ completeReExtraction: undefined }),
      completeBody,
      matchingAttemptDatabase()
    );
    expect(missingComplete.ok).toBe(false);
    if (missingComplete.ok) return;
    expect(missingComplete.error.message).toContain("completeReExtraction");

    const extractFailed = await completeFixtureReExtractionAction(
      composition({
        extractTriage: async () =>
          err({ code: "persistence_failed", message: "extract failed", retryable: false })
      }),
      completeBody,
      matchingAttemptDatabase()
    );
    expect(extractFailed.ok).toBe(false);
  });

  it("fails when fixture helpers are missing", async () => {
    setCorrectionFixtureMode(true);
    const missing = await completeFixtureReExtractionAction(
      composition({ registerExtractionFixtures: undefined }),
      completeBody,
      matchingAttemptDatabase()
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.message).toContain("Extraction fixtures");
  });

  it("fails closed when request_re_extraction omits the attempt id", async () => {
    setCorrectionFixtureMode(true);
    const requested = await requestReExtractionAction(
      composition({
        recordResolutionAction: async () =>
          ok({
            actionId: "action-1",
            newVersion: 2,
            derivedStatus: "open",
            commandId: "command-1"
          })
      }),
      requestBody
    );
    expect(requested.ok).toBe(false);
    if (requested.ok) return;
    expect(requested.error.httpStatus).toBe(500);
  });

  it("rejects complete posts that omit versions or include facts", async () => {
    setCorrectionFixtureMode(true);
    const missing = await completeFixtureReExtractionAction(
      composition(),
      new URLSearchParams(),
      matchingAttemptDatabase()
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.httpStatus).toBe(400);
    const facts = new URLSearchParams(completeBody);
    facts.set("extractedFacts", "[]");
    const factResult = await completeFixtureReExtractionAction(
      composition(),
      facts,
      matchingAttemptDatabase()
    );
    expect(factResult.ok).toBe(false);

    const system = new URLSearchParams(completeBody);
    system.set("actorId", "system:runtime");
    const actorResult = await completeFixtureReExtractionAction(
      composition(),
      system,
      matchingAttemptDatabase()
    );
    expect(actorResult.ok).toBe(false);
    if (actorResult.ok) return;
    expect(actorResult.error.message).toContain("system actor");
  });

  it("rejects a posted task that belongs to another candidate", async () => {
    setCorrectionFixtureMode(true);
    let recorded = false;
    const requested = await requestReExtractionAction(
      composition({
        getResolutionTask: async () => ok(fixtureTask("cand-other")),
        recordResolutionAction: async () => {
          recorded = true;
          return ok({
            actionId: "action-1",
            newVersion: 2,
            derivedStatus: "open",
            triageAttemptId: "attempt-1",
            commandId: "command-1"
          });
        }
      }),
      requestBody
    );
    expect(requested.ok).toBe(false);
    if (requested.ok) return;
    expect(requested.error.httpStatus).toBe(403);
    expect(requested.error.message).toContain("taskId");
    expect(recorded).toBe(false);
  });

  it("maps a missing posted task to HTTP 404", async () => {
    setCorrectionFixtureMode(true);
    let recorded = false;
    const requested = await requestReExtractionAction(
      composition({
        getResolutionTask: async () =>
          err({ code: "not_found", message: "Resolution task not found", retryable: false }),
        recordResolutionAction: async () => {
          recorded = true;
          return ok({
            actionId: "action-1",
            newVersion: 2,
            derivedStatus: "open",
            triageAttemptId: "attempt-1",
            commandId: "command-1"
          });
        }
      }),
      requestBody
    );
    expect(requested.ok).toBe(false);
    if (requested.ok) return;
    expect(requested.error.httpStatus).toBe(404);
    expect(recorded).toBe(false);
  });

  it("rejects complete posts that omit taskId", async () => {
    setCorrectionFixtureMode(true);
    const body = new URLSearchParams(completeBody);
    body.delete("taskId");
    let overlay = false;
    const completed = await completeFixtureReExtractionAction(
      composition({
        registerExtractionFixtures: () => {
          overlay = true;
          return ok(undefined);
        }
      }),
      body,
      matchingAttemptDatabase()
    );
    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.error.httpStatus).toBe(400);
    expect(overlay).toBe(false);
  });

  it("rejects complete posts whose task belongs to another candidate", async () => {
    setCorrectionFixtureMode(true);
    let overlay = false;
    const completed = await completeFixtureReExtractionAction(
      composition({
        getResolutionTask: async () => ok(fixtureTask("cand-other")),
        registerExtractionFixtures: () => {
          overlay = true;
          return ok(undefined);
        }
      }),
      completeBody,
      matchingAttemptDatabase()
    );
    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.error.httpStatus).toBe(403);
    expect(completed.error.message).toContain("taskId");
    expect(overlay).toBe(false);
  });

  it("rejects complete posts whose attempt belongs to another candidate", async () => {
    setCorrectionFixtureMode(true);
    let overlay = false;
    const completed = await completeFixtureReExtractionAction(
      composition({
        registerExtractionFixtures: () => {
          overlay = true;
          return ok(undefined);
        }
      }),
      completeBody,
      matchingAttemptDatabase({ scopeCandidateId: "cand-other" })
    );
    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.error.httpStatus).toBe(403);
    expect(completed.error.message).toContain("triageAttemptId");
    expect(overlay).toBe(false);
  });

  it("rejects complete posts whose attempt belongs to another task", async () => {
    setCorrectionFixtureMode(true);
    let overlay = false;
    const completed = await completeFixtureReExtractionAction(
      composition({
        registerExtractionFixtures: () => {
          overlay = true;
          return ok(undefined);
        }
      }),
      completeBody,
      matchingAttemptDatabase({ requestTaskId: "task-other" })
    );
    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.error.httpStatus).toBe(403);
    expect(completed.error.message).toContain("taskId");
    expect(overlay).toBe(false);
  });

  it("rejects complete posts that target a main_run attempt", async () => {
    setCorrectionFixtureMode(true);
    let overlay = false;
    const completed = await completeFixtureReExtractionAction(
      composition({
        registerExtractionFixtures: () => {
          overlay = true;
          return ok(undefined);
        }
      }),
      completeBody,
      matchingAttemptDatabase({
        kind: "main_run",
        scopeCandidateId: null,
        requestTaskId: null
      })
    );
    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.error.httpStatus).toBe(403);
    expect(completed.error.message).toContain("candidate_correction");
    expect(overlay).toBe(false);
  });

  it("rejects complete posts when the attempt row is missing", async () => {
    setCorrectionFixtureMode(true);
    let overlay = false;
    const completed = await completeFixtureReExtractionAction(
      composition({
        registerExtractionFixtures: () => {
          overlay = true;
          return ok(undefined);
        }
      }),
      completeBody,
      {
        prepare: () => ({
          get: () => undefined
        })
      }
    );
    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.error.httpStatus).toBe(404);
    expect(overlay).toBe(false);
  });

  it("fails closed when complete cannot open a database", async () => {
    setCorrectionFixtureMode(true);
    let overlay = false;
    const completed = await completeFixtureReExtractionAction(
      composition({
        registerExtractionFixtures: () => {
          overlay = true;
          return ok(undefined);
        }
      }),
      completeBody,
      null
    );
    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.error.httpStatus).toBe(500);
    expect(overlay).toBe(false);
  });

  it("reads a correction attempt id from the native client and fails closed otherwise", () => {
    expect(readCorrectionAttemptId(null, "action-1")).toBeUndefined();
    expect(
      readCorrectionAttemptId(
        {
          prepare: () => ({
            get: () => ({ triageAttemptId: "attempt-9" })
          })
        },
        "action-1"
      )
    ).toBe("attempt-9");
    expect(
      readCorrectionAttemptId(
        {
          $client: {
            prepare: () => ({
              get: () => {
                throw new Error("boom");
              }
            })
          }
        },
        "action-1"
      )
    ).toBeUndefined();
    expect(staleConflictCopy({ code: "command_conflict", message: "already in flight" })).toContain(
      "stale"
    );
    const bound = readCorrectionAttemptBinding(matchingAttemptDatabase(), "attempt-1");
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.value.kind).toBe("candidate_correction");
    expect(bound.value.scopeCandidateId).toBe("cand-1");
    expect(bound.value.requestTaskId).toBe("task-1");
    const thrown = readCorrectionAttemptBinding(
      {
        prepare: () => ({
          get: () => {
            throw new Error("boom");
          }
        })
      },
      "attempt-1"
    );
    expect(thrown.ok).toBe(false);
    if (thrown.ok) return;
    expect(thrown.error.httpStatus).toBe(500);
  });
});
