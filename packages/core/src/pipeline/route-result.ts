import { z } from "zod";

import { compareCodeUnits } from "../canonical/comparator.js";
import { compareRationals, type Rational } from "../canonical/rational.js";
import {
  formatReasonCode,
  reasonCodePrecedence,
  ReasonCodeSchema,
  type ReasonCode
} from "../domain/reason-code.js";
import type { CandidateTriageStatus, DecisionAvailability } from "../domain/status.js";
import { createDomainError, type DomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";
import type { Rubric } from "../rubric/rubric.js";
import { T_ESCALATE } from "../scoring/constants.js";
import type { DimensionAssessmentDerivation } from "./assess-dimensions.js";
import type { FactConsolidation } from "./consolidate-facts.js";
import type { HardRequirementResolution } from "./hard-requirements.js";

/**
 * Committed routing thresholds. `escalateThreshold` is the confidence cutoff
 * below which a candidate escalates on `low_confidence` alone;
 * `tenureContradictionMonths` is how far a claim may exceed date-derived tenure
 * before it is a structural contradiction. Both travel with the rubric snapshot
 * once rubric v1 locks, and are parameters until then.
 */
export type RoutingPolicy = Readonly<{
  escalateThreshold: Rational;
  tenureContradictionMonths: number;
}>;

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = Object.freeze({
  escalateThreshold: T_ESCALATE,
  tenureContradictionMonths: 12
});

/**
 * Signals the pure pipeline cannot derive from its own inputs: the parser's
 * verdict on required sections, corpus-level near-duplicate detection, the
 * committed prompt-injection heuristic, and any ambiguity a caller has already
 * named, such as `seniority`. Passing them explicitly keeps this function pure
 * and keeps the heuristics reviewable where they are computed.
 */
export const RoutingSignalsSchema = z
  .object({
    parseFailure: z.boolean(),
    possibleDuplicate: z.boolean(),
    promptInjectionFlagged: z.boolean(),
    ambiguousSubjectIds: z.array(z.string().min(1).max(128)).max(16)
  })
  .strict();

export type RoutingSignals = z.infer<typeof RoutingSignalsSchema>;

export type RoutingInput = Readonly<{
  consolidation: FactConsolidation;
  derivation: DimensionAssessmentDerivation;
  requirements: HardRequirementResolution;
  confidence: Rational | null;
}>;

export type CandidateRouting = Readonly<{
  status: CandidateTriageStatus;
  availability: DecisionAvailability;
  reasons: readonly ReasonCode[];
}>;

function invalidInput(message: string): DomainError {
  return createDomainError("invalid_input", message);
}

function highestClaimedMonths(consolidation: FactConsolidation): number {
  let highest = 0;
  for (const fact of consolidation.facts) {
    if (fact.payload.kind === "claimed_experience" && fact.payload.claimedMonths > highest) {
      highest = fact.payload.claimedMonths;
    }
  }
  return highest;
}

function compareReasonCodes(left: ReasonCode, right: ReasonCode): number {
  const byPrecedence = reasonCodePrecedence(left.kind) - reasonCodePrecedence(right.kind);
  if (byPrecedence !== 0) {
    return byPrecedence;
  }
  return compareCodeUnits(formatReasonCode(left), formatReasonCode(right));
}

/**
 * Derives status and the ordered routing reasons for one candidate result.
 *
 * Status resolves by the committed precedence `rejected_hard_requirement >
 * escalated > scored`, and every matched predicate contributes its own reason
 * regardless of which one set the status, so the routing outcome is
 * deterministic rather than order dependent. Each reason opens exactly one
 * resolution task, which is what makes P5's promise hold: no candidate
 * escalates without a named reason.
 *
 * `low_confidence` fires only when no other predicate matched, which is what
 * keeps it meaningful as the threshold-only remainder. An unavailable result
 * carries `assessment_unavailable`, has no headline confidence, and is
 * escalated rather than scored.
 */
export function routeCandidateResult(
  input: RoutingInput,
  rubric: Rubric,
  signalsInput: unknown,
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY
): Result<CandidateRouting, DomainError> {
  const signals = RoutingSignalsSchema.safeParse(signalsInput);
  if (!signals.success) {
    return err(invalidInput("Invalid routing signals"));
  }

  const unavailable = input.derivation.availability === "unavailable";
  if (unavailable !== (input.confidence === null)) {
    return err(
      invalidInput("An unavailable result carries no confidence and an available result must")
    );
  }

  const requiredDimensionIds = new Set<string>(
    rubric.dimensions
      .filter((dimension) => dimension.required)
      .map((dimension) => dimension.dimensionId)
  );

  const candidates: ReasonCode[] = [];
  if (unavailable) {
    candidates.push({ kind: "assessment_unavailable" });
  }

  const locatedSpanCount = input.derivation.assessments.reduce(
    (total, assessment) =>
      total + assessment.supportingSpanIds.length + assessment.contradictingSpanIds.length,
    0
  );
  if (signals.data.parseFailure || locatedSpanCount === 0) {
    candidates.push({ kind: "parse_failure" });
  }
  if (signals.data.promptInjectionFlagged) {
    candidates.push({ kind: "prompt_injection_flagged" });
  }
  if (signals.data.possibleDuplicate) {
    candidates.push({ kind: "possible_duplicate" });
  }

  const claimedMonths = highestClaimedMonths(input.consolidation);
  if (
    claimedMonths - input.requirements.derivedTenureMonths >
    policy.tenureContradictionMonths
  ) {
    candidates.push({ kind: "contradiction", subjectId: "tenure_vs_claim" });
  }

  for (const gap of input.derivation.gaps) {
    if (requiredDimensionIds.has(gap.dimensionId)) {
      candidates.push({ kind: "missing_evidence", subjectId: gap.dimensionId });
    }
  }
  for (const assessment of input.requirements.assessments) {
    if (assessment.outcome === "unknown") {
      candidates.push({ kind: "missing_evidence", subjectId: assessment.requirementId });
    }
  }
  for (const assessment of input.derivation.assessments) {
    if (assessment.levelDisagreement) {
      candidates.push({ kind: "ambiguous", subjectId: assessment.dimensionId });
    }
  }
  for (const subjectId of signals.data.ambiguousSubjectIds) {
    candidates.push({ kind: "ambiguous", subjectId });
  }

  const reasons: ReasonCode[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const parsed = ReasonCodeSchema.safeParse(candidate);
    if (!parsed.success) {
      return err(invalidInput("Routing produced a reason outside the closed vocabulary"));
    }
    const formatted = formatReasonCode(parsed.data);
    if (seen.has(formatted)) {
      continue;
    }
    seen.add(formatted);
    reasons.push(parsed.data);
  }

  if (
    reasons.length === 0 &&
    input.confidence !== null &&
    compareRationals(input.confidence, policy.escalateThreshold) < 0
  ) {
    reasons.push({ kind: "low_confidence" });
  }
  reasons.sort(compareReasonCodes);

  const status: CandidateTriageStatus = input.requirements.rejected
    ? "rejected_hard_requirement"
    : reasons.length > 0
      ? "escalated"
      : "scored";

  return ok(
    Object.freeze({
      status,
      availability: unavailable ? "unavailable" : "complete",
      reasons: Object.freeze(reasons)
    })
  );
}
