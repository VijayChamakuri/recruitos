import {
  ActorIdSchema,
  DimensionAssessmentEvidenceSpanIdSchema,
  DimensionAssessmentIdSchema,
  DimensionLevelSchema,
  EvidenceGapIdSchema,
  EvidencePolaritySchema,
  EvidenceSourceSchema,
  EvidenceSpanIdSchema,
  ExtractionRunIdSchema,
  MatchQualitySchema,
  NonnegativeIntegerSchema,
  RubricDimensionIdSchema,
  Sha256HexSchema,
  SourceDocumentIdSchema
} from "@recruitos/core";
import { z } from "zod";

/**
 * Quotes are bounded so a packet renders a citation rather than a document,
 * and so an oversized model response cannot become storage pressure.
 */
export const MAXIMUM_QUOTED_TEXT_LENGTH = 240;
export const MAXIMUM_MODEL_ID_LENGTH = 200;
export const MAXIMUM_EXTRACTOR_VERSION_LENGTH = 64;
export const MAXIMUM_DROP_REASON_LENGTH = 200;

/**
 * Quoted text is stored exactly as located, never trimmed: for the exact and
 * normalized tiers the stored offsets index the same code units, so trimming
 * would silently break the offset-resolution invariant.
 */
const quotedText = z.string().min(1).max(MAXIMUM_QUOTED_TEXT_LENGTH);
const modelId = z.string().trim().min(1).max(MAXIMUM_MODEL_ID_LENGTH);
const extractorVersion = z.string().trim().min(1).max(MAXIMUM_EXTRACTOR_VERSION_LENGTH);
const dropReason = z.string().trim().min(1).max(MAXIMUM_DROP_REASON_LENGTH);

/**
 * An unlocated quote. The design records the quote and its reason on the
 * extraction run instead of inventing an unresolved match quality, which is
 * what keeps the confidence resolution term auditable.
 */
export const DroppedQuoteSchema = z
  .object({
    quotedText,
    dimensionId: RubricDimensionIdSchema,
    reason: dropReason
  })
  .strict();
export type DroppedQuote = z.infer<typeof DroppedQuoteSchema>;

const extractionRunDraftShape = {
  extractionRunId: ExtractionRunIdSchema,
  spansReturned: NonnegativeIntegerSchema,
  spansLocated: NonnegativeIntegerSchema,
  droppedQuotes: z.array(DroppedQuoteSchema),
  modelId,
  fixtureKey: Sha256HexSchema.nullable(),
  createdAt: NonnegativeIntegerSchema
};

export const ExtractionRunDraftSchema = z.object(extractionRunDraftShape).strict();
export type ExtractionRunDraft = z.infer<typeof ExtractionRunDraftSchema>;

export const ExtractionRunSchema = z
  .object({
    ...extractionRunDraftShape,
    droppedQuotesJson: z.string(),
    droppedQuotesHash: Sha256HexSchema
  })
  .strict();
export type ExtractionRun = z.infer<typeof ExtractionRunSchema>;

const evidenceSpanShape = {
  evidenceSpanId: EvidenceSpanIdSchema,
  documentId: SourceDocumentIdSchema,
  start: NonnegativeIntegerSchema,
  end: NonnegativeIntegerSchema,
  quotedText,
  dimensionId: RubricDimensionIdSchema,
  polarity: EvidencePolaritySchema,
  source: EvidenceSourceSchema,
  matchQuality: MatchQualitySchema,
  extractorVersion,
  createdAt: NonnegativeIntegerSchema
};

export const EvidenceSpanDraftSchema = z.object(evidenceSpanShape).strict();
export type EvidenceSpanDraft = z.infer<typeof EvidenceSpanDraftSchema>;

export const EvidenceSpanSchema = z.object(evidenceSpanShape).strict();
export type EvidenceSpan = z.infer<typeof EvidenceSpanSchema>;

const evidenceGapDraftShape = {
  evidenceGapId: EvidenceGapIdSchema,
  dimensionId: RubricDimensionIdSchema,
  reasonCode: z.string(),
  documentsSearched: z.array(SourceDocumentIdSchema),
  createdAt: NonnegativeIntegerSchema
};

export const EvidenceGapDraftSchema = z.object(evidenceGapDraftShape).strict();
export type EvidenceGapDraft = z.infer<typeof EvidenceGapDraftSchema>;

export const EvidenceGapSchema = z
  .object({
    ...evidenceGapDraftShape,
    documentsSearchedJson: z.string(),
    documentsSearchedHash: Sha256HexSchema
  })
  .strict();
export type EvidenceGap = z.infer<typeof EvidenceGapSchema>;

const dimensionAssessmentShape = {
  dimensionAssessmentId: DimensionAssessmentIdSchema,
  dimensionId: RubricDimensionIdSchema,
  level: DimensionLevelSchema,
  source: EvidenceSourceSchema,
  actorId: ActorIdSchema.nullable(),
  createdAt: NonnegativeIntegerSchema
};

export const DimensionAssessmentDraftSchema = z.object(dimensionAssessmentShape).strict();
export type DimensionAssessmentDraft = z.infer<typeof DimensionAssessmentDraftSchema>;

export const DimensionAssessmentSchema = z.object(dimensionAssessmentShape).strict();
export type DimensionAssessment = z.infer<typeof DimensionAssessmentSchema>;

const dimensionAssessmentEvidenceSpanShape = {
  dimensionAssessmentEvidenceSpanId: DimensionAssessmentEvidenceSpanIdSchema,
  dimensionAssessmentId: DimensionAssessmentIdSchema,
  evidenceSpanId: EvidenceSpanIdSchema,
  spanOrdinal: NonnegativeIntegerSchema,
  createdAt: NonnegativeIntegerSchema
};

export const DimensionAssessmentEvidenceSpanDraftSchema = z
  .object(dimensionAssessmentEvidenceSpanShape)
  .strict();
export type DimensionAssessmentEvidenceSpanDraft = z.infer<
  typeof DimensionAssessmentEvidenceSpanDraftSchema
>;

export const DimensionAssessmentEvidenceSpanSchema = z
  .object(dimensionAssessmentEvidenceSpanShape)
  .strict();
export type DimensionAssessmentEvidenceSpan = z.infer<
  typeof DimensionAssessmentEvidenceSpanSchema
>;
