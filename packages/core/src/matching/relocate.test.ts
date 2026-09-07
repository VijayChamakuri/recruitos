import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { MAXIMUM_QUOTE_LENGTH } from "../domain/extraction.js";
import {
  QUOTE_UNLOCATED_REASON,
  relocateQuote,
  relocateQuoteClaim,
  type QuoteRelocation
} from "./relocate.js";
import { isUtf16CodePointBoundary } from "./utf16.js";

function located(normalizedText: string, quotedText: string): QuoteRelocation {
  const result = relocateQuote(normalizedText, quotedText);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  expect(result.value.matchedText).toBe(
    normalizedText.slice(result.value.start, result.value.end)
  );
  expect(isUtf16CodePointBoundary(normalizedText, result.value.start)).toBe(true);
  expect(isUtf16CodePointBoundary(normalizedText, result.value.end)).toBe(true);
  return result.value;
}

describe("relocateQuote source text validation", () => {
  it("rejects a non-string source text", () => {
    expect(relocateQuote(42, "a")).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "Source text must be a string" }
    });
  });

  it("rejects source text that is not usable at all", () => {
    expect(relocateQuote("", "a")).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "Source text is not usable source text" }
    });
  });

  it("rejects source text that is not already in normalized form", () => {
    expect(relocateQuote("a\r\nb", "a")).toMatchObject({
      ok: false,
      error: { code: "span_integrity_failed" }
    });
    expect(relocateQuote("\ufeffabc", "abc")).toMatchObject({
      ok: false,
      error: { code: "span_integrity_failed" }
    });
  });
});

describe("relocateQuote quote validation", () => {
  it("rejects a non-string quote", () => {
    expect(relocateQuote("some text", 7)).toMatchObject({
      ok: false,
      error: { code: "invalid_evidence", message: "Quote must be a string" }
    });
  });

  it("rejects a quote longer than the committed maximum", () => {
    const text = "x".repeat(MAXIMUM_QUOTE_LENGTH + 1);
    expect(relocateQuote(text, text)).toMatchObject({
      ok: false,
      error: { code: "invalid_evidence", message: "Quote exceeds the committed maximum length" }
    });
    expect(relocateQuote(text, "x".repeat(MAXIMUM_QUOTE_LENGTH)).ok).toBe(true);
  });

  it("rejects an empty or ill-formed quote", () => {
    expect(relocateQuote("some text", "")).toMatchObject({
      ok: false,
      error: { code: "invalid_evidence", message: "Quote is not usable source text" }
    });
    expect(relocateQuote("some text", "lone \ud800 surrogate")).toMatchObject({
      ok: false,
      error: { code: "invalid_evidence", message: "Quote is not usable source text" }
    });
  });
});

describe("relocateQuote exact tier", () => {
  it("locates a verbatim substring and reports the exact tier", () => {
    const text = "Built an evaluation harness for LLM output.";
    expect(located(text, "evaluation harness")).toEqual({
      start: 9,
      end: 27,
      quotedText: "evaluation harness",
      matchedText: "evaluation harness",
      matchQuality: "exact"
    });
  });

  it("resolves repeated quotes to the lowest start", () => {
    expect(located("shipped, then shipped again", "shipped").start).toBe(0);
  });

  it("prefers a later exact match over an earlier folded one", () => {
    const relocation = located("Shipped shipped", "shipped");
    expect(relocation.start).toBe(8);
    expect(relocation.matchQuality).toBe("exact");
  });
});

describe("relocateQuote normalized tier", () => {
  it("locates across ASCII case differences", () => {
    const relocation = located("Owned the Retrieval Pipeline", "owned the retrieval pipeline");
    expect(relocation).toMatchObject({
      start: 0,
      end: 28,
      matchedText: "Owned the Retrieval Pipeline",
      matchQuality: "normalized"
    });
  });

  it("locates across curly quotes and every supported dash", () => {
    const text = "the team\u2019s on\u2011call rotation \u2014 weekly";
    const relocation = located(text, "the team's on-call rotation - weekly");
    expect(relocation).toMatchObject({
      start: 0,
      end: text.length,
      matchedText: text,
      matchQuality: "normalized"
    });
    expect(relocation.quotedText).toBe("the team's on-call rotation - weekly");
  });

  it("keeps the folded interval the same length as the quote", () => {
    const relocation = located("A \u2014 B", "a - b");
    expect(relocation.end - relocation.start).toBe(5);
  });
});

describe("relocateQuote unicode handling", () => {
  it("locates quotes containing emoji and astral characters without splitting them", () => {
    const text = "shipped \u{1f680} to \u{10348} production";
    const relocation = located(text, "\u{1f680} to \u{10348}");
    expect(relocation.matchQuality).toBe("exact");
    expect(relocation.start).toBe(8);
  });

  it("locates a quote that differs only by unicode normalization form", () => {
    const text = "caf\u00e9 latte metrics";
    const relocation = located(text, "cafe\u0301 latte");
    expect(relocation).toMatchObject({
      start: 0,
      end: 10,
      matchedText: "caf\u00e9 latte",
      matchQuality: "exact"
    });
  });

  it("locates a combining sequence that has no precomposed form", () => {
    const text = "the q\u0301 marker";
    expect(located(text, "q\u0301 marker").start).toBe(4);
  });

  it("locates across mixed line endings in the quote", () => {
    const text = "first line\nsecond line";
    const relocation = located(text, "first line\r\nsecond");
    expect(relocation).toMatchObject({
      start: 0,
      end: 17,
      matchedText: "first line\nsecond",
      matchQuality: "exact"
    });
  });

  it("does not fold Turkish dotted or dotless i", () => {
    const text = "\u0130stanbul office";
    expect(located(text, "\u0130stanbul").start).toBe(0);
    expect(relocateQuote(text, "istanbul")).toMatchObject({
      ok: false,
      error: { details: { reason: QUOTE_UNLOCATED_REASON } }
    });
  });

  it("does not fold a nonbreaking space to a plain space", () => {
    const text = "ten\u00a0years";
    expect(located(text, "ten\u00a0years").matchQuality).toBe("exact");
    expect(relocateQuote(text, "ten years")).toMatchObject({
      ok: false,
      error: { details: { reason: QUOTE_UNLOCATED_REASON } }
    });
  });
});

describe("relocateQuote failure", () => {
  it("returns a typed unlocated failure the caller can distinguish", () => {
    expect(relocateQuote("the stored text", "never written anywhere")).toEqual({
      ok: false,
      error: {
        code: "invalid_evidence",
        message: "Quote did not locate in the source text",
        retryable: false,
        details: { reason: QUOTE_UNLOCATED_REASON }
      }
    });
  });
});

describe("relocateQuoteClaim", () => {
  it("ignores plausible but wrong offsets supplied by the model", () => {
    const text = "the evidence sentence";
    const result = relocateQuoteClaim(text, {
      quotedText: "evidence",
      start: 0,
      end: 4
    });
    expect(result).toMatchObject({ ok: true, value: { start: 4, end: 12 } });
  });

  it("accepts a claim with no offsets at all", () => {
    expect(relocateQuoteClaim("the evidence sentence", { quotedText: "sentence" })).toMatchObject({
      ok: true,
      value: { start: 13, end: 21 }
    });
  });

  it("rejects a claim that is not a quote claim", () => {
    expect(relocateQuoteClaim("text", { quote: "text" })).toMatchObject({
      ok: false,
      error: { code: "invalid_evidence", message: "Quote claim is invalid" }
    });
    expect(relocateQuoteClaim("text", { quotedText: "text", offset: 0 })).toMatchObject({
      ok: false,
      error: { message: "Quote claim is invalid" }
    });
  });
});

const QUOTE_TOKENS = ["a", "B", "\u2019", "\u2014", "\u{1f600}", "q\u0301", "\n", " "] as const;

describe("relocateQuote invariants", () => {
  it("returns an interval whose slice is exactly the matched text", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...QUOTE_TOKENS), { minLength: 1, maxLength: 12 }),
        fc.nat(11),
        fc.nat(11),
        (tokens, from, span) => {
          const text = tokens.join("");
          const start = from % tokens.length;
          const end = Math.min(start + 1 + (span % tokens.length), tokens.length);
          const quote = tokens.slice(start, end).join("");
          const result = relocateQuote(text, quote);
          expect(result.ok).toBe(true);
          if (!result.ok) {
            return;
          }
          expect(text.slice(result.value.start, result.value.end)).toBe(result.value.matchedText);
          expect(isUtf16CodePointBoundary(text, result.value.start)).toBe(true);
          expect(isUtf16CodePointBoundary(text, result.value.end)).toBe(true);
          expect(result.value.end - result.value.start).toBe(quote.length);
        }
      )
    );
  });
});
