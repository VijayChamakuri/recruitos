import type { Result, ReviewDecisionPayload } from "@recruitos/core";
import type { Class1EvaluationReport } from "../evaluation/class1.js";

export type { Class1EvaluationReport } from "../evaluation/class1.js";

export type RuntimeError = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}>;

export type CandidateTriageStatus =
  | "scored"
  | "rejected_hard_requirement"
  | "shortlisted"
  | "reviewed"
  | "escalated"
  | "rejected"
  | "pending";

export type CandidateSummary = Readonly<{
  candidateId: string;
  sourceKey: string;
  channel: "inbound" | "sourced";
  roleId: string;
  roleTitle: string;
  status: CandidateTriageStatus;
  score: number | null;
  confidence: number | null;
  reasons: readonly string[];
  tasksCount: number;
  sealed: boolean;
  createdAt: number;
}>;

export type ArithmeticTerm = Readonly<{
  dimensionId: string;
  dimensionName: string;
  weight: number;
  level: "none" | "weak" | "partial" | "strong";
  levelScore: number;
  weightedScore: number;
}>;

export type EvidenceSpan = Readonly<{
  evidenceSpanId: string;
  dimensionId: string;
  start: number;
  end: number;
  quotedText: string;
  polarity: "supporting" | "contradicting";
  matchQuality: "exact" | "normalized" | "fuzzy";
  documentId: string;
}>;

export type EvidenceGap = Readonly<{
  dimensionId: string;
  reason: string;
}>;

export type CandidateSourceDocumentView = Readonly<{
  documentId: string;
  documentKind: string;
  label: string;
  text: string;
}>;

export type ResolutionTaskStatus =
  | "open"
  | "review_required"
  | "resolved"
  | "dismissed";

export type ResolutionTaskSummary = Readonly<{
  resolutionTaskId: string;
  candidateId: string;
  candidateResultId: string;
  reasonCode: string;
  status: ResolutionTaskStatus;
  taskOrdinal: number;
  currentActionId?: string;
  version: number;
  createdAt: number;
}>;

export type PacketTaskListing = "this_result" | "current_candidate_work";

export type PacketResolutionTask = ResolutionTaskSummary &
  Readonly<{ listing: PacketTaskListing }>;

export type CandidatePacket = Readonly<{
  candidateId: string;
  sourceKey: string;
  channel: "inbound" | "sourced";
  corpusTag: string;
  roleId: string;
  roleTitle: string;
  status: CandidateTriageStatus;
  score: number | null;
  confidence: number | null;
  scoreText: string | null;
  confidenceText: string | null;
  confidenceInput: Readonly<{
    contradictionCount: number;
    dimensionsWithLocatedSpan: number;
    requiredFieldsMissing: number;
    spansLocated: number;
    spansReturned: number;
    totalDimensions: number;
    totalRequiredFields: number;
  }> | null;
  reasons: readonly string[];
  contentHash: string;
  sealed: boolean;
  createdAt: number;
  arithmeticTerms: readonly ArithmeticTerm[];
  evidenceSpans: readonly EvidenceSpan[];
  evidenceGaps: readonly EvidenceGap[];
  documents: readonly CandidateSourceDocumentView[];
  tasks: readonly PacketResolutionTask[];
  isHistoricalResult: boolean;
  resultId?: string;
  resultKind?: string;
  headVersion?: number;
  currentResultId?: string;
}>;

export type TriageRunSummary = Readonly<{
  runId: string;
  roleId: string;
  totalCandidates: number;
  scoredCount: number;
  escalatedCount: number;
  shortlistCount: number;
  sealedCount: number;
  durationMs: number;
  sealed: boolean;
}>;

export type ResolutionTaskDetail = ResolutionTaskSummary &
  Readonly<{
    actions: readonly {
      actionId: string;
      actorId: string;
      actionKind: string;
      rationale: string;
      createdAt: number;
    }[];
  }>;

export type ProposalStatus =
  | "pending"
  | "evidence_requested"
  | "approved"
  | "rejected"
  | "edited";

export type ProposalSummary = Readonly<{
  proposalId: string;
  candidateId: string;
  kind: string;
  status: ProposalStatus;
  proposedChange: string;
  version: number;
  createdAt: number;
}>;

export type SystemStatusSummary = Readonly<{
  databasePath: string;
  schemaVersion: number;
  activeRunId: string;
  candidateCount: number;
  openTasksCount: number;
  pendingProposalsCount: number;
  auditEventsCount: number;
  knownLimitationsCount: number;
  isSealed: boolean;
}>;

export type AuditEventSummary = Readonly<{
  auditEventId: string;
  eventName: string;
  actorId: string;
  occurredAt: number;
  payloadHash: string;
  commandId: string | null;
  eventOrdinal: number | null;
}>;

export type ListCandidatesOptions = Readonly<{
  roleId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  channel?: ("inbound" | "sourced") | undefined;
  status?: CandidateTriageStatus | undefined;
}>;

export type RunTriageOptions = Readonly<{
  roleId?: string | undefined;
  candidateIds?: readonly string[] | undefined;
  dryRun?: boolean | undefined;
}>;

export type ImportCandidatesSummary = Readonly<{
  commandId: string;
  imported: number;
  skipped: number;
  candidateIds: readonly string[];
}>;

export type StartTriageSummary = Readonly<{
  commandId: string;
  triageRunId: string;
  triageAttemptId: string;
  workItemCount: number;
}>;

export type ExtractionAttemptSummary = Readonly<{
  triageAttemptId: string;
  totalWorkItems: number;
  alreadySucceeded: number;
  processed: number;
  succeeded: number;
  reviewableFailures: number;
  blockedFailures: number;
  reusedArtifacts: number;
  spansReturned: number;
  spansLocated: number;
  droppedQuoteCount: number;
}>;

export type FinalizeTriageSummary = Readonly<{
  commandId: string;
  triageRunId: string;
  triageAttemptId: string;
  candidateCount: number;
  resultIds: readonly string[];
}>;

export type CompleteReExtractionSummary = Readonly<{
  commandId: string;
  triageAttemptId: string;
  resolutionTaskId: string;
  resolutionActionId: string;
  resultId: string;
  baseResultId: string;
  candidateHeadVersion: number;
  taskHeadVersion: number;
  derivedStatus: "review_required";
}>;

export type DemoPrepareSummary = Readonly<{
  candidateIds: readonly string[];
  triageAttemptId: string;
  triageRunId: string;
  resultIds: readonly string[];
}>;

export type ListResolutionTasksOptions = Readonly<{
  candidateId?: string | undefined;
  status?: ResolutionTaskStatus | undefined;
}>;

export type RecordResolutionActionInput = Readonly<{
  taskId: string;
  actionKind: string;
  actorId: string;
  rationale: string;
  expectedVersion: number;
  expectedCandidateHeadVersion?: number;
  commandId?: string;
}>;

export type ListProposalsOptions = Readonly<{
  candidateId?: string | undefined;
  status?: ProposalStatus | undefined;
}>;

export type RecordReviewDecisionInput = Readonly<{
  proposalId: string;
  actorId: string;
  expectedVersion: number;
  decision: ReviewDecisionPayload;
  commandId?: string;
}>;

export type ListAuditEventsOptions = Readonly<{
  cursor?: string | undefined;
  limit?: number | undefined;
}>;

export interface RecruitosComposition {
  prepareDemo?(input: Readonly<{
    actorId?: string;
  }>): Promise<Result<DemoPrepareSummary, RuntimeError>>;

  evaluateClass1?(
    candidateId: string
  ): Promise<Result<Class1EvaluationReport, RuntimeError>>;

  importCandidates(input: Readonly<{
    actorId: string;
    corpusTag?: "main" | "variant" | undefined;
  }>): Promise<Result<ImportCandidatesSummary, RuntimeError>>;

  startTriage(input: Readonly<{
    actorId: string;
    roleId: string;
    candidateIds: readonly string[];
    kind?: "main_run" | "variant_run" | undefined;
  }>): Promise<Result<StartTriageSummary, RuntimeError>>;

  extractTriage(
    triageAttemptId: string
  ): Promise<Result<ExtractionAttemptSummary, RuntimeError>>;

  registerExtractionFixtures?(
    triageAttemptId: string,
    options?: { overlay?: boolean }
  ): Result<void, RuntimeError>;

  completeReExtraction?(input: Readonly<{
    actorId: string;
    triageAttemptId: string;
    expectedTaskHeadVersion: number;
    expectedCandidateHeadVersion: number;
    commandId?: string;
  }>): Promise<Result<CompleteReExtractionSummary, RuntimeError>>;

  finalizeTriage(input: Readonly<{
    actorId: string;
    triageAttemptId: string;
    triageRunId?: string | undefined;
  }>): Promise<Result<FinalizeTriageSummary, RuntimeError>>;

  listCandidates(
    options?: ListCandidatesOptions
  ): Promise<Result<readonly CandidateSummary[], RuntimeError>>;

  getCandidatePacket(
    candidateId: string,
    options?: { resultId?: string }
  ): Promise<Result<CandidatePacket, RuntimeError>>;

  runTriage(
    options?: RunTriageOptions
  ): Promise<Result<TriageRunSummary, RuntimeError>>;

  getStatus(): Promise<Result<SystemStatusSummary, RuntimeError>>;

  listResolutionTasks(
    options?: ListResolutionTasksOptions
  ): Promise<Result<readonly ResolutionTaskSummary[], RuntimeError>>;

  getResolutionTask(
    taskId: string
  ): Promise<Result<ResolutionTaskDetail, RuntimeError>>;

  recordResolutionAction(
    input: RecordResolutionActionInput
  ): Promise<
    Result<
      {
        actionId: string;
        newVersion: number;
        derivedStatus: ResolutionTaskStatus;
        triageAttemptId?: string;
        commandId: string;
      },
      RuntimeError
    >
  >;

  listProposals(
    options?: ListProposalsOptions
  ): Promise<Result<readonly ProposalSummary[], RuntimeError>>;

  recordReviewDecision(
    input: RecordReviewDecisionInput
  ): Promise<
    Result<{ decisionId: string; newVersion: number; status: ProposalStatus; commandId: string }, RuntimeError>
  >;

  listAuditEvents(
    options?: ListAuditEventsOptions
  ): Promise<Result<readonly AuditEventSummary[], RuntimeError>>;
}
