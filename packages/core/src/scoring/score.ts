import { z } from "zod";

import { addRationals, multiplyRationals, type Rational } from "../canonical/rational.js";
import { RubricDimensionIdSchema, type RubricDimensionId } from "../domain/ids.js";
import { createDomainError, type DomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";
import { DimensionLevelSchema, type DimensionLevel } from "../rubric/levels.js";
import type { Rubric } from "../rubric/rubric.js";
import { LEVEL_VALUE } from "./constants.js";
import { mustRational, RATIONAL_HUNDRED, RATIONAL_ZERO } from "./exact.js";

const LevelAssessmentSchema = z
  .object({
    dimensionId: RubricDimensionIdSchema,
    level: DimensionLevelSchema
  })
  .strict()
  .readonly();

export type LevelAssessment = z.infer<typeof LevelAssessmentSchema>;

const LevelAssessmentsSchema = z.array(LevelAssessmentSchema);

export type DimensionScoreContribution = Readonly<{
  dimensionId: RubricDimensionId;
  level: DimensionLevel;
  weight: number;
  levelValue: Rational;
  weightedValue: Rational;
}>;

export type ScoreComputation = Readonly<{
  aggregate: Rational;
  weightedSum: Rational;
  totalWeight: number;
  contributions: readonly DimensionScoreContribution[];
}>;

/**
 * The scoring function f. Input carries only dimension ids and ordinal levels
 * plus the rubric weights (design invariant P6): no free text is representable.
 * Requires exactly one assessment per rubric dimension so the denominator is the
 * sum over all dimensions and an unevidenced dimension at none contributes zero.
 * All arithmetic is exact rational; the aggregate is 0..100.
 */
export function computeAggregateScore(
  assessmentsInput: unknown,
  rubric: Rubric
): Result<ScoreComputation, DomainError> {
  const parsed = LevelAssessmentsSchema.safeParse(assessmentsInput);
  if (!parsed.success) {
    return err(createDomainError("invalid_input", "Invalid level assessments"));
  }

  const levelByDimension = new Map<string, DimensionLevel>();
  for (const assessment of parsed.data) {
    if (levelByDimension.has(assessment.dimensionId)) {
      return err(
        createDomainError("score_invariant_failed", "Duplicate assessment for a rubric dimension")
      );
    }
    levelByDimension.set(assessment.dimensionId, assessment.level);
  }
  if (levelByDimension.size !== rubric.dimensions.length) {
    return err(
      createDomainError(
        "score_invariant_failed",
        "Assessments must cover every rubric dimension exactly once"
      )
    );
  }

  let weightedSum = RATIONAL_ZERO;
  let totalWeight = 0;
  const contributions: DimensionScoreContribution[] = [];
  for (const dimension of rubric.dimensions) {
    const level = levelByDimension.get(dimension.dimensionId);
    if (level === undefined) {
      return err(
        createDomainError("score_invariant_failed", "Assessments do not match the rubric dimensions")
      );
    }
    const levelValue = LEVEL_VALUE[level];
    const weightedValue = multiplyRationals(levelValue, mustRational(BigInt(dimension.weight), 1n));
    weightedSum = addRationals(weightedSum, weightedValue);
    totalWeight += dimension.weight;
    contributions.push({
      dimensionId: dimension.dimensionId,
      level,
      weight: dimension.weight,
      levelValue,
      weightedValue
    });
  }

  const scaled = multiplyRationals(RATIONAL_HUNDRED, weightedSum);
  const aggregate = mustRational(scaled.numerator, scaled.denominator * BigInt(totalWeight));
  return ok({
    aggregate,
    weightedSum,
    totalWeight,
    contributions: Object.freeze(contributions)
  });
}
