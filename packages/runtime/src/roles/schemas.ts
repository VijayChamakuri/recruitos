import {
  LevelAnchorsSchema,
  NonnegativeIntegerSchema,
  PositiveIntegerSchema,
  PositiveWeightSchema,
  RequirementIdSchema,
  RoleIdSchema,
  RubricAuthorshipSchema,
  RubricDimensionIdSchema,
  RubricIdSchema,
  RubricProvenanceAssumptionIdSchema,
  WorkflowAssumptionIdSchema
} from "@recruitos/core";
import { z } from "zod";

/**
 * Role titles are short display names. Requirement and dimension prose reuse
 * the core rubric 2000-character bound so a stored rubric can round-trip.
 */
export const MAXIMUM_ROLE_TITLE_LENGTH = 200;
export const MAXIMUM_REQUIREMENT_DESCRIPTION_LENGTH = 2000;
export const MAXIMUM_RUBRIC_PROSE_LENGTH = 2000;

export const RequirementKindSchema = z.enum(["hard", "scored"]);
export type RequirementKind = z.infer<typeof RequirementKindSchema>;

const title = z.string().trim().min(1).max(MAXIMUM_ROLE_TITLE_LENGTH);
const requirementDescription = z
  .string()
  .trim()
  .min(1)
  .max(MAXIMUM_REQUIREMENT_DESCRIPTION_LENGTH);
const rubricProse = z.string().trim().min(1).max(MAXIMUM_RUBRIC_PROSE_LENGTH);

const roleShape = {
  roleId: RoleIdSchema,
  title,
  createdAt: NonnegativeIntegerSchema
};

export const RoleDraftSchema = z.object(roleShape).strict();
export type RoleDraft = z.infer<typeof RoleDraftSchema>;

export const RoleSchema = z.object(roleShape).strict();
export type Role = z.infer<typeof RoleSchema>;

const requirementShape = {
  requirementId: RequirementIdSchema,
  roleId: RoleIdSchema,
  kind: RequirementKindSchema,
  description: requirementDescription,
  createdAt: NonnegativeIntegerSchema
};

export const RequirementDraftSchema = z.object(requirementShape).strict();
export type RequirementDraft = z.infer<typeof RequirementDraftSchema>;

export const RequirementSchema = z.object(requirementShape).strict();
export type Requirement = z.infer<typeof RequirementSchema>;

const rubricShape = {
  rubricId: RubricIdSchema,
  roleId: RoleIdSchema,
  version: PositiveIntegerSchema,
  provenanceAuthorship: RubricAuthorshipSchema,
  createdAt: NonnegativeIntegerSchema
};

export const RubricDraftSchema = z.object(rubricShape).strict();
export type RubricDraft = z.infer<typeof RubricDraftSchema>;

export const StoredRubricSchema = z.object(rubricShape).strict();
export type StoredRubric = z.infer<typeof StoredRubricSchema>;

const storedRubricDimensionShape = {
  rubricDimensionId: RubricDimensionIdSchema,
  rubricId: RubricIdSchema,
  dimensionId: RubricDimensionIdSchema,
  weight: PositiveWeightSchema,
  required: z.boolean(),
  definition: rubricProse,
  jobRelatedJustification: rubricProse,
  levelAnchors: LevelAnchorsSchema,
  ordinal: NonnegativeIntegerSchema,
  createdAt: NonnegativeIntegerSchema
};

export const RubricDimensionDraftSchema = z
  .object({
    ...storedRubricDimensionShape,
    definition: z.string().min(1),
    jobRelatedJustification: z.string().min(1),
    levelAnchors: z.object({
      none: z.string().min(1),
      weak: z.string().min(1),
      partial: z.string().min(1),
      strong: z.string().min(1)
    })
  })
  .strict();
export type RubricDimensionDraft = z.infer<typeof RubricDimensionDraftSchema>;

export const StoredRubricDimensionSchema = z.object(storedRubricDimensionShape).strict();
export type StoredRubricDimension = z.infer<typeof StoredRubricDimensionSchema>;

const storedRubricProvenanceAssumptionShape = {
  rubricProvenanceAssumptionId: RubricProvenanceAssumptionIdSchema,
  rubricId: RubricIdSchema,
  workflowAssumptionId: WorkflowAssumptionIdSchema,
  ordinal: NonnegativeIntegerSchema,
  createdAt: NonnegativeIntegerSchema
};

export const RubricProvenanceAssumptionDraftSchema = z
  .object(storedRubricProvenanceAssumptionShape)
  .strict();
export type RubricProvenanceAssumptionDraft = z.infer<
  typeof RubricProvenanceAssumptionDraftSchema
>;

export const StoredRubricProvenanceAssumptionSchema = z
  .object(storedRubricProvenanceAssumptionShape)
  .strict();
export type StoredRubricProvenanceAssumption = z.infer<
  typeof StoredRubricProvenanceAssumptionSchema
>;
