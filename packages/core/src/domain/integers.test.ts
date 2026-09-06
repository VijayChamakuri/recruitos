import { describe, expect, it } from "vitest";

import {
  BasisPointsSchema,
  CanonicalIntegerStringSchema,
  NonnegativeIntegerSchema,
  PositiveIntegerSchema,
  PositiveWeightSchema,
  SafeIntegerSchema,
  type SafeInteger
} from "./integers.js";

describe("integer schemas", () => {
  it("accepts values inside each exact integer domain", () => {
    expect(SafeIntegerSchema.parse(-1)).toBe(-1);
    expect(NonnegativeIntegerSchema.parse(0)).toBe(0);
    expect(PositiveIntegerSchema.parse(1)).toBe(1);
    expect(BasisPointsSchema.parse(10_000)).toBe(10_000);
    expect(PositiveWeightSchema.parse(3)).toBe(3);
  });

  it("keeps narrower integer brands assignable to safe integers", () => {
    const values: readonly SafeInteger[] = [
      NonnegativeIntegerSchema.parse(0),
      PositiveIntegerSchema.parse(1),
      BasisPointsSchema.parse(10_000),
      PositiveWeightSchema.parse(3)
    ];
    expect(values).toEqual([0, 1, 10_000, 3]);
  });

  it("rejects fractional, unsafe, negative, zero, and out-of-range values", () => {
    expect(SafeIntegerSchema.safeParse(1.5).success).toBe(false);
    expect(SafeIntegerSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
    expect(NonnegativeIntegerSchema.safeParse(-1).success).toBe(false);
    expect(PositiveIntegerSchema.safeParse(0).success).toBe(false);
    expect(BasisPointsSchema.safeParse(10_001).success).toBe(false);
  });

  it.each(["0", "1", "-1", "9007199254740993123456789"])(
    "accepts canonical integer string %s",
    (value) => {
      expect(CanonicalIntegerStringSchema.parse(value)).toBe(value);
    }
  );

  it.each(["-0", "+1", "01", "-01", "1.0", " 1"])(
    "rejects noncanonical integer string %s",
    (value) => {
      expect(CanonicalIntegerStringSchema.safeParse(value).success).toBe(false);
    }
  );
});
