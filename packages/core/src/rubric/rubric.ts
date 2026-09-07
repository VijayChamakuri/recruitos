import { z } from "zod";

import { RubricDimensionIdSchema, RubricIdSchema } from "../domain/ids.js";
import { PositiveWeightSchema } from "../domain/integers.js";
import { createDomainError, type DomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";

const NonEmptyProseSchema = z.string().trim().min(1).max(2000);

export const RubricDimensionSchema = z
  .object({
    dimensionId: RubricDimensionIdSchema,
    weight: PositiveWeightSchema,
    required: z.boolean(),
    definition: NonEmptyProseSchema,
    jobRelatedJustification: NonEmptyProseSchema
  })
  .strict()
  .readonly();

export type RubricDimension = z.infer<typeof RubricDimensionSchema>;

export const RubricSchema = z
  .object({
    rubricId: RubricIdSchema,
    version: z.string().trim().min(1).max(64),
    dimensions: z.array(RubricDimensionSchema).min(1)
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const dimension of value.dimensions) {
      if (seen.has(dimension.dimensionId)) {
        context.addIssue({ code: "custom", message: "Rubric dimension ids must be unique" });
      }
      seen.add(dimension.dimensionId);
    }
  })
  .readonly();

export type Rubric = z.infer<typeof RubricSchema>;

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
