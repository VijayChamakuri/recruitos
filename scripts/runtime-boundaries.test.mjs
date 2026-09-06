import { describe, expect, it } from "vitest";

import { compareBigInt } from "../packages/core/src/canonical/comparator.ts";
import { createRational } from "../packages/core/src/canonical/rational.ts";

const invalidBigints = [1, "1", null, undefined, {}];

describe("JavaScript exact arithmetic boundaries", () => {
  it.each(invalidBigints)("rejects compareBigInt operand %j", (value) => {
    expect(() => compareBigInt(value, 1n)).toThrow(TypeError);
    expect(() => compareBigInt(1n, value)).toThrow(TypeError);
  });

  it.each(invalidBigints)("rejects createRational input %j", (value) => {
    expect(createRational(value, 2n)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" }
    });
    expect(createRational(1n, value)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" }
    });
  });

  it("does not invoke custom conversion hooks", () => {
    let conversions = 0;
    const value = {
      [Symbol.toPrimitive]: () => {
        conversions += 1;
        return 1n;
      }
    };

    expect(() => compareBigInt(value, 1n)).toThrow(TypeError);
    expect(createRational(value, 2n)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" }
    });
    expect(conversions).toBe(0);
  });
});
