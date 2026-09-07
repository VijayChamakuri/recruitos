import { z } from "zod";

import { NonnegativeIntegerSchema } from "../domain/integers.js";
import { createDomainError, type DomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";
import { type DimensionLevel } from "../rubric/levels.js";

const SpanCountsSchema = z
  .object({
    supportingSpanCount: NonnegativeIntegerSchema,
    contradictingSpanCount: NonnegativeIntegerSchema
  })
  .strict();

export type SpanCounts = z.infer<typeof SpanCountsSchema>;

/**
 * Maps supporting and contradicting span counts to an ordinal level. Monotonic
 * in both arguments by construction with no fallthrough branch: adding a
 * supporting span can only raise the level, adding a contradicting span can only
 * lower it. Used as the calibration cross-check against the extractor level and
 * as the default proposed level in the human resolution form.
 */
export function deriveLevel(input: unknown): Result<DimensionLevel, DomainError> {
  const parsed = SpanCountsSchema.safeParse(input);
  if (!parsed.success) {
    return err(createDomainError("invalid_evidence", "Invalid span counts"));
  }
  const supporting = parsed.data.supportingSpanCount;
  const contradicting = parsed.data.contradictingSpanCount;
  if (supporting === 0) {
    return ok<DimensionLevel>("none");
  }
  if (contradicting >= supporting) {
    return ok<DimensionLevel>("none");
  }
  const net = supporting - contradicting;
  if (net === 1) {
    return ok<DimensionLevel>("weak");
  }
  if (net === 2) {
    return ok<DimensionLevel>("partial");
  }
  return ok<DimensionLevel>("strong");
}
