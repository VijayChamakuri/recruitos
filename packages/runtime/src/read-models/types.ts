import type { ResolutionTaskStatus } from "@recruitos/core";

export const DEFAULT_PAGE_SIZE = 50;
export const MAXIMUM_PAGE_SIZE = 100;

export type NativeStatement = Readonly<{
  run: (...parameters: readonly unknown[]) => { changes: number };
  get: (...parameters: readonly unknown[]) => unknown;
  all: (...parameters: readonly unknown[]) => unknown[];
}>;

export type NativeDatabase = Readonly<{
  prepare: (sql: string) => NativeStatement;
}>;

export type CandidateTriageStatus =
  | "scored"
  | "rejected_hard_requirement"
  | "escalated"
  | "pending";

export interface CandidateSummaryItem {
  readonly candidateId: string;
  readonly sourceSystem: string;
  readonly sourceKey: string;
  readonly channel: "inbound" | "sourced";
  readonly corpusTag: "main" | "variant";
  readonly isSynthetic: boolean;
  readonly createdAt: number;
  readonly importOrdinal: number | null;
  readonly status: CandidateTriageStatus;
  readonly scoreBasisPoints: number | null;
  readonly confidenceBasisPoints: number | null;
  readonly scoreAggregateText: string | null;
  readonly scoreConfidenceText: string | null;
  readonly currentResultId: string | null;
  readonly headVersion: number | null;
  readonly isSealed: boolean;
  readonly reasons: readonly string[];
}

export interface CandidateListPage {
  readonly items: readonly CandidateSummaryItem[];
  readonly nextCursor: string | undefined;
  readonly queryCount: number;
}

export interface ListCandidatesOptions {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly channel?: ("inbound" | "sourced") | undefined;
  readonly corpusTag?: ("main" | "variant") | undefined;
  readonly status?: CandidateTriageStatus | undefined;
}

export interface ResolutionTaskItem {
  readonly resolutionTaskId: string;
  readonly candidateId: string;
  readonly candidateResultId: string;
  readonly candidateResultReasonId: string;
  readonly reasonKind: string;
  readonly reasonCode: string;
  readonly reasonPrecedence: number;
  readonly taskOrdinal: number;
  readonly createdAt: number;
  readonly status: ResolutionTaskStatus;
  readonly currentActionId: string | null;
  readonly currentActionKind: string | null;
  readonly headVersion: number;
}

export interface ResolutionTaskListPage {
  readonly items: readonly ResolutionTaskItem[];
  readonly nextCursor: string | undefined;
  readonly queryCount: number;
}

export interface ListResolutionTasksOptions {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly status?: ResolutionTaskStatus | undefined;
  readonly candidateId?: string | undefined;
}

export interface CandidatePacketModel {
  readonly candidateId: string;
  readonly sourceSystem: string;
  readonly sourceKey: string;
  readonly channel: "inbound" | "sourced";
  readonly corpusTag: "main" | "variant";
  readonly isSynthetic: boolean;
  readonly createdAt: number;
  readonly headVersion: number;
  readonly resultId: string;
  readonly resultKind: string;
  readonly resultAvailability: string;
  readonly resultStatus: "scored" | "rejected_hard_requirement" | "escalated";
  readonly contentHash: string;
  readonly sealId: string;
  readonly isSealed: boolean;
}

export interface IndexPlanStep {
  readonly id: number;
  readonly parent: number;
  readonly detail: string;
}

export interface IndexPlanSummary {
  readonly query: string;
  readonly steps: readonly IndexPlanStep[];
  readonly usesCoveringOrIndexedScan: boolean;
}
