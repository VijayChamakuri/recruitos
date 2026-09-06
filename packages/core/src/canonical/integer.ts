import { CanonicalIntegerStringSchema } from "../domain/integers.js";
import { createDomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";
import type { DomainError } from "../errors/domain-error.js";
import type { CanonicalIntegerString } from "../domain/integers.js";

export function parseCanonicalInteger(value: unknown): Result<bigint, DomainError> {
  const parsed = CanonicalIntegerStringSchema.safeParse(value);
  if (!parsed.success) {
    return err(createDomainError("invalid_input", "Expected a canonical base-10 integer"));
  }
  return ok(BigInt(parsed.data));
}

export function formatCanonicalInteger(value: bigint): CanonicalIntegerString {
  return CanonicalIntegerStringSchema.parse(value.toString(10));
}
