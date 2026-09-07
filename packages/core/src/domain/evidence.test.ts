import { describe, expect, it } from "vitest";

import {
  EVIDENCE_POLARITIES,
  EVIDENCE_SOURCES,
  EvidencePolaritySchema,
  EvidenceSourceSchema,
  MATCH_QUALITIES,
  MatchQualitySchema
} from "./evidence.js";

describe("evidence vocabulary schemas", () => {
  it("accepts exactly the closed set of evidence polarities", () => {
    for (const polarity of EVIDENCE_POLARITIES) {
      expect(EvidencePolaritySchema.parse(polarity)).toBe(polarity);
    }
    expect(EvidencePolaritySchema.safeParse("neutral").success).toBe(false);
    expect(EvidencePolaritySchema.safeParse("").success).toBe(false);
  });

  it("accepts exactly the closed set of match qualities", () => {
    for (const matchQuality of MATCH_QUALITIES) {
      expect(MatchQualitySchema.parse(matchQuality)).toBe(matchQuality);
    }
    expect(MatchQualitySchema.safeParse("approximate").success).toBe(false);
  });

  it("accepts exactly the closed set of evidence sources", () => {
    for (const source of EVIDENCE_SOURCES) {
      expect(EvidenceSourceSchema.parse(source)).toBe(source);
    }
    expect(EvidenceSourceSchema.safeParse("model").success).toBe(false);
  });
});
