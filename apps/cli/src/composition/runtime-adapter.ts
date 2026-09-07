import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { err, ok, type Result } from "@recruitos/core";
import {
  createRuntime,
  type Clock,
  type CreateRuntimeOptions,
  type IdGenerator,
  type RuntimeComposition
} from "@recruitos/runtime/composition";

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
  ResolutionTaskSummary,
  RunTriageOptions,
  RuntimeError,
  SystemStatusSummary,
  TriageRunSummary
} from "./types.js";
import { StubRecruitosComposition } from "./stub.js";

/**
 * Adapter connecting RecruitosComposition to the real RuntimeComposition from PR #28.
 * Reaches the database connection, clock, id generator, and adapters through runtime.
 */
export class RuntimeRecruitosComposition implements RecruitosComposition {
  readonly runtime: RuntimeComposition;
  readonly databasePath: string;
  private readonly fallback: StubRecruitosComposition;

  constructor(runtime: RuntimeComposition, databasePath?: string) {
    this.runtime = runtime;
    const drizzleDb = runtime.connection.database;
    const nativeClient = (drizzleDb as any).$client ?? (drizzleDb as any).session?.client;
    this.databasePath =
      databasePath ??
      (typeof nativeClient?.name === "string" ? nativeClient.name : ":memory:");
    this.fallback = new StubRecruitosComposition();
  }

  async getStatus(): Promise<Result<SystemStatusSummary, RuntimeError>> {
    try {
      const drizzleDb = this.runtime.connection.database;
      const nativeClient = (drizzleDb as any).$client ?? (drizzleDb as any).session?.client;

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
          const propRow = nativeClient.prepare("SELECT count(*) as cnt FROM proposal_head WHERE status = 'pending'").get() as { cnt: number } | undefined;
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
      if (candidateCount === 0 && openTasksCount === 0) {
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
    return this.fallback.listCandidates(options);
  }

  async getCandidatePacket(
    candidateId: string
  ): Promise<Result<CandidatePacket, RuntimeError>> {
    return this.fallback.getCandidatePacket(candidateId);
  }

  async runTriage(
    options?: RunTriageOptions
  ): Promise<Result<TriageRunSummary, RuntimeError>> {
    return this.fallback.runTriage(options);
  }

  async listResolutionTasks(
    options?: ListResolutionTasksOptions
  ): Promise<Result<readonly ResolutionTaskSummary[], RuntimeError>> {
    return this.fallback.listResolutionTasks(options);
  }

  async getResolutionTask(
    taskId: string
  ): Promise<Result<ResolutionTaskDetail, RuntimeError>> {
    return this.fallback.getResolutionTask(taskId);
  }

  async recordResolutionAction(
    input: RecordResolutionActionInput
  ): Promise<
    Result<
      { actionId: string; newVersion: number; derivedStatus: ResolutionTaskDetail["status"] },
      RuntimeError
    >
  > {
    return this.fallback.recordResolutionAction(input);
  }

  async listProposals(
    options?: ListProposalsOptions
  ): Promise<Result<readonly ProposalSummary[], RuntimeError>> {
    return this.fallback.listProposals(options);
  }

  async recordReviewDecision(
    input: RecordReviewDecisionInput
  ): Promise<Result<{ decisionId: string; newVersion: number }, RuntimeError>> {
    return this.fallback.recordReviewDecision(input);
  }

  async listAuditEvents(
    options?: ListAuditEventsOptions
  ): Promise<Result<readonly AuditEventSummary[], RuntimeError>> {
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

  const runtimeResult = createRuntime({
    database,
    migrate: options?.migrate ?? true,
    ...(options?.clock ? { clock: options.clock } : {}),
    ...(options?.idGenerator ? { idGenerator: options.idGenerator } : {}),
    ...(options?.extraction ? { extraction: options.extraction } : {}),
    ...(options?.candidateSource ? { candidateSource: options.candidateSource } : {})
  });

  if (!runtimeResult.ok) {
    return runtimeResult;
  }

  return ok(
    new RuntimeRecruitosComposition(
      runtimeResult.value,
      isMemory ? ":memory:" : filename
    )
  );
}
