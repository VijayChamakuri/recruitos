import { describe, expect, it } from "vitest";
import { TOKENS_CSS } from "./tokens.js";

const SANS_FAMILIES = new Set(["IBM Plex Sans", "IBM Plex Sans Condensed"]);
const BLOCK_FAMILIES = new Set(["IBM Plex Mono", "Source Serif 4"]);

function fontDisplayByFamily(css: string): Map<string, string[]> {
  const displays = new Map<string, string[]>();
  for (const match of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    const body = match[1] ?? "";
    const family = /font-family:\s*"([^"]+)"/.exec(body)?.[1];
    const display = /font-display:\s*([a-z]+)/.exec(body)?.[1];
    expect(family, "each @font-face must name a family").toBeDefined();
    expect(display, `each @font-face for ${family ?? "unknown"} must set font-display`).toBeDefined();
    if (family === undefined || display === undefined) continue;
    const list = displays.get(family) ?? [];
    list.push(display);
    displays.set(family, list);
  }
  return displays;
}

describe("self-hosted font-display policy", () => {
  it("uses swap for sans and block for mono and serif", () => {
    const displays = fontDisplayByFamily(TOKENS_CSS);
    expect([...displays.keys()].sort()).toEqual(
      ["IBM Plex Mono", "IBM Plex Sans", "IBM Plex Sans Condensed", "Source Serif 4"].sort()
    );
    for (const [family, values] of displays) {
      if (SANS_FAMILIES.has(family)) {
        expect(values, family).toEqual(values.map(() => "swap"));
      } else if (BLOCK_FAMILIES.has(family)) {
        expect(values, family).toEqual(values.map(() => "block"));
      } else {
        throw new Error(`unexpected font family ${family}`);
      }
    }
    expect(displays.get("IBM Plex Mono")).toEqual(["block"]);
    expect(displays.get("Source Serif 4")).toEqual(["block", "block"]);
  });

  it("declares the 420px packet inspector rail", () => {
    expect(TOKENS_CSS).toContain("grid-template-columns: 1fr 420px");
    expect(TOKENS_CSS).toContain(".conflict-band");
    expect(TOKENS_CSS).toContain("var(--contradict)");
  });

  it("declares the historical packet desaturation state", () => {
    expect(TOKENS_CSS).toContain(".packet-historical");
    expect(TOKENS_CSS).toMatch(/\.packet-historical\s*\{[^}]*grayscale\(0\.68\)/);
    expect(TOKENS_CSS).toMatch(/\.packet-historical\s*\{[^}]*saturate\(0\.38\)/);
  });

  it("aligns document and evidence quotation typography with tokens", () => {
    expect(TOKENS_CSS).toMatch(/\.doc\s*\{[^}]*font-size:\s*var\(--t-doc\)/);
    expect(TOKENS_CSS).toMatch(/\.doc\s*\{[^}]*line-height:\s*var\(--lh-doc\)/);
    expect(TOKENS_CSS).toMatch(/\.card q\s*\{[^}]*font-size:\s*var\(--t-doc-sm\)/);
    expect(TOKENS_CSS).toMatch(/\.card q\s*\{[^}]*line-height:\s*var\(--lh-doc-sm\)/);
  });

  it("declares consistent focus-visible treatment with 80ms transition and suppresses pointer outlines", () => {
    expect(TOKENS_CSS).toContain(":focus:not(:focus-visible)");
    expect(TOKENS_CSS).toMatch(/:focus:not\(:focus-visible\)\s*\{\s*outline:\s*none;\s*\}/);
    expect(TOKENS_CSS).toContain(":focus-visible");
    expect(TOKENS_CSS).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
    expect(TOKENS_CSS).toMatch(/:focus-visible\s*\{[^}]*transition:\s*outline 80ms ease/);
  });

  it("declares the four-segment level chip and sr-only styling", () => {
    expect(TOKENS_CSS).toContain(".level-chip");
    expect(TOKENS_CSS).toContain(".level-chip-segments");
    expect(TOKENS_CSS).toContain(".level-seg");
    expect(TOKENS_CSS).toContain(".level-seg.filled");
    expect(TOKENS_CSS).toContain(".sr-only");
  });
});
