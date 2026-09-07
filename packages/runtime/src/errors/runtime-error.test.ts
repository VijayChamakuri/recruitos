import { describe, expect, it } from "vitest";

import { RuntimeErrorSchema, createRuntimeError } from "./runtime-error.js";

describe("createRuntimeError", () => {
  it("builds each runtime error code with a stable shape", () => {
    for (const code of [
      "persistence_failed",
      "migration_required",
      "command_conflict",
      "version_conflict",
      "not_found"
    ] as const) {
      const error = createRuntimeError(code, "message", false);
      expect(error).toEqual({ code, message: "message", retryable: false });
      expect(RuntimeErrorSchema.safeParse(error).success).toBe(true);
    }
  });

  it("carries a not_found code with optional safe details", () => {
    expect(
      createRuntimeError("not_found", "Candidate packet not found", false, {
        candidateId: "candidate-1"
      })
    ).toEqual({
      code: "not_found",
      message: "Candidate packet not found",
      retryable: false,
      details: { candidateId: "candidate-1" }
    });
  });

  it("rejects an unknown code", () => {
    expect(
      RuntimeErrorSchema.safeParse({
        code: "made_up",
        message: "x",
        retryable: false
      }).success
    ).toBe(false);
  });
});
