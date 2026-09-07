import { describe, expect, it } from "vitest";

import { formatRational } from "../canonical/rational.js";
import { computeConfidence } from "./confidence.js";

function confidenceOrThrow(input: unknown) {
  const result = computeConfidence(input);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return formatRational(result.value);
}

const fullyCovered = {
  dimensionsWithLocatedSpan: 6,
  totalDimensions: 6,
  spansLocated: 10,
  spansReturned: 10,
  contradictionCount: 0,
  requiredFieldsMissing: 0,
  totalRequiredFields: 4
};

describe("computeConfidence", () => {
  it("weights coverage and resolution at full coverage", () => {
    expect(confidenceOrThrow(fullyCovered)).toBe("7/10");
  });

  it("combines every term exactly", () => {
    expect(
      confidenceOrThrow({
        dimensionsWithLocatedSpan: 3,
        totalDimensions: 6,
        spansLocated: 5,
        spansReturned: 10,
        contradictionCount: 1,
        requiredFieldsMissing: 1,
        totalRequiredFields: 4
      })
    ).toBe("7/24");
  });

  it("treats resolution as zero when no spans were returned", () => {
    expect(
      confidenceOrThrow({
        dimensionsWithLocatedSpan: 0,
        totalDimensions: 6,
        spansLocated: 0,
        spansReturned: 0,
        contradictionCount: 0,
        requiredFieldsMissing: 0,
        totalRequiredFields: 4
      })
    ).toBe("0/1");
  });

  it("clamps below zero to zero", () => {
    expect(
      confidenceOrThrow({
        dimensionsWithLocatedSpan: 0,
        totalDimensions: 6,
        spansLocated: 0,
        spansReturned: 0,
        contradictionCount: 6,
        requiredFieldsMissing: 4,
        totalRequiredFields: 4
      })
    ).toBe("0/1");
  });

  it("clamps the contradiction rate to one", () => {
    expect(
      confidenceOrThrow({
        dimensionsWithLocatedSpan: 6,
        totalDimensions: 6,
        spansLocated: 10,
        spansReturned: 10,
        contradictionCount: 18,
        requiredFieldsMissing: 0,
        totalRequiredFields: 4
      })
    ).toBe("1/2");
  });

  it("rejects malformed confidence input", () => {
    expect(computeConfidence("nope")).toMatchObject({
      ok: false,
      error: { code: "invalid_evidence" }
    });
  });

  it("rejects coverage numerator above total dimensions", () => {
    expect(
      computeConfidence({ ...fullyCovered, dimensionsWithLocatedSpan: 7 })
    ).toMatchObject({ ok: false, error: { code: "invalid_evidence" } });
  });

  it("rejects located spans above returned spans", () => {
    expect(computeConfidence({ ...fullyCovered, spansLocated: 11 })).toMatchObject({
      ok: false,
      error: { code: "invalid_evidence" }
    });
  });

  it("rejects missing fields above total required fields", () => {
    expect(
      computeConfidence({ ...fullyCovered, requiredFieldsMissing: 5 })
    ).toMatchObject({ ok: false, error: { code: "invalid_evidence" } });
  });
});
