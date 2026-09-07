import { RUBRIC_V1 } from "./rubric-v1.js";
import { RubricSchema, type Rubric } from "./rubric.js";

/**
 * Compatibility export for deep imports that still point at draft-v1.
 * The locked snapshot is RUBRIC_V1. This projection keeps the stored-row
 * shape and the draft-v1 version string so the runtime role store can
 * round-trip until that lane persists anchors, provenance, and integer
 * version.
 */
export const DRAFT_RUBRIC_V1: Rubric = RubricSchema.parse({
  rubricId: RUBRIC_V1.rubricId,
  version: "draft-v1",
  dimensions: RUBRIC_V1.dimensions.map((dimension) => ({
    dimensionId: dimension.dimensionId,
    weight: dimension.weight,
    required: dimension.required,
    definition: dimension.definition,
    jobRelatedJustification: dimension.jobRelatedJustification
  }))
});
