import { describe, expect, it } from "vitest";

import { isWellFormedUtf16 } from "./text.js";

describe("well-formed UTF-16", () => {
  it.each(["", "plain", "A😀B", "�", "é", "e\u0301"])("accepts %j", (value) => {
    expect(isWellFormedUtf16(value)).toBe(true);
  });

  it.each(["\ud800", "\udc00", "A\ud800B", "A\udc00B", "\ud800\ud800", "\udc00\udc00"])(
    "rejects malformed value %j",
    (value) => {
      expect(isWellFormedUtf16(value)).toBe(false);
    }
  );
});
