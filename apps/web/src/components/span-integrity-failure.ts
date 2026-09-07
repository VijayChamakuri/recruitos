import { escapeHtml } from "./safe-text.js";

export type SpanIntegrityFailureProps = Readonly<{
  reason?: string | undefined;
  expectedText?: string | undefined;
  spanId?: string | undefined;
}>;

/**
 * Designed state for span integrity failure (DESIGN.md Part 8 Rule 9).
 * Renders an inline refused badge with struck outline reading
 * "span integrity failed, highlight refused" instead of silent omission.
 */
export function renderSpanIntegrityFailure(props?: SpanIntegrityFailureProps): string {
  const reasonAttr = props?.reason ? ` data-reason="${escapeHtml(props.reason)}"` : "";
  const idAttr = props?.spanId ? ` id="refused-${escapeHtml(props.spanId)}"` : "";
  const titleAttr = props?.reason ? ` title="${escapeHtml(props.reason)}"` : ' title="Span integrity violation"';

  return `<span class="span-refused"${idAttr}${reasonAttr}${titleAttr} role="status">span integrity failed, highlight refused</span>`;
}
