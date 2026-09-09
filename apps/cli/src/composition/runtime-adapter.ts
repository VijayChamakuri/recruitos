import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { err, ok, type Result } from "@recruitos/core";
import {
  createRuntime,
  demoCompositionOptions,
  type CreateRuntimeOptions,
  type IdGenerator,
  type RuntimeComposition
} from "@recruitos/runtime/composition";

import type {
  AuditEventSummary,
  CandidatePacket,
  CandidateSummary,
  CandidateTriageStatus,
  ListAuditEventsOptions,
  ListCandidatesOptions,
  ListProposalsOptions,
  ListResolutionTasksOptions,
  PacketResolutionTask,
  PacketTaskListing,
  ProposalSummary,
  RecordResolutionActionInput,
  RecordReviewDecisionInput,
  RecruitosComposition,
  ResolutionTaskDetail,
  ResolutionTaskSummary,
  RunTriageOptions,
  RuntimeError,
  SystemStatusSummary,
  TriageRunSummary
} from "./types.js";
import { StubRecruitosComposition } from "./stub.js";

import {
  completeReExtraction,
  demoPrepare,
  importCandidates,
  listAuditEvents,
  listCandidates,
  listProposals,
  listResolutionTasks,
  recordReviewDecision as recordProposalReviewDecision,
  registerDemoCorrectionFixtures,
  registerDemoFixtures,
  requestReExtraction,
  runExtractionAttempt,
  startTriageRun,
  finalizeTriageRun,
  createRuntimeError,
  deriveResolutionTaskStatus,
  runImmediateTransaction,
  readResolutionTask,
  readResolutionTaskHead,
  readResolutionActions,
  readCandidateTriageResult,
  type AuditEventItem,
  type CandidatePacketModel,
  type CandidateSummaryItem,
  type ProposalListItem,
  type ResolutionTaskItem
} from "@recruitos/runtime";
import { loadCandidatePacketSnapshot } from "./packet-snapshot.js";
import { runClass1EvaluationForFinalizedCandidate } from "../evaluation/index.js";

function toRuntimeCandidateStatus(
  status?: CandidateTriageStatus
): "scored" | "rejected_hard_requirement" | "escalated" | "pending" | undefined {
  if (!status) return undefined;
  if (status === "scored" || status === "shortlisted" || status === "reviewed") {
    return "scored";
  }
  if (status === "rejected_hard_requirement" || status === "rejected") {
    return "rejected_hard_requirement";
  }
  if (status === "escalated") return "escalated";
  if (status === "pending") return "pending";
  return undefined;
}

function toCliCandidateStatus(
  status: "scored" | "rejected_hard_requirement" | "escalated" | "pending"
): CandidateTriageStatus {
  return status;
}

function toCandidateSummary(item: CandidateSummaryItem): CandidateSummary {
  return {
    candidateId: item.candidateId,
    sourceKey: item.sourceKey,
    channel: item.channel,
    roleId: "role-default",
    roleTitle: "Staff Software Engineer",
    status: toCliCandidateStatus(item.status),
    score: item.scoreBasisPoints !== null ? item.scoreBasisPoints / 100 : null,
    confidence:
      item.confidenceBasisPoints !== null ? item.confidenceBasisPoints / 10_000 : null,
    reasons: item.reasons,
    tasksCount: 0,
    sealed: item.isSealed,
    createdAt: item.createdAt
  };
}

function toAuditEventSummary(item: AuditEventItem): AuditEventSummary {
  return {
    auditEventId: item.auditEventId,
    eventName: item.eventName,
    actorId: item.actorId,
    occurredAt: item.occurredAt,
    payloadHash: item.payloadHash,
    commandId: item.commandId,
    eventOrdinal: item.eventOrdinal
  };
}

function toProposalSummary(item: ProposalListItem): ProposalSummary {
  return {
    proposalId: item.proposalId,
    candidateId: item.candidateId,
    kind: item.kind,
    status: item.status,
    proposedChange: item.proposedChange,
    version: item.version,
    createdAt: item.createdAt
  };
}

function toResolutionTaskSummary(item: ResolutionTaskItem): ResolutionTaskSummary {
  return {
    resolutionTaskId: item.resolutionTaskId,
    candidateId: item.candidateId,
    candidateResultId: item.candidateResultId,
    reasonCode: item.reasonCode,
    status: item.status,
    taskOrdinal: item.taskOrdinal,
    ...(item.currentActionId ? { currentActionId: item.currentActionId } : {}),
    version: item.headVersion,
    createdAt: item.createdAt
  };
}

type ScoreContributionRow = Readonly<{
  dimensionId: string;
  level: "none" | "weak" | "partial" | "strong";
  levelValue: string;
  weight: number;
  weightedValue: string;
}>;

function rationalNumber(value: string): number {
  const [numerator, denominator] = value.split("/").map(Number);
  return denominator ? (numerator ?? 0) / denominator : 0;
}

function packetTaskListing(
  task: ResolutionTaskSummary,
  packetResultId: string,
  isHistoricalResult: boolean
): PacketTaskListing {
  if (isHistoricalResult) {
    return "current_candidate_work";
  }
  return task.candidateResultId === packetResultId
    ? "this_result"
    : "current_candidate_work";
}

function toPacketTasks(
  tasks: readonly ResolutionTaskSummary[],
  packetResultId: string,
  isHistoricalResult: boolean
): readonly PacketResolutionTask[] {
  return tasks.map((task) => ({
    ...task,
    listing: packetTaskListing(task, packetResultId, isHistoricalResult)
  }));
}

function toCandidatePacket(
  packet: CandidatePacketModel,
  nativeClient: NativeClientHandle | null,
  tasks: readonly ResolutionTaskSummary[],
  options: {
    readonly isHistoricalResult: boolean;
    readonly currentResultId: string;
  }
): CandidatePacket {
  let arithmeticTerms: CandidatePacket["arithmeticTerms"] = [];
  let evidenceSpans: CandidatePacket["evidenceSpans"] = [];
  let evidenceGaps: CandidatePacket["evidenceGaps"] = [];
  let documents: CandidatePacket["documents"] = [];

  if (nativeClient) {
    const score = nativeClient
      .prepare("SELECT content_json AS contentJson FROM score_result WHERE candidate_result_id = ?")
      .get(packet.resultId) as { contentJson: string } | undefined;
    if (score) {
      const content = JSON.parse(score.contentJson) as {
        contributions: readonly ScoreContributionRow[];
      };
      const totalWeight = content.contributions.reduce(
        (sum, contribution) => sum + contribution.weight,
        0
      );
      arithmeticTerms = content.contributions.map((contribution) => ({
        dimensionId: contribution.dimensionId,
        dimensionName: contribution.dimensionId,
        weight: totalWeight === 0 ? 0 : (contribution.weight / totalWeight) * 100,
        level: contribution.level,
        levelScore: rationalNumber(contribution.levelValue) * 100,
        weightedScore:
          totalWeight === 0
            ? 0
            : (rationalNumber(contribution.weightedValue) / totalWeight) * 100
      }));
    }

    evidenceSpans = nativeClient.prepare(
      `SELECT
        span.evidence_span_id AS evidenceSpanId,
        span.dimension_id AS dimensionId,
        span.start AS start,
        span.end AS end,
        span.quoted_text AS quotedText,
        span.polarity AS polarity,
        span.match_quality AS matchQuality,
        span.document_id AS documentId
       FROM candidate_result_evidence_span result_span
       JOIN evidence_span span ON span.evidence_span_id = result_span.evidence_span_id
       WHERE result_span.candidate_result_id = ?
       ORDER BY result_span.span_ordinal ASC`
    ).all(packet.resultId) as CandidatePacket["evidenceSpans"];

    evidenceGaps = nativeClient.prepare(
      `SELECT
        result_gap.dimension_id AS dimensionId,
        gap.reason_code AS reason
       FROM candidate_result_evidence_gap result_gap
       JOIN evidence_gap gap ON gap.evidence_gap_id = result_gap.evidence_gap_id
       WHERE result_gap.candidate_result_id = ?
       ORDER BY result_gap.gap_ordinal ASC`
    ).all(packet.resultId) as CandidatePacket["evidenceGaps"];

    documents = nativeClient.prepare(
      `SELECT
        document.source_document_id AS documentId,
        candidate_document.document_kind AS documentKind,
        candidate_document.label AS label,
        document.raw_text AS text
       FROM candidate_document
       JOIN source_document document
         ON document.source_document_id = candidate_document.source_document_id
       WHERE candidate_document.candidate_id = ?
       ORDER BY candidate_document.document_ordinal ASC`
    ).all(packet.candidateId) as CandidatePacket["documents"];
  }

  return {
    candidateId: packet.candidateId,
    sourceKey: packet.sourceKey,
    channel: packet.channel,
    corpusTag: packet.corpusTag,
    roleId: "role-default",
    roleTitle: "Staff Software Engineer",
    status: toCliCandidateStatus(packet.resultStatus),
    score:
      packet.scoreAggregateBasisPoints === null
        ? null
        : packet.scoreAggregateBasisPoints / 100,
    confidence:
      packet.scoreConfidenceBasisPoints === null
        ? null
        : packet.scoreConfidenceBasisPoints / 10_000,
    scoreText: packet.scoreAggregateText,
    confidenceText: packet.scoreConfidenceText,
    confidenceInput: packet.confidenceInput,
    reasons: packet.reasons,
    contentHash: packet.contentHash,
    sealed: packet.isSealed,
    createdAt: packet.createdAt,
    arithmeticTerms,
    evidenceSpans,
    evidenceGaps,
    documents,
    tasks: toPacketTasks(tasks, packet.resultId, options.isHistoricalResult),
    isHistoricalResult: options.isHistoricalResult,
    resultId: packet.resultId,
    resultKind: packet.resultKind,
    headVersion: packet.headVersion,
    currentResultId: options.currentResultId
  };
}

type NativeClientHandle = Readonly<{
  name?: string;
  prepare: (sql: string) => {
    get: (...params: readonly unknown[]) => unknown;
    all: (...params: readonly unknown[]) => unknown[];
  };
}>;

function getNativeClient(db: unknown): NativeClientHandle | null {
  if (typeof db !== "object" || db === null) return null;
  const client = "$client" in db ? (db as { $client: unknown }).$client : db;
  if (
    typeof client === "object" &&
    client !== null &&
    "prepare" in client &&
    typeof (client as { prepare: unknown }).prepare === "function"
  ) {
    return client as NativeClientHandle;
  }
  return null;
}

/**
 * Adapter connecting RecruitosComposition to the real RuntimeComposition from PR #28.
 * Reaches the database connection, clock, id generator, and adapters through runtime.
 */
export class RuntimeRecruitosComposition implements RecruitosComposition {
  readonly runtime: RuntimeComposition;
  readonly databasePath: string;
  private readonly fallback: StubRecruitosComposition;
  private readonly allowStubFallback: boolean;

  constructor(
    runtime: RuntimeComposition,
    databasePath?: string,
    allowStubFallback = false
  ) {
    this.runtime = runtime;
    const nativeClient = getNativeClient(runtime.connection.database);
    this.databasePath =
      databasePath ??
      (typeof nativeClient?.name === "string" ? nativeClient.name : ":memory:");
    this.fallback = new StubRecruitosComposition();
    this.allowStubFallback = allowStubFallback;
  }

  async prepareDemo(input: {
    actorId?: string;
  }): Promise<Result<import("./types.js").DemoPrepareSummary, RuntimeError>> {
    if (this.hasCandidatesInDb()) {
      return err({
        code: "persistence_failed",
        message: "Demo corpus imported no candidates",
        retryable: false
      });
    }
    return demoPrepare(this.runtime, input);
  }

  async evaluateClass1(
    candidateId: string
  ): Promise<Result<import("./types.js").Class1EvaluationReport, RuntimeError>> {
    return runClass1EvaluationForFinalizedCandidate(
      this.runtime.connection.database,
      candidateId
    );
  }

  async importCandidates(input: {
    actorId: string;
    corpusTag?: "main" | "variant" | undefined;
  }): Promise<Result<import("./types.js").ImportCandidatesSummary, RuntimeError>> {
    const result = await importCandidates(this.runtime, {
      actorId: input.actorId,
      ...(input.corpusTag === undefined ? {} : { corpusTag: input.corpusTag })
    });
    if (!result.ok) return result;
    return ok({ commandId: result.value.metadata.commandId, ...result.value.result });
  }

  async startTriage(input: {
    actorId: string;
    roleId: string;
    candidateIds: readonly string[];
    kind?: "main_run" | "variant_run" | undefined;
  }): Promise<Result<import("./types.js").StartTriageSummary, RuntimeError>> {
    const result = startTriageRun(this.runtime, {
      actorId: input.actorId,
      roleId: input.roleId,
      candidateIds: input.candidateIds,
      ...(input.kind === undefined ? {} : { kind: input.kind })
    });
    if (!result.ok) return result;
    return ok({ commandId: result.value.metadata.commandId, ...result.value.result });
  }

  async extractTriage(
    triageAttemptId: string
  ): Promise<Result<import("./types.js").ExtractionAttemptSummary, RuntimeError>> {
    const result = await runExtractionAttempt(this.runtime, { triageAttemptId });
    if (!result.ok) return result;
    return ok({
      ...result.value,
      droppedQuoteCount: result.value.droppedQuotes.length
    });
  }

  registerExtractionFixtures(
    triageAttemptId: string,
    options?: { overlay?: boolean }
  ): Result<void, RuntimeError> {
    return options?.overlay
      ? registerDemoCorrectionFixtures(this.runtime, triageAttemptId)
      : registerDemoFixtures(this.runtime, triageAttemptId);
  }

  async completeReExtraction(input: {
    actorId: string;
    triageAttemptId: string;
    expectedTaskHeadVersion: number;
    expectedCandidateHeadVersion: number;
    commandId?: string;
  }): Promise<Result<import("./types.js").CompleteReExtractionSummary, RuntimeError>> {
    const result = completeReExtraction(this.runtime, {
      actorId: input.actorId,
      triageAttemptId: input.triageAttemptId,
      expectedTaskHeadVersion: input.expectedTaskHeadVersion,
      expectedCandidateHeadVersion: input.expectedCandidateHeadVersion,
      ...(input.commandId === undefined ? {} : { commandId: input.commandId })
    });
    if (!result.ok) return result;
    return ok({ commandId: result.value.metadata.commandId, ...result.value.result });
  }

  async finalizeTriage(input: {
    actorId: string;
    triageAttemptId: string;
    triageRunId?: string | undefined;
  }): Promise<Result<import("./types.js").FinalizeTriageSummary, RuntimeError>> {
    const result = finalizeTriageRun(this.runtime, {
      actorId: input.actorId,
      triageAttemptId: input.triageAttemptId,
      ...(input.triageRunId === undefined ? {} : { triageRunId: input.triageRunId })
    });
    if (!result.ok) return result;
    return ok({ commandId: result.value.metadata.commandId, ...result.value.result });
  }

  private hasCandidatesInDb(): boolean {
    try {
      const nativeClient = getNativeClient(this.runtime.connection.database);
      if (nativeClient) {
        const row = nativeClient.prepare("SELECT count(*) as cnt FROM candidate_head").get() as { cnt: number } | undefined;
        return (row?.cnt ?? 0) > 0;
      }
    } catch {
      // Table may not exist yet
    }
    return false;
  }

  private hasAuditEventsInDb(): boolean {
    try {
      const nativeClient = getNativeClient(this.runtime.connection.database);
      if (nativeClient) {
        const row = nativeClient.prepare("SELECT count(*) as cnt FROM audit_event").get() as
          | { cnt: number }
          | undefined;
        return (row?.cnt ?? 0) > 0;
      }
    } catch {
      // Table may not exist yet
    }
    return false;
  }

  private hasProposalsInDb(): boolean {
    try {
      const nativeClient = getNativeClient(this.runtime.connection.database);
      if (nativeClient) {
        const row = nativeClient.prepare("SELECT count(*) as cnt FROM proposal").get() as
          | { cnt: number }
          | undefined;
        return (row?.cnt ?? 0) > 0;
      }
    } catch {
      // Table may not exist yet
    }
    return false;
  }

  private hasTasksInDb(): boolean {
    try {
      const nativeClient = getNativeClient(this.runtime.connection.database);
      if (nativeClient) {
        const row = nativeClient.prepare("SELECT count(*) as cnt FROM resolution_task_head").get() as { cnt: number } | undefined;
        return (row?.cnt ?? 0) > 0;
      }
    } catch {
      // Table may not exist yet
    }
    return false;
  }

  async getStatus(): Promise<Result<SystemStatusSummary, RuntimeError>> {
    try {
      const nativeClient = getNativeClient(this.runtime.connection.database);

      let schemaVersion = 15;
      let candidateCount = 0;
      let openTasksCount = 0;
      let pendingProposalsCount = 0;
      let auditEventsCount = 0;
      let isSealed = false;

      if (nativeClient && typeof nativeClient.prepare === "function") {
        try {
          const migRow = nativeClient.prepare("SELECT count(*) as cnt FROM __drizzle_migrations").get() as { cnt: number } | undefined;
          if (migRow) {
            schemaVersion = migRow.cnt;
          }
        } catch {
          // Table not ready
        }

        try {
          const candRow = nativeClient.prepare("SELECT count(*) as cnt FROM candidate_head").get() as { cnt: number } | undefined;
          if (candRow) {
            candidateCount = candRow.cnt;
          }
        } catch {
          // Table not ready
        }

        try {
          const taskRow = nativeClient.prepare("SELECT count(*) as cnt FROM resolution_task_head WHERE status != 'resolved'").get() as { cnt: number } | undefined;
          if (taskRow) {
            openTasksCount = taskRow.cnt;
          }
        } catch {
          // Table not ready
        }

        try {
          const propRow = nativeClient
            .prepare(
              `SELECT count(*) AS cnt
               FROM proposal p
               JOIN candidate_triage_result ctr
                 ON ctr.candidate_triage_result_id = p.candidate_result_id
               JOIN candidate_head ch
                 ON ch.candidate_id = ctr.candidate_id
                 AND ch.current_result_id = p.candidate_result_id
               LEFT JOIN proposal_head ph ON ph.proposal_id = p.proposal_id
               WHERE ph.proposal_id IS NULL`
            )
            .get() as { cnt: number } | undefined;
          if (propRow) {
            pendingProposalsCount = propRow.cnt;
          }
        } catch {
          // Table not ready
        }

        try {
          const auditRow = nativeClient.prepare("SELECT count(*) as cnt FROM audit_event").get() as { cnt: number } | undefined;
          if (auditRow) {
            auditEventsCount = auditRow.cnt;
          }
        } catch {
          // Table not ready
        }

        try {
          const sealRow = nativeClient.prepare("SELECT count(*) as cnt FROM candidate_result_seal").get() as { cnt: number } | undefined;
          if (sealRow && sealRow.cnt > 0) {
            isSealed = true;
          }
        } catch {
          // Table not ready
        }
      }

      // If DB has data, report DB stats. If empty (in-memory test), merge with fallback.
      if (
        this.allowStubFallback &&
        candidateCount === 0 &&
        openTasksCount === 0
      ) {
        const fallbackStatus = await this.fallback.getStatus();
        if (fallbackStatus.ok) {
          return ok({
            ...fallbackStatus.value,
            databasePath: this.databasePath,
            schemaVersion
          });
        }
      }

      return ok({
        databasePath: this.databasePath,
        schemaVersion,
        activeRunId: `run-${this.runtime.clock.now()}`,
        candidateCount,
        openTasksCount,
        pendingProposalsCount,
        auditEventsCount,
        knownLimitationsCount: 3,
        isSealed
      });
    } catch (error) {
      return err({
        code: "database_error",
        message: `Failed to inspect status: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false
      });
    }
  }

  async listCandidates(
    options?: ListCandidatesOptions
  ): Promise<Result<readonly CandidateSummary[], RuntimeError>> {
    if (this.hasCandidatesInDb() || !this.allowStubFallback) {
      const pageResult = await listCandidates(this.runtime.connection.database, {
        limit: options?.limit,
        channel: options?.channel,
        status: toRuntimeCandidateStatus(options?.status)
      });
      if (!pageResult.ok) {
        return err({
          code: "database_error",
          message: pageResult.error.message,
          retryable: false
        });
      }
      return ok(pageResult.value.items.map(toCandidateSummary));
    }
    return this.fallback.listCandidates(options);
  }

  async getCandidatePacket(
    candidateId: string,
    options?: { resultId?: string }
  ): Promise<Result<CandidatePacket, RuntimeError>> {
    const snapshot = loadCandidatePacketSnapshot(
      this.runtime.connection,
      candidateId,
      options?.resultId === undefined ? undefined : { resultId: options.resultId }
    );
    if (!snapshot.ok) {
      if (this.allowStubFallback && !this.hasCandidatesInDb()) {
        return this.fallback.getCandidatePacket(candidateId);
      }
      return err({
        code: snapshot.error.code,
        message: snapshot.error.message,
        retryable: false
      });
    }

    return ok(
      toCandidatePacket(
        snapshot.value.selected,
        getNativeClient(this.runtime.connection.database),
        snapshot.value.tasks.map(toResolutionTaskSummary),
        {
          isHistoricalResult: snapshot.value.isHistoricalResult,
          currentResultId: snapshot.value.currentResultId
        }
      )
    );
  }

  async runTriage(
    options?: RunTriageOptions
  ): Promise<Result<TriageRunSummary, RuntimeError>> {
    return this.fallback.runTriage(options);
  }

  async listResolutionTasks(
    options?: ListResolutionTasksOptions
  ): Promise<Result<readonly ResolutionTaskSummary[], RuntimeError>> {
    if (this.hasTasksInDb() || !this.allowStubFallback) {
      const pageResult = await listResolutionTasks(this.runtime.connection.database, {
        candidateId: options?.candidateId,
        status: options?.status
      });
      if (!pageResult.ok) {
        return err({
          code: "database_error",
          message: pageResult.error.message,
          retryable: false
        });
      }
      return ok(pageResult.value.items.map(toResolutionTaskSummary));
    }
    return this.fallback.listResolutionTasks(options);
  }

  async getResolutionTask(
    taskId: string
  ): Promise<Result<ResolutionTaskDetail, RuntimeError>> {
    const loaded = runImmediateTransaction(this.runtime.connection, (context) => {
      const task = readResolutionTask(context, taskId);
      if (!task.ok) {
        return task;
      }
      if (task.value === undefined) {
        return err(
          createRuntimeError("not_found", `Resolution task "${taskId}" not found`, false)
        );
      }
      const result = readCandidateTriageResult(context, task.value.candidateResultId);
      if (!result.ok) {
        return result;
      }
      if (result.value === undefined) {
        return err(
          createRuntimeError(
            "not_found",
            `Candidate result "${task.value.candidateResultId}" not found`,
            false
          )
        );
      }
      const head = readResolutionTaskHead(context, taskId);
      if (!head.ok) {
        return head;
      }
      const actions = readResolutionActions(context, taskId);
      if (!actions.ok) {
        return actions;
      }
      const reason = context.nativeDatabase
        .prepare(
          `SELECT reason_code AS reasonCode
           FROM candidate_result_reason
           WHERE candidate_result_reason_id = ?`
        )
        .get(task.value.candidateResultReasonId) as { reasonCode: string } | undefined;
      const currentAction =
        head.value === undefined
          ? undefined
          : actions.value.find((action) => action.resolutionActionId === head.value!.currentActionId);
      const status = deriveResolutionTaskStatus(currentAction?.actionKind ?? null);
      return ok({
        resolutionTaskId: task.value.resolutionTaskId,
        candidateId: result.value.candidateId,
        candidateResultId: task.value.candidateResultId,
        reasonCode: reason?.reasonCode ?? "",
        status,
        taskOrdinal: task.value.taskOrdinal,
        ...(head.value?.currentActionId ? { currentActionId: head.value.currentActionId } : {}),
        version: head.value?.version ?? 0,
        createdAt: task.value.createdAt,
        actions: actions.value.map((action) => ({
          actionId: action.resolutionActionId,
          actorId: action.actorId,
          actionKind: action.actionKind,
          rationale:
            "rationale" in action.payload && typeof action.payload.rationale === "string"
              ? action.payload.rationale
              : action.actionKind,
          createdAt: action.createdAt
        }))
      });
    });
    if (loaded.ok) {
      return loaded;
    }
    if (this.allowStubFallback) {
      return this.fallback.getResolutionTask(taskId);
    }
    return err({
      code: loaded.error.code,
      message: loaded.error.message,
      retryable: false
    });
  }

  async recordResolutionAction(
    input: RecordResolutionActionInput
  ): Promise<
    Result<
      {
        actionId: string;
        newVersion: number;
        derivedStatus: ResolutionTaskDetail["status"];
        triageAttemptId?: string;
        commandId: string;
      },
      RuntimeError
    >
  > {
    if (input.actionKind === "reextraction_completed") {
      return err({
        code: "command_conflict",
        message: "reextraction_completed is a system-only action",
        retryable: false
      });
    }
    if (input.actionKind === "request_re_extraction") {
      if (input.expectedCandidateHeadVersion === undefined) {
        return err({
          code: "invalid_argument",
          message: "--candidate-version is required when requesting re-extraction",
          retryable: false
        });
      }
      const result = requestReExtraction(this.runtime, {
        actorId: input.actorId,
        resolutionTaskId: input.taskId,
        expectedTaskHeadVersion: input.expectedVersion,
        expectedCandidateHeadVersion: input.expectedCandidateHeadVersion,
        ...(input.commandId === undefined ? {} : { commandId: input.commandId })
      });
      if (!result.ok) {
        return err({
          code: result.error.code,
          message: result.error.message,
          retryable: result.error.retryable,
          ...(result.error.details === undefined ? {} : { details: result.error.details })
        });
      }
      return ok({
        actionId: result.value.result.resolutionActionId,
        newVersion: result.value.result.taskHeadVersion,
        derivedStatus: result.value.result.derivedStatus,
        triageAttemptId: result.value.result.triageAttemptId,
        commandId: result.value.metadata.commandId
      });
    }
    return this.fallback.recordResolutionAction(input);
  }

  async listProposals(
    options?: ListProposalsOptions
  ): Promise<Result<readonly ProposalSummary[], RuntimeError>> {
    if (this.hasProposalsInDb() || !this.allowStubFallback) {
      const items: ProposalSummary[] = [];
      let cursor: string | undefined;
      do {
        const pageResult = listProposals(this.runtime.connection.database, {
          candidateId: options?.candidateId,
          status: options?.status,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor })
        });
        if (!pageResult.ok) {
          return err({
            code: "database_error",
            message: pageResult.error.message,
            retryable: false
          });
        }
        items.push(...pageResult.value.items.map(toProposalSummary));
        cursor = pageResult.value.nextCursor;
      } while (cursor);
      return ok(items);
    }
    return this.fallback.listProposals(options);
  }

  async recordReviewDecision(
    input: RecordReviewDecisionInput
  ): Promise<
    Result<{ decisionId: string; newVersion: number; status: ProposalSummary["status"]; commandId: string }, RuntimeError>
  > {
    if (this.allowStubFallback) {
      return this.fallback.recordReviewDecision(input);
    }
    const result = recordProposalReviewDecision(this.runtime, {
      actorId: input.actorId,
      proposalId: input.proposalId,
      expectedVersion: input.expectedVersion,
      decision: input.decision,
      ...(input.commandId === undefined ? {} : { commandId: input.commandId })
    });
    if (!result.ok) {
      return err({
        code: result.error.code,
        message: result.error.message,
        retryable: result.error.retryable,
        ...(result.error.details === undefined ? {} : { details: result.error.details })
      });
    }
    return ok({
      decisionId: result.value.result.decisionId,
      newVersion: result.value.result.newVersion,
      status: result.value.result.status,
      commandId: result.value.metadata.commandId
    });
  }

  async listAuditEvents(
    options?: ListAuditEventsOptions
  ): Promise<Result<readonly AuditEventSummary[], RuntimeError>> {
    if (this.hasAuditEventsInDb() || !this.allowStubFallback) {
      const pageResult = listAuditEvents(this.runtime.connection.database, {
        limit: options?.limit,
        ...(options?.cursor === undefined ? {} : { cursor: options.cursor })
      });
      if (!pageResult.ok) {
        return err({
          code: "database_error",
          message: pageResult.error.message,
          retryable: false
        });
      }
      return ok(pageResult.value.items.map(toAuditEventSummary));
    }
    return this.fallback.listAuditEvents(options);
  }
}

/**
 * Creates a RecruitosComposition backed by an active RuntimeComposition.
 */
export function createCompositionFromRuntime(
  runtime: RuntimeComposition,
  databasePath?: string
): RecruitosComposition {
  return new RuntimeRecruitosComposition(runtime, databasePath);
}

/**
 * Creates the default RecruitOS composition using createRuntime from PR #28.
 */
function createTempDbFilename(): string {
  const dir = mkdtempSync(join(tmpdir(), "recruitos-runtime-"));
  return join(dir, "runtime.db");
}

/**
 * File-backed CLI commands each start a new process. The default incrementing
 * generator would reuse `runtime-0000000001` as a command id and trip
 * command_identity_mismatch on the next write. Namespace each process.
 */
export function createProcessUniqueIdGenerator(prefix: string): IdGenerator {
  const namespace = randomBytes(8).toString("hex");
  let counter = 0;
  return Object.freeze({
    next: (): string => {
      counter += 1;
      return `${prefix}-${namespace}-${counter.toString().padStart(10, "0")}`;
    }
  });
}

export function createDefaultRuntimeComposition(
  options?: Partial<CreateRuntimeOptions>
): Result<RecruitosComposition, RuntimeError> {
  const isMemory =
    !options?.database?.filename || options.database.filename === ":memory:";
  const filename = isMemory ? createTempDbFilename() : options.database.filename;

  const database = {
    filename,
    ...(options?.database?.migrationsFolder
      ? { migrationsFolder: options.database.migrationsFolder }
      : {})
  };

  const idGenerator =
    options?.idGenerator ??
    (isMemory ? undefined : createProcessUniqueIdGenerator("runtime"));

  const runtimeResult = createRuntime({
    database,
    migrate: options?.migrate ?? true,
    ...(options?.clock ? { clock: options.clock } : {}),
    ...(idGenerator === undefined ? {} : { idGenerator }),
    ...(options?.extraction ? { extraction: options.extraction } : {}),
    ...(options?.candidateSource ? { candidateSource: options.candidateSource } : {})
  });

  if (!runtimeResult.ok) {
    return runtimeResult;
  }

  return ok(
    new RuntimeRecruitosComposition(
      runtimeResult.value,
      isMemory ? ":memory:" : filename,
      options === undefined
    )
  );
}

/** Creates the deterministic synthetic composition used by `demo:prepare`. */
export function createDemoRuntimeComposition(
  filename: string
): Result<RecruitosComposition, RuntimeError> {
  const runtimeResult = createRuntime(
    demoCompositionOptions({ database: { filename } })
  );
  if (!runtimeResult.ok) return runtimeResult;
  return ok(new RuntimeRecruitosComposition(runtimeResult.value, filename));
}
