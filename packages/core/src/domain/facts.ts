import { z } from "zod";

import { IsoYearMonthSchema, type IsoYearMonth } from "./dates.js";

/**
 * V1 closed fact kinds. These are the only grounded claims the packet can
 * name, and they are the only inputs hard-requirement predicates may read.
 */
export const STRUCTURED_FACT_KINDS = [
  "employment_interval",
  "work_authorization_statement",
  "current_title",
  "employer_history_entry",
  "claimed_experience"
] as const;

export const StructuredFactKindSchema = z.enum(STRUCTURED_FACT_KINDS);
export type StructuredFactKind = z.infer<typeof StructuredFactKindSchema>;

/**
 * Closed required-field identifiers. Kept here rather than imported from
 * scoring so domain vocabulary does not depend on the scoring engine. A
 * dedicated test pins this list to `REQUIRED_FIELD_IDS`.
 */
export const HARD_REQUIREMENT_FIELD_IDS = [
  "years_experience",
  "work_authorization",
  "current_title",
  "employer_history"
] as const;

export const HardRequirementFieldIdSchema = z.enum(HARD_REQUIREMENT_FIELD_IDS);
export type HardRequirementFieldId = z.infer<typeof HardRequirementFieldIdSchema>;

export const HARD_REQUIREMENT_OUTCOMES = ["pass", "fail", "unknown"] as const;

export const HardRequirementOutcomeSchema = z.enum(HARD_REQUIREMENT_OUTCOMES);
export type HardRequirementOutcome = z.infer<typeof HardRequirementOutcomeSchema>;

/**
 * How a fact was proposed before consolidation. Parser output, extractor
 * output, and human edits remain visible; none silently override another.
 */
export const FACT_PROVENANCE_SOURCES = ["parsed", "extracted", "human"] as const;

export const FactProvenanceSourceSchema = z.enum(FACT_PROVENANCE_SOURCES);
export type FactProvenanceSource = z.infer<typeof FactProvenanceSourceSchema>;

export const WORK_AUTHORIZATION_CLASSIFICATIONS = [
  "authorized",
  "requires_sponsorship",
  "not_authorized"
] as const;

export const WorkAuthorizationClassificationSchema = z.enum(
  WORK_AUTHORIZATION_CLASSIFICATIONS
);
export type WorkAuthorizationClassification = z.infer<
  typeof WorkAuthorizationClassificationSchema
>;

export const EMPLOYMENT_END_PRESENT = "present";

export const EmploymentEndSchema = z.union([
  IsoYearMonthSchema,
  z.literal(EMPLOYMENT_END_PRESENT)
]);
export type EmploymentEnd = z.infer<typeof EmploymentEndSchema>;

const MAXIMUM_EMPLOYER_LENGTH = 200;
const MAXIMUM_TITLE_LENGTH = 200;
const MAXIMUM_AUTHORIZATION_STATEMENT_LENGTH = 500;
export const MAXIMUM_CLAIMED_MONTHS = 720;

const employer = z.string().trim().min(1).max(MAXIMUM_EMPLOYER_LENGTH);
const title = z.string().trim().min(1).max(MAXIMUM_TITLE_LENGTH);
const authorizationStatement = z
  .string()
  .trim()
  .min(1)
  .max(MAXIMUM_AUTHORIZATION_STATEMENT_LENGTH);

function yearMonthOrder(value: IsoYearMonth): number {
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7));
}

function employmentRangeIsValid(interval: {
  startMonth: IsoYearMonth;
  endMonth: EmploymentEnd;
}): boolean {
  if (interval.endMonth === EMPLOYMENT_END_PRESENT) {
    return true;
  }
  return yearMonthOrder(interval.startMonth) <= yearMonthOrder(interval.endMonth);
}

export const EmploymentIntervalFactSchema = z
  .object({
    kind: z.literal("employment_interval"),
    employer,
    title,
    startMonth: IsoYearMonthSchema,
    endMonth: EmploymentEndSchema
  })
  .strict();
export type EmploymentIntervalFact = z.infer<typeof EmploymentIntervalFactSchema>;

export const WorkAuthorizationStatementFactSchema = z
  .object({
    kind: z.literal("work_authorization_statement"),
    classification: WorkAuthorizationClassificationSchema,
    statementText: authorizationStatement
  })
  .strict();
export type WorkAuthorizationStatementFact = z.infer<
  typeof WorkAuthorizationStatementFactSchema
>;

export const CurrentTitleFactSchema = z
  .object({
    kind: z.literal("current_title"),
    title
  })
  .strict();
export type CurrentTitleFact = z.infer<typeof CurrentTitleFactSchema>;

export const EmployerHistoryEntryFactSchema = z
  .object({
    kind: z.literal("employer_history_entry"),
    employer,
    startMonth: IsoYearMonthSchema,
    endMonth: EmploymentEndSchema
  })
  .strict();
export type EmployerHistoryEntryFact = z.infer<typeof EmployerHistoryEntryFactSchema>;

export const ClaimedExperienceFactSchema = z
  .object({
    kind: z.literal("claimed_experience"),
    claimedMonths: z.number().int().min(0).max(MAXIMUM_CLAIMED_MONTHS)
  })
  .strict();
export type ClaimedExperienceFact = z.infer<typeof ClaimedExperienceFactSchema>;

export const StructuredFactPayloadSchema = z
  .discriminatedUnion("kind", [
    EmploymentIntervalFactSchema,
    WorkAuthorizationStatementFactSchema,
    CurrentTitleFactSchema,
    EmployerHistoryEntryFactSchema,
    ClaimedExperienceFactSchema
  ])
  .superRefine((payload, context) => {
    if (
      (payload.kind === "employment_interval" || payload.kind === "employer_history_entry") &&
      !employmentRangeIsValid(payload)
    ) {
      context.addIssue({
        code: "custom",
        message: "Employment interval start must not be after the ending month"
      });
    }
  });
export type StructuredFactPayload = z.infer<typeof StructuredFactPayloadSchema>;

const SEMANTIC_KEY_SEPARATOR = "\u001f";

/**
 * Type-specific semantic key used to deduplicate grounded facts. Callers do
 * not supply this; persistence derives it from the payload.
 */
export function structuredFactSemanticKey(payload: StructuredFactPayload): string {
  switch (payload.kind) {
    case "employment_interval":
      return `${payload.employer}${SEMANTIC_KEY_SEPARATOR}${payload.startMonth}`;
    case "work_authorization_statement":
      return payload.classification;
    case "current_title":
      return payload.title;
    case "employer_history_entry":
      return `${payload.employer}${SEMANTIC_KEY_SEPARATOR}${payload.startMonth}`;
    case "claimed_experience":
      return `claimed:${payload.claimedMonths}`;
  }
}
