import { Buffer } from "node:buffer";
import { err, ok, type Result } from "@recruitos/core";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";

const CURRENT_CURSOR_VERSION = 1;

/**
 * Encodes keyset cursor values into an opaque URL-safe string.
 */
export function encodeCursor<T extends object>(data: T): string {
  const envelope = {
    v: CURRENT_CURSOR_VERSION,
    ...data
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

/**
 * Decodes and validates an opaque keyset cursor string.
 */
export function decodeCursor<T extends object>(
  cursorString: string,
  requiredKeys: readonly (keyof T)[]
): Result<T, RuntimeError> {
  if (typeof cursorString !== "string" || cursorString.trim() === "") {
    return err(
      createRuntimeError("persistence_failed", "Cursor string must be a non-empty string", false)
    );
  }

  try {
    const jsonText = Buffer.from(cursorString, "base64url").toString("utf8");
    const parsed = JSON.parse(jsonText);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return err(
        createRuntimeError("persistence_failed", "Decoded cursor must be an object", false)
      );
    }

    if (parsed.v !== CURRENT_CURSOR_VERSION) {
      return err(
        createRuntimeError(
          "persistence_failed",
          `Unsupported cursor version: expected ${CURRENT_CURSOR_VERSION}, received ${String(parsed.v)}`,
          false
        )
      );
    }

    for (const key of requiredKeys) {
      if (!(key in parsed) || parsed[key as string] === undefined) {
        return err(
          createRuntimeError(
            "persistence_failed",
            `Cursor missing required key: ${String(key)}`,
            false
          )
        );
      }
    }

    return ok(parsed as T);
  } catch (error) {
    return err(
      createRuntimeError(
        "persistence_failed",
        `Failed to parse cursor: ${String(error)}`,
        false
      )
    );
  }
}
