import { z } from "zod";

export const SafeIntegerSchema = z.number().int().safe();
export type SafeInteger = z.infer<typeof SafeIntegerSchema>;

export const NonnegativeIntegerSchema = SafeIntegerSchema.nonnegative();
export type NonnegativeInteger = z.infer<typeof NonnegativeIntegerSchema>;

export const PositiveIntegerSchema = SafeIntegerSchema.positive();
export type PositiveInteger = z.infer<typeof PositiveIntegerSchema>;

export const BasisPointsSchema = NonnegativeIntegerSchema.max(10_000).brand<"BasisPoints">();
export type BasisPoints = z.infer<typeof BasisPointsSchema>;

export const PositiveWeightSchema = PositiveIntegerSchema.brand<"PositiveWeight">();
export type PositiveWeight = z.infer<typeof PositiveWeightSchema>;

export const CanonicalIntegerStringSchema = z
  .string()
  .regex(/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/u, "Expected a canonical base-10 integer");
export type CanonicalIntegerString = z.infer<typeof CanonicalIntegerStringSchema>;
