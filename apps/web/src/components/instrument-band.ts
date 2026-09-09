import type { SystemStatusSummary } from "@recruitos/cli";
import { hrefWithAppearance, type Appearance } from "../appearance.js";
import { escapeHtml } from "./safe-text.js";

export type InstrumentBandProps = Readonly<{
  status: SystemStatusSummary;
  appearance: Appearance;
  inboundCount: number;
  sourcedCount: number;
  scoredCount: number;
  outstandingTaskCount: number;
  corpusSublabel?: string | undefined;
}>;

/**
 * Variant B Bench Instrument Band:
 * 6-cell instrument band of hairline-separated mono readouts.
 * Strictly no cards, no gauges, tabular-nums lining-nums.
 */
export function renderInstrumentBand(props: InstrumentBandProps): string {
  const s = props.status;
  const appearance = props.appearance;
  const corpusSublabel =
    props.corpusSublabel ??
    `${props.inboundCount} inbound · ${props.sourcedCount} sourced · synthetic`;
  const routedPercent =
    s.candidateCount > 0
      ? ((props.outstandingTaskCount / s.candidateCount) * 100).toFixed(1)
      : "0.0";

  return [
    `<div class="band" data-testid="instrument-band">`,
    `  <div>`,
    `    <div class="k">Run</div>`,
    `    <div class="v">${escapeHtml(s.activeRunId)} ${s.isSealed ? "sealed" : "active"}</div>`,
    `    <div class="s">rubric v1 · immutable</div>`,
    `  </div>`,
    `  <div>`,
    `    <div class="k">Corpus</div>`,
    `    <div class="v">${s.candidateCount}</div>`,
    `    <div class="s">${escapeHtml(corpusSublabel)}</div>`,
    `  </div>`,
    `  <div>`,
    `    <div class="k">Routed to humans</div>`,
    `    <div class="v link"><a href="${escapeHtml(hrefWithAppearance("/review", appearance))}" style="color:inherit;text-decoration:underline">${props.outstandingTaskCount} open tasks</a></div>`,
    `    <div class="s">${routedPercent}% of corpus</div>`,
    `  </div>`,
    `  <div>`,
    `    <div class="k">Scored</div>`,
    `    <div class="v">${props.scoredCount} / ${s.candidateCount}</div>`,
    `    <div class="s">escalated and rejected_hard_requirement excluded</div>`,
    `  </div>`,
    `  <div>`,
    `    <div class="k">Awaiting approval</div>`,
    `    <div class="v link"><a href="${escapeHtml(hrefWithAppearance("/review", appearance))}" style="color:inherit;text-decoration:underline">${s.pendingProposalsCount} proposals</a></div>`,
    `    <div class="s">no outbound effect</div>`,
    `  </div>`,
    `  <div>`,
    `    <div class="k">Known limitations</div>`,
    `    <div class="v link"><a href="${escapeHtml(hrefWithAppearance("/status", appearance))}" style="color:inherit;text-decoration:underline">${s.knownLimitationsCount} open</a></div>`,
    `    <div class="s">count from runtime status</div>`,
    `  </div>`,
    `</div>`
  ].join("\n");
}
