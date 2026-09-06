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

const largeIntegerArbitrary = fc.bigInt({ min: -(1n << 160n), max: 1n << 160n });
const positiveDenominatorArbitrary = fc.bigInt({ min: 1n, max: 1n << 120n });
const rationalArbitrary = fc
  .tuple(largeIntegerArbitrary, positiveDenominatorArbitrary)
  .map(([numerator, denominator]) => rational(numerator, denominator));

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

  it.each([1, "1", null, undefined, {}])("rejects non-bigint numerator %j", (value) => {
    const result = createRational(value as unknown as bigint, 2n);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it.each([1, "1", null, undefined, {}])("rejects non-bigint denominator %j", (value) => {
    const result = createRational(1n, value as unknown as bigint);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("rejects rational conversion hooks without invoking them", () => {
    let conversions = 0;
    const value = {
      [Symbol.toPrimitive]: () => {
        conversions += 1;
        return 1n;
      }
    };
    expect(createRational(value as unknown as bigint, 2n)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" }
    });
    expect(createRational(1n, value as unknown as bigint)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" }
    });
    expect(conversions).toBe(0);
  });

  it("returns readonly frozen values from every operation", () => {
    const oneHalf = rational(1n, 2n);
    const values = [
      oneHalf,
      rationalFromInteger(1n),
      addRationals(oneHalf, oneHalf),
      subtractRationals(oneHalf, oneHalf),
      multiplyRationals(oneHalf, oneHalf)
    ];
    const quotient = divideRationals(oneHalf, oneHalf);
    if (!quotient.ok) {
      throw new Error("Expected valid quotient in test");
    }
    values.push(quotient.value);

    for (const value of values) {
      expect(Object.isFrozen(value)).toBe(true);
      expect(() => {
        // @ts-expect-error Rational values are readonly after schema validation.
        value.denominator = 0n;
      }).toThrow(TypeError);
      expect(value.denominator).toBeGreaterThan(0n);
    }
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

  it("always reduces values and keeps denominators positive", () => {
    fc.assert(
      fc.property(
        largeIntegerArbitrary,
        fc.bigInt({ min: -(1n << 120n), max: 1n << 120n }).filter((value) => value !== 0n),
        (numerator, denominator) => {
          const value = rational(numerator, denominator);
          expect(value.denominator).toBeGreaterThan(0n);
          expect(greatestCommonDivisor(value.numerator, value.denominator)).toBe(1n);
        }
      ),
      { numRuns: 250, seed: 20_260_906 }
    );
  });

  it("preserves value when numerator and denominator share a scale", () => {
    fc.assert(
      fc.property(
        largeIntegerArbitrary,
        positiveDenominatorArbitrary,
        fc.bigInt({ min: 1n, max: 1n << 64n }),
        (numerator, denominator, scale) => {
          expect(rational(numerator * scale, denominator * scale)).toEqual(
            rational(numerator, denominator)
          );
        }
      ),
      { numRuns: 250, seed: 20_260_907 }
    );
  });

  it("compares rationals antisymmetrically and transitively", () => {
    fc.assert(
      fc.property(rationalArbitrary, rationalArbitrary, rationalArbitrary, (a, b, c) => {
        const ab = compareRationals(a, b);
        const ba = compareRationals(b, a);
        expect(ab).toBe(ba === 0 ? 0 : -ba);
        if (ab <= 0 && compareRationals(b, c) <= 0) {
          expect(compareRationals(a, c)).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: 250, seed: 20_260_908 }
    );
  });

  it("obeys exact arithmetic identities for large bigint values", () => {
    const zero = rationalFromInteger(0n);
    const one = rationalFromInteger(1n);
    fc.assert(
      fc.property(rationalArbitrary, (value) => {
        expect(addRationals(value, zero)).toEqual(value);
        expect(subtractRationals(value, value)).toEqual(zero);
        expect(multiplyRationals(value, one)).toEqual(value);
        if (value.numerator !== 0n) {
          expect(divideRationals(value, value)).toEqual({ ok: true, value: one });
        }
      }),
      { numRuns: 250, seed: 20_260_909 }
    );
  });

  it("rounds immediately below, at, and above half boundaries", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1_000_000n, max: 1_000_000n }),
        fc.bigInt({ min: 2n, max: 1_000_000n }),
        (integer, scale) => {
          const doubledScale = scale * 2n;
          const boundaryNumerator = (integer * 2n + 1n) * scale;
          expect(roundHalfUp(rational(boundaryNumerator - 1n, doubledScale))).toBe(integer);
          expect(roundHalfUp(rational(integer * 2n + 1n, 2n))).toBe(integer + 1n);
          expect(roundHalfUp(rational(boundaryNumerator + 1n, doubledScale))).toBe(integer + 1n);
        }
      ),
      { numRuns: 250, seed: 20_260_910 }
    );
  });
});
