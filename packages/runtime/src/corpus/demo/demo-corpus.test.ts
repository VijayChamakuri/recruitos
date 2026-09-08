import { describe, expect, it } from "vitest";

import { RUBRIC_V1, sha256Hex } from "@recruitos/core";

import {
  DEMO_CANDIDATE_SOURCE_KEY,
  DEMO_CORPUS_SEED_HASH,
  DEMO_DIMENSION_IDS,
  DEMO_EXPECTED_OUTCOME,
  demoCandidateSourceRecords,
  demoExtractionResponseBody
} from "./demo-corpus.js";

describe("demo corpus", () => {
  it("covers every rubric v1 dimension exactly once", () => {
    expect([...DEMO_DIMENSION_IDS].sort()).toEqual(
      RUBRIC_V1.dimensions.map((dimension) => dimension.dimensionId).sort()
    );
  });

  it("yields one synthetic candidate with one resume and a work authorization answer", () => {
    const records = demoCandidateSourceRecords();
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.sourceKey).toBe(DEMO_CANDIDATE_SOURCE_KEY);
    expect(record.channel).toBe("inbound");
    expect(record.documents).toHaveLength(1);
    expect(record.documents[0]!.documentKind).toBe("resume");
    expect(record.applicationAnswers.workAuthorization?.questionKey).toBe("eligible_to_work");
  });

  it("builds an on-contract extraction body whose quote is a verbatim resume slice", () => {
    const resume = demoCandidateSourceRecords()[0]!.documents[0]!.rawText;
    for (const dimensionId of DEMO_DIMENSION_IDS) {
      const body = JSON.parse(demoExtractionResponseBody(dimensionId)) as {
        dimensionId: string;
        proposedLevel: string;
        spans: ReadonlyArray<{ quotedText: string; polarity: string }>;
        rejectedClaims: readonly unknown[];
      };
      expect(body.dimensionId).toBe(dimensionId);
      expect(["none", "weak", "partial", "strong"]).toContain(body.proposedLevel);
      expect(body.rejectedClaims).toEqual([]);
      expect(body.spans.length).toBeGreaterThan(0);
      for (const span of body.spans) {
        expect(span.polarity).toBe("supporting");
        expect(resume).toContain(span.quotedText);
      }
    }
  });

  it("throws for an unknown dimension id", () => {
    expect(() => demoExtractionResponseBody("not_a_dimension")).toThrow(
      /No demo extraction fixture/
    );
  });

  it("has a stable 64 hex seed hash", () => {
    expect(DEMO_CORPUS_SEED_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(DEMO_CORPUS_SEED_HASH).not.toBe(sha256Hex(""));
  });

  it("expects an escalated, complete, sealed outcome with three missing-evidence reasons", () => {
    expect(DEMO_EXPECTED_OUTCOME).toEqual({
      sourceKey: DEMO_CANDIDATE_SOURCE_KEY,
      status: "escalated",
      availability: "complete",
      reasonCodes: [
        "missing_evidence:current_title",
        "missing_evidence:employer_history",
        "missing_evidence:years_experience"
      ],
      hasScore: true,
      hasConfidence: true,
      sealed: true
    });
  });
});
