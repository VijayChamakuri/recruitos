import type { FoldedMatchQuality } from "../../packages/core/src/index.js";

/**
 * Type definitions for RecruitOS Evaluation Harness (Class 1, Class 2, Class 3).
 * Follows evaluation specifications from DESIGN.md and the implementation plan.
 */

export type Polarity = "supporting" | "contradicting";
export type RelocatedMatchQuality = FoldedMatchQuality;

export interface SpanInterval {
  readonly start: number;
  readonly end: number;
}

export interface ExpectedSpan extends SpanInterval {
  readonly id: string;
  readonly candidateId: string;
  readonly documentId: string;
  readonly dimension: string;
  readonly polarity: Polarity;
  readonly text: string;
}

export interface PredictedSpan extends SpanInterval {
  readonly id: string;
  readonly candidateId: string;
  readonly documentId: string;
  readonly dimension: string;
  readonly polarity: Polarity;
  readonly text: string;
  readonly confidence?: number;
}

export interface MatchedSpanPair {
  readonly expected: ExpectedSpan;
  readonly predicted: PredictedSpan;
  readonly iou: number;
  readonly isExactBoundary: boolean;
}

export interface EvalMetrics {
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
}

export interface SpanMatchResult {
  readonly matches: readonly MatchedSpanPair[];
  readonly unmatchedExpected: readonly ExpectedSpan[];
  readonly unmatchedPredicted: readonly PredictedSpan[];
  readonly metrics: EvalMetrics;
  readonly meanIou: number | null;
  readonly medianIou: number | null;
  readonly exactBoundaryMatchRate: number | null;
}

export interface DimensionCoverage {
  readonly dimension: string;
  readonly locatedSpanCount: number;
  readonly validatedGapCount: number;
  readonly isComplete: boolean;
}

export interface Class1EvaluationInput {
  readonly candidateId: string;
  readonly tier: 1 | 2;
  readonly totalDimensions: number;
  readonly dimensionCoverages: readonly DimensionCoverage[];
  readonly knownLimitations: readonly string[];
}

export interface Class1EvaluationReport {
  readonly passed: boolean;
  readonly candidateId: string;
  readonly locatedSpanCoverageRate: number;
  readonly coverageRequirementMet: boolean;
  readonly allDimensionsAccountedFor: boolean;
  readonly knownLimitationsCountMet: boolean;
  readonly violations: readonly string[];
}

export interface BiasGroupCut {
  readonly groupName: string;
  readonly totalCount: number;
  readonly selectedCount: number;
  readonly selectionRate: number | null;
  readonly selectionRatioVsReference: number | null;
}

export interface Class3BiasAuditDemo {
  readonly title: string;
  readonly syntheticDisclaimer: string;
  readonly proposedCuts: readonly BiasGroupCut[];
  readonly approvedCuts: readonly BiasGroupCut[];
  readonly referenceGroupName: string;
}

export interface ExtractedQuoteClaim {
  readonly id: string;
  readonly candidateId: string;
  readonly documentId: string;
  readonly dimension: string;
  readonly polarity: Polarity;
  readonly quotedText: string;
  readonly claimedStart?: number;
  readonly claimedEnd?: number;
  readonly confidence?: number;
}

export interface RelocatedPredictedSpan extends PredictedSpan {
  readonly matchQuality: RelocatedMatchQuality;
  readonly matchedText: string;
}

export interface QuoteRelocationFailure {
  readonly claimId: string;
  readonly candidateId: string;
  readonly documentId: string;
  readonly dimension: string;
  readonly quotedText: string;
  readonly error: string;
  readonly reason?: string;
}

export interface RelocationBatchResult {
  readonly totalClaims: number;
  readonly relocatedSpans: readonly RelocatedPredictedSpan[];
  readonly unlocatedClaims: readonly QuoteRelocationFailure[];
  readonly exactMatches: number;
  readonly normalizedMatches: number;
  readonly relocationRate: number | null;
}

export interface GroundedSpanEvaluationResult {
  readonly spanMatches: SpanMatchResult;
  readonly relocation: RelocationBatchResult;
  readonly effectivePrecision: number | null;
}
