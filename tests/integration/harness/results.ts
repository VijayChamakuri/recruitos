import type { Result } from "../../../packages/core/src/index.js";
import type { RuntimeError } from "../../../packages/runtime/src/errors/index.js";

export function unwrap<TValue>(result: Result<TValue, RuntimeError>): TValue {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

export function expectError(result: Result<unknown, RuntimeError>): RuntimeError {
  if (result.ok) {
    throw new Error("Expected a failed Result");
  }
  return result.error;
}
