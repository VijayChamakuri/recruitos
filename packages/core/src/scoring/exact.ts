import { createRational, rationalFromInteger, type Rational } from "../canonical/rational.js";

/**
 * Builds a rational from a numerator and denominator that callers have already
 * proven nonzero and valid. The failure branch is unreachable in scoring and is
 * excluded from coverage, mirroring rationalOrThrow in the rational module.
 */
export function mustRational(numerator: bigint, denominator: bigint): Rational {
  const result = createRational(numerator, denominator);
  /* v8 ignore next 3 */
  if (!result.ok) {
    throw new Error("Unexpected invalid rational in scoring");
  }
  return result.value;
}

export const RATIONAL_ZERO: Rational = rationalFromInteger(0n);
export const RATIONAL_ONE: Rational = rationalFromInteger(1n);
export const RATIONAL_HUNDRED: Rational = rationalFromInteger(100n);
