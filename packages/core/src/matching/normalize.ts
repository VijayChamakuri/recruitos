import { isWellFormedUtf16 } from "../canonical/text.js";
import { createDomainError, type DomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";

/**
 * The text normalization policy version. Frozen at rubric lock alongside the
 * matching policy, then recorded on the run input snapshot so every fixture and
 * every recorded offset is tied to the exact policy that produced it.
 *
 * Policy 1: strip a single leading byte-order mark, fold CR and CRLF line
 * endings to LF, then apply Unicode NFC. Nothing else. Content is never
 * deleted, reordered, or rewritten. Suspicious or injected phrases survive
 * verbatim so downstream review can see them.
 */
export const TEXT_NORMALIZATION_POLICY_VERSION = 1;

const LEADING_BYTE_ORDER_MARK = "\uFEFF";
const CR_OR_CRLF = /\r\n?/gu;

export type NormalizedSourceText = Readonly<{
  normalizedText: string;
  policyVersion: number;
}>;

function invalidInput(message: string): DomainError {
  return createDomainError("invalid_input", message);
}

/**
 * Produces the canonical normalized form of raw source text. The result is what
 * every UTF-16 offset in the system indexes into: `normalizedText.slice(start,
 * end)` is authoritative. Deterministic and idempotent. Applying it to its own
 * output returns the same string.
 */
export function normalizeSourceText(
  rawText: unknown
): Result<NormalizedSourceText, DomainError> {
  if (typeof rawText !== "string") {
    return err(invalidInput("Source text must be a string"));
  }
  if (rawText.length === 0) {
    return err(invalidInput("Source text is empty"));
  }
  if (!isWellFormedUtf16(rawText)) {
    return err(invalidInput("Source text is not well-formed UTF-16"));
  }

  const withoutMark = rawText.startsWith(LEADING_BYTE_ORDER_MARK)
    ? rawText.slice(1)
    : rawText;
  const normalizedText = withoutMark.replace(CR_OR_CRLF, "\n").normalize("NFC");

  if (normalizedText.length === 0) {
    return err(invalidInput("Source text normalizes to empty"));
  }

  return ok(
    Object.freeze({
      normalizedText,
      policyVersion: TEXT_NORMALIZATION_POLICY_VERSION
    })
  );
}
