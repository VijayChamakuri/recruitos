import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { foldForMatching, QUOTE_FOLD_POLICY_VERSION, QUOTE_FOLD_TABLE } from "./fold.js";

const ASCII_CASE_FOLD_COUNT = 26;
const PUNCTUATION_FOLD_COUNT = 20;

describe("QUOTE_FOLD_TABLE", () => {
  it("commits a policy version", () => {
    expect(QUOTE_FOLD_POLICY_VERSION).toBe(1);
  });

  it("maps exactly one code unit to exactly one code unit", () => {
    expect(QUOTE_FOLD_TABLE.size).toBe(ASCII_CASE_FOLD_COUNT + PUNCTUATION_FOLD_COUNT);
    for (const [from, to] of QUOTE_FOLD_TABLE) {
      expect(from).toHaveLength(1);
      expect(to).toHaveLength(1);
      expect(from).not.toBe(to);
    }
  });

  it("is idempotent because no fold target is itself foldable", () => {
    for (const [, to] of QUOTE_FOLD_TABLE) {
      expect(QUOTE_FOLD_TABLE.has(to)).toBe(false);
    }
  });

  it("covers ASCII case, the quote family, and the dash family", () => {
    expect(QUOTE_FOLD_TABLE.get("A")).toBe("a");
    expect(QUOTE_FOLD_TABLE.get("Z")).toBe("z");
    expect(QUOTE_FOLD_TABLE.get("\u2019")).toBe("'");
    expect(QUOTE_FOLD_TABLE.get("\u201c")).toBe('"');
    expect(QUOTE_FOLD_TABLE.get("\u2014")).toBe("-");
  });

  it("excludes folds that would change length or meaning", () => {
    const excluded = ["\u00a0", "\u0130", "\u0131", "\u00ab", "\u00bb", "a", "-"];
    for (const character of excluded) {
      expect(QUOTE_FOLD_TABLE.has(character)).toBe(false);
    }
  });
});

describe("foldForMatching", () => {
  it("folds ASCII case and leaves lowercase alone", () => {
    expect(foldForMatching("Shipped LLM Systems")).toBe("shipped llm systems");
    expect(foldForMatching("already lower")).toBe("already lower");
  });

  it("folds curly quotes and every supported dash to their ASCII forms", () => {
    expect(foldForMatching("\u2018a\u2019 \u201cb\u201d \u2032c\u2033")).toBe("'a' \"b\" 'c\"");
    expect(foldForMatching("\u2010\u2011\u2012\u2013\u2014\u2015\u2212")).toBe("-------");
  });

  it("leaves nonbreaking spaces, dotted I, and dotless i untouched", () => {
    expect(foldForMatching("a\u00a0b")).toBe("a\u00a0b");
    expect(foldForMatching("\u0130stanbul")).toBe("\u0130stanbul");
    expect(foldForMatching("\u0131")).toBe("\u0131");
  });

  it("leaves astral characters, emoji, and combining marks untouched", () => {
    expect(foldForMatching("\u{1f600}")).toBe("\u{1f600}");
    expect(foldForMatching("\u{10348}")).toBe("\u{10348}");
    expect(foldForMatching("q\u0301")).toBe("q\u0301");
  });

  it("preserves length and is idempotent for any string", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const folded = foldForMatching(value);
        expect(folded).toHaveLength(value.length);
        expect(foldForMatching(folded)).toBe(folded);
      })
    );
  });
});
