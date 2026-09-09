import type {
  ArithmeticTerm,
  CandidatePacket,
  EvidenceGap,
  EvidenceSpan
} from "@recruitos/cli";
import { RUBRIC_V1 } from "@recruitos/core";
import {
  DEFAULT_APPEARANCE,
  hrefWithAppearance,
  type Appearance
} from "../appearance.js";
import { renderAnnotatedDocument } from "./span-highlight.js";
import { renderEvidenceGapCard } from "./evidence-gap-card.js";
import { escapeHtml } from "./safe-text.js";
import { formatWeightPercent } from "../format.js";
import { TEST_IDS } from "../testids.js";
import { renderConflictBand, renderPriorResultLink, renderTaskInspector } from "./task-inspector.js";
import type { PacketInspectorModel } from "../server/inspector-model.js";

export type CandidatePacketViewProps = Readonly<{
  packet: CandidatePacket;
  focusedDimensionId?: string | undefined;
  focusedSpanId?: string | undefined;
  appearance?: Appearance | undefined;
  inspector?: PacketInspectorModel | undefined;
}>;

function inspectingLabel(packet: CandidatePacket): string {
  if (packet.isHistoricalResult) {
    return packet.resultId
      ? `Inspecting: historical result ${packet.resultId}`
      : "Inspecting: historical result";
  }
  return "Inspecting: current head";
}

function renderConfidenceInputs(packet: CandidatePacket): string {
  const input = packet.confidenceInput;
  if (input === null) {
    return [
      `        <div class="mono muted" data-testid="${TEST_IDS.CONFIDENCE_INPUTS}" style="font-size:12px;margin:8px 0">`,
      `          Confidence inputs unavailable`,
      `        </div>`
    ].join("\n");
  }
  return [
    `        <div data-testid="${TEST_IDS.CONFIDENCE_INPUTS}" style="margin:8px 0 12px">`,
    `          <div class="caps">Confidence inputs</div>`,
    `          <div class="mono muted" style="font-size:12px;margin-top:4px">`,
    `            Dimension coverage: ${input.dimensionsWithLocatedSpan}/${input.totalDimensions}`,
    `            · Quote resolution: ${input.spansLocated}/${input.spansReturned}`,
    `            · Contradictions: ${input.contradictionCount}`,
    `            · Required missing: ${input.requiredFieldsMissing}/${input.totalRequiredFields}`,
    `          </div>`,
    `        </div>`
  ].join("\n");
}

function renderPacketTasks(tasks: CandidatePacket["tasks"]): string {
  if (tasks.length === 0) {
    return [
      `    <div data-testid="${TEST_IDS.PACKET_TASKS}" class="mono faint" style="font-size:12px;margin-top:6px">`,
      `      No current resolution tasks`,
      `    </div>`
    ].join("\n");
  }
  const rows = tasks.map((task) => {
    const listing =
      task.listing === "this_result" ? "this result" : "current candidate work";
    return [
      `      <li data-testid="${TEST_IDS.PACKET_TASK_ITEM(task.resolutionTaskId)}" style="margin:2px 0">`,
      `        <span class="mono">${escapeHtml(task.resolutionTaskId)}</span>`,
      `        · ${escapeHtml(task.reasonCode)}`,
      `        · <span data-testid="${TEST_IDS.TASK_STATUS(task.resolutionTaskId)}">${escapeHtml(task.status)}</span>`,
      `        · ${escapeHtml(listing)}`,
      `      </li>`
    ].join("");
  });
  return [
    `    <div data-testid="${TEST_IDS.PACKET_TASKS}" style="margin-top:6px">`,
    `      <div class="caps">Current resolution tasks</div>`,
    `      <ul style="margin:4px 0 0;padding-left:18px;font-size:12px" class="mono">`,
    rows.join("\n"),
    `      </ul>`,
    `    </div>`
  ].join("\n");
}

function ledgerDimensions(packet: CandidatePacket): readonly {
  dimensionId: string;
  dimensionName: string;
  level?: string;
  weightedScore?: number;
}[] {
  if (packet.arithmeticTerms.length > 0) {
    return packet.arithmeticTerms;
  }
  return RUBRIC_V1.dimensions.map((dimension) => ({
    dimensionId: dimension.dimensionId,
    dimensionName: dimension.dimensionId
  }));
}

/**
 * Variant B Bench Candidate Review Packet:
 * 3-pane layout at declared surface values:
 * 1. pane.arith: --surface-inset graphite (5 cols)
 * 2. pane.ledger: --surface neutral (7 cols)
 * 3. pane.source: --surface-paper white (6 cols)
 * The aggregate score does not appear in the packet header.
 */
export function renderCandidatePacketView(props: CandidatePacketViewProps): string {
  const p = props.packet;
  const appearance = props.appearance ?? DEFAULT_APPEARANCE;
  const focusedDim = props.focusedDimensionId ?? p.arithmeticTerms[0]?.dimensionId;
  const returnHref = hrefWithAppearance("/triage", appearance);

  const termRows = p.arithmeticTerms.map((term: ArithmeticTerm) => {
    const isFocused = term.dimensionId === focusedDim;
    const onClass = isFocused ? " on" : "";
    return [
      `      <tr class="${onClass}" data-term-dim="${escapeHtml(term.dimensionId)}" data-testid="${TEST_IDS.ARITHMETIC_TERM(term.dimensionId)}">`,
      `        <td>${escapeHtml(term.dimensionName)}</td>`,
      `        <td class="n">${formatWeightPercent(term.weight)}</td>`,
      `        <td>${escapeHtml(term.level)}</td>`,
      `        <td class="n">${term.levelScore.toFixed(0)}</td>`,
      `        <td class="n">${term.weightedScore.toFixed(2)}</td>`,
      `      </tr>`
    ].join("\n");
  });

  const arithmeticHeadline = p.scoreText ?? "unavailable";
  const confidenceHeadline = p.confidenceText ?? "unavailable";

  const arithPane = [
    `    <section class="pane arith" data-testid="pane-arithmetic">`,
    `      <header class="panehead">`,
    `        <span>Score Decomposition (5-Col)</span>`,
    `        <span class="mono">${p.sealed ? "sealed" : "mutable"}</span>`,
    `      </header>`,
    `      <div class="arithbox" data-testid="${TEST_IDS.SCORE_CARD}">`,
    `        <div class="caps">Visible arithmetic</div>`,
    `        <div class="big">${escapeHtml(arithmeticHeadline)}</div>`,
    `        <div class="mono muted" style="font-size:12px;margin:4px 0 8px">Confidence: ${escapeHtml(confidenceHeadline)}</div>`,
    renderConfidenceInputs(p),
    `        <table class="terms" data-testid="${TEST_IDS.ARITHMETIC_TABLE}">`,
    `          <thead><tr>`,
    `            <th>Dimension</th><th style="text-align:right">Wt</th><th>Level</th><th style="text-align:right">Pts</th><th style="text-align:right">Score</th>`,
    `          </tr></thead>`,
    `          <tbody>`,
    termRows.length > 0
      ? termRows.join("\n")
      : `            <tr><td colspan="5" class="muted">Assessment unavailable. No arithmetic terms.</td></tr>`,
    `          </tbody>`,
    `        </table>`,
    `      </div>`,
    `    </section>`
  ].join("\n");

  const dimBlocks = ledgerDimensions(p).map((term, idx) => {
    const spans = p.evidenceSpans.filter((s) => s.dimensionId === term.dimensionId);
    const gaps = p.evidenceGaps.filter((g) => g.dimensionId === term.dimensionId);
    const levelLabel =
      term.level !== undefined && term.weightedScore !== undefined
        ? `${term.level} (${term.weightedScore.toFixed(1)})`
        : "unavailable";

    const spanCards = spans.map((span: EvidenceSpan) => {
      const isFocused = span.evidenceSpanId === props.focusedSpanId;
      const bracketClass = span.polarity === "supporting" ? "sup" : "con";
      const focusedClass = isFocused ? " focused" : "";
      return [
        `        <div class="card bracket ${bracketClass}${focusedClass}" id="card-${escapeHtml(span.evidenceSpanId)}" data-span-id="${escapeHtml(span.evidenceSpanId)}" data-testid="${TEST_IDS.EVIDENCE_SPAN_CARD(span.evidenceSpanId)}">`,
        `          <q class="serif">&ldquo;${escapeHtml(span.quotedText)}&rdquo;</q>`,
        `          <div class="meta">${span.polarity} &middot; quality: ${span.matchQuality} &middot; doc: ${escapeHtml(span.documentId)}</div>`,
        `        </div>`
      ].join("\n");
    });

    const gapCards = gaps.map((gap: EvidenceGap) => renderEvidenceGapCard(gap));

    return [
      `      <div class="dimblock" id="dim-${escapeHtml(term.dimensionId)}" data-testid="${TEST_IDS.DIMENSION_BLOCK(term.dimensionId)}">`,
      `        <div class="dimhead">`,
      `          <span class="idx">0${idx + 1}</span>`,
      `          <span class="nm">${escapeHtml(term.dimensionName)}</span>`,
      `          <span class="caps">${escapeHtml(levelLabel)}</span>`,
      `        </div>`,
      spanCards.length > 0 ? spanCards.join("\n") : "",
      gapCards.length > 0 ? gapCards.join("\n") : "",
      spanCards.length === 0 && gapCards.length === 0
        ? `        <div class="muted faint" style="font-size:12px;padding:4px 0">No evidence items recorded</div>`
        : "",
      `      </div>`
    ].join("\n");
  });

  const ledgerPane = [
    `    <section class="pane ledger" data-testid="pane-ledger">`,
    `      <header class="panehead">`,
    `        <span>Evidence Ledger</span>`,
    `        <span class="mono">${p.evidenceSpans.length} spans &middot; ${p.evidenceGaps.length} gaps</span>`,
    `      </header>`,
    dimBlocks.join("\n"),
    `    </section>`
  ].join("\n");

  const primaryDoc = p.documents[0];
  const sourceBody =
    primaryDoc === undefined
      ? `      <div class="doc" data-testid="${TEST_IDS.RESUME_VIEWER}"><span class="muted">Source document unavailable</span></div>`
      : [
          renderAnnotatedDocument(primaryDoc.text, p.evidenceSpans, props.focusedSpanId),
          `      <div class="raw-source-text" data-testid="${TEST_IDS.RAW_SOURCE_TEXT}" style="display:none">${escapeHtml(primaryDoc.text)}</div>`
        ].join("\n");

  const sourcePane = [
    `    <section class="pane source" data-testid="pane-source">`,
    `      <header class="panehead">`,
    `        <span>Source &middot; ${escapeHtml(primaryDoc?.label ?? "unavailable")}</span>`,
    `        <span class="mono">${escapeHtml(primaryDoc?.documentKind ?? "none")}</span>`,
    `      </header>`,
    sourceBody,
    `    </section>`
  ].join("\n");

  const routingReasons = p.reasons;
  const inspector = props.inspector;
  const priorResultId = inspector?.priorResultId;
  const resultKind = p.resultKind ?? "unavailable";
  const resultIdAttr = p.resultId === undefined ? "" : ` data-result-id="${escapeHtml(p.resultId)}"`;
  const resultKindAttr = ` data-result-kind="${escapeHtml(resultKind)}"`;
  const sourceKeyAttr = ` data-source-key="${escapeHtml(p.sourceKey)}"`;
  const candidateIdAttr = ` data-candidate-id="${escapeHtml(p.candidateId)}"`;

  const headerHtml = [
    `  <div style="padding:10px 16px 8px;border-bottom:1px solid var(--hairline-strong);background:var(--surface)">`,
    `    <div style="display:flex;align-items:baseline;gap:12px">`,
    `      <a href="${escapeHtml(returnHref)}" class="mono link" style="font-size:12px" data-testid="${TEST_IDS.RETURN_TO_QUEUE}">Return to triage queue</a>`,
    `      <span style="flex:1"></span>`,
    `      <span class="pill-synthetic" data-testid="${TEST_IDS.SYNTHETIC_DATA_PILL}">SYNTHETIC DATA</span>`,
    `    </div>`,
    `    <div style="display:flex;align-items:baseline;gap:12px;margin-top:6px">`,
    `      <span style="font-size:24px;line-height:30px;font-weight:600">${escapeHtml(p.sourceKey)}</span>`,
    `      <span class="muted">${escapeHtml(p.roleTitle)}</span>`,
    `      <span class="mono" style="font-size:12px">ID: ${escapeHtml(p.candidateId)}</span>`,
    `    </div>`,
    `    <div class="mono faint" style="font-size:12px;margin-top:4px">`,
    `      channel: ${escapeHtml(p.channel)} &middot; status: <strong style="color:var(--text)">${escapeHtml(p.status)}</strong> &middot; result kind: ${escapeHtml(resultKind)} &middot; content hash: ${escapeHtml(p.contentHash.slice(0, 16))}... &middot; sealed: ${p.sealed ? "yes" : "no"}`,
    `    </div>`,
    `    <div class="mono" style="font-size:12px;margin-top:4px" data-testid="${TEST_IDS.PACKET_INSPECTING_LABEL}">${escapeHtml(inspectingLabel(p))}</div>`,
    `    <div style="display:flex;align-items:center;gap:12px;margin-top:6px" data-testid="${TEST_IDS.VERSION_HISTORY}">`,
    `      <span class="badge" data-testid="${TEST_IDS.SUPERSEDING_BADGE}">${p.sealed ? "Sealed Version" : "Active Head"}</span>`,
    `      <span class="sep">&#124;</span>`,
    priorResultId
      ? renderPriorResultLink(p.candidateId, appearance, priorResultId)
      : "",
    `      <div data-testid="${TEST_IDS.ROUTING_REASONS}" style="display:inline-flex;gap:6px;flex-wrap:wrap">`,
    routingReasons.length > 0
      ? routingReasons
          .map(
            (r) =>
              `<span class="tag reason-tag" data-testid="${TEST_IDS.ROUTING_REASON_TAG(r)}">${escapeHtml(r)}</span>`
          )
          .join("")
      : `<span class="mono faint" style="font-size:12px">no routing reasons</span>`,
    `      </div>`,
    `    </div>`,
    renderPacketTasks(p.tasks),
    `  </div>`
  ].join("\n");

  const panesHtml = [
    `  <div class="packet-b" data-testid="candidate-packet-view"${candidateIdAttr}${resultIdAttr}${resultKindAttr}${sourceKeyAttr}>`,
    `    <svg class="thread" aria-hidden="true">`,
    `      <!-- The thread connects focused claim to evidence card and source span -->`,
    `    </svg>`,
    arithPane,
    ledgerPane,
    sourcePane,
    `  </div>`
  ].join("\n");

  if (inspector === undefined) {
    return [headerHtml, panesHtml].join("\n");
  }

  const conflictSlot =
    inspector.conflictMessage === undefined
      ? ""
      : `    <div class="packet-conflict-slot">${renderConflictBand(inspector.conflictMessage)}</div>`;

  return [
    `  <div class="packet-shell">`,
    headerHtml,
    conflictSlot,
    `    <div class="packet-with-inspector">`,
    `      <div class="packet-main">`,
    panesHtml,
    `      </div>`,
    renderTaskInspector(inspector),
    `    </div>`,
    `  </div>`
  ].join("\n");
}
