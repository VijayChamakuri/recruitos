import { err, ok, type Result } from "@recruitos/core";

import type {
  AuditEventSummary,
  CandidatePacket,
  CandidateSummary,
  ListAuditEventsOptions,
  ListCandidatesOptions,
  ListProposalsOptions,
  ListResolutionTasksOptions,
  ProposalSummary,
  RecordResolutionActionInput,
  RecordReviewDecisionInput,
  RecruitosComposition,
  ResolutionTaskDetail,
  ResolutionTaskStatus,
  ResolutionTaskSummary,
  RunTriageOptions,
  RuntimeError,
  SystemStatusSummary,
  TriageRunSummary
} from "./types.js";

const BASE_TIMESTAMP = 1_788_700_000_000;

function notFound(message: string): RuntimeError {
  return { code: "not_found", message, retryable: false };
}

function versionConflict(expected: number, actual: number): RuntimeError {
  return {
    code: "version_conflict",
    message: `Expected version ${expected} but found version ${actual}`,
    retryable: true,
    details: { expected, actual }
  };
}

export class StubRecruitosComposition implements RecruitosComposition {
  private candidates: CandidateSummary[];
  private packets: Map<string, CandidatePacket>;
  private tasks: Map<string, ResolutionTaskDetail>;
  private proposals: Map<string, ProposalSummary>;
  private auditEvents: AuditEventSummary[];

  constructor() {
    this.candidates = [
      {
        candidateId: "candidate-1",
        sourceKey: "tier-one/0001",
        channel: "inbound",
        roleId: "role-applied-ai-engineer",
        roleTitle: "Applied AI Engineer",
        status: "shortlisted",
        score: 84.5,
        confidence: 0.92,
        reasons: [],
        tasksCount: 0,
        sealed: true,
        createdAt: BASE_TIMESTAMP
      },
      {
        candidateId: "candidate-2",
        sourceKey: "tier-one/0002",
        channel: "inbound",
        roleId: "role-applied-ai-engineer",
        roleTitle: "Applied AI Engineer",
        status: "escalated",
        score: null,
        confidence: null,
        reasons: ["assessment_unavailable"],
        tasksCount: 1,
        sealed: false,
        createdAt: BASE_TIMESTAMP + 1000
      },
      {
        candidateId: "candidate-3",
        sourceKey: "tier-one/0003",
        channel: "sourced",
        roleId: "role-applied-ai-engineer",
        roleTitle: "Applied AI Engineer",
        status: "reviewed",
        score: 68.0,
        confidence: 0.81,
        reasons: [],
        tasksCount: 0,
        sealed: true,
        createdAt: BASE_TIMESTAMP + 2000
      }
    ];

    const resumeDoc = {
      documentId: "doc-1",
      documentKind: "resume",
      label: "Resume",
      text: [
        "Alex Mercer - Senior Systems Engineer",
        "Experience:",
        "Staff Infrastructure Engineer at DataFlow Inc (2021-Present)",
        "Designed and implemented distributed query execution engine processing 50TB daily.",
        "Engineered zero-downtime database migration framework with atomic rollback.",
        "Led incident response and post-mortem evaluation practice across 6 platform squads.",
        "Built synthetic workload generator to stress-test consensus consistency.",
        "Senior Backend Engineer at CloudScale (2018-2021)",
        "Implemented high-throughput event streaming pipeline with 99.99% uptime SLA."
      ].join("\n")
    };

    const packet1: CandidatePacket = {
      candidateId: "candidate-1",
      sourceKey: "tier-one/0001",
      channel: "inbound",
      corpusTag: "main",
      roleId: "role-applied-ai-engineer",
      roleTitle: "Applied AI Engineer",
      status: "shortlisted",
      score: 84.5,
      confidence: 0.92,
      scoreText: "169/200",
      confidenceText: "23/25",
      confidenceInput: {
        contradictionCount: 0,
        dimensionsWithLocatedSpan: 5,
        requiredFieldsMissing: 0,
        spansLocated: 7,
        spansReturned: 8,
        totalDimensions: 6,
        totalRequiredFields: 4
      },
      reasons: [],
      contentHash: "8a4f91e0d37bc01fae2981329cbf7689104fa2bc018247df789123405abcde01",
      sealed: true,
      createdAt: BASE_TIMESTAMP,
      arithmeticTerms: [
        {
          dimensionId: "system_architecture",
          dimensionName: "System Architecture",
          weight: 25,
          level: "strong",
          levelScore: 100,
          weightedScore: 25.0
        },
        {
          dimensionId: "evaluation_practice",
          dimensionName: "Evaluation Practice",
          weight: 20,
          level: "strong",
          levelScore: 100,
          weightedScore: 20.0
        },
        {
          dimensionId: "coding_craft",
          dimensionName: "Coding Craft",
          weight: 20,
          level: "partial",
          levelScore: 65,
          weightedScore: 13.0
        },
        {
          dimensionId: "reasoning_integrity",
          dimensionName: "Reasoning Integrity",
          weight: 15,
          level: "strong",
          levelScore: 100,
          weightedScore: 15.0
        },
        {
          dimensionId: "communication",
          dimensionName: "Technical Communication",
          weight: 10,
          level: "partial",
          levelScore: 65,
          weightedScore: 6.5
        },
        {
          dimensionId: "collaboration",
          dimensionName: "Team Collaboration",
          weight: 10,
          level: "partial",
          levelScore: 50,
          weightedScore: 5.0
        }
      ],
      evidenceSpans: [
        {
          evidenceSpanId: "span-1",
          dimensionId: "system_architecture",
          start: 110,
          end: 189,
          quotedText:
            "Designed and implemented distributed query execution engine processing 50TB daily.",
          polarity: "supporting",
          matchQuality: "exact",
          documentId: "doc-1"
        },
        {
          evidenceSpanId: "span-2",
          dimensionId: "evaluation_practice",
          start: 268,
          end: 349,
          quotedText:
            "Led incident response and post-mortem evaluation practice across 6 platform squads.",
          polarity: "supporting",
          matchQuality: "exact",
          documentId: "doc-1"
        },
        {
          evidenceSpanId: "span-3",
          dimensionId: "system_architecture",
          start: 190,
          end: 267,
          quotedText:
            "Engineered zero-downtime database migration framework with atomic rollback.",
          polarity: "supporting",
          matchQuality: "exact",
          documentId: "doc-1"
        }
      ],
      evidenceGaps: [],
      documents: [resumeDoc],
      tasks: [],
      isHistoricalResult: false,
      resultId: "result-1",
      resultKind: "initial",
      headVersion: 1,
      currentResultId: "result-1"
    };

    const task1: ResolutionTaskDetail = {
      resolutionTaskId: "task-1",
      candidateId: "candidate-2",
      candidateResultId: "result-2",
      reasonCode: "assessment_unavailable",
      status: "open",
      taskOrdinal: 0,
      version: 0,
      createdAt: BASE_TIMESTAMP + 1000,
      actions: []
    };

    const packet2: CandidatePacket = {
      candidateId: "candidate-2",
      sourceKey: "tier-one/0002",
      channel: "inbound",
      corpusTag: "main",
      roleId: "role-applied-ai-engineer",
      roleTitle: "Applied AI Engineer",
      status: "escalated",
      score: null,
      confidence: null,
      scoreText: null,
      confidenceText: null,
      confidenceInput: null,
      reasons: ["assessment_unavailable"],
      contentHash: "1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef01",
      sealed: false,
      createdAt: BASE_TIMESTAMP + 1000,
      arithmeticTerms: [],
      evidenceSpans: [],
      evidenceGaps: [
        {
          dimensionId: "system_architecture",
          reason: "Extractor encountered unparseable table format in resume work experience."
        }
      ],
      documents: [
        {
          documentId: "doc-2",
          documentKind: "resume",
          label: "Resume",
          text: "Jordan Lee\nTechnical Lead with 8 years in machine learning platforms."
        }
      ],
      tasks: [{ ...task1, listing: "this_result" }],
      isHistoricalResult: false,
      resultId: "result-2",
      resultKind: "initial",
      headVersion: 1,
      currentResultId: "result-2"
    };

    const packet3: CandidatePacket = {
      candidateId: "candidate-3",
      sourceKey: "tier-one/0003",
      channel: "sourced",
      corpusTag: "main",
      roleId: "role-applied-ai-engineer",
      roleTitle: "Applied AI Engineer",
      status: "reviewed",
      score: 68.0,
      confidence: 0.81,
      scoreText: "17/25",
      confidenceText: "81/100",
      confidenceInput: null,
      reasons: [],
      contentHash: "2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef012a",
      sealed: true,
      createdAt: BASE_TIMESTAMP + 2000,
      arithmeticTerms: [
        {
          dimensionId: "system_architecture",
          dimensionName: "System Architecture",
          weight: 50,
          level: "partial",
          levelScore: 70,
          weightedScore: 35.0
        },
        {
          dimensionId: "coding_craft",
          dimensionName: "Coding Craft",
          weight: 50,
          level: "partial",
          levelScore: 66,
          weightedScore: 33.0
        }
      ],
      evidenceSpans: [],
      evidenceGaps: [],
      documents: [
        {
          documentId: "doc-3",
          documentKind: "resume",
          label: "Resume",
          text: "Morgan Riley\nBackend Engineer specializing in real-time streaming."
        }
      ],
      tasks: [],
      isHistoricalResult: false
    };

    this.packets = new Map([
      ["candidate-1", packet1],
      ["candidate-2", packet2],
      ["candidate-3", packet3]
    ]);

    this.tasks = new Map([["task-1", task1]]);

    this.proposals = new Map([
      [
        "proposal-1",
        {
          proposalId: "proposal-1",
          candidateId: "candidate-3",
          kind: "stage_advancement",
          status: "pending",
          proposedChange: "Advance candidate to technical interview screen.",
          version: 0,
          createdAt: BASE_TIMESTAMP + 3000
        }
      ]
    ]);

    this.auditEvents = [
      {
        auditEventId: "audit-1",
        eventName: "corpus_sealed",
        actorId: "system:runtime",
        occurredAt: BASE_TIMESTAMP - 10000,
        payloadHash: "c018247df789123405abcde018a4f91e0d37bc01fae2981329cbf7689104fa2b",
        commandId: null,
        eventOrdinal: null
      },
      {
        auditEventId: "audit-2",
        eventName: "triage_run_started",
        actorId: "human:recruiter-1",
        occurredAt: BASE_TIMESTAMP - 5000,
        payloadHash: "d37bc01fae2981329cbf7689104fa2bc018247df789123405abcde018a4f91e0",
        commandId: null,
        eventOrdinal: null
      },
      {
        auditEventId: "audit-3",
        eventName: "candidate_triage_result_sealed",
        actorId: "system:runtime",
        occurredAt: BASE_TIMESTAMP,
        payloadHash: "fae2981329cbf7689104fa2bc018247df789123405abcde018a4f91e0d37bc01",
        commandId: null,
        eventOrdinal: null
      }
    ];
  }

  async importCandidates(): Promise<
    Result<import("./types.js").ImportCandidatesSummary, RuntimeError>
  > {
    return ok({
      commandId: "command-stub-import",
      imported: 0,
      skipped: 0,
      candidateIds: []
    });
  }

  async startTriage(input: {
    roleId: string;
  }): Promise<Result<import("./types.js").StartTriageSummary, RuntimeError>> {
    return ok({
      commandId: "command-stub-start",
      triageRunId: "run-stub",
      triageAttemptId: "attempt-stub",
      workItemCount: 0
    });
  }

  async extractTriage(
    triageAttemptId: string
  ): Promise<Result<import("./types.js").ExtractionAttemptSummary, RuntimeError>> {
    return ok({
      triageAttemptId,
      totalWorkItems: 0,
      alreadySucceeded: 0,
      processed: 0,
      succeeded: 0,
      reviewableFailures: 0,
      blockedFailures: 0,
      reusedArtifacts: 0,
      spansReturned: 0,
      spansLocated: 0,
      droppedQuoteCount: 0
    });
  }

  registerExtractionFixtures(): Result<void, RuntimeError> {
    return ok(undefined);
  }

  async completeReExtraction(input: {
    triageAttemptId: string;
    expectedTaskHeadVersion: number;
    expectedCandidateHeadVersion: number;
    commandId?: string;
  }): Promise<Result<import("./types.js").CompleteReExtractionSummary, RuntimeError>> {
    return ok({
      commandId: input.commandId ?? "command-stub-complete-correction",
      triageAttemptId: input.triageAttemptId,
      resolutionTaskId: "task-stub-correction",
      resolutionActionId: "action-stub-correction",
      resultId: "result-stub-correction",
      baseResultId: "result-stub-base",
      candidateHeadVersion: input.expectedCandidateHeadVersion + 1,
      taskHeadVersion: input.expectedTaskHeadVersion + 1,
      derivedStatus: "review_required"
    });
  }

  async finalizeTriage(input: {
    triageAttemptId: string;
  }): Promise<Result<import("./types.js").FinalizeTriageSummary, RuntimeError>> {
    return ok({
      commandId: "command-stub-finalize",
      triageRunId: "run-stub",
      triageAttemptId: input.triageAttemptId,
      candidateCount: 0,
      resultIds: []
    });
  }

  async listCandidates(
    options: ListCandidatesOptions = {}
  ): Promise<Result<readonly CandidateSummary[], RuntimeError>> {
    let result = [...this.candidates];
    if (options.channel) {
      result = result.filter((c) => c.channel === options.channel);
    }
    if (options.status) {
      result = result.filter((c) => c.status === options.status);
    }
    if (options.roleId) {
      result = result.filter((c) => c.roleId === options.roleId);
    }
    const offset = options.offset ?? 0;
    const limit = options.limit ?? result.length;
    return ok(result.slice(offset, offset + limit));
  }

  async getCandidatePacket(
    candidateId: string
  ): Promise<Result<CandidatePacket, RuntimeError>> {
    const packet = this.packets.get(candidateId);
    if (!packet) {
      return err(notFound(`Candidate packet not found for ID: ${candidateId}`));
    }
    return ok(packet);
  }

  async runTriage(
    options: RunTriageOptions = {}
  ): Promise<Result<TriageRunSummary, RuntimeError>> {
    const runId = `run-${Date.now()}`;
    const roleId = options.roleId ?? "role-applied-ai-engineer";
    const total = options.candidateIds
      ? options.candidateIds.length
      : this.candidates.length;

    const summary: TriageRunSummary = {
      runId,
      roleId,
      totalCandidates: total,
      scoredCount: 2,
      escalatedCount: 1,
      shortlistCount: 1,
      sealedCount: options.dryRun ? 0 : 2,
      durationMs: 420,
      sealed: !options.dryRun
    };

    return ok(summary);
  }

  async getStatus(): Promise<Result<SystemStatusSummary, RuntimeError>> {
    const summary: SystemStatusSummary = {
      databasePath: "sqlite:///var/data/recruitos.db",
      schemaVersion: 15,
      activeRunId: "run-7",
      candidateCount: 140,
      openTasksCount: 41,
      pendingProposalsCount: 12,
      auditEventsCount: 1842,
      knownLimitationsCount: 3,
      isSealed: true
    };
    return ok(summary);
  }

  async listResolutionTasks(
    options: ListResolutionTasksOptions = {}
  ): Promise<Result<readonly ResolutionTaskSummary[], RuntimeError>> {
    let tasks = Array.from(this.tasks.values());
    if (options.candidateId) {
      tasks = tasks.filter((t) => t.candidateId === options.candidateId);
    }
    if (options.status) {
      tasks = tasks.filter((t) => t.status === options.status);
    }
    return ok(tasks);
  }

  async getResolutionTask(
    taskId: string
  ): Promise<Result<ResolutionTaskDetail, RuntimeError>> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return err(notFound(`Resolution task not found for ID: ${taskId}`));
    }
    return ok(task);
  }

  async recordResolutionAction(
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
  > {
    const task = this.tasks.get(input.taskId);
    if (!task) {
      return err(notFound(`Resolution task not found for ID: ${input.taskId}`));
    }
    if (task.version !== input.expectedVersion) {
      return err(versionConflict(input.expectedVersion, task.version));
    }

    const actionId = `action-${task.actions.length + 1}`;
    const newVersion = task.version + 1;
    const derivedStatus: ResolutionTaskStatus =
      input.actionKind === "dismiss" ? "dismissed" : "resolved";

    const updatedTask: ResolutionTaskDetail = {
      ...task,
      status: derivedStatus,
      version: newVersion,
      currentActionId: actionId,
      actions: [
        ...task.actions,
        {
          actionId,
          actorId: input.actorId,
          actionKind: input.actionKind,
          rationale: input.rationale,
          createdAt: Date.now()
        }
      ]
    };

    this.tasks.set(input.taskId, updatedTask);

    return ok({
      actionId,
      newVersion,
      derivedStatus,
      commandId: input.commandId ?? "command-stub-review"
    });
  }

  async listProposals(
    options: ListProposalsOptions = {}
  ): Promise<Result<readonly ProposalSummary[], RuntimeError>> {
    let proposals = Array.from(this.proposals.values());
    if (options.candidateId) {
      proposals = proposals.filter((p) => p.candidateId === options.candidateId);
    }
    if (options.status) {
      proposals = proposals.filter((p) => p.status === options.status);
    }
    return ok(proposals);
  }

  async recordReviewDecision(
    input: RecordReviewDecisionInput
  ): Promise<
    Result<{ decisionId: string; newVersion: number; status: ProposalSummary["status"]; commandId: string }, RuntimeError>
  > {
    const proposal = this.proposals.get(input.proposalId);
    if (!proposal) {
      return err(notFound(`Proposal not found for ID: ${input.proposalId}`));
    }
    if (proposal.version !== input.expectedVersion) {
      return err(versionConflict(input.expectedVersion, proposal.version));
    }

    const decisionId = `decision-${Date.now()}`;
    const newVersion = proposal.version + 1;
    const newStatus =
      input.decision.kind === "approve"
        ? "approved"
        : input.decision.kind === "reject"
          ? "rejected"
          : input.decision.kind === "edit"
            ? "edited"
            : "evidence_requested";

    this.proposals.set(input.proposalId, {
      ...proposal,
      status: newStatus,
      version: newVersion
    });

    return ok({
      decisionId,
      newVersion,
      status: newStatus,
      commandId: input.commandId ?? "command-stub-proposal-decision"
    });
  }

  async listAuditEvents(
    options: ListAuditEventsOptions = {}
  ): Promise<Result<readonly AuditEventSummary[], RuntimeError>> {
    const limit = options.limit ?? this.auditEvents.length;
    return ok(this.auditEvents.slice(0, limit));
  }
}

export function createStubComposition(): RecruitosComposition {
  return new StubRecruitosComposition();
}
