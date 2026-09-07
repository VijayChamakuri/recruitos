import { z } from "zod";

export const CANDIDATE_TRIAGE_STATUSES = [
  "scored",
  "rejected_hard_requirement",
  "escalated"
] as const;

export const CandidateTriageStatusSchema = z.enum(CANDIDATE_TRIAGE_STATUSES);
export type CandidateTriageStatus = z.infer<typeof CandidateTriageStatusSchema>;

/**
 * Whether a stored result has a complete six-dimension score. Unavailable
 * results have no score, stay escalated, and never enter shortlist math.
 */
export const DECISION_AVAILABILITIES = ["complete", "unavailable"] as const;

export const DecisionAvailabilitySchema = z.enum(DECISION_AVAILABILITIES);
export type DecisionAvailability = z.infer<typeof DecisionAvailabilitySchema>;

/**
 * Official-run membership is initial. Corrections supersede a prior result
 * without creating a new run or moving original membership.
 */
export const CANDIDATE_RESULT_KINDS = ["initial", "correction"] as const;

export const CandidateResultKindSchema = z.enum(CANDIDATE_RESULT_KINDS);
export type CandidateResultKind = z.infer<typeof CandidateResultKindSchema>;
