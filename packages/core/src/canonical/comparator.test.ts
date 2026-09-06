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
    expect(compareSafeInteger(1, 2)).toBe(-1);
    expect(compareSafeInteger(2, 1)).toBe(1);
    expect(compareSafeInteger(2, 2)).toBe(0);
    expect(compareCodeUnits("A", "a")).toBe(-1);
    expect(compareCodeUnits("a", "A")).toBe(1);
    expect(compareCodeUnits("a", "a")).toBe(0);
  });

  it("composes tie breakers and reverse order", () => {
    type Row = Readonly<{ id: string; score: number }>;
    const byScore = compareBy<Row, number>((value) => value.score, compareSafeInteger);
    const byId = compareBy<Row, string>((value) => value.id, compareCodeUnits);
    const comparator = combineComparators(reverseComparator(byScore), byId);
    const values = [
      { id: "b", score: 2 },
      { id: "c", score: 3 },
      { id: "a", score: 2 }
    ];
    expect(sortDeterministically(values, comparator)).toEqual([
      { id: "c", score: 3 },
      { id: "a", score: 2 },
      { id: "b", score: 2 }
    ]);
    expect(combineComparators<{ id: string }>()({ id: "a" }, { id: "b" })).toBe(0);
    expect(reverseComparator(compareSafeInteger)(1, 1)).toBe(0);
    expect(reverseComparator(compareSafeInteger)(1, 2)).toBe(1);
  });

  it("is antisymmetric, transitive, and total for safe integers", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer(),
        fc.integer(),
        (a, b, c) => {
          const ab = compareSafeInteger(a, b);
          const ba = compareSafeInteger(b, a);
          expect(ab).toBe(ba === 0 ? 0 : -ba);
          expect([-1, 0, 1]).toContain(ab);
          if (ab <= 0 && compareSafeInteger(b, c) <= 0) {
            expect(compareSafeInteger(a, c)).toBeLessThanOrEqual(0);
          }
        }
      ),
      { seed: 20_260_905 }
    );
  });
});
