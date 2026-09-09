import { describe, expect, it } from "vitest";
import { formatWeightPercent } from "./format.js";

describe("formatWeightPercent", () => {
  it("rounds repeating floats for people", () => {
    expect(formatWeightPercent(8.333333333333332)).toBe("8.3%");
    expect(formatWeightPercent(16.666666666666668)).toBe("16.7%");
    expect(formatWeightPercent(25)).toBe("25%");
    expect(formatWeightPercent(25.0)).toBe("25%");
  });

  it("returns n/a for non-finite values", () => {
    expect(formatWeightPercent(Number.NaN)).toBe("n/a");
    expect(formatWeightPercent(Number.POSITIVE_INFINITY)).toBe("n/a");
  });
});
