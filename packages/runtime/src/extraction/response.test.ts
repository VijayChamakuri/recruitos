import { describe, expect, it } from "vitest";

import {
  ExtractionResponseBodySchema,
  locateResponseSpans,
  parseExtractionResponseBody,
  type ExtractionResponseBody
} from "./response.js";

const DIMENSION = "applied_ml_llm_systems";

function body(overrides: Partial<ExtractionResponseBody> = {}): ExtractionResponseBody {
  return ExtractionResponseBodySchema.parse({
    dimensionId: DIMENSION,
    proposedLevel: "partial",
    spans: [{ quotedText: "shipped a retrieval service", polarity: "supporting" }],
    rejectedClaims: [],
    ...overrides
  });
}

describe("parseExtractionResponseBody", () => {
  it("accepts a body that matches the contract", () => {
    const raw = JSON.stringify({
      dimensionId: DIMENSION,
      proposedLevel: "strong",
      spans: [
        { quotedText: "owned the eval harness", polarity: "supporting" },
        { quotedText: "no production traffic", polarity: "contradicting" }
      ],
      rejectedClaims: [
        { kind: "unsupported_claim", quotedText: "world class", reason: "no evidence" }
      ]
    });
    const result = parseExtractionResponseBody(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.proposedLevel).toBe("strong");
    expect(result.value.spans).toHaveLength(2);
  });

  it("rejects a body that is not valid JSON", () => {
    const result = parseExtractionResponseBody("{ not json");
    expect(result).toMatchObject({
      ok: false,
      error: { code: "persistence_failed", details: { reason: "malformed_json" } }
    });
  });

  it("rejects a body missing a required field", () => {
    const raw = JSON.stringify({ dimensionId: DIMENSION, spans: [], rejectedClaims: [] });
    const result = parseExtractionResponseBody(raw);
    expect(result).toMatchObject({
      ok: false,
      error: { details: { reason: "schema_violation" } }
    });
  });

  it("rejects a body with an unknown field", () => {
    const raw = JSON.stringify({
      dimensionId: DIMENSION,
      proposedLevel: "none",
      spans: [],
      rejectedClaims: [],
      confidence: 0.9
    });
    expect(parseExtractionResponseBody(raw)).toMatchObject({
      ok: false,
      error: { details: { reason: "schema_violation" } }
    });
  });

  it("rejects a span with an unknown polarity", () => {
    const raw = JSON.stringify({
      dimensionId: DIMENSION,
      proposedLevel: "weak",
      spans: [{ quotedText: "text", polarity: "neutral" }],
      rejectedClaims: []
    });
    expect(parseExtractionResponseBody(raw)).toMatchObject({
      ok: false,
      error: { details: { reason: "schema_violation" } }
    });
  });

  it("rejects a quote over the committed maximum length", () => {
    const raw = JSON.stringify({
      dimensionId: DIMENSION,
      proposedLevel: "weak",
      spans: [{ quotedText: "a".repeat(241), polarity: "supporting" }],
      rejectedClaims: []
    });
    expect(parseExtractionResponseBody(raw)).toMatchObject({
      ok: false,
      error: { details: { reason: "schema_violation" } }
    });
  });
});

describe("locateResponseSpans", () => {
  const text = "The candidate shipped a retrieval service and owned the eval harness.";

  it("locates every quote with an exact match and reports full coverage", () => {
    const result = locateResponseSpans(
      body({
        spans: [
          { quotedText: "shipped a retrieval service", polarity: "supporting" },
          { quotedText: "owned the eval harness", polarity: "supporting" }
        ]
      }),
      text
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.spansReturned).toBe(2);
    expect(result.value.spansLocated).toBe(2);
    expect(result.value.droppedQuotes).toEqual([]);
    const [first] = result.value.acceptedOutput.spans;
    expect(text.slice(first!.start, first!.end)).toBe("shipped a retrieval service");
    expect(first!.matchQuality).toBe("exact");
    expect(result.value.acceptedOutput.dimensionId).toBe(DIMENSION);
    expect(result.value.acceptedOutput.proposedLevel).toBe("partial");
  });

  it("locates a quote through the fold table as a normalized match", () => {
    const curly = "He said don’t ship without a test.";
    const result = locateResponseSpans(
      body({ spans: [{ quotedText: "don't ship without a test", polarity: "contradicting" }] }),
      curly
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.acceptedOutput.spans[0]!.matchQuality).toBe("normalized");
    expect(result.value.acceptedOutput.spans[0]!.polarity).toBe("contradicting");
  });

  it("drops an unlocated quote onto droppedQuotes and keeps the located ones", () => {
    const result = locateResponseSpans(
      body({
        spans: [
          { quotedText: "shipped a retrieval service", polarity: "supporting" },
          { quotedText: "led a team of forty engineers", polarity: "supporting" }
        ]
      }),
      text
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.spansReturned).toBe(2);
    expect(result.value.spansLocated).toBe(1);
    expect(result.value.acceptedOutput.spans).toHaveLength(1);
    expect(result.value.droppedQuotes).toEqual([
      {
        quotedText: "led a team of forty engineers",
        dimensionId: DIMENSION,
        reason: "unlocated"
      }
    ]);
  });

  it("passes rejected claims through unchanged", () => {
    const rejectedClaims = [
      { kind: "fabricated_reference" as const, quotedText: "cited a paper", reason: "no such paper" }
    ];
    const result = locateResponseSpans(body({ rejectedClaims }), text);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.rejectedClaims).toEqual(rejectedClaims);
  });

  it("accepts a none level with no spans", () => {
    const result = locateResponseSpans(
      body({ proposedLevel: "none", spans: [] }),
      text
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.acceptedOutput.spans).toEqual([]);
    expect(result.value.droppedQuotes).toEqual([]);
    expect(result.value.spansReturned).toBe(0);
  });

  it("fails the whole response when a quote is not usable source text", () => {
    const result = locateResponseSpans(
      body({ spans: [{ quotedText: "\uD800", polarity: "supporting" }] }),
      text
    );
    expect(result).toMatchObject({
      ok: false,
      error: { details: { reason: "unusable_quote" } }
    });
  });

  it("fails when the source text is not already normalized", () => {
    const result = locateResponseSpans(
      body({ spans: [{ quotedText: "anything", polarity: "supporting" }] }),
      "trailing\r\ncarriage return"
    );
    expect(result).toMatchObject({
      ok: false,
      error: { details: { reason: "unusable_quote" } }
    });
  });
});
