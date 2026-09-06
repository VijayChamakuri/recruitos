import { describe, expect, it } from "vitest";

import { createDomainError, DomainErrorSchema, type DomainErrorCode } from "./domain-error.js";

const codes: readonly DomainErrorCode[] = [
  "invalid_input",
  "invalid_rubric",
  "invalid_evidence",
  "invalid_transition",
  "unsupported_resolution",
  "score_invariant_failed",
  "span_integrity_failed"
];

describe("DomainError", () => {
  it("constructs every closed error variant", () => {
    for (const code of codes) {
      expect(createDomainError(code, "Safe message", { count: 1, field: "id", active: true, extra: null }))
        .toEqual({
          code,
          message: "Safe message",
          retryable: false,
          details: { count: 1, field: "id", active: true, extra: null }
        });
    }
  });

  it("omits details when none are supplied", () => {
    expect(createDomainError("invalid_input", "Safe message")).toEqual({
      code: "invalid_input",
      message: "Safe message",
      retryable: false
    });
  });

  it("rejects unknown fields and unsafe detail values", () => {
    expect(
      DomainErrorSchema.safeParse({
        code: "invalid_input",
        message: "Safe message",
        retryable: false,
        cause: "private"
      }).success
    ).toBe(false);
    expect(() => createDomainError("invalid_input", "Safe message", { bad: 1.5 })).toThrow();
  });
});
