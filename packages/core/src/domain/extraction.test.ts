import { describe, expect, it } from "vitest";

import {
  EXTRACTION_FAILURE_ERROR_CLASSES,
  EXTRACTION_LIMITS,
  EXTRACTION_REJECTED_CLAIM_KINDS,
  ExtractionFailureErrorClassSchema,
  ExtractionRejectedClaimKindSchema,
  MAXIMUM_EVIDENCE_ITEMS_PER_WORK_ITEM,
  MAXIMUM_PROVIDER_RESPONSE_BYTES,
  MAXIMUM_QUOTE_LENGTH,
  MAXIMUM_SERIALIZED_REQUEST_BYTES,
  MAXIMUM_STRUCTURED_FACTS_PER_WORK_ITEM,
  MAXIMUM_VALIDATION_DETAILS
} from "./extraction.js";

describe("extraction contract vocabulary", () => {
  it("pins the v1 capacity limits that belong to spec identity", () => {
    expect(EXTRACTION_LIMITS).toEqual({
      maxEvidenceItems: MAXIMUM_EVIDENCE_ITEMS_PER_WORK_ITEM,
      maxStructuredFacts: MAXIMUM_STRUCTURED_FACTS_PER_WORK_ITEM,
      maxValidationDetails: MAXIMUM_VALIDATION_DETAILS,
      maxQuoteLength: MAXIMUM_QUOTE_LENGTH,
      maxSerializedRequestBytes: MAXIMUM_SERIALIZED_REQUEST_BYTES,
      maxProviderResponseBytes: MAXIMUM_PROVIDER_RESPONSE_BYTES
    });
    expect(EXTRACTION_LIMITS).toEqual({
      maxEvidenceItems: 12,
      maxStructuredFacts: 16,
      maxValidationDetails: 8,
      maxQuoteLength: 240,
      maxSerializedRequestBytes: 163_840,
      maxProviderResponseBytes: 65_536
    });
  });

  it("accepts exactly the closed set of extraction failure classes", () => {
    for (const errorClass of EXTRACTION_FAILURE_ERROR_CLASSES) {
      expect(ExtractionFailureErrorClassSchema.parse(errorClass)).toBe(errorClass);
    }
    expect(ExtractionFailureErrorClassSchema.safeParse("provider_error").success).toBe(false);
    expect(ExtractionFailureErrorClassSchema.safeParse("unlocated_quote").success).toBe(false);
    expect(ExtractionFailureErrorClassSchema.safeParse("").success).toBe(false);
  });

  it("accepts exactly the closed set of rejected-claim kinds", () => {
    for (const kind of EXTRACTION_REJECTED_CLAIM_KINDS) {
      expect(ExtractionRejectedClaimKindSchema.parse(kind)).toBe(kind);
    }
    expect(ExtractionRejectedClaimKindSchema.safeParse("dropped_quote").success).toBe(false);
    expect(ExtractionRejectedClaimKindSchema.safeParse("structurally_invalid").success).toBe(
      false
    );
  });
});
