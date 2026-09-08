import type {
  ArithmeticTerm,
  CandidatePacket,
  EvidenceGap,
  EvidenceSpan
} from "@recruitos/cli";
import { renderAnnotatedDocument } from "./span-highlight.js";
import { renderEvidenceGapCard } from "./evidence-gap-card.js";
import { escapeHtml } from "./safe-text.js";
import { TEST_IDS } from "../testids.js";

export type CandidatePacketViewProps = Readonly<{
  packet: CandidatePacket;
  focusedDimensionId?: string | undefined;
  focusedSpanId?: string | undefined;
}>;

/**
 * Variant B Bench Candidate Review Packet:
 * 3-pane layout at declared surface values:
 * 1. pane.arith: --surface-inset graphite (5 cols)
 * 2. pane.ledger: --surface neutral (7 cols)
 * 3. pane.source: --surface-paper white (6 cols)
 */
export function renderCandidatePacketView(props: CandidatePacketViewProps): string {
  const p = props.packet;
  const focusedDim = props.focusedDimensionId ?? p.arithmeticTerms[0]?.dimensionId;

  // Pane 1: Arithmetic matrix (5 cols)
  const termRows = p.arithmeticTerms.map((term: ArithmeticTerm) => {
    const isFocused = term.dimensionId === focusedDim;
    const onClass = isFocused ? " on" : "";
    return [
      `      <tr class="${onClass}" data-term-dim="${escapeHtml(term.dimensionId)}" data-testid="${TEST_IDS.ARITHMETIC_TERM(term.dimensionId)}">`,
      `        <td>${escapeHtml(term.dimensionName)}</td>`,
      `        <td class="n">${term.weight}%</td>`,
      `        <td>${escapeHtml(term.level)}</td>`,
      `        <td class="n">${term.levelScore.toFixed(0)}</td>`,
      `        <td class="n">${term.weightedScore.toFixed(2)}</td>`,
      `      </tr>`
    ].join("\n");
  });

  const totalScore = p.arithmeticTerms.reduce((sum, t) => sum + t.weightedScore, 0);

  const arithPane = [
    `    <section class="pane arith" data-testid="pane-arithmetic">`,
    `      <header class="panehead">`,
    `        <span>Score Decomposition (5-Col)</span>`,
    `        <span class="mono">${p.sealed ? "sealed" : "mutable"}</span>`,
    `      </header>`,
    `      <div class="arithbox" data-testid="${TEST_IDS.SCORE_CARD}">`,
    `        <div class="caps">Overall Score</div>`,
    `        <div class="big">${p.score !== null ? p.score.toFixed(1) : totalScore.toFixed(1)} <span class="mono faint" style="font-size:14px">/ 100</span></div>`,
    `        <div class="mono muted" style="font-size:12px;margin:4px 0 12px">Confidence: ${p.confidence !== null ? `${Math.round(p.confidence * 100)}%` : "N/A"}</div>`,
    `        <table class="terms" data-testid="${TEST_IDS.ARITHMETIC_TABLE}">`,
    `          <thead><tr>`,
    `            <th>Dimension</th><th style="text-align:right">Wt</th><th>Level</th><th style="text-align:right">Pts</th><th style="text-align:right">Score</th>`,
    `          </tr></thead>`,
    `          <tbody>`,
    termRows.join("\n"),
    `            <tr class="total">`,
    `              <td colspan="4">Total</td>`,
    `              <td class="n">${totalScore.toFixed(2)}</td>`,
    `            </tr>`,
    `          </tbody>`,
    `        </table>`,
    `      </div>`,
    `    </section>`
  ].join("\n");

  // Pane 2: Evidence Ledger (7 cols)
  const dimBlocks = p.arithmeticTerms.map((term, idx) => {
    const spans = p.evidenceSpans.filter((s) => s.dimensionId === term.dimensionId);
    const gaps = p.evidenceGaps.filter((g) => g.dimensionId === term.dimensionId);

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
      `          <span class="caps">${term.level} (${term.weightedScore.toFixed(1)})</span>`,
      `        </div>`,
      spanCards.length > 0 ? spanCards.join("\n") : "",
      gapCards.length > 0 ? gapCards.join("\n") : "",
      spanCards.length === 0 && gapCards.length === 0 ? `        <div class="muted faint" style="font-size:12px;padding:4px 0">No evidence items recorded</div>` : "",
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

  // Pane 3: Source Document (6 cols)
  const primaryDoc = p.documents[0] ?? {
    documentId: "doc-empty",
    documentKind: "source",
    label: "Document",
    text: "(no document content available)"
  };

  const sourcePane = [
    `    <section class="pane source" data-testid="pane-source">`,
    `      <header class="panehead">`,
    `        <span>Source &middot; ${escapeHtml(primaryDoc.label)}</span>`,
    `        <span class="mono">${escapeHtml(primaryDoc.documentKind)}</span>`,
    `      </header>`,
    renderAnnotatedDocument(primaryDoc.text, p.evidenceSpans, props.focusedSpanId),
    `      <div class="raw-source-text" data-testid="${TEST_IDS.RAW_SOURCE_TEXT}" style="display:none">${escapeHtml(primaryDoc.text)}</div>`,
    `    </section>`
  ].join("\n");

  const taskReasons = Array.from(new Set(p.tasks.map((t) => t.reasonCode)));

  return [
    `  <div style="padding:10px 16px 8px;border-bottom:1px solid var(--hairline-strong);background:var(--surface)">`,
    `    <div style="display:flex;align-items:baseline;gap:12px">`,
    `      <span style="font-size:24px;line-height:30px;font-weight:600">${escapeHtml(p.sourceKey)}</span>`,
    `      <span class="muted">${escapeHtml(p.roleTitle)}</span>`,
    `      <span style="flex:1"></span>`,
    `      <span class="pill-synthetic">Synthetic</span>`,
    `      <span class="mono" style="font-size:12px">ID: ${escapeHtml(p.candidateId)}</span>`,
    `    </div>`,
    `    <div class="mono faint" style="font-size:12px;margin-top:4px">`,
    `      channel: ${escapeHtml(p.channel)} &middot; status: <strong style="color:var(--text)">${escapeHtml(p.status)}</strong> &middot; content hash: ${escapeHtml(p.contentHash.slice(0, 16))}... &middot; sealed: ${p.sealed ? "yes" : "no"}`,
    `    </div>`,
    `    <div style="display:flex;align-items:center;gap:12px;margin-top:6px" data-testid="${TEST_IDS.VERSION_HISTORY}">`,
    `      <span class="badge" data-testid="${TEST_IDS.SUPERSEDING_BADGE}">${p.sealed ? "Sealed Version" : "Active Head"}</span>`,
    `      <a href="#history" class="mono link faint" style="font-size:12px" data-testid="${TEST_IDS.PRIOR_VERSION_LINK}">Prior versions</a>`,
    `      <span class="sep">&#124;</span>`,
    `      <div data-testid="${TEST_IDS.ROUTING_REASONS}" style="display:inline-flex;gap:6px">`,
    taskReasons.length > 0
      ? taskReasons.map((r) => `<span class="tag reason-tag" data-testid="${TEST_IDS.ROUTING_REASON_TAG(r)}">${escapeHtml(r)}</span>`).join("")
      : `<span class="mono faint" style="font-size:12px">no escalation reasons</span>`,
    `      </div>`,
    `    </div>`,
    `  </div>`,
    `  <div class="packet-b" data-testid="candidate-packet-view">`,
    `    <svg class="thread" aria-hidden="true">`,
    `      <!-- The thread connects focused claim to evidence card and source span -->`,
    `    </svg>`,
    arithPane,
    ledgerPane,
    sourcePane,
    `  </div>`
  ].join("\n");
}
