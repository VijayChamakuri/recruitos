import { type Rational } from "../canonical/rational.js";
import type { DimensionLevel } from "../rubric/levels.js";
import { mustRational, RATIONAL_ONE, RATIONAL_ZERO } from "./exact.js";

/**
 * Committed scoring and confidence constants. This is the single file the design
 * requires: weights, level values, and thresholds live here, versioned with the
 * rubric, and the UI renders the arithmetic that consumes them.
 */

/** Exact value of each ordinal level, consumed by the scoring function f. */
export const LEVEL_VALUE: Readonly<Record<DimensionLevel, Rational>> = Object.freeze({
  none: RATIONAL_ZERO,
  weak: mustRational(33n, 100n),
  partial: mustRational(67n, 100n),
  strong: RATIONAL_ONE
});

/** Weights on each confidence term (0.45, 0.25, 0.20, 0.10). */
export const CONFIDENCE_WEIGHTS = Object.freeze({
  coverage: mustRational(45n, 100n),
  resolution: mustRational(25n, 100n),
  contradiction: mustRational(20n, 100n),
  missingFields: mustRational(10n, 100n)
});

/** Escalation threshold: confidence below this escalates with low_confidence. */
export const T_ESCALATE: Rational = mustRational(55n, 100n);

/** Number of scored candidates the shortlist retains. */
export const SHORTLIST_N = 10;

/** Committed required-field list; its length is the miss_rate denominator. */
export const REQUIRED_FIELD_IDS = Object.freeze([
  "years_experience",
  "work_authorization",
  "current_title",
  "employer_history"
] as const);
