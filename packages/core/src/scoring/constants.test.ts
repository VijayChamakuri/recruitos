import { describe, expect, it } from "vitest";

import {
  REQUIRED_FIELD_IDS,
  SCORING_POLICY_V1,
  SHORTLIST_N
} from "./constants.js";

describe("SCORING_POLICY_V1", () => {
  it("pins the integer snapshot form of the committed scoring policy", () => {
    expect(SCORING_POLICY_V1.levelValues).toEqual({
      none: 0,
      weak: 3300,
      partial: 6700,
      strong: 10000
    });
    expect(SCORING_POLICY_V1.confidenceWeights).toEqual({
      coverage: 4500,
      resolution: 2500,
      contradiction: 2000,
      missingFields: 1000
    });
    expect(SCORING_POLICY_V1.escalateThreshold).toBe(5500);
    expect(SCORING_POLICY_V1.shortlistN).toBe(SHORTLIST_N);
    expect(SCORING_POLICY_V1.requiredFieldIds).toEqual(REQUIRED_FIELD_IDS);
  });
});
