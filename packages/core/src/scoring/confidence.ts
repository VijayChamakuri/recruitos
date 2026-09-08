import { z } from "zod";

import {
  addRationals,
  clampRational,
  multiplyRationals,
  subtractRationals,
  type Rational
} from "../canonical/rational.js";
import { NonnegativeIntegerSchema, PositiveIntegerSchema } from "../domain/integers.js";
import { createDomainError, type DomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";
import { CONFIDENCE_WEIGHTS } from "./constants.js";
import { mustRational, RATIONAL_ONE, RATIONAL_ZERO } from "./exact.js";

export const ConfidenceInputSchema = z
  .object({
    dimensionsWithLocatedSpan: NonnegativeIntegerSchema,
    totalDimensions: PositiveIntegerSchema,
    spansLocated: NonnegativeIntegerSchema,
    spansReturned: NonnegativeIntegerSchema,
    contradictionCount: NonnegativeIntegerSchema,
    requiredFieldsMissing: NonnegativeIntegerSchema,
    totalRequiredFields: PositiveIntegerSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.dimensionsWithLocatedSpan > value.totalDimensions) {
      context.addIssue({ code: "custom", message: "coverage numerator exceeds total dimensions" });
    }
    if (value.spansLocated > value.spansReturned) {
      context.addIssue({ code: "custom", message: "located spans exceed returned spans" });
    }
    if (value.requiredFieldsMissing > value.totalRequiredFields) {
      context.addIssue({ code: "custom", message: "missing fields exceed total required fields" });
    }
  });

export type ConfidenceInput = z.infer<typeof ConfidenceInputSchema>;

/**
 * Computes confidence deterministically (design invariant P4), never
 * self-reported. confidence = clamp01(0.45*coverage + 0.25*resolution
 * - 0.20*contra_rate - 0.10*miss_rate), all exact rational, result in 0..1.
 * resolution is 0 when the extractor returned no spans.
 */
export function computeConfidence(input: unknown): Result<Rational, DomainError> {
  const parsed = ConfidenceInputSchema.safeParse(input);
  if (!parsed.success) {
    return err(createDomainError("invalid_evidence", "Invalid confidence input"));
  }
  const value = parsed.data;

  const coverage = mustRational(
    BigInt(value.dimensionsWithLocatedSpan),
    BigInt(value.totalDimensions)
  );
  const resolution =
    value.spansReturned === 0
      ? RATIONAL_ZERO
      : mustRational(BigInt(value.spansLocated), BigInt(value.spansReturned));
  const contraRate = clampRational(
    mustRational(BigInt(value.contradictionCount), BigInt(value.totalDimensions)),
    RATIONAL_ZERO,
    RATIONAL_ONE
  );
  const missRate = mustRational(
    BigInt(value.requiredFieldsMissing),
    BigInt(value.totalRequiredFields)
  );

  const positive = addRationals(
    multiplyRationals(CONFIDENCE_WEIGHTS.coverage, coverage),
    multiplyRationals(CONFIDENCE_WEIGHTS.resolution, resolution)
  );
  const afterContradiction = subtractRationals(
    positive,
    multiplyRationals(CONFIDENCE_WEIGHTS.contradiction, contraRate)
  );
  const combined = subtractRationals(
    afterContradiction,
    multiplyRationals(CONFIDENCE_WEIGHTS.missingFields, missRate)
  );
  return ok(clampRational(combined, RATIONAL_ZERO, RATIONAL_ONE));
}
