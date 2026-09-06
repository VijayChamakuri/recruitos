import { z } from "zod";

import type { DomainError } from "../errors/domain-error.js";
import { createDomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";
import { compareBigInt, type Ordering } from "./comparator.js";

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = absolute(left);
  let b = absolute(right);
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

export const RationalSchema = z
  .object({
    numerator: z.bigint(),
    denominator: z.bigint().positive()
  })
  .strict()
  .superRefine((value, context) => {
    if (greatestCommonDivisor(value.numerator, value.denominator) !== 1n) {
      context.addIssue({ code: "custom", message: "Rational must be reduced" });
    }
  })
  .readonly()
  .brand<"Rational">();

export type Rational = z.infer<typeof RationalSchema>;

export function createRational(
  numerator: bigint,
  denominator: bigint
): Result<Rational, DomainError> {
  if (denominator === 0n) {
    return err(createDomainError("invalid_input", "Rational denominator must not be zero"));
  }

  const sign = denominator < 0n ? -1n : 1n;
  const signedNumerator = numerator * sign;
  const positiveDenominator = denominator * sign;
  const divisor = greatestCommonDivisor(signedNumerator, positiveDenominator);

  return ok(
    RationalSchema.parse({
      numerator: signedNumerator / divisor,
      denominator: positiveDenominator / divisor
    })
  );
}

function rationalOrThrow(numerator: bigint, denominator: bigint): Rational {
  const result = createRational(numerator, denominator);
  // Every caller derives a nonzero denominator from validated rational values.
  /* v8 ignore next 3 */
  if (!result.ok) {
    throw new Error("Impossible zero denominator in rational operation");
  }
  return result.value;
}

export function rationalFromInteger(value: bigint): Rational {
  return rationalOrThrow(value, 1n);
}

export function addRationals(left: Rational, right: Rational): Rational {
  return rationalOrThrow(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator
  );
}

export function subtractRationals(left: Rational, right: Rational): Rational {
  return rationalOrThrow(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator
  );
}

export function multiplyRationals(left: Rational, right: Rational): Rational {
  return rationalOrThrow(
    left.numerator * right.numerator,
    left.denominator * right.denominator
  );
}

export function divideRationals(
  dividend: Rational,
  divisor: Rational
): Result<Rational, DomainError> {
  if (divisor.numerator === 0n) {
    return err(createDomainError("invalid_input", "Cannot divide by zero"));
  }
  return createRational(
    dividend.numerator * divisor.denominator,
    dividend.denominator * divisor.numerator
  );
}

export function compareRationals(left: Rational, right: Rational): Ordering {
  return compareBigInt(
    left.numerator * right.denominator,
    right.numerator * left.denominator
  );
}

export function clampRational(value: Rational, minimum: Rational, maximum: Rational): Rational {
  if (compareRationals(value, minimum) === -1) {
    return minimum;
  }
  if (compareRationals(value, maximum) === 1) {
    return maximum;
  }
  return value;
}

function floorDivide(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder < 0n ? quotient - 1n : quotient;
}

export function roundHalfUp(value: Rational): bigint {
  return floorDivide(
    value.numerator * 2n + value.denominator,
    value.denominator * 2n
  );
}

export function formatRational(value: Rational): string {
  return `${value.numerator.toString(10)}/${value.denominator.toString(10)}`;
}

export function parseRational(value: unknown): Result<Rational, DomainError> {
  if (typeof value !== "string") {
    return err(createDomainError("invalid_input", "Expected a canonical rational string"));
  }
  const match = /^(0|-[1-9][0-9]*|[1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(value);
  if (match === null) {
    return err(createDomainError("invalid_input", "Expected a canonical rational string"));
  }
  const [numeratorText, denominatorText] = z
    .tuple([z.string(), z.string()])
    .parse(match.slice(1));
  const parsed = createRational(BigInt(numeratorText), BigInt(denominatorText));
  if (!parsed.ok || formatRational(parsed.value) !== value) {
    return err(createDomainError("invalid_input", "Expected a reduced canonical rational string"));
  }
  return parsed;
}
