import { z } from "zod";

export const CANDIDATE_TRIAGE_STATUSES = [
  "scored",
  "rejected_hard_requirement",
  "escalated"
] as const;

export const CandidateTriageStatusSchema = z.enum(CANDIDATE_TRIAGE_STATUSES);
export type CandidateTriageStatus = z.infer<typeof CandidateTriageStatusSchema>;
