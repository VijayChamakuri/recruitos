import { describe, expect, it } from "vitest";

import {
  CandidateIdSchema,
  canonicalJsonSha256,
  computeAggregateScore,
  computeConfidence,
  createRational,
  deriveLevel,
  RUBRIC_V1,
  shortlistCut,
  validateUtf16Slice
} from "./index.js";

describe("public API", () => {
  it("exports the first core foundation slice from one entry point", () => {
    expect(CandidateIdSchema.parse("candidate_1")).toBe("candidate_1");
    expect(createRational(1n, 2n).ok).toBe(true);
    expect(canonicalJsonSha256({ stable: true }).ok).toBe(true);
    expect(validateUtf16Slice("text", { start: 0, end: 4, matchedText: "text" }).ok).toBe(true);
  });

  it("exports the rubric and deterministic decision engine from one entry point", () => {
    expect(RUBRIC_V1.dimensions).toHaveLength(6);
    expect(RUBRIC_V1.version).toBe(1);
    expect(deriveLevel({ supportingSpanCount: 2, contradictingSpanCount: 0 })).toEqual({
      ok: true,
      value: "partial"
    });
    const assessments = RUBRIC_V1.dimensions.map((dimension) => ({
      dimensionId: dimension.dimensionId,
      level: "none" as const
    }));
    expect(computeAggregateScore(assessments, RUBRIC_V1).ok).toBe(true);
    expect(
      computeConfidence({
        dimensionsWithLocatedSpan: 6,
        totalDimensions: 6,
        spansLocated: 10,
        spansReturned: 10,
        contradictionCount: 0,
        requiredFieldsMissing: 0,
        totalRequiredFields: 4
      }).ok
    ).toBe(true);
    expect(shortlistCut([]).ok).toBe(true);
  });
});
