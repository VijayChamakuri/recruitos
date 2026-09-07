import {
  IsoDateSchema,
  MAXIMUM_EVIDENCE_ITEMS_PER_WORK_ITEM,
  MAXIMUM_PROVIDER_RESPONSE_BYTES,
  MAXIMUM_QUOTE_LENGTH,
  MAXIMUM_SERIALIZED_REQUEST_BYTES,
  MAXIMUM_STRUCTURED_FACTS_PER_WORK_ITEM,
  MAXIMUM_VALIDATION_DETAILS,
  NonnegativeIntegerSchema,
  PositiveWeightSchema,
  RoleIdSchema,
  RubricDimensionIdSchema,
  RunInputSnapshotIdSchema,
  SCORING_POLICY_V1,
  Sha256HexSchema
} from "@recruitos/core";
import { z } from "zod";

const MAXIMUM_EXTRACTOR_VERSION_LENGTH = 64;
const MAXIMUM_PROMPT_TEMPLATE_VERSION_LENGTH = 64;
const MAXIMUM_RUBRIC_VERSION_LENGTH = 64;
const MAXIMUM_RUBRIC_PROSE_LENGTH = 2000;

const extractorVersion = z.string().trim().min(1).max(MAXIMUM_EXTRACTOR_VERSION_LENGTH);
const promptTemplateVersion = z
  .string()
  .trim()
  .min(1)
  .max(MAXIMUM_PROMPT_TEMPLATE_VERSION_LENGTH);
const rubricVersion = z.string().trim().min(1).max(MAXIMUM_RUBRIC_VERSION_LENGTH);
const rubricProse = z.string().trim().min(1).max(MAXIMUM_RUBRIC_PROSE_LENGTH);

/**
 * V1 capacity contract hashed into the snapshot. Changing a limit produces a
 * new snapshot identity, the same rule extraction specs already enforce.
 */
export const RunInputSnapshotLimitsSchema = z
  .object({
    maxEvidenceItems: z.literal(MAXIMUM_EVIDENCE_ITEMS_PER_WORK_ITEM),
    maxStructuredFacts: z.literal(MAXIMUM_STRUCTURED_FACTS_PER_WORK_ITEM),
    maxValidationDetails: z.literal(MAXIMUM_VALIDATION_DETAILS),
    maxQuoteLength: z.literal(MAXIMUM_QUOTE_LENGTH),
    maxSerializedRequestBytes: z.literal(MAXIMUM_SERIALIZED_REQUEST_BYTES),
    maxProviderResponseBytes: z.literal(MAXIMUM_PROVIDER_RESPONSE_BYTES)
  })
  .strict();
export type RunInputSnapshotLimits = z.infer<typeof RunInputSnapshotLimitsSchema>;

/**
 * Integer basis-point scoring policy. Weights belong here because the snapshot
 * is the decision configuration, not an extraction prompt.
 */
export const RunInputScoringPolicySchema = z
  .object({
    levelValues: z
      .object({
        none: z.literal(SCORING_POLICY_V1.levelValues.none),
        weak: z.literal(SCORING_POLICY_V1.levelValues.weak),
        partial: z.literal(SCORING_POLICY_V1.levelValues.partial),
        strong: z.literal(SCORING_POLICY_V1.levelValues.strong)
      })
      .strict(),
    confidenceWeights: z
      .object({
        coverage: z.literal(SCORING_POLICY_V1.confidenceWeights.coverage),
        resolution: z.literal(SCORING_POLICY_V1.confidenceWeights.resolution),
        contradiction: z.literal(SCORING_POLICY_V1.confidenceWeights.contradiction),
        missingFields: z.literal(SCORING_POLICY_V1.confidenceWeights.missingFields)
      })
      .strict(),
    escalateThreshold: z.literal(SCORING_POLICY_V1.escalateThreshold),
    shortlistN: z.literal(SCORING_POLICY_V1.shortlistN),
    requiredFieldIds: z.tuple([
      z.literal(SCORING_POLICY_V1.requiredFieldIds[0]),
      z.literal(SCORING_POLICY_V1.requiredFieldIds[1]),
      z.literal(SCORING_POLICY_V1.requiredFieldIds[2]),
      z.literal(SCORING_POLICY_V1.requiredFieldIds[3])
    ])
  })
  .strict();
export type RunInputScoringPolicy = z.infer<typeof RunInputScoringPolicySchema>;

export const RunInputSnapshotDimensionSchema = z
  .object({
    dimensionId: RubricDimensionIdSchema,
    weight: PositiveWeightSchema,
    required: z.boolean(),
    definition: rubricProse,
    jobRelatedJustification: rubricProse,
    ordinal: NonnegativeIntegerSchema
  })
  .strict();
export type RunInputSnapshotDimension = z.infer<typeof RunInputSnapshotDimensionSchema>;

/**
 * Exact decision configuration hashed into run_input_snapshot.content_hash.
 * Frozen date, role, rubric prose, weights, scoring policy, extractor versions,
 * and v1 limits are all identity. Snapshot row IDs and timestamps are not.
 */
export const RunInputSnapshotContentSchema = z
  .object({
    frozenDate: IsoDateSchema,
    roleId: RoleIdSchema,
    rubricVersion,
    dimensions: z.array(RunInputSnapshotDimensionSchema).min(1),
    scoringPolicy: RunInputScoringPolicySchema,
    extractorVersion,
    promptTemplateVersion,
    limits: RunInputSnapshotLimitsSchema
  })
  .strict();
export type RunInputSnapshotContent = z.infer<typeof RunInputSnapshotContentSchema>;

export const RunInputSnapshotDraftSchema = z
  .object({
    runInputSnapshotId: RunInputSnapshotIdSchema,
    content: z.unknown(),
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type RunInputSnapshotDraft = z.infer<typeof RunInputSnapshotDraftSchema>;

export const RunInputSnapshotSchema = z
  .object({
    runInputSnapshotId: RunInputSnapshotIdSchema,
    content: RunInputSnapshotContentSchema,
    contentJson: z.string(),
    contentHash: Sha256HexSchema,
    frozenDate: IsoDateSchema,
    rubricVersion,
    roleId: RoleIdSchema,
    extractorVersion,
    promptTemplateVersion,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type RunInputSnapshot = z.infer<typeof RunInputSnapshotSchema>;
