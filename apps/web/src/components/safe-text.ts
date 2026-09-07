/**
 * Text safety and UTF-16 surrogate pair validation for RecruitOS.
 * Ensures span offsets never split surrogate pairs and text is safely HTML-escaped.
 */

export function escapeHtml(unsafe: string): string {
  return unsafe
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export type SpanValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Validates that an interval [start, end] is within string bounds and does not
 * split a UTF-16 surrogate pair (0xD800 to 0xDBFF followed by 0xDC00 to 0xDFFF).
 */
export function validateSpanInterval(
  text: string,
  start: number,
  end: number
): SpanValidationResult {
  if (start < 0 || end < 0) {
    return { ok: false, reason: "Negative offset is invalid" };
  }
  if (start > text.length || end > text.length) {
    return {
      ok: false,
      reason: `Offset out of bounds: [${start}, ${end}] exceeds length ${text.length}`
    };
  }
  if (start > end) {
    return {
      ok: false,
      reason: `Inverted interval: start ${start} exceeds end ${end}`
    };
  }

  // Check if start splits a surrogate pair (i.e. points at a low surrogate preceded by high)
  if (start > 0 && start < text.length) {
    const prevChar = text.charCodeAt(start - 1);
    const currChar = text.charCodeAt(start);
    if (prevChar >= 0xd800 && prevChar <= 0xdbff && currChar >= 0xdc00 && currChar <= 0xdfff) {
      return { ok: false, reason: "Start offset splits a UTF-16 surrogate pair" };
    }
  }

  // Check if end splits a surrogate pair
  if (end > 0 && end < text.length) {
    const prevChar = text.charCodeAt(end - 1);
    const currChar = text.charCodeAt(end);
    if (prevChar >= 0xd800 && prevChar <= 0xdbff && currChar >= 0xdc00 && currChar <= 0xdfff) {
      return { ok: false, reason: "End offset splits a UTF-16 surrogate pair" };
    }
  }

  return { ok: true };
}

/**
 * Validates whether the slice of text matches the expected text exactly.
 */
export function validateSpanContent(
  sourceText: string,
  start: number,
  end: number,
  expectedText: string
): SpanValidationResult {
  const intervalCheck = validateSpanInterval(sourceText, start, end);
  if (!intervalCheck.ok) {
    return intervalCheck;
  }

  const actualSlice = sourceText.slice(start, end);
  if (actualSlice !== expectedText) {
    return {
      ok: false,
      reason: `Span content mismatch: expected "${expectedText}" but found "${actualSlice}"`
    };
  }

  return { ok: true };
}
