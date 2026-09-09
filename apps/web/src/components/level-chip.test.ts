import { describe, expect, it } from "vitest";
import { levelSegmentCount, renderLevelChip } from "./level-chip.js";
import { TEST_IDS } from "../testids.js";

describe("levelSegmentCount", () => {
  it("maps assessment levels to ordinal segment counts out of 4", () => {
    expect(levelSegmentCount("strong")).toBe(4);
    expect(levelSegmentCount("STRONG")).toBe(4);
    expect(levelSegmentCount("partial")).toBe(2);
    expect(levelSegmentCount("Partial")).toBe(2);
    expect(levelSegmentCount("weak")).toBe(1);
    expect(levelSegmentCount("WEAK")).toBe(1);
    expect(levelSegmentCount("none")).toBe(0);
    expect(levelSegmentCount("NONE")).toBe(0);
  });

  it("handles undefined and unknown levels safely as zero", () => {
    expect(levelSegmentCount(undefined)).toBe(0);
    expect(levelSegmentCount("unknown_level")).toBe(0);
    expect(levelSegmentCount("")).toBe(0);
  });
});

describe("renderLevelChip", () => {
  it("renders unavailable placeholder when level is undefined or empty", () => {
    expect(renderLevelChip(undefined)).toBe('<span class="muted faint">unavailable</span>');
    expect(renderLevelChip("")).toBe('<span class="muted faint">unavailable</span>');
    expect(renderLevelChip("   ")).toBe('<span class="muted faint">unavailable</span>');
  });

  it("renders four empty segment outlines for none level with accessible text", () => {
    const html = renderLevelChip("none");
    expect(html).toContain(`data-testid="${TEST_IDS.LEVEL_CHIP}"`);
    expect(html).toContain('data-level="none"');
    expect(html).toContain('aria-label="Level: none"');
    expect(html).toContain('title="none"');
    expect(html).toContain('<span class="sr-only">none</span>');
    // None has 0 filled segments
    expect(html).not.toContain("level-seg filled");
    const countSegments = (html.match(/class="level-seg"/g) ?? []).length;
    expect(countSegments).toBe(4);
  });

  it("renders 1 filled segment for weak level", () => {
    const html = renderLevelChip("weak");
    expect(html).toContain('data-level="weak"');
    expect(html).toContain('<span class="sr-only">weak</span>');
    const filledMatches = (html.match(/class="level-seg filled"/g) ?? []).length;
    const emptyMatches = (html.match(/class="level-seg"/g) ?? []).length;
    expect(filledMatches).toBe(1);
    expect(emptyMatches).toBe(3);
  });

  it("renders 2 filled segments for partial level", () => {
    const html = renderLevelChip("partial");
    expect(html).toContain('data-level="partial"');
    expect(html).toContain('<span class="sr-only">partial</span>');
    const filledMatches = (html.match(/class="level-seg filled"/g) ?? []).length;
    const emptyMatches = (html.match(/class="level-seg"/g) ?? []).length;
    expect(filledMatches).toBe(2);
    expect(emptyMatches).toBe(2);
  });

  it("renders 4 filled segments for strong level", () => {
    const html = renderLevelChip("strong");
    expect(html).toContain('data-level="strong"');
    expect(html).toContain('<span class="sr-only">strong</span>');
    const filledMatches = (html.match(/class="level-seg filled"/g) ?? []).length;
    const emptyMatches = (html.match(/class="level-seg"/g) ?? []).length;
    expect(filledMatches).toBe(4);
    expect(emptyMatches).toBe(0);
  });

  it("escapes special characters in level text", () => {
    const html = renderLevelChip("<custom>");
    expect(html).toContain("&lt;custom&gt;");
    expect(html).not.toContain("<custom>");
  });
});
