import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  addRationals,
  clampRational,
  compareRationals,
  createRational,
  divideRationals,
  formatRational,
  multiplyRationals,
  parseRational,
  RationalSchema,
  rationalFromInteger,
  roundHalfUp,
  subtractRationals
} from "./rational.js";

function rational(numerator: bigint, denominator: bigint) {
  const result = createRational(numerator, denominator);
  if (!result.ok) {
    throw new Error("Expected valid rational in test");
  }
  return result.value;
}

describe("exact rational arithmetic", () => {
  it("normalizes signs and common factors", () => {
    expect(createRational(2n, 4n)).toEqual({
      ok: true,
      value: { numerator: 1n, denominator: 2n }
    });
    expect(createRational(2n, -4n)).toEqual({
      ok: true,
      value: { numerator: -1n, denominator: 2n }
    });
    expect(createRational(0n, -4n)).toEqual({
      ok: true,
      value: { numerator: 0n, denominator: 1n }
    });
    expect(createRational(1n, 0n).ok).toBe(false);
    expect(RationalSchema.safeParse({ numerator: 2n, denominator: 4n }).success).toBe(false);
  });

  it("adds, subtracts, multiplies, and divides exactly", () => {
    const oneHalf = rational(1n, 2n);
    const oneThird = rational(1n, 3n);
    expect(formatRational(addRationals(oneHalf, oneThird))).toBe("5/6");
    expect(formatRational(subtractRationals(oneHalf, oneThird))).toBe("1/6");
    expect(formatRational(multiplyRationals(oneHalf, oneThird))).toBe("1/6");
    expect(divideRationals(oneHalf, oneThird)).toEqual({
      ok: true,
      value: { numerator: 3n, denominator: 2n }
    });
    expect(divideRationals(oneHalf, rationalFromInteger(0n)).ok).toBe(false);
  });

  it("compares and clamps exact values", () => {
    const zero = rationalFromInteger(0n);
    const one = rationalFromInteger(1n);
    const half = rational(1n, 2n);
    expect(compareRationals(zero, half)).toBe(-1);
    expect(compareRationals(one, half)).toBe(1);
    expect(compareRationals(half, rational(2n, 4n))).toBe(0);
    expect(clampRational(rational(-1n, 2n), zero, one)).toBe(zero);
    expect(clampRational(rational(3n, 2n), zero, one)).toBe(one);
    expect(clampRational(half, zero, one)).toBe(half);
  });

  it("rounds half up without floating point", () => {
    expect(roundHalfUp(rational(1n, 2n))).toBe(1n);
    expect(roundHalfUp(rational(3n, 2n))).toBe(2n);
    expect(roundHalfUp(rational(1n, 3n))).toBe(0n);
    expect(roundHalfUp(rational(-1n, 2n))).toBe(0n);
    expect(roundHalfUp(rational(-3n, 2n))).toBe(-1n);
    expect(roundHalfUp(rational(-5n, 3n))).toBe(-2n);
  });

  it("parses only reduced canonical strings", () => {
    expect(parseRational("-2/3")).toEqual({
      ok: true,
      value: { numerator: -2n, denominator: 3n }
    });
    for (const value of [1, "2/4", "01/2", "1/0", "1/-2", "1.0/2"]) {
      expect(parseRational(value).ok).toBe(false);
    }
  });

  it("round trips reduced rational strings", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1_000_000n, max: 1_000_000n }),
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        (numerator, denominator) => {
          const value = rational(numerator, denominator);
          expect(parseRational(formatRational(value))).toEqual({ ok: true, value });
        }
      ),
      { seed: 20_260_905 }
    );
  });
});
