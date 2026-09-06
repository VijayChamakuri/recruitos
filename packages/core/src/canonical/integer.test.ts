import { describe, expect, it } from "vitest";

import { formatCanonicalInteger, parseCanonicalInteger } from "./integer.js";

describe("canonical integers", () => {
  it.each([
    ["0", 0n],
    ["42", 42n],
    ["-42", -42n],
    ["9007199254740993123456789", 9_007_199_254_740_993_123_456_789n]
  ])("parses %s exactly", (text, expected) => {
    expect(parseCanonicalInteger(text)).toEqual({ ok: true, value: expected });
    expect(formatCanonicalInteger(expected)).toBe(text);
  });

  it.each([undefined, 1, "+1", "01", "-0", "1.0"])("rejects noncanonical value %j", (value) => {
    const result = parseCanonicalInteger(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_input");
    }
  });
});
