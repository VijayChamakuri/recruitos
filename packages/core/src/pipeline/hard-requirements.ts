import { z } from "zod";

import { compareCodeUnits } from "../canonical/comparator.js";
import { IsoYearMonthSchema, type IsoYearMonth } from "../domain/dates.js";
import {
  EMPLOYMENT_END_PRESENT,
  HARD_REQUIREMENT_FIELD_IDS,
  HardRequirementFieldIdSchema,
  StructuredFactKindSchema,
  WorkAuthorizationClassificationSchema,
  type HardRequirementFieldId,
  type HardRequirementOutcome,
  type StructuredFactKind
} from "../domain/facts.js";
import { PositiveIntegerSchema } from "../domain/integers.js";
import { createDomainError, type DomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";
import type { ConsolidatedFact, FactConsolidation } from "./consolidate-facts.js";

/**
 * The executable v1 predicates. Declarative rather than callable so the whole
 * requirement policy is data: it hashes into the run input snapshot, renders in
 * the Trust Center, and cannot smuggle behaviour past a recorded decision.
 *
 * Each predicate reads exactly one fact kind. That is what makes the plan's
 * three-valued rule mechanical: absence of that kind is `unknown`, a conflict
 * on that kind is `unknown`, and only a conclusive grounded violation is
 * `fail`.
 */
export const HardRequirementPredicateSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("minimum_experience_months"), months: PositiveIntegerSchema })
    .strict(),
  z
    .object({
      kind: z.literal("work_authorization_in"),
      allowed: z.array(WorkAuthorizationClassificationSchema).min(1)
    })
    .strict(),
  z.object({ kind: z.literal("fact_present"), factKind: StructuredFactKindSchema }).strict()
]);

export type HardRequirementPredicate = z.infer<typeof HardRequirementPredicateSchema>;

export const HardRequirementSchema = z
  .object({
    requirementId: HardRequirementFieldIdSchema,
    predicate: HardRequirementPredicateSchema
  })
  .strict();

export type HardRequirement = z.infer<typeof HardRequirementSchema>;

/**
 * The requirement policy plus the determinism context it needs. `asOfMonth` is
 * the corpus's frozen snapshot month: `present` resolves against it rather than
 * against a clock, so reruns are stable.
 *
 * The policy travels beside the rubric rather than inside it because rubric v1
 * is still draft. At rubric lock it becomes part of the rubric snapshot; until
 * then callers pass it, and nothing here waits on the lock.
 */
export const HardRequirementPolicySchema = z
  .object({
    asOfMonth: IsoYearMonthSchema,
    requirements: z.array(HardRequirementSchema).min(1).max(HARD_REQUIREMENT_FIELD_IDS.length)
  })
  .strict();

export type HardRequirementPolicy = z.infer<typeof HardRequirementPolicySchema>;

/** Why an outcome came out the way it did, for the packet to render. */
export const HARD_REQUIREMENT_REASONS = [
  "satisfied",
  "violated",
  "absent",
  "conflicted",
  "ambiguous"
] as const;

export const HardRequirementReasonSchema = z.enum(HARD_REQUIREMENT_REASONS);
export type HardRequirementReason = z.infer<typeof HardRequirementReasonSchema>;

export type HardRequirementAssessment = Readonly<{
  requirementId: HardRequirementFieldId;
  outcome: HardRequirementOutcome;
  reason: HardRequirementReason;
  factKind: StructuredFactKind;
  supportingFactKeys: readonly string[];
  contradictingFactKeys: readonly string[];
}>;

export type HardRequirementResolution = Readonly<{
  assessments: readonly HardRequirementAssessment[];
  rejected: boolean;
  unknownCount: number;
  derivedTenureMonths: number;
}>;

const MONTHS_PER_YEAR = 12;

function invalidInput(message: string): DomainError {
  return createDomainError("invalid_input", message);
}

function monthIndex(value: IsoYearMonth): number {
  return Number(value.slice(0, 4)) * MONTHS_PER_YEAR + Number(value.slice(5, 7)) - 1;
}

/**
 * Total months of employment across the grounded employment intervals, as a
 * union of half-open month ranges. An explicit ending month is inclusive and
 * becomes the following exclusive month; `present` resolves to the frozen
 * snapshot month, also inclusive. Overlapping and adjacent ranges merge, so
 * concurrent work is counted once and never summed.
 */
export function deriveTenureMonths(
  facts: readonly ConsolidatedFact[],
  asOfMonth: IsoYearMonth
): number {
  const asOfIndex = monthIndex(asOfMonth);
  const ranges: { start: number; endExclusive: number }[] = [];
  for (const fact of facts) {
    if (fact.payload.kind !== "employment_interval") {
      continue;
    }
    const start = monthIndex(fact.payload.startMonth);
    const endExclusive =
      fact.payload.endMonth === EMPLOYMENT_END_PRESENT
        ? asOfIndex + 1
        : monthIndex(fact.payload.endMonth) + 1;
    if (endExclusive > start) {
      ranges.push({ start, endExclusive });
    }
  }

  ranges.sort((left, right) => left.start - right.start);
  let months = 0;
  let cursor = -1;
  for (const range of ranges) {
    const start = range.start > cursor ? range.start : cursor;
    if (range.endExclusive > start) {
      months += range.endExclusive - start;
      cursor = range.endExclusive;
    }
  }
  return months;
}

function factsOfKind(
  facts: readonly ConsolidatedFact[],
  kind: StructuredFactKind
): readonly ConsolidatedFact[] {
  return facts.filter((fact) => fact.payload.kind === kind);
}

function sortedKeys(facts: readonly ConsolidatedFact[]): readonly string[] {
  return Object.freeze(facts.map((fact) => fact.factKey).sort(compareCodeUnits));
}

function predicateFactKind(predicate: HardRequirementPredicate): StructuredFactKind {
  switch (predicate.kind) {
    case "minimum_experience_months":
      return "employment_interval";
    case "work_authorization_in":
      return "work_authorization_statement";
    case "fact_present":
      return predicate.factKind;
  }
}

type Verdict = Readonly<{
  outcome: HardRequirementOutcome;
  reason: HardRequirementReason;
  supporting: readonly ConsolidatedFact[];
  contradicting: readonly ConsolidatedFact[];
}>;

function unknown(reason: HardRequirementReason): Verdict {
  return { outcome: "unknown", reason, supporting: [], contradicting: [] };
}

function evaluateExperience(
  months: number,
  relevant: readonly ConsolidatedFact[],
  derivedMonths: number
): Verdict {
  return derivedMonths >= months
    ? { outcome: "pass", reason: "satisfied", supporting: relevant, contradicting: [] }
    : { outcome: "fail", reason: "violated", supporting: [], contradicting: relevant };
}

/**
 * The classifications every grounded authorization statement asserts, in fact
 * order. Read in one pass over the whole fact set so the caller never has to
 * re-narrow a filtered list.
 */
function workAuthorizationClassifications(facts: readonly ConsolidatedFact[]): readonly string[] {
  const classifications: string[] = [];
  for (const fact of facts) {
    if (fact.payload.kind === "work_authorization_statement") {
      classifications.push(fact.payload.classification);
    }
  }
  return classifications;
}

function evaluateWorkAuthorization(
  allowed: readonly string[],
  relevant: readonly ConsolidatedFact[],
  classifications: readonly string[]
): Verdict {
  const satisfying = classifications.filter((classification) => allowed.includes(classification));
  if (satisfying.length === classifications.length) {
    return { outcome: "pass", reason: "satisfied", supporting: relevant, contradicting: [] };
  }
  if (satisfying.length === 0) {
    return { outcome: "fail", reason: "violated", supporting: [], contradicting: relevant };
  }
  return unknown("ambiguous");
}

type FactContext = Readonly<{
  derivedTenureMonths: number;
  classifications: readonly string[];
}>;

function evaluate(
  predicate: HardRequirementPredicate,
  relevant: readonly ConsolidatedFact[],
  context: FactContext
): Verdict {
  switch (predicate.kind) {
    case "minimum_experience_months":
      return evaluateExperience(predicate.months, relevant, context.derivedTenureMonths);
    case "work_authorization_in":
      return evaluateWorkAuthorization(predicate.allowed, relevant, context.classifications);
    // Presence is the whole predicate: the fact is there, so the requirement is
    // satisfied. Absence is handled before evaluation and resolves `unknown`,
    // which is why a missing field escalates and never rejects.
    case "fact_present":
      return { outcome: "pass", reason: "satisfied", supporting: relevant, contradicting: [] };
  }
}

/**
 * Resolves every committed hard requirement to `pass`, `fail`, or `unknown`
 * over the consolidated facts.
 *
 * `pass` requires conclusive grounded satisfaction and lists the facts that
 * gave it. `fail` requires a conclusive grounded violation and lists the facts
 * that caused it; it is the only outcome that rejects a candidate. Everything
 * else is `unknown`: absence of any fact of the kind the predicate reads, a
 * visible conflict on that kind, or an inconclusive predicate. `unknown` never
 * rejects, it escalates, and its count is the `requiredFieldsMissing` numerator
 * the confidence formula consumes.
 *
 * The consolidation is a core value produced by `consolidateStructuredFacts`,
 * so it arrives typed rather than as an unvalidated boundary input, the same
 * way the scoring functions take a validated `Rubric`.
 */
export function resolveHardRequirements(
  consolidation: FactConsolidation,
  policyInput: unknown
): Result<HardRequirementResolution, DomainError> {
  const parsed = HardRequirementPolicySchema.safeParse(policyInput);
  if (!parsed.success) {
    return err(invalidInput("Invalid hard requirement policy"));
  }

  const byRequirement = new Map<string, HardRequirement>();
  for (const requirement of parsed.data.requirements) {
    if (byRequirement.has(requirement.requirementId)) {
      return err(invalidInput("Duplicate hard requirement"));
    }
    byRequirement.set(requirement.requirementId, requirement);
  }

  const conflictedKinds = new Set(consolidation.conflicts.map((conflict) => conflict.kind));
  const derivedTenureMonths = deriveTenureMonths(consolidation.facts, parsed.data.asOfMonth);
  const context: FactContext = {
    derivedTenureMonths,
    classifications: workAuthorizationClassifications(consolidation.facts)
  };

  const assessments: HardRequirementAssessment[] = [];
  let rejected = false;
  let unknownCount = 0;
  for (const requirementId of HARD_REQUIREMENT_FIELD_IDS) {
    const requirement = byRequirement.get(requirementId);
    if (requirement === undefined) {
      return err(invalidInput("The policy must cover every committed hard requirement once"));
    }
    const factKind = predicateFactKind(requirement.predicate);
    const relevant = factsOfKind(consolidation.facts, factKind);
    const verdict =
      relevant.length === 0
        ? unknown("absent")
        : conflictedKinds.has(factKind)
          ? unknown("conflicted")
          : evaluate(requirement.predicate, relevant, context);

    rejected = rejected || verdict.outcome === "fail";
    unknownCount += verdict.outcome === "unknown" ? 1 : 0;
    assessments.push(
      Object.freeze({
        requirementId,
        outcome: verdict.outcome,
        reason: verdict.reason,
        factKind,
        supportingFactKeys: sortedKeys(verdict.supporting),
        contradictingFactKeys: sortedKeys(verdict.contradicting)
      })
    );
  }

  return ok(
    Object.freeze({
      assessments: Object.freeze(assessments),
      rejected,
      unknownCount,
      derivedTenureMonths
    })
  );
}
