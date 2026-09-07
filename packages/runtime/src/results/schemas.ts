import {
  BasisPointsSchema,
  CandidateIdSchema,
  CandidateResultDimensionAssessmentIdSchema,
  CandidateResultEvidenceGapIdSchema,
  CandidateResultEvidenceSpanIdSchema,
  CandidateResultFactConflictIdSchema,
  CandidateResultHardRequirementAssessmentIdSchema,
  CandidateResultKindSchema,
  CandidateResultReasonIdSchema,
  CandidateResultStructuredFactIdSchema,
  CandidateTriageResultIdSchema,
  CandidateTriageStatusSchema,
  DecisionAvailabilitySchema,
  DimensionAssessmentIdSchema,
  DimensionLevelSchema,
  EvidenceGapIdSchema,
  EvidenceSpanIdSchema,
  FactConflictIdSchema,
  HardRequirementAssessmentIdSchema,
  NonnegativeIntegerSchema,
  PositiveIntegerSchema,
  PositiveWeightSchema,
  ReasonCodeKindSchema,
  RubricDimensionIdSchema,
  ScoreResultIdSchema,
  Sha256HexSchema,
  StructuredFactIdSchema
} from "@recruitos/core";
import { z } from "zod";

export {
  CANDIDATE_RESULT_KINDS,
  CANDIDATE_TRIAGE_STATUSES,
  DECISION_AVAILABILITIES,
  REASON_CODE_KINDS,
  REASON_CODE_KINDS_WITHOUT_SUBJECT,
  REASON_CODE_KINDS_WITH_SUBJECT,
  REASON_CODE_PRECEDENCE
} from "@recruitos/core";

const MAXIMUM_RESULT_EVIDENCE_SPANS = 72;
const MAXIMUM_RESULT_GAPS = 6;
const MAXIMUM_RESULT_ASSESSMENTS = 6;
const MAXIMUM_RESULT_FACTS = 16;
const MAXIMUM_RESULT_CONFLICTS = 16;
const MAXIMUM_RESULT_REQUIREMENTS = 4;
const CANONICAL_RATIONAL_TEXT = z
  .string()
  .min(3)
  .max(64)
  .regex(/^(0|[1-9][0-9]*)\/([1-9][0-9]*)$/u);

export const CandidateResultEvidenceSpanDraftSchema = z
  .object({
    candidateResultEvidenceSpanId: CandidateResultEvidenceSpanIdSchema,
    evidenceSpanId: EvidenceSpanIdSchema
  })
  .strict();
export type CandidateResultEvidenceSpanDraft = z.infer<
  typeof CandidateResultEvidenceSpanDraftSchema
>;

export const CandidateResultEvidenceSpanSchema = z
  .object({
    candidateResultEvidenceSpanId: CandidateResultEvidenceSpanIdSchema,
    evidenceSpanId: EvidenceSpanIdSchema,
    spanOrdinal: NonnegativeIntegerSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type CandidateResultEvidenceSpan = z.infer<typeof CandidateResultEvidenceSpanSchema>;

export const CandidateResultEvidenceGapDraftSchema = z
  .object({
    candidateResultEvidenceGapId: CandidateResultEvidenceGapIdSchema,
    evidenceGapId: EvidenceGapIdSchema,
    dimensionId: RubricDimensionIdSchema
  })
  .strict();
export type CandidateResultEvidenceGapDraft = z.infer<
  typeof CandidateResultEvidenceGapDraftSchema
>;

export const CandidateResultEvidenceGapSchema = z
  .object({
    candidateResultEvidenceGapId: CandidateResultEvidenceGapIdSchema,
    evidenceGapId: EvidenceGapIdSchema,
    dimensionId: RubricDimensionIdSchema,
    gapOrdinal: NonnegativeIntegerSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type CandidateResultEvidenceGap = z.infer<typeof CandidateResultEvidenceGapSchema>;

export const CandidateResultDimensionAssessmentDraftSchema = z
  .object({
    candidateResultDimensionAssessmentId: CandidateResultDimensionAssessmentIdSchema,
    dimensionAssessmentId: DimensionAssessmentIdSchema,
    dimensionId: RubricDimensionIdSchema
  })
  .strict();
export type CandidateResultDimensionAssessmentDraft = z.infer<
  typeof CandidateResultDimensionAssessmentDraftSchema
>;

export const CandidateResultDimensionAssessmentSchema = z
  .object({
    candidateResultDimensionAssessmentId: CandidateResultDimensionAssessmentIdSchema,
    dimensionAssessmentId: DimensionAssessmentIdSchema,
    dimensionId: RubricDimensionIdSchema,
    assessmentOrdinal: NonnegativeIntegerSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type CandidateResultDimensionAssessment = z.infer<
  typeof CandidateResultDimensionAssessmentSchema
>;

export const CandidateResultStructuredFactDraftSchema = z
  .object({
    candidateResultStructuredFactId: CandidateResultStructuredFactIdSchema,
    structuredFactId: StructuredFactIdSchema
  })
  .strict();
export type CandidateResultStructuredFactDraft = z.infer<
  typeof CandidateResultStructuredFactDraftSchema
>;

export const CandidateResultStructuredFactSchema = z
  .object({
    candidateResultStructuredFactId: CandidateResultStructuredFactIdSchema,
    structuredFactId: StructuredFactIdSchema,
    factOrdinal: NonnegativeIntegerSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type CandidateResultStructuredFact = z.infer<typeof CandidateResultStructuredFactSchema>;

export const CandidateResultFactConflictDraftSchema = z
  .object({
    candidateResultFactConflictId: CandidateResultFactConflictIdSchema,
    factConflictId: FactConflictIdSchema
  })
  .strict();
export type CandidateResultFactConflictDraft = z.infer<
  typeof CandidateResultFactConflictDraftSchema
>;

export const CandidateResultFactConflictSchema = z
  .object({
    candidateResultFactConflictId: CandidateResultFactConflictIdSchema,
    factConflictId: FactConflictIdSchema,
    conflictOrdinal: NonnegativeIntegerSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type CandidateResultFactConflict = z.infer<typeof CandidateResultFactConflictSchema>;

export const CandidateResultHardRequirementAssessmentDraftSchema = z
  .object({
    candidateResultHardRequirementAssessmentId: CandidateResultHardRequirementAssessmentIdSchema,
    hardRequirementAssessmentId: HardRequirementAssessmentIdSchema
  })
  .strict();
export type CandidateResultHardRequirementAssessmentDraft = z.infer<
  typeof CandidateResultHardRequirementAssessmentDraftSchema
>;

export const CandidateResultHardRequirementAssessmentSchema = z
  .object({
    candidateResultHardRequirementAssessmentId: CandidateResultHardRequirementAssessmentIdSchema,
    hardRequirementAssessmentId: HardRequirementAssessmentIdSchema,
    requirementOrdinal: NonnegativeIntegerSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type CandidateResultHardRequirementAssessment = z.infer<
  typeof CandidateResultHardRequirementAssessmentSchema
>;

export const CandidateResultReasonDraftSchema = z
  .object({
    candidateResultReasonId: CandidateResultReasonIdSchema,
    candidateResultId: CandidateTriageResultIdSchema,
    reasonCode: z.string().min(1).max(256),
    reasonOrdinal: NonnegativeIntegerSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type CandidateResultReasonDraft = z.infer<typeof CandidateResultReasonDraftSchema>;

export const CandidateResultReasonSchema = z
  .object({
    candidateResultReasonId: CandidateResultReasonIdSchema,
    candidateResultId: CandidateTriageResultIdSchema,
    reasonKind: ReasonCodeKindSchema,
    subjectId: z.string().min(1).max(128).nullable(),
    reasonCode: z.string().min(1).max(256),
    reasonOrdinal: NonnegativeIntegerSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type CandidateResultReason = z.infer<typeof CandidateResultReasonSchema>;

export const ScoreContributionSchema = z
  .object({
    dimensionId: RubricDimensionIdSchema,
    level: DimensionLevelSchema,
    levelValue: CANONICAL_RATIONAL_TEXT,
    weight: PositiveWeightSchema,
    weightedValue: CANONICAL_RATIONAL_TEXT
  })
  .strict();
export type ScoreContribution = z.infer<typeof ScoreContributionSchema>;

export const ScoreConfidenceInputSchema = z
  .object({
    contradictionCount: NonnegativeIntegerSchema,
    dimensionsWithLocatedSpan: NonnegativeIntegerSchema,
    requiredFieldsMissing: NonnegativeIntegerSchema,
    spansLocated: NonnegativeIntegerSchema,
    spansReturned: NonnegativeIntegerSchema,
    totalDimensions: PositiveIntegerSchema,
    totalRequiredFields: PositiveIntegerSchema
  })
  .strict();
export type ScoreConfidenceInput = z.infer<typeof ScoreConfidenceInputSchema>;

export const ScoreResultContentSchema = z
  .object({
    aggregate: CANONICAL_RATIONAL_TEXT,
    candidateTriageResultId: CandidateTriageResultIdSchema,
    confidence: CANONICAL_RATIONAL_TEXT,
    confidenceInput: ScoreConfidenceInputSchema,
    contributions: z.array(ScoreContributionSchema).length(6)
  })
  .strict();
export type ScoreResultContent = z.infer<typeof ScoreResultContentSchema>;

export const ScoreResultDraftSchema = z
  .object({
    scoreResultId: ScoreResultIdSchema,
    aggregate: CANONICAL_RATIONAL_TEXT,
    confidence: CANONICAL_RATIONAL_TEXT,
    confidenceInput: ScoreConfidenceInputSchema,
    contributions: z.array(ScoreContributionSchema).length(6)
  })
  .strict();
export type ScoreResultDraft = z.infer<typeof ScoreResultDraftSchema>;

export const ScoreResultSchema = z
  .object({
    scoreResultId: ScoreResultIdSchema,
    candidateResultId: CandidateTriageResultIdSchema,
    aggregateText: CANONICAL_RATIONAL_TEXT,
    confidenceText: CANONICAL_RATIONAL_TEXT,
    aggregateBasisPoints: BasisPointsSchema,
    confidenceBasisPoints: BasisPointsSchema,
    content: ScoreResultContentSchema,
    contentJson: z.string(),
    contentHash: Sha256HexSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type ScoreResult = z.infer<typeof ScoreResultSchema>;

export const CandidateTriageResultContentSchema = z
  .object({
    availability: DecisionAvailabilitySchema,
    candidateId: CandidateIdSchema,
    dimensionAssessmentIds: z.array(DimensionAssessmentIdSchema).max(MAXIMUM_RESULT_ASSESSMENTS),
    evidenceGapIds: z.array(EvidenceGapIdSchema).max(MAXIMUM_RESULT_GAPS),
    evidenceSpanIds: z.array(EvidenceSpanIdSchema).max(MAXIMUM_RESULT_EVIDENCE_SPANS),
    factConflictIds: z.array(FactConflictIdSchema).max(MAXIMUM_RESULT_CONFLICTS),
    hardRequirementAssessmentIds: z
      .array(HardRequirementAssessmentIdSchema)
      .max(MAXIMUM_RESULT_REQUIREMENTS),
    kind: CandidateResultKindSchema,
    status: CandidateTriageStatusSchema,
    structuredFactIds: z.array(StructuredFactIdSchema).max(MAXIMUM_RESULT_FACTS),
    supersedesResultId: CandidateTriageResultIdSchema.nullable()
  })
  .strict();
export type CandidateTriageResultContent = z.infer<typeof CandidateTriageResultContentSchema>;

export const CandidateTriageResultDraftSchema = z
  .object({
    candidateTriageResultId: CandidateTriageResultIdSchema,
    candidateId: CandidateIdSchema,
    kind: CandidateResultKindSchema,
    availability: DecisionAvailabilitySchema,
    status: CandidateTriageStatusSchema,
    supersedesResultId: CandidateTriageResultIdSchema.nullable(),
    evidenceSpans: z
      .array(CandidateResultEvidenceSpanDraftSchema)
      .max(MAXIMUM_RESULT_EVIDENCE_SPANS),
    evidenceGaps: z.array(CandidateResultEvidenceGapDraftSchema).max(MAXIMUM_RESULT_GAPS),
    dimensionAssessments: z
      .array(CandidateResultDimensionAssessmentDraftSchema)
      .max(MAXIMUM_RESULT_ASSESSMENTS),
    structuredFacts: z.array(CandidateResultStructuredFactDraftSchema).max(MAXIMUM_RESULT_FACTS),
    factConflicts: z.array(CandidateResultFactConflictDraftSchema).max(MAXIMUM_RESULT_CONFLICTS),
    hardRequirementAssessments: z
      .array(CandidateResultHardRequirementAssessmentDraftSchema)
      .max(MAXIMUM_RESULT_REQUIREMENTS),
    score: ScoreResultDraftSchema.nullable(),
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type CandidateTriageResultDraft = z.infer<typeof CandidateTriageResultDraftSchema>;

export const CandidateTriageResultSchema = z
  .object({
    candidateTriageResultId: CandidateTriageResultIdSchema,
    candidateId: CandidateIdSchema,
    kind: CandidateResultKindSchema,
    availability: DecisionAvailabilitySchema,
    status: CandidateTriageStatusSchema,
    supersedesResultId: CandidateTriageResultIdSchema.nullable(),
    contentJson: z.string(),
    contentHash: Sha256HexSchema,
    evidenceSpans: z.array(CandidateResultEvidenceSpanSchema),
    evidenceGaps: z.array(CandidateResultEvidenceGapSchema),
    dimensionAssessments: z.array(CandidateResultDimensionAssessmentSchema),
    structuredFacts: z.array(CandidateResultStructuredFactSchema),
    factConflicts: z.array(CandidateResultFactConflictSchema),
    hardRequirementAssessments: z.array(CandidateResultHardRequirementAssessmentSchema),
    score: ScoreResultSchema.nullable(),
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type CandidateTriageResult = z.infer<typeof CandidateTriageResultSchema>;
