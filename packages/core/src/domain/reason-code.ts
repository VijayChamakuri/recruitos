import { z } from "zod";

import { createDomainError, type DomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";

/**
 * The closed reason-code vocabulary from design invariant P5. Every kind that
 * carries a parameter (for example `missing_evidence:<dimension>`) is
 * structural here: `{ kind, subjectId }`. `formatReasonCode` produces the
 * display and storage string; `parseReasonCode` is the inverse, used to
 * validate stored text against this closed set at the app layer, since a
 * parameterized form cannot be a SQL CHECK enum.
 *
 * The predicate logic that decides which reason code fires for a candidate is
 * a later pipeline slice. This module only names the closed vocabulary.
 */
export const REASON_CODE_KINDS_WITH_SUBJECT = [
  "missing_evidence",
  "contradiction",
  "ambiguous"
] as const;

export const REASON_CODE_KINDS_WITHOUT_SUBJECT = [
  "parse_failure",
  "possible_duplicate",
  "prompt_injection_flagged",
  "low_confidence"
] as const;

export const REASON_CODE_KINDS = [
  ...REASON_CODE_KINDS_WITH_SUBJECT,
  ...REASON_CODE_KINDS_WITHOUT_SUBJECT
] as const;

export const ReasonCodeKindSchema = z.enum(REASON_CODE_KINDS);
export type ReasonCodeKind = z.infer<typeof ReasonCodeKindSchema>;

const reasonCodeSubjectId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u, "Reason code subject must be printable ASCII without spaces");

export const ReasonCodeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing_evidence"), subjectId: reasonCodeSubjectId }).strict(),
  z.object({ kind: z.literal("contradiction"), subjectId: reasonCodeSubjectId }).strict(),
  z.object({ kind: z.literal("ambiguous"), subjectId: reasonCodeSubjectId }).strict(),
  z.object({ kind: z.literal("parse_failure") }).strict(),
  z.object({ kind: z.literal("possible_duplicate") }).strict(),
  z.object({ kind: z.literal("prompt_injection_flagged") }).strict(),
  z.object({ kind: z.literal("low_confidence") }).strict()
]);

export type ReasonCode = z.infer<typeof ReasonCodeSchema>;

export const MAXIMUM_REASON_CODE_TEXT_LENGTH = 256;

/**
 * Produces the canonical display and storage string for a structural reason
 * code: `kind:subjectId` when parameterized, `kind` otherwise.
 */
export function formatReasonCode(reasonCode: ReasonCode): string {
  return "subjectId" in reasonCode
    ? `${reasonCode.kind}:${reasonCode.subjectId}`
    : reasonCode.kind;
}

/**
 * Parses stored reason-code text back into the closed structural vocabulary.
 * This is the app-level validation the parameterized forms require, since a
 * SQL CHECK cannot enumerate every `missing_evidence:<dimension>` value.
 */
export function parseReasonCode(textInput: unknown): Result<ReasonCode, DomainError> {
  if (
    typeof textInput !== "string" ||
    textInput.length === 0 ||
    textInput.length > MAXIMUM_REASON_CODE_TEXT_LENGTH
  ) {
    return err(createDomainError("invalid_input", "Invalid reason code text"));
  }

  const separatorIndex = textInput.indexOf(":");
  const candidate =
    separatorIndex === -1
      ? { kind: textInput }
      : {
          kind: textInput.slice(0, separatorIndex),
          subjectId: textInput.slice(separatorIndex + 1)
        };

  const parsed = ReasonCodeSchema.safeParse(candidate);
  if (!parsed.success) {
    return err(
      createDomainError("invalid_input", "Reason code is not in the closed vocabulary")
    );
  }
  return ok(parsed.data);
}
