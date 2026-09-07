import {
  EXTRACTION_LIMITS,
  ExtractionArtifactIdSchema,
  ExtractionFailureErrorClassSchema,
  ExtractionFailureIdSchema,
  ExtractionRejectedClaimKindSchema,
  ExtractionSpecIdSchema,
  MAXIMUM_EVIDENCE_ITEMS_PER_WORK_ITEM,
  MAXIMUM_PROVIDER_RESPONSE_BYTES,
  MAXIMUM_QUOTE_LENGTH,
  MAXIMUM_SERIALIZED_REQUEST_BYTES,
  MAXIMUM_STRUCTURED_FACTS_PER_WORK_ITEM,
  MAXIMUM_VALIDATION_DETAILS,
  MatchQualitySchema,
  NonnegativeIntegerSchema,
  EvidencePolaritySchema,
  RubricDimensionIdSchema,
  Sha256HexSchema,
  SourceDocumentIdSchema,
  DimensionLevelSchema
} from "@recruitos/core";
import { z } from "zod";

export {
  EXTRACTION_LIMITS,
  MAXIMUM_EVIDENCE_ITEMS_PER_WORK_ITEM,
  MAXIMUM_PROVIDER_RESPONSE_BYTES,
  MAXIMUM_QUOTE_LENGTH,
  MAXIMUM_SERIALIZED_REQUEST_BYTES,
  MAXIMUM_STRUCTURED_FACTS_PER_WORK_ITEM,
  MAXIMUM_VALIDATION_DETAILS
};

const MAXIMUM_MODEL_ID_LENGTH = 200;
const MAXIMUM_EXTRACTOR_VERSION_LENGTH = 64;
const MAXIMUM_RUBRIC_PROSE_LENGTH = 2000;
const MAXIMUM_DROP_REASON_LENGTH = 200;
export const MAXIMUM_PROMPT_TEMPLATE_VERSION_LENGTH = 64;
export const MAXIMUM_DIAGNOSTIC_SUMMARY_LENGTH = 200;

const modelId = z.string().trim().min(1).max(MAXIMUM_MODEL_ID_LENGTH);
const extractorVersion = z.string().trim().min(1).max(MAXIMUM_EXTRACTOR_VERSION_LENGTH);
const promptTemplateVersion = z
  .string()
  .trim()
  .min(1)
  .max(MAXIMUM_PROMPT_TEMPLATE_VERSION_LENGTH);
const rubricProse = z.string().trim().min(1).max(MAXIMUM_RUBRIC_PROSE_LENGTH);
const quotedText = z.string().min(1).max(MAXIMUM_QUOTE_LENGTH);
const dropReason = z.string().trim().min(1).max(MAXIMUM_DROP_REASON_LENGTH);
const diagnosticSummary = z
  .string()
  .trim()
  .min(1)
  .max(MAXIMUM_DIAGNOSTIC_SUMMARY_LENGTH);
const diagnosticDetail = z.string().trim().min(1).max(MAXIMUM_DIAGNOSTIC_SUMMARY_LENGTH);

/**
 * Exact model and validation contract hashed into extraction_spec.content_hash.
 * Rubric weights are excluded so weight tuning cannot invalidate fixtures;
 * dimension definitions are included because they are in the prompt.
 */
export const ExtractionSpecLimitsSchema = z
  .object({
    maxEvidenceItems: z.literal(MAXIMUM_EVIDENCE_ITEMS_PER_WORK_ITEM),
    maxStructuredFacts: z.literal(MAXIMUM_STRUCTURED_FACTS_PER_WORK_ITEM),
    maxValidationDetails: z.literal(MAXIMUM_VALIDATION_DETAILS),
    maxQuoteLength: z.literal(MAXIMUM_QUOTE_LENGTH),
    maxSerializedRequestBytes: z.literal(MAXIMUM_SERIALIZED_REQUEST_BYTES),
    maxProviderResponseBytes: z.literal(MAXIMUM_PROVIDER_RESPONSE_BYTES)
  })
  .strict();
export type ExtractionSpecLimits = z.infer<typeof ExtractionSpecLimitsSchema>;

export const ExtractionSpecContentSchema = z
  .object({
    modelId,
    extractorVersion,
    promptTemplateVersion,
    promptHash: Sha256HexSchema,
    schemaHash: Sha256HexSchema,
    dimensionId: RubricDimensionIdSchema,
    dimensionDefinition: rubricProse,
    jobRelatedJustification: rubricProse,
    limits: ExtractionSpecLimitsSchema
  })
  .strict();
export type ExtractionSpecContent = z.infer<typeof ExtractionSpecContentSchema>;

export const ExtractionSpecDraftSchema = z
  .object({
    extractionSpecId: ExtractionSpecIdSchema,
    content: z.unknown(),
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type ExtractionSpecDraft = z.infer<typeof ExtractionSpecDraftSchema>;

export const ExtractionSpecSchema = z
  .object({
    extractionSpecId: ExtractionSpecIdSchema,
    content: ExtractionSpecContentSchema,
    contentJson: z.string(),
    contentHash: Sha256HexSchema,
    modelId,
    extractorVersion,
    promptHash: Sha256HexSchema,
    schemaHash: Sha256HexSchema,
    dimensionId: RubricDimensionIdSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type ExtractionSpec = z.infer<typeof ExtractionSpecSchema>;

/**
 * Located proposal spans after quote relocation. Offsets are ignored from the
 * model and rewritten against stored normalized text before this record is
 * prepared.
 */
export const ExtractionAcceptedSpanSchema = z
  .object({
    start: NonnegativeIntegerSchema,
    end: NonnegativeIntegerSchema,
    quotedText,
    polarity: EvidencePolaritySchema,
    matchQuality: MatchQualitySchema
  })
  .strict();
export type ExtractionAcceptedSpan = z.infer<typeof ExtractionAcceptedSpanSchema>;

export const ExtractionAcceptedOutputSchema = z
  .object({
    dimensionId: RubricDimensionIdSchema,
    proposedLevel: DimensionLevelSchema,
    spans: z.array(ExtractionAcceptedSpanSchema)
  })
  .strict();
export type ExtractionAcceptedOutput = z.infer<typeof ExtractionAcceptedOutputSchema>;

export const ExtractionRejectedClaimSchema = z
  .object({
    kind: ExtractionRejectedClaimKindSchema,
    quotedText,
    reason: dropReason
  })
  .strict();
export type ExtractionRejectedClaim = z.infer<typeof ExtractionRejectedClaimSchema>;

export const ExtractionArtifactDraftSchema = z
  .object({
    extractionArtifactId: ExtractionArtifactIdSchema,
    specId: ExtractionSpecIdSchema,
    sourceDocumentId: SourceDocumentIdSchema,
    acceptedOutput: ExtractionAcceptedOutputSchema,
    rejectedClaims: z.array(ExtractionRejectedClaimSchema),
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type ExtractionArtifactDraft = z.infer<typeof ExtractionArtifactDraftSchema>;

export const ExtractionArtifactSchema = z
  .object({
    extractionArtifactId: ExtractionArtifactIdSchema,
    specId: ExtractionSpecIdSchema,
    sourceDocumentId: SourceDocumentIdSchema,
    acceptedOutput: ExtractionAcceptedOutputSchema,
    acceptedOutputJson: z.string(),
    acceptedOutputHash: Sha256HexSchema,
    rejectedClaims: z.array(ExtractionRejectedClaimSchema),
    rejectedClaimsJson: z.string(),
    rejectedClaimsHash: Sha256HexSchema,
    contentHash: Sha256HexSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type ExtractionArtifact = z.infer<typeof ExtractionArtifactSchema>;

export const ExtractionFailureDiagnosticSchema = z
  .object({
    summary: diagnosticSummary,
    details: z.array(diagnosticDetail)
  })
  .strict();
export type ExtractionFailureDiagnostic = z.infer<typeof ExtractionFailureDiagnosticSchema>;

export const ExtractionFailureDraftSchema = z
  .object({
    extractionFailureId: ExtractionFailureIdSchema,
    specId: ExtractionSpecIdSchema,
    sourceDocumentId: SourceDocumentIdSchema,
    errorClass: ExtractionFailureErrorClassSchema,
    responseHash: Sha256HexSchema,
    responseByteLength: NonnegativeIntegerSchema,
    diagnostic: ExtractionFailureDiagnosticSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type ExtractionFailureDraft = z.infer<typeof ExtractionFailureDraftSchema>;

export const ExtractionFailureSchema = z
  .object({
    extractionFailureId: ExtractionFailureIdSchema,
    specId: ExtractionSpecIdSchema,
    sourceDocumentId: SourceDocumentIdSchema,
    errorClass: ExtractionFailureErrorClassSchema,
    responseHash: Sha256HexSchema,
    responseByteLength: NonnegativeIntegerSchema,
    diagnostic: ExtractionFailureDiagnosticSchema,
    diagnosticJson: z.string(),
    diagnosticHash: Sha256HexSchema,
    contentHash: Sha256HexSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type ExtractionFailure = z.infer<typeof ExtractionFailureSchema>;
