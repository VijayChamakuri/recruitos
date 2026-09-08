import { describe, expect, it } from "vitest";

import {
  formatRational,
  multiplyRationals,
  rationalFromInteger,
  roundHalfUp
} from "../canonical/rational.js";
import { RUBRIC_V1 } from "../rubric/rubric-v1.js";
import type { DimensionLevel } from "../rubric/levels.js";
import { computeAggregateScore, type LevelAssessment } from "./score.js";

function assessmentsWith(levels: Partial<Record<string, DimensionLevel>>): LevelAssessment[] {
  return RUBRIC_V1.dimensions.map((dimension) => ({
    dimensionId: dimension.dimensionId,
    level: levels[dimension.dimensionId] ?? "none"
  }));
}

function scoreOrThrow(assessments: readonly LevelAssessment[]) {
  const result = computeAggregateScore(assessments, RUBRIC_V1);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

describe("computeAggregateScore", () => {
  it("scores all-none as zero and all-strong as one hundred", () => {
    const allNone = scoreOrThrow(assessmentsWith({}));
    expect(formatRational(allNone.aggregate)).toBe("0/1");
    expect(allNone.totalWeight).toBe(12);
    expect(allNone.contributions).toHaveLength(6);

    const allStrong = scoreOrThrow(
      assessmentsWith(
        Object.fromEntries(
          RUBRIC_V1.dimensions.map((dimension) => [dimension.dimensionId, "strong"])
        )
      )
    );
    expect(formatRational(allStrong.aggregate)).toBe("100/1");
  });

  it("moving evaluation practice from none to partial adds 11.2 points", () => {
    const partial = scoreOrThrow(assessmentsWith({ evaluation_and_measurement: "partial" }));
    expect(formatRational(partial.aggregate)).toBe("67/6");
    const tenths = roundHalfUp(multiplyRationals(partial.aggregate, rationalFromInteger(10n)));
    expect(tenths).toBe(112n);
  });

  it("records exact per-dimension contributions", () => {
    const partial = scoreOrThrow(assessmentsWith({ evaluation_and_measurement: "partial" }));
    const contribution = partial.contributions.find(
      (entry) => entry.dimensionId === "evaluation_and_measurement"
    );
    expect(contribution).toBeDefined();
    expect(formatRational(contribution!.levelValue)).toBe("67/100");
    expect(contribution!.weight).toBe(2);
    expect(formatRational(contribution!.weightedValue)).toBe("67/50");
    expect(formatRational(partial.weightedSum)).toBe("67/50");
  });

  it("rejects malformed assessment input", () => {
    expect(computeAggregateScore("nope", RUBRIC_V1)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" }
    });
  });

  it("rejects duplicate assessments for one dimension", () => {
    const assessments = assessmentsWith({});
    const duplicated: LevelAssessment[] = [
      ...assessments.slice(0, 5),
      { dimensionId: assessments[0]!.dimensionId, level: "weak" }
    ];
    expect(computeAggregateScore(duplicated, RUBRIC_V1)).toMatchObject({
      ok: false,
      error: { code: "score_invariant_failed" }
    });
  });

  it("rejects an assessment count that does not cover every dimension", () => {
    const assessments = assessmentsWith({}).slice(0, 5);
    expect(computeAggregateScore(assessments, RUBRIC_V1)).toMatchObject({
      ok: false,
      error: { code: "score_invariant_failed" }
    });
  });

  it("rejects assessments whose ids do not match the rubric", () => {
    const assessments = assessmentsWith({});
    const mismatched = [
      ...assessments.slice(0, 5),
      { dimensionId: "extra_dimension", level: "none" }
    ];
    expect(computeAggregateScore(mismatched, RUBRIC_V1)).toMatchObject({
      ok: false,
      error: { code: "score_invariant_failed" }
    });
  });
});
