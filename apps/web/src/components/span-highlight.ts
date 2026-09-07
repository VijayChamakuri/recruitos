import type { EvidenceSpan } from "@recruitos/cli";
import { escapeHtml, validateSpanContent, validateSpanInterval } from "./safe-text.js";
import { renderSpanIntegrityFailure } from "./span-integrity-failure.js";

export type SpanHighlightProps = Readonly<{
  text: string;
  polarity: "supporting" | "contradicting";
  dimensionId?: string | undefined;
  spanId?: string | undefined;
  isFocused?: boolean | undefined;
}>;

/**
 * Renders an inline evidence span highlight conforming to Variant B Bench:
 * - Supporting: teal wash, left underline rule
 * - Contradicting: ochre wash with 45-degree hatch underlay
 * - Corner radius: --r-mark: 0px (never rounded)
 */
export function renderSpanHighlight(props: SpanHighlightProps): string {
  const cls = props.polarity === "supporting" ? "sup" : "con";
  const focusedCls = props.isFocused ? " focused" : "";
  const idAttr = props.spanId ? ` id="span-${escapeHtml(props.spanId)}"` : "";
  const dataDim = props.dimensionId ? ` data-dimension="${escapeHtml(props.dimensionId)}"` : "";
  const tag = props.dimensionId
    ? `<span class="tag">${escapeHtml(props.dimensionId)}</span>`
    : "";

  return `<mark class="${cls}${focusedCls}"${idAttr}${dataDim} data-polarity="${props.polarity}">${escapeHtml(
    props.text
  )}${tag}</mark>`;
}

/**
 * Renders source document text with inline highlights.
 * If any span violates boundaries or content hash integrity, the designed
 * SpanIntegrityFailure component is rendered in place of the corrupt span
 * so the rest of the document and packet still renders safely.
 */
export function renderAnnotatedDocument(
  sourceText: string,
  spans: readonly EvidenceSpan[],
  focusedSpanId?: string
): string {
  if (spans.length === 0) {
    return `<div class="doc">${escapeHtml(sourceText).replace(/\n/g, "<br>")}</div>`;
  }

  // Sort spans by start ascending
  const sortedSpans = [...spans].sort((a, b) => a.start - b.start);

  const parts: string[] = [];
  let cursor = 0;

  for (const span of sortedSpans) {
    // If span starts before previous span ended (overlapping spans)
    if (span.start < cursor) {
      // Append inline integrity refusal for overlap
      parts.push(
        renderSpanIntegrityFailure({
          reason: `Overlapping span at [${span.start}, ${span.end}]`,
          spanId: span.evidenceSpanId
        })
      );
      continue;
    }

    // Append un-annotated text before this span
    if (span.start > cursor) {
      parts.push(escapeHtml(sourceText.slice(cursor, span.start)).replace(/\n/g, "<br>"));
    }

    // Validate span integrity against source text
    const check = validateSpanContent(sourceText, span.start, span.end, span.quotedText);

    if (!check.ok) {
      parts.push(
        renderSpanIntegrityFailure({
          reason: check.reason,
          expectedText: span.quotedText,
          spanId: span.evidenceSpanId
        })
      );
    } else {
      const isFocused = focusedSpanId === span.evidenceSpanId;
      parts.push(
        renderSpanHighlight({
          text: span.quotedText,
          polarity: span.polarity,
          dimensionId: span.dimensionId,
          spanId: span.evidenceSpanId,
          isFocused
        })
      );
    }

    cursor = Math.max(cursor, span.end);
  }

  // Remainder of text
  if (cursor < sourceText.length) {
    parts.push(escapeHtml(sourceText.slice(cursor)).replace(/\n/g, "<br>"));
  }

  return `<div class="doc">${parts.join("")}</div>`;
}
