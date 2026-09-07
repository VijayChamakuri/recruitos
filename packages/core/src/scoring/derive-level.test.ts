import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { DimensionLevel } from "../rubric/levels.js";
import { deriveLevel } from "./derive-level.js";

const LEVEL_ORDER: Readonly<Record<DimensionLevel, number>> = {
  none: 0,
  weak: 1,
  partial: 2,
  strong: 3
};

function levelRank(supporting: number, contradicting: number): number {
  const result = deriveLevel({
    supportingSpanCount: supporting,
    contradictingSpanCount: contradicting
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return LEVEL_ORDER[result.value];
}

describe("deriveLevel", () => {
  it("rejects malformed span counts", () => {
    expect(deriveLevel({ supportingSpanCount: -1, contradictingSpanCount: 0 })).toMatchObject({
      ok: false,
      error: { code: "invalid_evidence" }
    });
    expect(deriveLevel("nope")).toMatchObject({ ok: false, error: { code: "invalid_evidence" } });
  });

  it("returns none with no supporting spans", () => {
    expect(deriveLevel({ supportingSpanCount: 0, contradictingSpanCount: 0 })).toEqual({
      ok: true,
      value: "none"
    });
  });

  it("returns none when contradictions cancel support", () => {
    expect(deriveLevel({ supportingSpanCount: 2, contradictingSpanCount: 2 })).toEqual({
      ok: true,
      value: "none"
    });
  });

  it("maps net support of one, two, and three-plus to weak, partial, strong", () => {
    expect(deriveLevel({ supportingSpanCount: 1, contradictingSpanCount: 0 })).toEqual({
      ok: true,
      value: "weak"
    });
    expect(deriveLevel({ supportingSpanCount: 3, contradictingSpanCount: 1 })).toEqual({
      ok: true,
      value: "partial"
    });
    expect(deriveLevel({ supportingSpanCount: 5, contradictingSpanCount: 1 })).toEqual({
      ok: true,
      value: "strong"
    });
  });

  it("is monotonic in both arguments", () => {
    fc.assert(
      fc.property(fc.nat({ max: 40 }), fc.nat({ max: 40 }), (supporting, contradicting) => {
        expect(levelRank(supporting + 1, contradicting)).toBeGreaterThanOrEqual(
          levelRank(supporting, contradicting)
        );
        expect(levelRank(supporting, contradicting + 1)).toBeLessThanOrEqual(
          levelRank(supporting, contradicting)
        );
      })
    );
  });
});
