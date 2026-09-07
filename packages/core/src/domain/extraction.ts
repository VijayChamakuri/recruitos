import { z } from "zod";

/**
 * V1 extraction cardinality and byte limits from the capacity contract.
 * These values are part of ExtractionSpec identity: changing any of them
 * produces a new spec hash and invalidates recorded fixtures.
 */
export const MAXIMUM_EVIDENCE_ITEMS_PER_WORK_ITEM = 12;
export const MAXIMUM_STRUCTURED_FACTS_PER_WORK_ITEM = 16;
export const MAXIMUM_VALIDATION_DETAILS = 8;
export const MAXIMUM_QUOTE_LENGTH = 240;
export const MAXIMUM_SERIALIZED_REQUEST_BYTES = 163_840;
export const MAXIMUM_PROVIDER_RESPONSE_BYTES = 65_536;

export const EXTRACTION_LIMITS = {
  maxEvidenceItems: MAXIMUM_EVIDENCE_ITEMS_PER_WORK_ITEM,
  maxStructuredFacts: MAXIMUM_STRUCTURED_FACTS_PER_WORK_ITEM,
  maxValidationDetails: MAXIMUM_VALIDATION_DETAILS,
  maxQuoteLength: MAXIMUM_QUOTE_LENGTH,
  maxSerializedRequestBytes: MAXIMUM_SERIALIZED_REQUEST_BYTES,
  maxProviderResponseBytes: MAXIMUM_PROVIDER_RESPONSE_BYTES
} as const;

export type ExtractionLimits = typeof EXTRACTION_LIMITS;

/**
 * Why a whole provider response became a reviewable extraction failure
 * instead of a persisted artifact. Unlocated quotes beside otherwise valid
 * output are rejected claims on the artifact, not members of this set.
 */
export const EXTRACTION_FAILURE_ERROR_CLASSES = [
  "structurally_invalid",
  "oversized_response",
  "identity_mismatch",
  "cardinality_exceeded"
] as const;

export const ExtractionFailureErrorClassSchema = z.enum(EXTRACTION_FAILURE_ERROR_CLASSES);
export type ExtractionFailureErrorClass = z.infer<typeof ExtractionFailureErrorClassSchema>;

/**
 * Bounded rejected claims retained on a valid artifact. The surrounding
 * response stays usable; these claims never become evidence spans.
 */
export const EXTRACTION_REJECTED_CLAIM_KINDS = [
  "unlocated_quote",
  "fabricated_reference",
  "unsupported_claim"
] as const;

export const ExtractionRejectedClaimKindSchema = z.enum(EXTRACTION_REJECTED_CLAIM_KINDS);
export type ExtractionRejectedClaimKind = z.infer<typeof ExtractionRejectedClaimKindSchema>;
