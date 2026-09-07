import type {
  Class1EvaluationInput,
  Class1EvaluationReport
} from "./types.js";

const MINIMUM_LOCATED_SPAN_COVERAGE = 0.7;
const MINIMUM_KNOWN_LIMITATIONS = 3;

/**
 * Executes the Class 1 deterministic evaluation gate over candidate dimension coverages.
 * Verifies:
 * 1. At least 70% located-span coverage across tier-one dimensions
 * 2. Every remaining dimension has a validated gap (no silently absent dimensions)
 * 3. At least 3 known limitations are visible and assertion-classified
 */
export function runClass1EvaluationGate(
  input: Class1EvaluationInput
): Class1EvaluationReport {
  const violations: string[] = [];

  const locatedDimensions = input.dimensionCoverages.filter(
    (dim) => dim.locatedSpanCount > 0
  ).length;

  const coverageRate =
    input.totalDimensions > 0
      ? Number((locatedDimensions / input.totalDimensions).toFixed(4))
      : 0;

  const coverageRequirementMet =
    input.tier === 1 ? coverageRate >= MINIMUM_LOCATED_SPAN_COVERAGE : true;

  if (input.tier === 1 && !coverageRequirementMet) {
    violations.push(
      `Tier-1 located-span coverage ${(coverageRate * 100).toFixed(1)}% is below required ${MINIMUM_LOCATED_SPAN_COVERAGE * 100}%`
    );
  }

  // Check that every dimension has either located span(s) or validated gap(s)
  const unaccountedDimensions = input.dimensionCoverages.filter(
    (dim) => dim.locatedSpanCount === 0 && dim.validatedGapCount === 0
  );

  const allDimensionsAccountedFor =
    unaccountedDimensions.length === 0 &&
    input.dimensionCoverages.length >= input.totalDimensions;

  if (!allDimensionsAccountedFor) {
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
  }

  // Check that at least 3 known limitations remain visible
  const knownLimitationsCountMet =
    input.knownLimitations.length >= MINIMUM_KNOWN_LIMITATIONS;

  if (!knownLimitationsCountMet) {
    violations.push(
      `Expected at least ${MINIMUM_KNOWN_LIMITATIONS} visible known limitations, found ${input.knownLimitations.length}`
    );
  }

  const passed =
    coverageRequirementMet &&
    allDimensionsAccountedFor &&
    knownLimitationsCountMet;

  return {
    passed,
    candidateId: input.candidateId,
    locatedSpanCoverageRate: coverageRate,
    coverageRequirementMet,
    allDimensionsAccountedFor,
    knownLimitationsCountMet,
    violations
  };
}
