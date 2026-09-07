import { z } from "zod";

import { EvidenceGapIdSchema, EvidenceSpanIdSchema } from "./ids.js";

/**
 * Derived proposal status. The proposal row is immutable and has no status
 * column. Status is a function of the current `proposal_head` pointer: no
 * decision means still pending, `request_evidence` waits on the recruiter,
 * and approve, edit, and reject close the review.
 */
export const PROPOSAL_STATUSES = [
  "pending",
  "evidence_requested",
  "approved",
  "rejected",
  "edited"
] as const;

export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const PROPOSAL_KINDS = [
  "follow_up_draft",
  "ats_stage_change",
  "shortlist_inclusion",
  "rejection"
] as const;

export const ProposalKindSchema = z.enum(PROPOSAL_KINDS);
export type ProposalKind = z.infer<typeof ProposalKindSchema>;

/** Score-based kinds are forbidden on unavailable results. */
export const SCORE_BASED_PROPOSAL_KINDS = ["shortlist_inclusion"] as const;

export const REVIEW_DECISION_KINDS = [
  "approve",
  "edit",
  "reject",
  "request_evidence"
] as const;

export const ReviewDecisionKindSchema = z.enum(REVIEW_DECISION_KINDS);
export type ReviewDecisionKind = z.infer<typeof ReviewDecisionKindSchema>;

export const MAXIMUM_PROPOSAL_BODY_LENGTH = 2000;
export const MAXIMUM_ATS_STAGE_LENGTH = 64;

const rationale = z.string().trim().min(1).max(MAXIMUM_PROPOSAL_BODY_LENGTH);
const body = z.string().trim().min(1).max(MAXIMUM_PROPOSAL_BODY_LENGTH);
const targetStage = z.string().trim().min(1).max(MAXIMUM_ATS_STAGE_LENGTH);

export const ProposalPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("follow_up_draft"),
      body,
      evidenceGapId: EvidenceGapIdSchema.optional()
    })
    .strict(),
  z.object({ kind: z.literal("ats_stage_change"), targetStage }).strict(),
  z.object({ kind: z.literal("shortlist_inclusion") }).strict(),
  z.object({ kind: z.literal("rejection"), rationale }).strict()
]);

export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>;

export const ReviewDecisionPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve") }).strict(),
  z
    .object({
      kind: z.literal("edit"),
      editedPayload: ProposalPayloadSchema
    })
    .strict(),
  z.object({ kind: z.literal("reject"), rationale }).strict(),
  z.object({ kind: z.literal("request_evidence"), rationale }).strict()
]);

export type ReviewDecisionPayload = z.infer<typeof ReviewDecisionPayloadSchema>;

export function isScoreBasedProposalKind(kind: ProposalKind): boolean {
  return (SCORE_BASED_PROPOSAL_KINDS as readonly string[]).includes(kind);
}

/**
 * Projects proposal status from the current review decision, or `pending` when
 * the head has not been initialized.
 */
export function deriveProposalStatus(
  currentDecisionKind: ReviewDecisionKind | null
): ProposalStatus {
  if (currentDecisionKind === null) {
    return "pending";
  }
  switch (currentDecisionKind) {
    case "approve":
      return "approved";
    case "reject":
      return "rejected";
    case "edit":
      return "edited";
    case "request_evidence":
      return "evidence_requested";
  }
}
