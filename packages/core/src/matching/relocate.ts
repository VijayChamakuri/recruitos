import { z } from "zod";

import type { MatchQuality } from "../domain/evidence.js";
import { MAXIMUM_QUOTE_LENGTH } from "../domain/extraction.js";
import { createDomainError, type DomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";
import { foldForMatching } from "./fold.js";
import { normalizeSourceText } from "./normalize.js";

/**
 * The two tiers this module can produce. `fuzzy` is a separate later tier and
 * is deliberately not representable here, so a fold-table match can never be
 * mislabelled as a fuzzy one.
 */
export type FoldedMatchQuality = Extract<MatchQuality, "exact" | "normalized">;

/**
 * A relocated quote. `start` and `end` are zero-based, end-exclusive UTF-16
 * code-unit offsets into the stored normalized text, so
 * `normalizedText.slice(start, end)` is authoritative and equals `matchedText`.
 * `quotedText` is the extractor's claim, retained verbatim; `matchedText` is
 * what the packet highlights.
 */
export type QuoteRelocation = Readonly<{
  start: number;
  end: number;
  quotedText: string;
  matchedText: string;
  matchQuality: FoldedMatchQuality;
}>;

/**
 * An extractor quote claim. Models routinely return plausible but wrong
 * offsets, so `start` and `end` are accepted and then ignored: relocation is
 * always recomputed from the stored text.
 */
export const QuoteClaimSchema = z
  .object({
    quotedText: z.string(),
    start: z.unknown().optional(),
    end: z.unknown().optional()
  })
  .strict();

export type QuoteClaim = z.infer<typeof QuoteClaimSchema>;

/** Detail flag that distinguishes an unlocated quote from an invalid one. */
export const QUOTE_UNLOCATED_REASON = "unlocated";

function invalidText(message: string): DomainError {
  return createDomainError("invalid_input", message);
}

function invalidQuote(message: string): DomainError {
  return createDomainError("invalid_evidence", message);
}

function unlocated(): DomainError {
  return createDomainError("invalid_evidence", "Quote did not locate in the source text", {
    reason: QUOTE_UNLOCATED_REASON
  });
}

/**
 * Brings an extractor quote into the same policy space as the stored text.
 * This is preparation of the claim, not of the source: the transform runs on
 * the quote only, and the located interval is measured against the stored
 * text, so offsets stay exact even where preparation changes the quote's own
 * length.
 */
function prepareQuote(
  quotedTextInput: unknown
): Result<Readonly<{ quotedText: string; preparedQuote: string }>, DomainError> {
  if (typeof quotedTextInput !== "string") {
    return err(invalidQuote("Quote must be a string"));
  }
  if (quotedTextInput.length > MAXIMUM_QUOTE_LENGTH) {
    return err(invalidQuote("Quote exceeds the committed maximum length"));
  }
  const prepared = normalizeSourceText(quotedTextInput);
  if (!prepared.ok) {
    return err(invalidQuote("Quote is not usable source text"));
  }
  return ok({ quotedText: quotedTextInput, preparedQuote: prepared.value.normalizedText });
}

function requireNormalizedText(textInput: unknown): Result<string, DomainError> {
  if (typeof textInput !== "string") {
    return err(invalidText("Source text must be a string"));
  }
  const normalized = normalizeSourceText(textInput);
  if (!normalized.ok) {
    return err(invalidText("Source text is not usable source text"));
  }
  if (normalized.value.normalizedText !== textInput) {
    return err(
      createDomainError(
        "span_integrity_failed",
        "Source text is not in normalized form, so offsets would not index it"
      )
    );
  }
  return ok(textInput);
}

function locate(
  normalizedText: string,
  preparedQuote: string
): Readonly<{ start: number; matchQuality: FoldedMatchQuality }> | undefined {
  const exactStart = normalizedText.indexOf(preparedQuote);
  if (exactStart !== -1) {
    return { start: exactStart, matchQuality: "exact" };
  }
  const foldedStart = foldForMatching(normalizedText).indexOf(foldForMatching(preparedQuote));
  if (foldedStart !== -1) {
    return { start: foldedStart, matchQuality: "normalized" };
  }
  return undefined;
}

/**
 * Locates a quote in stored normalized text and returns its zero-based,
 * end-exclusive UTF-16 interval.
 *
 * Two tiers, in order. Tier 1 is an exact substring match. Tier 2 applies the
 * committed one-to-one fold table to both sides; because the table never
 * changes length, the folded index is directly an index into the stored text.
 * Tier order beats position: an exact match later in the text wins over a
 * folded match earlier in it. Within a tier, repeated occurrences resolve to
 * the lowest start, and since the interval length is fixed that is also the
 * lowest end.
 *
 * Anything the fold table cannot reconcile, including spacing differences and
 * paraphrase, is left unlocated for the fuzzy tier rather than guessed at
 * here.
 */
export function relocateQuote(
  normalizedTextInput: unknown,
  quotedTextInput: unknown
): Result<QuoteRelocation, DomainError> {
  const normalizedText = requireNormalizedText(normalizedTextInput);
  if (!normalizedText.ok) {
    return normalizedText;
  }
  const quote = prepareQuote(quotedTextInput);
  if (!quote.ok) {
    return quote;
  }

  const located = locate(normalizedText.value, quote.value.preparedQuote);
  if (located === undefined) {
    return err(unlocated());
  }

  const start = located.start;
  const end = start + quote.value.preparedQuote.length;
  return ok(
    Object.freeze({
      start,
      end,
      quotedText: quote.value.quotedText,
      matchedText: normalizedText.value.slice(start, end),
      matchQuality: located.matchQuality
    })
  );
}

/**
 * Relocates an extractor quote claim. Any `start` or `end` the model supplied
 * is discarded before matching, which is the plan's rule for plausible but
 * wrong offsets.
 */
export function relocateQuoteClaim(
  normalizedTextInput: unknown,
  claimInput: unknown
): Result<QuoteRelocation, DomainError> {
  const claim = QuoteClaimSchema.safeParse(claimInput);
  if (!claim.success) {
    return err(invalidQuote("Quote claim is invalid"));
  }
  return relocateQuote(normalizedTextInput, claim.data.quotedText);
}
