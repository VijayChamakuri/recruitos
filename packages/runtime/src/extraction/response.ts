import {
  DimensionLevelSchema,
  EvidencePolaritySchema,
  RubricDimensionIdSchema,
  err,
  ok,
  relocateQuote,
  type Result
} from "@recruitos/core";
import { z } from "zod";

import type { DroppedQuote } from "../evidence/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  ExtractionAcceptedOutputSchema,
  ExtractionRejectedClaimSchema,
  MAXIMUM_QUOTE_LENGTH,
  type ExtractionAcceptedOutput,
  type ExtractionRejectedClaim
} from "./schemas.js";

/**
 * The provider output contract for one work item (one rubric dimension, one
 * document). This is the shape of the raw `body` string an `ExtractionAdapter`
 * returns, before any persistence input is built. Its SHA-256 is what
 * `ExtractionSpecContent.schemaHash` commits to, and the tier-1 corpus fixtures
 * are authored against it.
 *
 * Per the product design (P1): the model returns an ordinal level from the
 * fixed enum plus verbatim contiguous quotes with a polarity. It never returns
 * offsets. Code locates each quote in the stored normalized text
 * (`relocateResponseSpans`); an unlocated quote is dropped and recorded on the
 * extraction run, never guessed at.
 */

/** A quote the model asserts, before relocation. Offsets are never accepted. */
const ExtractionResponseSpanSchema = z
  .object({
    quotedText: z.string().min(1).max(MAXIMUM_QUOTE_LENGTH),
    polarity: EvidencePolaritySchema
  })
  .strict();

export const ExtractionResponseBodySchema = z
  .object({
    dimensionId: RubricDimensionIdSchema,
    proposedLevel: DimensionLevelSchema,
    spans: z.array(ExtractionResponseSpanSchema),
    rejectedClaims: z.array(ExtractionRejectedClaimSchema)
  })
  .strict();

export type ExtractionResponseBody = z.infer<typeof ExtractionResponseBodySchema>;

/** Why a raw response could not be turned into a validated artifact. */
export type ExtractionResponseFailureReason =
  | "malformed_json"
  | "schema_violation"
  | "unusable_quote";

/** The located form: what `prepareExtractionArtifact` and the run row consume. */
export type LocatedExtractionResponse = Readonly<{
  acceptedOutput: ExtractionAcceptedOutput;
  rejectedClaims: readonly ExtractionRejectedClaim[];
  droppedQuotes: readonly DroppedQuote[];
  spansReturned: number;
  spansLocated: number;
}>;

function responseFailure(
  message: string,
  reason: ExtractionResponseFailureReason
): RuntimeError {
  return createRuntimeError("persistence_failed", message, false, { reason });
}

/**
 * Parses and validates a raw adapter body against the provider output
 * contract. A malformed or off-contract body is a fixture or provider defect,
 * not a candidate outcome; the caller records it as a blocked failure.
 */
export function parseExtractionResponseBody(
  rawBody: string
): Result<ExtractionResponseBody, RuntimeError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return err(responseFailure("Extraction response body is not valid JSON", "malformed_json"));
  }
  const body = ExtractionResponseBodySchema.safeParse(parsed);
  if (!body.success) {
    return err(
      responseFailure("Extraction response body does not match the contract", "schema_violation")
    );
  }
  return ok(body.data);
}

/**
 * Locates every asserted quote against the stored normalized text and assembles
 * the accepted output. Exact and folded tiers only; the fuzzy tier is deferred.
 * An unlocated quote is not an error: it is dropped and returned for the
 * extraction run's `droppedQuotes`, which keeps the confidence resolution term
 * auditable. A quote that is not usable source text at all is a contract
 * violation and fails the whole response.
 */
export function locateResponseSpans(
  body: ExtractionResponseBody,
  normalizedText: string
): Result<LocatedExtractionResponse, RuntimeError> {
  const located: Array<z.input<typeof ExtractionAcceptedOutputSchema>["spans"][number]> = [];
  const dropped: DroppedQuote[] = [];

  for (const span of body.spans) {
    const relocation = relocateQuote(normalizedText, span.quotedText);
    if (relocation.ok) {
      located.push({
        start: relocation.value.start,
        end: relocation.value.end,
        quotedText: span.quotedText,
        polarity: span.polarity,
        matchQuality: relocation.value.matchQuality
      });
      continue;
    }
    if (relocation.error.details?.["reason"] === "unlocated") {
      dropped.push({
        quotedText: span.quotedText,
        dimensionId: body.dimensionId,
        reason: "unlocated"
      });
      continue;
    }
    return err(
      responseFailure(
        `Extraction response quote is not usable source text: ${relocation.error.message}`,
        "unusable_quote"
      )
    );
  }

  // Every span here was located by relocateQuote from a schema-bounded quote,
  // so parsing to the branded accepted-output shape cannot fail.
  const acceptedOutput = ExtractionAcceptedOutputSchema.parse({
    dimensionId: body.dimensionId,
    proposedLevel: body.proposedLevel,
    spans: located
  });

  return ok({
    acceptedOutput,
    rejectedClaims: body.rejectedClaims,
    droppedQuotes: dropped,
    spansReturned: body.spans.length,
    spansLocated: located.length
  });
}
