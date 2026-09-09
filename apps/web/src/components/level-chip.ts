import { escapeHtml } from "./safe-text.js";
import { TEST_IDS } from "../testids.js";

/**
 * Returns the number of filled segments (out of 4) for an ordinal assessment level.
 * Mapped to ordinal scale: none = 0 (empty outline), weak = 1, partial = 2, strong = 4.
 */
export function levelSegmentCount(level: string | undefined): number {
  if (level === undefined) {
    return 0;
  }
  switch (level.toLowerCase()) {
    case "strong":
      return 4;
    case "partial":
      return 2;
    case "weak":
      return 1;
    case "none":
    default:
      return 0;
  }
}

/**
 * Renders the approved four-segment LevelChip per DESIGN.md Part 8 Rule 13:
 * Ordinal, not categorical. Four quarter-segments filled to the level in foreground grey.
 * none is an empty four-segment outline. Ordinal data looks ordinal. Levels never get their own hue.
 * Textual level remains accessible to screen readers and automated tests via .sr-only and aria-label.
 */
export function renderLevelChip(level: string | undefined): string {
  if (level === undefined || level.trim() === "") {
    return `<span class="muted faint">unavailable</span>`;
  }
  const normalized = level.toLowerCase();
  const filledSegments = levelSegmentCount(normalized);
  const segments = [0, 1, 2, 3]
    .map(
      (idx) =>
        `<span class="level-seg${idx < filledSegments ? " filled" : ""}" aria-hidden="true"></span>`
    )
    .join("");

  return [
    `<span class="level-chip" data-level="${escapeHtml(normalized)}" data-testid="${TEST_IDS.LEVEL_CHIP}" aria-label="Level: ${escapeHtml(level)}" title="${escapeHtml(level)}">`,
    `  <span class="level-chip-segments" aria-hidden="true">${segments}</span>`,
    `  <span class="sr-only">${escapeHtml(level)}</span>`,
    `</span>`
  ].join("");
}
