import { describe, expect, it } from "vitest";

import { DIMENSION_LEVELS, DimensionLevelSchema } from "./levels.js";
import { RUBRIC_V1, RUBRIC_V1_CANONICAL_BYTES, RUBRIC_V1_HASH } from "./rubric-v1.js";
import {
  createLockedRubric,
  createRubric,
  LockedRubricSchema,
  mustRubricCanonicalSnapshot,
  RubricSchema,
  totalRubricWeight
} from "./rubric.js";

const SAMPLE_ANCHORS = {
  none: "No located evidence for the sample dimension.",
  weak: "Thin located evidence for the sample dimension.",
  partial: "Partial located evidence for the sample dimension.",
  strong: "Strong located evidence for the sample dimension."
} as const;

function validDimension(overrides: Record<string, unknown> = {}) {
  return {
    dimensionId: "sample_dimension",
    weight: 2,
    required: true,
    definition: "A sample dimension definition.",
    jobRelatedJustification: "It is job related for the sample role.",
    levelAnchors: SAMPLE_ANCHORS,
    ...overrides
  };
}

function validRubric(dimensions: readonly unknown[], overrides: Record<string, unknown> = {}) {
  return {
    rubricId: "rubric_sample",
    version: 1,
    provenance: {
      authorship: "product-authored",
      restsOn: ["WA-09"]
    },
    dimensions,
    ...overrides
  };
}

function collectProse(rubric: typeof RUBRIC_V1): string[] {
  const prose: string[] = [];
  for (const dimension of rubric.dimensions) {
    prose.push(dimension.definition, dimension.jobRelatedJustification);
    for (const level of DIMENSION_LEVELS) {
      prose.push(dimension.levelAnchors[level]);
    }
  }
  return prose;
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

  it("accepts a stored-shape rubric without anchors or provenance", () => {
    const result = createRubric({
      rubricId: "rubric_legacy",
      version: "test-v1",
      dimensions: [
        {
          dimensionId: "sample_dimension",
          weight: 2,
          required: true,
          definition: "A sample dimension definition.",
          jobRelatedJustification: "It is job related for the sample role."
        }
      ]
    });
    expect(result.ok).toBe(true);
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

  it("rejects empty provenance restsOn", () => {
    expect(
      createRubric(validRubric([validDimension()], { provenance: { authorship: "product-authored", restsOn: [] } }))
    ).toMatchObject({ ok: false, error: { code: "invalid_rubric" } });
  });

  it("rejects an extra level-anchor key", () => {
    expect(
      createRubric(
        validRubric([
          validDimension({
            levelAnchors: { ...SAMPLE_ANCHORS, extra: "Not a level." }
          })
        ])
      )
    ).toMatchObject({ ok: false, error: { code: "invalid_rubric" } });
  });

  it("accepts recruiter-validated provenance and rejects an unknown authorship label", () => {
    expect(
      createRubric(
        validRubric([validDimension()], {
          provenance: { authorship: "recruiter-validated", restsOn: ["WA-09"] }
        })
      ).ok
    ).toBe(true);
    expect(
      createRubric(
        validRubric([validDimension()], {
          provenance: { authorship: "unknown", restsOn: ["WA-09"] }
        })
      )
    ).toMatchObject({ ok: false, error: { code: "invalid_rubric" } });
  });

  it("rejects a missing level-anchor key", () => {
    expect(
      createRubric(
        validRubric([
          validDimension({
            levelAnchors: {
              none: SAMPLE_ANCHORS.none,
              weak: SAMPLE_ANCHORS.weak,
              partial: SAMPLE_ANCHORS.partial
            }
          })
        ])
      )
    ).toMatchObject({ ok: false, error: { code: "invalid_rubric" } });
  });
});

describe("createLockedRubric", () => {
  it("accepts the locked v1 shape and rejects a missing version literal", () => {
    expect(createLockedRubric(RUBRIC_V1).ok).toBe(true);
    expect(createLockedRubric({ ...RUBRIC_V1, version: 2 })).toMatchObject({
      ok: false,
      error: { code: "invalid_rubric" }
    });
  });

  it("rejects duplicate dimension ids on a locked snapshot", () => {
    const first = RUBRIC_V1.dimensions[0];
    if (first === undefined) {
      throw new Error("expected a first dimension");
    }
    expect(createLockedRubric({ ...RUBRIC_V1, dimensions: [first, first] })).toMatchObject({
      ok: false,
      error: { code: "invalid_rubric" }
    });
  });

  it("rejects a locked dimension that omits anchors", () => {
    const first = RUBRIC_V1.dimensions[0];
    if (first === undefined) {
      throw new Error("expected a first dimension");
    }
    expect(
      createLockedRubric({
        ...RUBRIC_V1,
        dimensions: [
          {
            dimensionId: first.dimensionId,
            weight: first.weight,
            required: first.required,
            definition: first.definition,
            jobRelatedJustification: first.jobRelatedJustification
          },
          ...RUBRIC_V1.dimensions.slice(1)
        ]
      })
    ).toMatchObject({ ok: false, error: { code: "invalid_rubric" } });
  });
});

describe("mustRubricCanonicalSnapshot", () => {
  it("returns canonical bytes and a sha-256 for a locked rubric", () => {
    const snapshot = mustRubricCanonicalSnapshot(RUBRIC_V1);
    expect(snapshot.canonicalBytes).toBe(RUBRIC_V1_CANONICAL_BYTES);
    expect(snapshot.hash).toBe(RUBRIC_V1_HASH);
  });

  it("throws when the value cannot be canonicalized", () => {
    expect(() => mustRubricCanonicalSnapshot(undefined)).toThrow("Rubric canonicalization failed");
  });
});

describe("locked rubric v1", () => {
  it("matches the approved dimension shape and weights", () => {
    expect(LockedRubricSchema.safeParse(RUBRIC_V1).success).toBe(true);
    expect(RubricSchema.safeParse(RUBRIC_V1).success).toBe(true);
    expect(RUBRIC_V1.version).toBe(1);
    expect(RUBRIC_V1.rubricId).toBe("rubric_applied_ai_engineer_v1");
    expect(RUBRIC_V1.dimensions).toHaveLength(6);
    expect(RUBRIC_V1.dimensions.map((dimension) => dimension.weight)).toEqual([
      3, 3, 2, 2, 1, 1
    ]);
    expect(RUBRIC_V1.dimensions.map((dimension) => dimension.required)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false
    ]);
    expect(totalRubricWeight(RUBRIC_V1)).toBe(12);
  });

  it("has exactly three required dimensions and non-empty justification prose", () => {
    const required = RUBRIC_V1.dimensions.filter((dimension) => dimension.required);
    expect(required).toHaveLength(3);
    for (const dimension of RUBRIC_V1.dimensions) {
      expect(dimension.definition.length).toBeGreaterThan(0);
      expect(dimension.jobRelatedJustification.length).toBeGreaterThan(0);
    }
  });

  it("has unique dimension ids", () => {
    const ids = RUBRIC_V1.dimensions.map((dimension) => dimension.dimensionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("contains no placeholder prose", () => {
    for (const text of collectProse(RUBRIC_V1)) {
      expect(text.toLowerCase().includes("placeholder")).toBe(false);
    }
  });

  it("gives every dimension four non-empty anchors keyed exactly by DIMENSION_LEVELS", () => {
    for (const dimension of RUBRIC_V1.dimensions) {
      expect(Object.keys(dimension.levelAnchors)).toEqual([...DIMENSION_LEVELS]);
      for (const level of DIMENSION_LEVELS) {
        expect(dimension.levelAnchors[level].length).toBeGreaterThan(0);
      }
    }
  });

  it("records non-empty product-authored provenance", () => {
    expect(RUBRIC_V1.provenance.authorship).toBe("product-authored");
    expect(RUBRIC_V1.provenance.restsOn.length).toBeGreaterThan(0);
    expect(RUBRIC_V1.provenance.restsOn).toEqual([
      "WA-05",
      "WA-09",
      "WA-10",
      "WA-11",
      "WA-12",
      "WA-13",
      "WA-16",
      "WA-17",
      "WA-26",
      "WA-32"
    ]);
  });

  it("round-trips canonical bytes and hashes identically across two computations", () => {
    const parsed = JSON.parse(RUBRIC_V1_CANONICAL_BYTES) as unknown;
    const again = mustRubricCanonicalSnapshot(parsed);
    expect(again.canonicalBytes).toBe(RUBRIC_V1_CANONICAL_BYTES);
    expect(again.hash).toBe(RUBRIC_V1_HASH);
    expect(mustRubricCanonicalSnapshot(RUBRIC_V1).hash).toBe(RUBRIC_V1_HASH);
    expect(RUBRIC_V1_HASH).toBe("7a1eddb8e31d0c67fd3326a65ddda396872cf7082b6a5d18e16d86943176bf9c");
  });
});
