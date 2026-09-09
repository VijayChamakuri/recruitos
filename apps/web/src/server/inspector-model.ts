import type {
  CandidatePacket,
  PacketResolutionTask,
  RecruitosComposition,
  ResolutionTaskDetail
} from "@recruitos/cli";
import { hrefWithAppearance, type Appearance } from "../appearance.js";
import { getServerRuntime } from "./composition.js";
import { readCorrectionAttemptId } from "./correction-actions.js";
import { isCorrectionFixtureMode } from "./correction-mode.js";
import { FIXTURE_CORRECTION_SOURCE_KEY } from "./form-body.js";

export type PacketInspectorModel = Readonly<{
  appearance: Appearance;
  packet: CandidatePacket;
  correctionFixtureMode: boolean;
  fixtureCandidate: boolean;
  historical: boolean;
  task: PacketResolutionTask | undefined;
  taskDetail: ResolutionTaskDetail | undefined;
  inFlight: boolean;
  triageAttemptId: string | undefined;
  expectedTaskHeadVersion: number | undefined;
  expectedCandidateHeadVersion: number | undefined;
  conflictMessage: string | undefined;
  preservedRationale: string | undefined;
  freezeSubmit: boolean;
  notice: string | undefined;
  priorResultId: string | undefined;
  requestActionHref: string;
  completeActionHref: string;
}>;

export function selectInspectorTask(
  tasks: readonly PacketResolutionTask[]
): PacketResolutionTask | undefined {
  return (
    tasks.find((task) => task.status === "open") ??
    tasks.find((task) => task.status === "review_required")
  );
}

function currentActionKind(detail: ResolutionTaskDetail | undefined): string | undefined {
  if (detail === undefined) {
    return undefined;
  }
  if (detail.currentActionId === undefined) {
    return undefined;
  }
  return detail.actions.find((action) => action.actionId === detail.currentActionId)?.actionKind;
}

export async function loadPacketInspectorModel(input: {
  composition: RecruitosComposition;
  packet: CandidatePacket;
  appearance: Appearance;
  searchParams: URLSearchParams;
  conflictMessage?: string;
  preservedRationale?: string;
  freezeSubmit?: boolean;
  expectedTaskHeadVersion?: number;
  expectedCandidateHeadVersion?: number;
}): Promise<PacketInspectorModel> {
  const task = selectInspectorTask(input.packet.tasks);
  let taskDetail: ResolutionTaskDetail | undefined;
  if (task !== undefined) {
    const loaded = await input.composition.getResolutionTask(task.resolutionTaskId);
    if (loaded.ok) {
      taskDetail = loaded.value;
    }
  }
  const queryAttempt = input.searchParams.get("correction_attempt") ?? undefined;
  const runtime = getServerRuntime();
  const lookedUpAttempt =
    runtime !== null && taskDetail?.currentActionId !== undefined
      ? readCorrectionAttemptId(runtime.connection.database, taskDetail.currentActionId)
      : undefined;
  const inFlight = currentActionKind(taskDetail) === "request_re_extraction";
  const triageAttemptId = queryAttempt ?? (inFlight ? lookedUpAttempt : undefined);
  const notice = input.searchParams.get("notice") ?? undefined;
  const priorResultId = input.searchParams.get("prior") ?? undefined;

  return {
    appearance: input.appearance,
    packet: input.packet,
    correctionFixtureMode: isCorrectionFixtureMode(),
    fixtureCandidate: input.packet.sourceKey === FIXTURE_CORRECTION_SOURCE_KEY,
    historical: input.packet.isHistoricalResult,
    task,
    taskDetail,
    inFlight,
    triageAttemptId,
    expectedTaskHeadVersion:
      input.expectedTaskHeadVersion ?? taskDetail?.version ?? task?.version,
    expectedCandidateHeadVersion:
      input.expectedCandidateHeadVersion ?? input.packet.headVersion,
    conflictMessage: input.conflictMessage,
    preservedRationale: input.preservedRationale,
    freezeSubmit: input.freezeSubmit === true,
    notice,
    priorResultId,
    requestActionHref: hrefWithAppearance("/actions/request-re-extraction", input.appearance),
    completeActionHref: hrefWithAppearance("/actions/complete-fixture-extraction", input.appearance)
  };
}
