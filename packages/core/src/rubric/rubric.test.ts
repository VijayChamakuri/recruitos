import { describe, expect, it } from "vitest";

import { DRAFT_RUBRIC_V1 } from "./draft-v1.js";
import { DIMENSION_LEVELS, DimensionLevelSchema } from "./levels.js";
import { createRubric, RubricSchema, totalRubricWeight } from "./rubric.js";

function validDimension(overrides: Record<string, unknown> = {}) {
  return {
    dimensionId: "sample_dimension",
    weight: 2,
    required: true,
    definition: "A sample dimension definition.",
    jobRelatedJustification: "It is job related for the sample role.",
    ...overrides
  };
}

function validRubric(dimensions: readonly unknown[]) {
  return {
    rubricId: "rubric_sample",
    version: "test-v1",
    dimensions
  };
}

describe("dimension levels", () => {
  it("exposes the closed four-level ordinal enum", () => {
    expect(DIMENSION_LEVELS).toEqual(["none", "weak", "partial", "strong"]);
    expect(DimensionLevelSchema.parse("partial")).toBe("partial");
    expect(DimensionLevelSchema.safeParse("excellent").success).toBe(false);
  });
});

describe("createRubric", () => {
  it("accepts a well-formed rubric and trims prose", () => {
    const result = createRubric(
      validRubric([validDimension({ definition: "  Padded definition.  " })])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.dimensions[0]?.definition).toBe("Padded definition.");
    expect(totalRubricWeight(result.value)).toBe(2);
  });

  it("rejects an empty dimension list", () => {
    expect(createRubric(validRubric([]))).toMatchObject({
      ok: false,
      error: { code: "invalid_rubric" }
    });
  });

  it("rejects an empty definition after trimming", () => {
    expect(
      createRubric(validRubric([validDimension({ definition: "   " })]))
    ).toMatchObject({ ok: false, error: { code: "invalid_rubric" } });
  });

  it("rejects duplicate dimension ids", () => {
    expect(
      createRubric(
        validRubric([
          validDimension({ dimensionId: "repeated" }),
          validDimension({ dimensionId: "repeated", weight: 1 })
        ])
      )
    ).toMatchObject({ ok: false, error: { code: "invalid_rubric" } });
  });

  it("rejects a non-positive weight", () => {
    expect(
      createRubric(validRubric([validDimension({ weight: 0 })]))
    ).toMatchObject({ ok: false, error: { code: "invalid_rubric" } });
  });
});

describe("draft rubric v1", () => {
  it("matches the approved dimension shape and weights", () => {
    expect(RubricSchema.safeParse(DRAFT_RUBRIC_V1).success).toBe(true);
    expect(DRAFT_RUBRIC_V1.version).toBe("draft-v1");
    expect(DRAFT_RUBRIC_V1.dimensions).toHaveLength(6);
    expect(DRAFT_RUBRIC_V1.dimensions.map((dimension) => dimension.weight)).toEqual([
      3, 3, 2, 2, 1, 1
    ]);
    expect(DRAFT_RUBRIC_V1.dimensions.map((dimension) => dimension.required)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false
    ]);
    expect(totalRubricWeight(DRAFT_RUBRIC_V1)).toBe(12);
  });

  it("has exactly three required dimensions and non-empty justification prose", () => {
    const required = DRAFT_RUBRIC_V1.dimensions.filter((dimension) => dimension.required);
    expect(required).toHaveLength(3);
    for (const dimension of DRAFT_RUBRIC_V1.dimensions) {
      expect(dimension.definition.length).toBeGreaterThan(0);
      expect(dimension.jobRelatedJustification.length).toBeGreaterThan(0);
    }
  });

  it("has unique dimension ids", () => {
    const ids = DRAFT_RUBRIC_V1.dimensions.map((dimension) => dimension.dimensionId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
