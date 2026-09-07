import { z } from "zod";

/**
 * The closed ordinal level enum the extractor emits per rubric dimension.
 * The LLM never emits a number (design invariant P1): it selects one of these
 * levels, and the deterministic scorer maps levels to values.
 */
export const DIMENSION_LEVELS = ["none", "weak", "partial", "strong"] as const;

export const DimensionLevelSchema = z.enum(DIMENSION_LEVELS);
export type DimensionLevel = z.infer<typeof DimensionLevelSchema>;
