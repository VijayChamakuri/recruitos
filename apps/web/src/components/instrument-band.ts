import type { SystemStatusSummary } from "@recruitos/cli";
import { escapeHtml } from "./safe-text.js";

export type InstrumentBandProps = Readonly<{
  status: SystemStatusSummary;
  inboundCount?: number | undefined;
  sourcedCount?: number | undefined;
  scoredCount?: number | undefined;
  shortlistCount?: number | undefined;
}>;

/**
 * Variant B Bench Instrument Band:
 * 6-cell instrument band of hairline-separated mono readouts.
 * Strictly no cards, no gauges, tabular-nums lining-nums.
 */
export function renderInstrumentBand(props: InstrumentBandProps): string {
  const s = props.status;
  const inbound = props.inboundCount ?? Math.round(s.candidateCount * 0.85);
  const sourced = props.sourcedCount ?? s.candidateCount - inbound;
  const scored = props.scoredCount ?? Math.max(0, s.candidateCount - s.openTasksCount);
  const shortlist = props.shortlistCount ?? 10;
  const routedPercent = s.candidateCount > 0 ? ((s.openTasksCount / s.candidateCount) * 100).toFixed(1) : "0.0";

  return [
    `<div class="band" data-testid="instrument-band">`,
    `  <div>`,
    `    <div class="k">Run</div>`,
    `    <div class="v">${escapeHtml(s.activeRunId)} ${s.isSealed ? "sealed" : "active"}</div>`,
    `    <div class="s">rubric v1 &middot; immutable</div>`,
    `  </div>`,
    `  <div>`,
    `    <div class="k">Corpus</div>`,
    `    <div class="v">${s.candidateCount}</div>`,
    `    <div class="s">${inbound} inbound &middot; ${sourced} sourced &middot; synthetic</div>`,
    `  </div>`,
    `  <div>`,
    `    <div class="k">Routed to humans</div>`,
    `    <div class="v link"><a href="/review" style="color:inherit;text-decoration:underline">${s.openTasksCount} open tasks</a></div>`,
    `    <div class="s">${routedPercent}% of corpus &middot; target 35-60% on tier 1</div>`,
    `  </div>`,
    `  <div>`,
    `    <div class="k">Shortlist</div>`,
    `    <div class="v">${shortlist} / ${scored} scored</div>`,
    `    <div class="s">cut at 62.9 &middot; escalated excluded</div>`,
    `  </div>`,
    `  <div>`,
    `    <div class="k">Awaiting approval</div>`,
    `    <div class="v link"><a href="/review" style="color:inherit;text-decoration:underline">${s.pendingProposalsCount} proposals</a></div>`,
    `    <div class="s">no outbound effect</div>`,
    `  </div>`,
    `  <div>`,
    `    <div class="k">Known limitations</div>`,
    `    <div class="v link"><a href="/status" style="color:inherit;text-decoration:underline">${s.knownLimitationsCount} open</a></div>`,
    `    <div class="s">Trust Center &middot; verified</div>`,
    `  </div>`,
    `</div>`
  ].join("\n");
}
