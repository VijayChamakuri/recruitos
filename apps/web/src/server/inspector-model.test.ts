import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance.js";
import { TEST_IDS } from "../testids.js";
import { renderCandidatePacketView } from "../components/candidate-packet.js";
import { renderTaskInspector } from "../components/task-inspector.js";
import { selectInspectorTask, type PacketInspectorModel } from "./inspector-model.js";
import type { CandidatePacket, PacketResolutionTask } from "@recruitos/cli";

function packet(tasks: PacketResolutionTask[]): CandidatePacket {
  return {
    candidateId: "cand-1",
    sourceKey: "demo/route-4-reviewable-failure",
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
    tasks,
    isHistoricalResult: false,
    resultId: "result-1",
    resultKind: "main_run",
    headVersion: 1
  };
}

function task(
  status: PacketResolutionTask["status"],
  id = "task-open"
): PacketResolutionTask {
  return {
    resolutionTaskId: id,
    candidateId: "cand-1",
    candidateResultId: "result-1",
    reasonCode: "assessment_unavailable",
    status,
    taskOrdinal: 1,
    version: 1,
    createdAt: 1,
    listing: "this_result"
  };
}

function model(overrides: Partial<PacketInspectorModel> = {}): PacketInspectorModel {
  const open = task("open");
  const basePacket = packet([open]);
  return {
    appearance: DEFAULT_APPEARANCE,
    packet: basePacket,
    correctionFixtureMode: true,
    fixtureCandidate: true,
    historical: false,
    task: open,
    taskDetail: undefined,
    inFlight: false,
    triageAttemptId: undefined,
    expectedTaskHeadVersion: 1,
    expectedCandidateHeadVersion: 1,
    conflictMessage: undefined,
    preservedRationale: undefined,
    freezeSubmit: false,
    notice: undefined,
    priorResultId: undefined,
    requestActionHref: "/actions/request-re-extraction?theme=light&density=default",
    completeActionHref: "/actions/complete-fixture-extraction?theme=light&density=default",
    ...overrides
  };
}

describe("packet inspector selection and rendering", () => {
  it("prefers an open task over review_required", () => {
    const selected = selectInspectorTask([task("review_required", "t-rev"), task("open", "t-open")]);
    expect(selected?.resolutionTaskId).toBe("t-open");
  });

  it("renders request re-extraction without an actor select or fact inputs", () => {
    const html = renderTaskInspector(model());
    expect(html).toContain(`data-testid="${TEST_IDS.TASK_INSPECTOR}"`);
    expect(html).toContain(`data-testid="${TEST_IDS.RESOLUTION_FORM}"`);
    expect(html).toContain("Request re-extraction");
    expect(html).toContain("human:operator");
    expect(html).not.toContain("system:runtime");
    expect(html).not.toContain("Confirm AI");
    expect(html).not.toContain("name=\"actorId\"");
    expect(html).not.toContain("name=\"evidenceText\"");
    expect(html).toContain(`data-testid="${TEST_IDS.FIXTURE_MODE_MARK}"`);
  });

  it("renders a stale conflict band and keeps the posted rationale", () => {
    const inspector = model({
      freezeSubmit: true,
      conflictMessage:
        "You reviewed task v1. This packet is now v2. The submission is stale. Refresh to the current head. There is no Save anyway.",
      preservedRationale: "Keep this rationale"
    });
    const html = renderCandidatePacketView({
      packet: inspector.packet,
      appearance: inspector.appearance,
      inspector
    });
    expect(html).toContain("packet-conflict-slot");
    expect(html).toContain(`data-testid="${TEST_IDS.CONFLICT_ERROR_BANNER}"`);
    expect(html).toContain("stale");
    expect(html).toContain("Keep this rationale");
    expect(html).toContain("disabled");
    expect(html).toContain("There is no Save anyway.");
    expect(html).not.toContain(`data-testid="${TEST_IDS.COMPLETE_FIXTURE_BTN}"`);
  });

  it("renders the demo-only fixture completion control when in flight", () => {
    const html = renderTaskInspector(
      model({
        inFlight: true,
        triageAttemptId: "attempt-9",
        notice: "reextraction_requested"
      })
    );
    expect(html).toContain(`data-testid="${TEST_IDS.COMPLETE_FIXTURE_BTN}"`);
    expect(html).toContain(`data-testid="${TEST_IDS.TOAST_SUCCESS}"`);
    expect(html).toContain("name=\"triageAttemptId\"");
    expect(html).not.toContain("name=\"actorId\"");
  });

  it("explains live-mode-only for non-fixture candidates", () => {
    const html = renderTaskInspector(model({ fixtureCandidate: false }));
    expect(html).toContain("live-mode-only");
    expect(html).not.toContain(`data-testid="${TEST_IDS.RESOLUTION_FORM}"`);
  });

  it("explains make demo-web-correction when mutations are off", () => {
    const html = renderTaskInspector(model({ correctionFixtureMode: false }));
    expect(html).toContain("make demo-web-correction");
    expect(html).not.toContain(`data-testid="${TEST_IDS.RESOLUTION_FORM}"`);
  });
});
