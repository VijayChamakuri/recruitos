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
});
