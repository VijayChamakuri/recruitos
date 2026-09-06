import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  combineComparators,
  compareBigInt,
  compareBy,
  compareCodeUnits,
  compareSafeInteger,
  OrderingSchema,
  reverseComparator,
  sortDeterministically
} from "./comparator.js";
import { SafeIntegerSchema, type SafeInteger } from "../domain/integers.js";

function safeInteger(value: number): SafeInteger {
  return SafeIntegerSchema.parse(value);
}

describe("deterministic comparators", () => {
  it("validates only normalized ordering values", () => {
    expect(OrderingSchema.parse(-1)).toBe(-1);
    expect(OrderingSchema.parse(0)).toBe(0);
    expect(OrderingSchema.parse(1)).toBe(1);
    expect(OrderingSchema.safeParse(2).success).toBe(false);
  });

  it("compares bigints, safe integers, and strings without locale state", () => {
    expect(compareBigInt(1n, 2n)).toBe(-1);
    expect(compareBigInt(2n, 1n)).toBe(1);
    expect(compareBigInt(2n, 2n)).toBe(0);
    expect(compareSafeInteger(safeInteger(1), safeInteger(2))).toBe(-1);
    expect(compareSafeInteger(safeInteger(2), safeInteger(1))).toBe(1);
    expect(compareSafeInteger(safeInteger(2), safeInteger(2))).toBe(0);
    expect(compareCodeUnits("A", "a")).toBe(-1);
    expect(compareCodeUnits("a", "A")).toBe(1);
    expect(compareCodeUnits("a", "a")).toBe(0);
  });

  it("composes tie breakers and reverse order", () => {
    type Row = Readonly<{ id: string; score: SafeInteger }>;
    const byScore = compareBy<Row, SafeInteger>((value) => value.score, compareSafeInteger);
    const byId = compareBy<Row, string>((value) => value.id, compareCodeUnits);
    const comparator = combineComparators(reverseComparator(byScore), byId);
    const values = [
      { id: "b", score: safeInteger(2) },
      { id: "c", score: safeInteger(3) },
      { id: "a", score: safeInteger(2) }
    ];
    expect(sortDeterministically(values, comparator)).toEqual([
      { id: "c", score: 3 },
      { id: "a", score: 2 },
      { id: "b", score: 2 }
    ]);
    expect(combineComparators<{ id: string }>()({ id: "a" }, { id: "b" })).toBe(0);
    expect(reverseComparator(compareSafeInteger)(safeInteger(1), safeInteger(1))).toBe(0);
    expect(reverseComparator(compareSafeInteger)(safeInteger(1), safeInteger(2))).toBe(1);
  });

  it.each([NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid runtime input %s",
    (value) => {
      expect(() =>
        compareSafeInteger(value as unknown as SafeInteger, safeInteger(1))
      ).toThrow();
      expect(() =>
        compareSafeInteger(safeInteger(1), value as unknown as SafeInteger)
      ).toThrow();
    }
  );

  it("requires branded safe integers at compile time", () => {
    // @ts-expect-error Plain numbers have not crossed the canonical schema boundary.
    compareSafeInteger(1, safeInteger(2));
  });

  it("is antisymmetric, transitive, and total for safe integers", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer(),
        fc.integer(),
        (a, b, c) => {
          const safeA = safeInteger(a);
          const safeB = safeInteger(b);
          const safeC = safeInteger(c);
          const ab = compareSafeInteger(safeA, safeB);
          const ba = compareSafeInteger(safeB, safeA);
          expect(ab).toBe(ba === 0 ? 0 : -ba);
          expect([-1, 0, 1]).toContain(ab);
          if (ab <= 0 && compareSafeInteger(safeB, safeC) <= 0) {
            expect(compareSafeInteger(safeA, safeC)).toBeLessThanOrEqual(0);
          }
        }
      ),
      { seed: 20_260_905 }
    );
  });
});
