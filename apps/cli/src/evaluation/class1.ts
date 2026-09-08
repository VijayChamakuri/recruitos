export type DimensionCoverage = Readonly<{
  dimension: string;
  locatedSpanCount: number;
  validatedGapCount: number;
  isComplete: boolean;
}>;

export type Class1EvaluationInput = Readonly<{
  candidateId: string;
  tier: 1 | 2;
  totalDimensions: number;
  dimensionCoverages: readonly DimensionCoverage[];
  knownLimitations: readonly string[];
}>;

export type Class1EvaluationReport = Readonly<{
  passed: boolean;
  candidateId: string;
  locatedSpanCoverageRate: number;
  coverageRequirementMet: boolean;
  allDimensionsAccountedFor: boolean;
  knownLimitationsCountMet: boolean;
  violations: readonly string[];
}>;

const MINIMUM_LOCATED_SPAN_COVERAGE = 0.7;
const MINIMUM_KNOWN_LIMITATIONS = 3;

/** Executes the existing deterministic Class 1 evaluation gate. */
export function runClass1EvaluationGate(
  input: Class1EvaluationInput
): Class1EvaluationReport {
  const violations: string[] = [];
  const locatedDimensions = input.dimensionCoverages.filter(
    (dimension) => dimension.locatedSpanCount > 0
  ).length;
  const locatedSpanCoverageRate =
    input.totalDimensions > 0
      ? Number((locatedDimensions / input.totalDimensions).toFixed(4))
      : 0;
  const coverageRequirementMet =
    input.tier !== 1 || locatedSpanCoverageRate >= MINIMUM_LOCATED_SPAN_COVERAGE;

  if (!coverageRequirementMet) {
    violations.push(
      `Tier-1 located-span coverage ${(locatedSpanCoverageRate * 100).toFixed(1)}% is below required ${MINIMUM_LOCATED_SPAN_COVERAGE * 100}%`
    );
  }

  const unaccountedDimensions = input.dimensionCoverages.filter(
    (dimension) =>
      dimension.locatedSpanCount === 0 && dimension.validatedGapCount === 0
  );
  const allDimensionsAccountedFor =
    unaccountedDimensions.length === 0 &&
    input.dimensionCoverages.length >= input.totalDimensions;

  for (const missing of unaccountedDimensions) {
    violations.push(
      `Dimension "${missing.dimension}" is silently absent (lacks located span and validated gap)`
    );
  }
  if (input.dimensionCoverages.length < input.totalDimensions) {
    violations.push(
      `Expected ${input.totalDimensions} dimensions, but only ${input.dimensionCoverages.length} were evaluated`
    );
  }

  const knownLimitationsCountMet =
    input.knownLimitations.length >= MINIMUM_KNOWN_LIMITATIONS;
  if (!knownLimitationsCountMet) {
    violations.push(
      `Expected at least ${MINIMUM_KNOWN_LIMITATIONS} visible known limitations, found ${input.knownLimitations.length}`
    );
  }

  return {
    passed:
      coverageRequirementMet &&
      allDimensionsAccountedFor &&
      knownLimitationsCountMet,
    candidateId: input.candidateId,
    locatedSpanCoverageRate,
    coverageRequirementMet,
    allDimensionsAccountedFor,
    knownLimitationsCountMet,
    violations
  };
}
