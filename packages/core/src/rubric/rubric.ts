import { z } from "zod";

import { canonicalJsonStringify } from "../canonical/json.js";
import { sha256Hex } from "../canonical/sha256.js";
import type { Sha256Hex } from "../domain/hashes.js";
import { RubricDimensionIdSchema, RubricIdSchema } from "../domain/ids.js";
import { PositiveWeightSchema } from "../domain/integers.js";
import { createDomainError, type DomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";
import { DIMENSION_LEVELS, type DimensionLevel } from "./levels.js";

const NonEmptyProseSchema = z.string().trim().min(1).max(2000);

const levelAnchorShape = Object.fromEntries(
  DIMENSION_LEVELS.map((level) => [level, NonEmptyProseSchema])
) as { [K in DimensionLevel]: typeof NonEmptyProseSchema };

export const LevelAnchorsSchema = z.object(levelAnchorShape).strict().readonly();
export type LevelAnchors = z.infer<typeof LevelAnchorsSchema>;

export const RUBRIC_AUTHORSHIP = ["product-authored", "recruiter-validated"] as const;
export const RubricAuthorshipSchema = z.enum(RUBRIC_AUTHORSHIP);
export type RubricAuthorship = z.infer<typeof RubricAuthorshipSchema>;

export const WorkflowAssumptionIdSchema = z
  .string()
  .regex(/^WA-\d{2}$/u, "Expected a WA-NN assumption id");
export type WorkflowAssumptionId = z.infer<typeof WorkflowAssumptionIdSchema>;

export const RubricProvenanceSchema = z
  .object({
    authorship: RubricAuthorshipSchema,
    restsOn: z.array(WorkflowAssumptionIdSchema).min(1)
  })
  .strict()
  .readonly();
export type RubricProvenance = z.infer<typeof RubricProvenanceSchema>;

export const RubricDimensionSchema = z
  .object({
    dimensionId: RubricDimensionIdSchema,
    weight: PositiveWeightSchema,
    required: z.boolean(),
    definition: NonEmptyProseSchema,
    jobRelatedJustification: NonEmptyProseSchema,
    levelAnchors: LevelAnchorsSchema.optional()
  })
  .strict()
  .readonly();

export type RubricDimension = z.infer<typeof RubricDimensionSchema>;

export const LockedRubricDimensionSchema = z
  .object({
    dimensionId: RubricDimensionIdSchema,
    weight: PositiveWeightSchema,
    required: z.boolean(),
    definition: NonEmptyProseSchema,
    jobRelatedJustification: NonEmptyProseSchema,
    levelAnchors: LevelAnchorsSchema
  })
  .strict()
  .readonly();

export type LockedRubricDimension = z.infer<typeof LockedRubricDimensionSchema>;

function uniqueDimensionIds(
  value: { readonly dimensions: readonly { readonly dimensionId: string }[] },
  context: z.RefinementCtx
): void {
  const seen = new Set<string>();
  for (const dimension of value.dimensions) {
    if (seen.has(dimension.dimensionId)) {
      context.addIssue({ code: "custom", message: "Rubric dimension ids must be unique" });
    }
    seen.add(dimension.dimensionId);
  }
}

/**
 * General rubric snapshot. `version` accepts the locked integer form and the
 * stored string form so other lanes can keep parsing headers until they persist
 * integer versions. `provenance` and `levelAnchors` are present on the locked
 * v1 snapshot; they stay optional here so stored rows and helper rubrics still
 * satisfy this schema.
 */
export const RubricSchema = z
  .object({
    rubricId: RubricIdSchema,
    version: z.union([z.number().int().positive(), z.string().trim().min(1).max(64)]),
    provenance: RubricProvenanceSchema.optional(),
    dimensions: z.array(RubricDimensionSchema).min(1)
  })
  .strict()
  .superRefine(uniqueDimensionIds)
  .readonly();

export type Rubric = z.infer<typeof RubricSchema>;

/** Gate 2 locked snapshot: integer version 1, provenance, and four anchors. */
export const LockedRubricSchema = z
  .object({
    rubricId: RubricIdSchema,
    version: z.literal(1),
    provenance: RubricProvenanceSchema,
    dimensions: z.array(LockedRubricDimensionSchema).min(1)
  })
  .strict()
  .superRefine(uniqueDimensionIds)
  .readonly();

export type LockedRubric = z.infer<typeof LockedRubricSchema>;

export function totalRubricWeight(rubric: Rubric): number {
  let total = 0;
  for (const dimension of rubric.dimensions) {
    total += dimension.weight;
  }
  return total;
}

export function createRubric(input: unknown): Result<Rubric, DomainError> {
  const parsed = RubricSchema.safeParse(input);
  if (!parsed.success) {
    return err(createDomainError("invalid_rubric", "Invalid rubric definition"));
  }
  return ok(parsed.data);
}

export function createLockedRubric(input: unknown): Result<LockedRubric, DomainError> {
  const parsed = LockedRubricSchema.safeParse(input);
  if (!parsed.success) {
    return err(createDomainError("invalid_rubric", "Invalid locked rubric definition"));
  }
  return ok(parsed.data);
}

export type RubricCanonicalSnapshot = Readonly<{
  canonicalBytes: string;
  hash: Sha256Hex;
}>;

/**
 * Canonical JSON bytes plus SHA-256 for a rubric snapshot. The hash covers
 * every field including level anchors.
 */
export function mustRubricCanonicalSnapshot(value: unknown): RubricCanonicalSnapshot {
  const canonical = canonicalJsonStringify(value);
  if (!canonical.ok) {
    throw new Error("Rubric canonicalization failed");
  }
  return {
    canonicalBytes: canonical.value,
    hash: sha256Hex(canonical.value)
  };
}
