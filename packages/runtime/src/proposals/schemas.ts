import {
  ActorIdSchema,
  CandidateTriageResultIdSchema,
  EvidenceSpanIdSchema,
  NonnegativeIntegerSchema,
  PositiveIntegerSchema,
  ProposalEvidenceSpanIdSchema,
  ProposalIdSchema,
  ProposalKindSchema,
  ProposalPayloadSchema,
  ReviewDecisionIdSchema,
  ReviewDecisionKindSchema,
  ReviewDecisionPayloadSchema,
  Sha256HexSchema
} from "@recruitos/core";
import { z } from "zod";

export {
  MAXIMUM_ATS_STAGE_LENGTH,
  MAXIMUM_PROPOSAL_BODY_LENGTH,
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  ProposalKindSchema,
  ProposalPayloadSchema,
  ProposalStatusSchema,
  REVIEW_DECISION_KINDS,
  ReviewDecisionKindSchema,
  ReviewDecisionPayloadSchema,
  SCORE_BASED_PROPOSAL_KINDS,
  deriveProposalStatus,
  isScoreBasedProposalKind
} from "@recruitos/core";

export const ProposalEvidenceSpanDraftSchema = z
  .object({
    proposalEvidenceSpanId: ProposalEvidenceSpanIdSchema,
    evidenceSpanId: EvidenceSpanIdSchema
  })
  .strict();
export type ProposalEvidenceSpanDraft = z.infer<typeof ProposalEvidenceSpanDraftSchema>;

export const ProposalEvidenceSpanSchema = z
  .object({
    proposalEvidenceSpanId: ProposalEvidenceSpanIdSchema,
    evidenceSpanId: EvidenceSpanIdSchema,
    spanOrdinal: NonnegativeIntegerSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type ProposalEvidenceSpan = z.infer<typeof ProposalEvidenceSpanSchema>;

export const ProposalDraftSchema = z
  .object({
    proposalId: ProposalIdSchema,
    candidateResultId: CandidateTriageResultIdSchema,
    proposalOrdinal: NonnegativeIntegerSchema,
    payload: ProposalPayloadSchema,
    evidenceSpans: z.array(ProposalEvidenceSpanDraftSchema).default([]),
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type ProposalDraft = z.infer<typeof ProposalDraftSchema>;

export const ProposalSchema = z
  .object({
    proposalId: ProposalIdSchema,
    candidateResultId: CandidateTriageResultIdSchema,
    proposalKind: ProposalKindSchema,
    proposalOrdinal: NonnegativeIntegerSchema,
    payload: ProposalPayloadSchema,
    payloadJson: z.string().min(2),
    payloadHash: Sha256HexSchema,
    evidenceSpans: z.array(ProposalEvidenceSpanSchema),
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type Proposal = z.infer<typeof ProposalSchema>;

export const ReviewDecisionDraftSchema = z
  .object({
    reviewDecisionId: ReviewDecisionIdSchema,
    proposalId: ProposalIdSchema,
    actorId: ActorIdSchema,
    decisionOrdinal: NonnegativeIntegerSchema,
    payload: ReviewDecisionPayloadSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type ReviewDecisionDraft = z.infer<typeof ReviewDecisionDraftSchema>;

export const ReviewDecisionSchema = z
  .object({
    reviewDecisionId: ReviewDecisionIdSchema,
    proposalId: ProposalIdSchema,
    actorId: ActorIdSchema,
    decisionKind: ReviewDecisionKindSchema,
    decisionOrdinal: NonnegativeIntegerSchema,
    payload: ReviewDecisionPayloadSchema,
    payloadJson: z.string().min(2),
    payloadHash: Sha256HexSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export const ProposalHeadSchema = z
  .object({
    proposalId: ProposalIdSchema,
    currentDecisionId: ReviewDecisionIdSchema,
    version: PositiveIntegerSchema
  })
  .strict();
export type ProposalHead = z.infer<typeof ProposalHeadSchema>;
