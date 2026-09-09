import { describe, expect, it } from "vitest";

import { RUBRIC_V1, sha256Hex } from "@recruitos/core";

import {
  DEMO_CANDIDATE_SOURCE_KEYS,
  DEMO_CORPUS_SEED_HASH,
  DEMO_DIMENSION_IDS,
  DEMO_EXPECTED_OUTCOMES,
  DEMO_WORK_AUTHORIZATION_QUESTION_KEY,
  DEMO_REVIEWABLE_FAILURE_SOURCE_KEY,
  demoCandidateSourceRecords,
  demoCorrectionExtractionResponseBody,
  demoExtractionResponseBody
} from "./demo-corpus.js";

type ExtractionBody = Readonly<{
  dimensionId: string;
  proposedLevel: string;
  spans: ReadonlyArray<{ quotedText: string; polarity: string }>;
  rejectedClaims: readonly unknown[];
}>;

function bodyFor(dimensionId: string, sourceKey: string): ExtractionBody {
  return JSON.parse(demoExtractionResponseBody(dimensionId, sourceKey)) as ExtractionBody;
}

describe("demo corpus", () => {
  it("covers every rubric v1 dimension exactly once", () => {
    expect([...DEMO_DIMENSION_IDS].sort()).toEqual(
      RUBRIC_V1.dimensions.map((dimension) => dimension.dimensionId).sort()
    );
  });

  it("yields seven synthetic candidates, one resume each, along the expected routes", () => {
    const records = demoCandidateSourceRecords();
    expect(records).toHaveLength(7);
    expect(records.map((record) => record.sourceKey)).toEqual([...DEMO_CANDIDATE_SOURCE_KEYS]);
    expect(
      new Set(records.map((record) => record.documents[0]?.rawText.split("\n")[1])).size
    ).toBe(7);
    for (const record of records) {
      expect(record.channel).toBe("inbound");
      expect(record.documents).toHaveLength(1);
      expect(record.documents[0]!.documentKind).toBe("resume");
    }
  });

  it("attaches a work authorization answer only to the authorized candidates", () => {
    const records = demoCandidateSourceRecords();
    const authorized = records.filter(
      (record) => record.applicationAnswers.workAuthorization !== undefined
    );
    // Route 3 is the only candidate authored without the structured answer.
    expect(authorized).toHaveLength(6);
    for (const record of authorized) {
      expect(record.applicationAnswers.workAuthorization?.questionKey).toBe(
        DEMO_WORK_AUTHORIZATION_QUESTION_KEY
      );
    }
  });

  it("builds on-contract extraction bodies whose located quotes are verbatim resume slices", () => {
    const resumeBySourceKey = new Map(
      demoCandidateSourceRecords().map((record) => [
        record.sourceKey,
        record.documents[0]!.rawText
      ])
    );
    for (const sourceKey of DEMO_CANDIDATE_SOURCE_KEYS) {
      const resume = resumeBySourceKey.get(sourceKey)!;
      for (const dimensionId of DEMO_DIMENSION_IDS) {
        const body = bodyFor(dimensionId, sourceKey);
        expect(body.dimensionId).toBe(dimensionId);
        expect(["none", "weak", "partial", "strong"]).toContain(body.proposedLevel);
        expect(body.rejectedClaims).toEqual([]);
        expect(body.spans.length).toBeGreaterThan(0);
        for (const span of body.spans) {
          expect(span.polarity).toBe("supporting");
          // Every quote carrying the candidate token is a real narrative line
          // and must be a verbatim contiguous slice of that candidate's resume.
          if (span.quotedText.includes(sourceKey)) {
            expect(resume).toContain(span.quotedText);
          }
        }
      }
    }
  });

  it("gives every candidate a unique quote per dimension so no two artifacts collide", () => {
    const seen = new Set<string>();
    for (const sourceKey of DEMO_CANDIDATE_SOURCE_KEYS) {
      for (const dimensionId of DEMO_DIMENSION_IDS) {
        for (const span of bodyFor(dimensionId, sourceKey).spans) {
          if (!span.quotedText.includes(sourceKey)) {
            continue;
          }
          const key = `${dimensionId}::${span.quotedText}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
    }
  });

  it("gives every candidate distinct evidence statements beyond its reference token", () => {
    const statements = demoCandidateSourceRecords().flatMap((record) =>
      record.documents[0]!.rawText
        .split("\n")
        .filter((line) => line.includes("[ref demo/"))
        .map((line) => line.replace(/ \[ref demo\/[^\]]+\]$/, ""))
    );
    expect(statements).toHaveLength(42);
    expect(new Set(statements).size).toBe(42);
  });

  it("correction overlay locates the evaluation quote for the reviewable-failure candidate", () => {
    const resume = demoCandidateSourceRecords().find(
      (record) => record.sourceKey === DEMO_REVIEWABLE_FAILURE_SOURCE_KEY
    )!.documents[0]!.rawText;
    const initial = bodyFor("evaluation_and_measurement", DEMO_REVIEWABLE_FAILURE_SOURCE_KEY);
    expect(resume).not.toContain(initial.spans[0]!.quotedText);
    const corrected = JSON.parse(
      demoCorrectionExtractionResponseBody(
        "evaluation_and_measurement",
        DEMO_REVIEWABLE_FAILURE_SOURCE_KEY
      )
    ) as ExtractionBody;
    expect(corrected.proposedLevel).toBe("partial");
    expect(corrected.spans).toHaveLength(1);
    expect(resume).toContain(corrected.spans[0]!.quotedText);
    expect(corrected.spans[0]!.quotedText).toContain(DEMO_REVIEWABLE_FAILURE_SOURCE_KEY);
  });

  it("reuses the initial fixture body for every other route during correction", () => {
    for (const sourceKey of DEMO_CANDIDATE_SOURCE_KEYS) {
      if (sourceKey === DEMO_REVIEWABLE_FAILURE_SOURCE_KEY) {
        continue;
      }
      for (const dimensionId of DEMO_DIMENSION_IDS) {
        expect(demoCorrectionExtractionResponseBody(dimensionId, sourceKey)).toBe(
          demoExtractionResponseBody(dimensionId, sourceKey)
        );
      }
    }
  });

  it("throws for an unknown dimension on a correction body", () => {
    expect(() =>
      demoCorrectionExtractionResponseBody("not_a_dimension", DEMO_REVIEWABLE_FAILURE_SOURCE_KEY)
    ).toThrow(/No demo extraction fixture/);
  });

  it("throws for an unknown dimension id", () => {
    expect(() =>
      demoExtractionResponseBody("not_a_dimension", DEMO_CANDIDATE_SOURCE_KEYS[0]!)
    ).toThrow(/No demo extraction fixture/);
  });

  it("throws for an unknown source key", () => {
    expect(() => demoExtractionResponseBody(DEMO_DIMENSION_IDS[0]!, "demo/not-a-route")).toThrow(
      /No demo candidate/
    );
  });

  it("has a stable 64 hex seed hash", () => {
    expect(DEMO_CORPUS_SEED_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(DEMO_CORPUS_SEED_HASH).not.toBe(sha256Hex(""));
  });

  it("publishes one expected outcome per candidate, each sealed", () => {
    expect(DEMO_EXPECTED_OUTCOMES.map((outcome) => outcome.sourceKey)).toEqual([
      ...DEMO_CANDIDATE_SOURCE_KEYS
    ]);
    for (const outcome of DEMO_EXPECTED_OUTCOMES) {
      expect(outcome.sealed).toBe(true);
      expect(["scored", "escalated", "rejected_hard_requirement"]).toContain(outcome.status);
      expect(["complete", "unavailable"]).toContain(outcome.availability);
      const complete = outcome.availability === "complete";
      expect(outcome.scoreText === null).toBe(!complete);
      expect(outcome.confidenceText === null).toBe(!complete);
      expect(outcome.spansReturned === null).toBe(!complete);
      expect(outcome.spansLocated === null).toBe(!complete);
      if (complete) {
        expect(outcome.scoreText).toMatch(/^\d+\/\d+$/);
        expect(outcome.confidenceText).toMatch(/^\d+\/\d+$/);
        expect(outcome.spansLocated!).toBeLessThanOrEqual(outcome.spansReturned!);
      }
    }
  });

  it("routes each of the seven primary outcomes at least once", () => {
    const statuses = new Set(DEMO_EXPECTED_OUTCOMES.map((outcome) => outcome.status));
    expect(statuses).toEqual(new Set(["scored", "escalated", "rejected_hard_requirement"]));
    expect(
      new Set(DEMO_EXPECTED_OUTCOMES.map((outcome) => outcome.scoreText).filter(Boolean)).size
    ).toBeGreaterThanOrEqual(5);
    expect(
      DEMO_EXPECTED_OUTCOMES.some((outcome) => outcome.availability === "unavailable")
    ).toBe(true);
    // The quote-grounding route is the one with a returned-but-unlocated span.
    expect(
      DEMO_EXPECTED_OUTCOMES.some(
        (outcome) =>
          outcome.spansReturned !== null &&
          outcome.spansLocated !== null &&
          outcome.spansReturned > outcome.spansLocated
      )
    ).toBe(true);
  });
});
