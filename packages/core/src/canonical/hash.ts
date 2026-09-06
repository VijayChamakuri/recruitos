import type { DomainError } from "../errors/domain-error.js";
import { mapResult, type Result } from "../errors/result.js";
import type { Sha256Hex } from "../domain/hashes.js";
import { canonicalJsonStringify } from "./json.js";
import { sha256Hex } from "./sha256.js";

export function canonicalJsonSha256(value: unknown): Result<Sha256Hex, DomainError> {
  return mapResult(canonicalJsonStringify(value), sha256Hex);
}
