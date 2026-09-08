import {
  canonicalJsonSha256,
  HARD_REQUIREMENT_FIELD_IDS,
  HardRequirementPolicySchema,
  HardRequirementSchema,
  IsoYearMonthSchema,
  PositiveIntegerSchema,
  WorkAuthorizationClassificationSchema,
  type HardRequirement,
  type HardRequirementPolicy,
  type IsoYearMonth,
  type Result,
  type Sha256Hex,
  type WorkAuthorizationClassification
} from "@recruitos/core";
import { z } from "zod";

import { createRuntimeError, type RuntimeError } from "../errors/index.js";

/**
 * Hard requirement policy v1.
 *
 * Implements the product owner decisions recorded in OQ-7 from the signed
 * RubricAssumptionRecord:
 * 1. Work authorization: hard requirement resolved only from candidate application
 *    answers, never document prose. When no answer exists, it resolves to unknown
 *    and never rejects.
 * 2. Years of experience: hard requirement with a floor of 24 months, derived
 *    via deriveTenureMonths over employment intervals.
 * 3. Location: conservative handling. The committed core schema (HARD_REQUIREMENT_FIELD_IDS)
 *    tracks years_experience, work_authorization, current_title, and employer_history.
 *    Any location evaluation remains non-rejecting.
 */

export const DEFAULT_MINIMUM_EXPERIENCE_MONTHS = PositiveIntegerSchema.parse(24);

export const DEFAULT_ALLOWED_WORK_AUTHORIZATIONS = Object.freeze([
  "authorized"
] as const satisfies readonly WorkAuthorizationClassification[]);

export const CreateHardRequirementPolicyV1OptionsSchema = z
  .object({
    minimumExperienceMonths: PositiveIntegerSchema.min(24, {
      message: "Minimum experience months must be at least 24 per OQ-7"
    }).optional(),
    allowedWorkAuthorizations: z
      .array(WorkAuthorizationClassificationSchema)
      .min(1)
      .optional()
  })
  .strict();

export type CreateHardRequirementPolicyV1Options = z.infer<
  typeof CreateHardRequirementPolicyV1OptionsSchema
>;

function policyFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

/**
 * Creates the declarative v1 hard requirement policy covering all four committed
 * hard requirements.
 */
export function createHardRequirementPolicyV1(
  asOfMonthInput: unknown,
  optionsInput?: unknown
): Result<HardRequirementPolicy, RuntimeError> {
  const asOfMonth = IsoYearMonthSchema.safeParse(asOfMonthInput);
  if (!asOfMonth.success) {
    return { ok: false, error: policyFailure("Invalid asOfMonth year-month format") };
  }

  const options =
    optionsInput === undefined
      ? { minimumExperienceMonths: DEFAULT_MINIMUM_EXPERIENCE_MONTHS, allowedWorkAuthorizations: DEFAULT_ALLOWED_WORK_AUTHORIZATIONS }
      : CreateHardRequirementPolicyV1OptionsSchema.safeParse(optionsInput);

  if ("success" in options && !options.success) {
    return {
      ok: false,
      error: policyFailure(options.error.issues[0]!.message)
    };
  }

  const optionsData = "data" in options ? options.data : options;
  const rawMonths = optionsData.minimumExperienceMonths ?? DEFAULT_MINIMUM_EXPERIENCE_MONTHS;
  const months = PositiveIntegerSchema.parse(rawMonths);
  const allowedWorkAuthorizations =
    optionsData.allowedWorkAuthorizations ?? DEFAULT_ALLOWED_WORK_AUTHORIZATIONS;

  const yearsReq = HardRequirementSchema.parse({
    requirementId: "years_experience",
    predicate: {
      kind: "minimum_experience_months",
      months
    }
  });

  const workAuthReq = HardRequirementSchema.parse({
    requirementId: "work_authorization",
    predicate: {
      kind: "work_authorization_in",
      allowed: [...allowedWorkAuthorizations]
    }
  });

  const titleReq = HardRequirementSchema.parse({
    requirementId: "current_title",
    predicate: {
      kind: "fact_present",
      factKind: "current_title"
    }
  });

  const employerReq = HardRequirementSchema.parse({
    requirementId: "employer_history",
    predicate: {
      kind: "fact_present",
      factKind: "employer_history_entry"
    }
  });

  const rawPolicy = {
    asOfMonth: asOfMonth.data,
    requirements: [yearsReq, workAuthReq, titleReq, employerReq]
  };

  const parsed = HardRequirementPolicySchema.safeParse(rawPolicy);
  /* v8 ignore next 3 */
  if (!parsed.success) {
    return { ok: false, error: policyFailure("Constructed policy does not match schema") };
  }

  return { ok: true, value: Object.freeze(parsed.data) };
}

/**
 * Deterministically computes the SHA-256 hash of a HardRequirementPolicy
 * for run input snapshots and seals.
 */
export function hashHardRequirementPolicy(
  policy: HardRequirementPolicy
): Result<Sha256Hex, RuntimeError> {
  const hashResult = canonicalJsonSha256(policy);
  if (!hashResult.ok) {
    return {
      ok: false,
      error: policyFailure(`Failed to hash hard requirement policy: ${hashResult.error.message}`)
    };
  }
  return { ok: true, value: hashResult.value };
}
