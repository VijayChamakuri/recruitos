import { describe, expect, it } from "vitest";

import {
  isUtf16CodePointBoundary,
  Utf16IntervalSchema,
  Utf16SliceSchema,
  validateUtf16Interval,
  validateUtf16Slice
} from "./utf16.js";

describe("UTF-16 intervals", () => {
  const text = "A😀B";

  it("uses zero-based end-exclusive code-unit offsets", () => {
    expect(text.length).toBe(4);
    expect(validateUtf16Interval(text, { start: 1, end: 3 })).toEqual({
      ok: true,
      value: { start: 1, end: 3 }
    });
    expect(validateUtf16Slice(text, { start: 1, end: 3, matchedText: "😀" })).toEqual({
      ok: true,
      value: { start: 1, end: 3, matchedText: "😀" }
    });
  });

  it("accepts empty generic intervals at valid boundaries", () => {
    expect(validateUtf16Interval(text, { start: 4, end: 4 }).ok).toBe(true);
    expect(isUtf16CodePointBoundary(text, 0)).toBe(true);
    expect(isUtf16CodePointBoundary(text, text.length)).toBe(true);
  });

  it("rejects invalid shapes, reversed ranges, and empty matched slices", () => {
    expect(Utf16IntervalSchema.safeParse({ start: 2, end: 1 }).success).toBe(false);
    expect(Utf16SliceSchema.safeParse({ start: 1, end: 1, matchedText: "" }).success).toBe(false);
    expect(validateUtf16Interval(text, { start: -1, end: 1 }).ok).toBe(false);
    expect(validateUtf16Slice(text, { start: 1, end: 1, matchedText: "" }).ok).toBe(false);
  });

  it("rejects out-of-bounds intervals and surrogate splits", () => {
    expect(validateUtf16Interval(text, { start: 0, end: 5 }).ok).toBe(false);
    expect(validateUtf16Interval(text, { start: 2, end: 3 }).ok).toBe(false);
    expect(validateUtf16Interval(text, { start: 1, end: 2 }).ok).toBe(false);
    expect(validateUtf16Slice(text, { start: 0, end: 5, matchedText: "A😀B!" }).ok).toBe(false);
    expect(isUtf16CodePointBoundary(text, 2)).toBe(false);
  });

  it("rejects source-slice mismatches with typed integrity errors", () => {
    const result = validateUtf16Slice(text, { start: 1, end: 3, matchedText: "AB" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "span_integrity_failed",
        retryable: false,
        details: { start: 1, end: 3 }
      });
    }
  });
});
