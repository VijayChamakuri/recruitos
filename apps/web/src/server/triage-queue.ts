import type {
  CandidatePacket,
  CandidateSummary,
  RecruitosComposition,
  ResolutionTaskSummary
} from "@recruitos/cli";
import { err, ok, type Result } from "@recruitos/core";
import {
  coverageCellsForPacket,
  type EvidenceCoverageCell
} from "../components/evidence-coverage-strip.js";

const OUTSTANDING_TASK_STATUSES = new Set(["open", "review_required"]);

export type TriageQueueRow = Readonly<{
  candidate: CandidateSummary;
  tasksCount: number;
  packet: CandidatePacket | null;
  coverage: readonly EvidenceCoverageCell[];
  scoreLabel: string;
  confidenceLabel: string;
}>;

export type TriageQueueModel = Readonly<{
  rows: readonly TriageQueueRow[];
  outstandingTasks: readonly ResolutionTaskSummary[];
  inboundCount: number;
  sourcedCount: number;
  scoredCount: number;
  rejectedHardRequirementCount: number;
  escalatedCount: number;
  outstandingTaskCount: number;
  reasonCodeCounts: readonly { code: string; count: number }[];
  firstCandidateId: string | undefined;
}>;

function isOutstanding(task: ResolutionTaskSummary): boolean {
  return OUTSTANDING_TASK_STATUSES.has(task.status);
}

export function outstandingTaskCountForCandidate(
  candidateId: string,
  tasks: readonly ResolutionTaskSummary[]
): number {
  return tasks.filter((task) => task.candidateId === candidateId && isOutstanding(task)).length;
}

export function tallyReasonCodes(
  candidates: readonly CandidateSummary[]
): readonly { code: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    for (const reason of candidate.reasons) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}

function scoreLabel(candidate: CandidateSummary, packet: CandidatePacket | null): string {
  if (packet?.scoreText) {
    return packet.scoreText;
  }
  if (candidate.score !== null) {
    return candidate.score.toFixed(1);
  }
  return "n/a";
}

function confidenceLabel(candidate: CandidateSummary, packet: CandidatePacket | null): string {
  if (packet?.confidenceText) {
    return packet.confidenceText;
  }
  if (candidate.confidence !== null) {
    return candidate.confidence.toFixed(2);
  }
  return "n/a";
}

export async function loadTriageQueueModel(
  composition: RecruitosComposition
): Promise<Result<TriageQueueModel, { code: string; message: string; retryable: boolean }>> {
  const candidatesResult = await composition.listCandidates({ limit: 50 });
  if (!candidatesResult.ok) {
    return candidatesResult;
  }
  const tasksResult = await composition.listResolutionTasks();
  if (!tasksResult.ok) {
    return tasksResult;
  }

  const candidates = candidatesResult.value;
  const outstandingTasks = tasksResult.value.filter(isOutstanding);
  const packets = await Promise.all(
    candidates.map((candidate) => composition.getCandidatePacket(candidate.candidateId))
  );

  const rows: TriageQueueRow[] = candidates.map((candidate, index) => {
    const packetResult = packets[index];
    const packet = packetResult?.ok === true ? packetResult.value : null;
    return {
      candidate,
      tasksCount: outstandingTaskCountForCandidate(candidate.candidateId, outstandingTasks),
      packet,
      coverage: coverageCellsForPacket(packet),
      scoreLabel: scoreLabel(candidate, packet),
      confidenceLabel: confidenceLabel(candidate, packet)
    };
  });

  return ok({
    rows,
    outstandingTasks,
    inboundCount: candidates.filter((candidate) => candidate.channel === "inbound").length,
    sourcedCount: candidates.filter((candidate) => candidate.channel === "sourced").length,
    scoredCount: candidates.filter((candidate) => candidate.status === "scored").length,
    rejectedHardRequirementCount: candidates.filter(
      (candidate) => candidate.status === "rejected_hard_requirement"
    ).length,
    escalatedCount: candidates.filter((candidate) => candidate.status === "escalated").length,
    outstandingTaskCount: outstandingTasks.length,
    reasonCodeCounts: tallyReasonCodes(candidates),
    firstCandidateId: candidates[0]?.candidateId
  });
}
