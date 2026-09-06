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

  it.each([1, Number.MAX_SAFE_INTEGER + 1, "42", null, undefined])(
    "rejects non-bigint runtime input %s",
    (value) => {
      expect(() => formatCanonicalInteger(value as unknown as bigint)).toThrow(TypeError);
    }
  );

  it("rejects objects without invoking custom string conversion", () => {
    let conversions = 0;
    const value = {
      toString: () => {
        conversions += 1;
        return "42";
      }
    };
    expect(() => formatCanonicalInteger(value as unknown as bigint)).toThrow(TypeError);
    expect(conversions).toBe(0);
  });
});
