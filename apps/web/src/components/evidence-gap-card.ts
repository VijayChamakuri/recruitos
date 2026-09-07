import type { EvidenceGap } from "@recruitos/cli";
import { escapeHtml } from "./safe-text.js";

/**
 * Renders an Evidence Gap card per DESIGN.md Part 2 / Variant B Bench:
 * Zero hue, dashed outline (gap-outline), bracket styling.
 */
export function renderEvidenceGapCard(gap: EvidenceGap): string {
  return [
    `<div class="bracket gap" data-gap-dimension="${escapeHtml(gap.dimensionId)}">`,
    `  <div class="caps" style="margin-bottom:4px">Evidence Gap &middot; ${escapeHtml(gap.dimensionId)}</div>`,
    `  <div class="muted" style="font-size:13px;line-height:18px">${escapeHtml(gap.reason)}</div>`,
    `</div>`
  ].join("\n");
}
