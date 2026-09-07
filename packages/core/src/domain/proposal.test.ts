import { describe, expect, it } from "vitest";

import {
  deriveProposalStatus,
  isScoreBasedProposalKind,
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
  type ReviewDecisionKind
} from "./proposal.js";

describe("proposal vocabulary", () => {
  it("closes status over pending, evidence_requested, approved, rejected, and edited", () => {
    expect(PROPOSAL_STATUSES).toEqual([
      "pending",
      "evidence_requested",
      "approved",
      "rejected",
      "edited"
    ]);
    for (const status of PROPOSAL_STATUSES) {
      expect(ProposalStatusSchema.parse(status)).toBe(status);
    }
    expect(ProposalStatusSchema.safeParse("sent").success).toBe(false);
  });

  it("closes proposal kinds and marks shortlist_inclusion as score-based", () => {
    expect(PROPOSAL_KINDS).toEqual([
      "follow_up_draft",
      "ats_stage_change",
      "shortlist_inclusion",
      "rejection"
    ]);
    expect(SCORE_BASED_PROPOSAL_KINDS).toEqual(["shortlist_inclusion"]);
    expect(isScoreBasedProposalKind("shortlist_inclusion")).toBe(true);
    expect(isScoreBasedProposalKind("rejection")).toBe(false);
    expect(ProposalKindSchema.safeParse("email").success).toBe(false);
  });

  it("derives status from the current decision kind or its absence", () => {
    expect(deriveProposalStatus(null)).toBe("pending");
    expect(deriveProposalStatus("request_evidence")).toBe("evidence_requested");
    expect(deriveProposalStatus("approve")).toBe("approved");
    expect(deriveProposalStatus("reject")).toBe("rejected");
    expect(deriveProposalStatus("edit")).toBe("edited");
  });

  it("covers every closed decision kind in the status projection", () => {
    const seen = new Set<string>();
    for (const kind of REVIEW_DECISION_KINDS) {
      seen.add(deriveProposalStatus(kind as ReviewDecisionKind));
    }
    expect(seen.has("pending")).toBe(false);
    expect(seen.has("evidence_requested")).toBe(true);
    expect(seen.has("approved")).toBe(true);
    expect(seen.has("rejected")).toBe(true);
    expect(seen.has("edited")).toBe(true);
  });
});

describe("proposal and review-decision payloads", () => {
  it("requires a trimmed body for follow_up_draft and a rationale for rejection", () => {
    expect(
      ProposalPayloadSchema.parse({
        kind: "follow_up_draft",
        body: " Please send a work-authorization document. "
      })
    ).toEqual({
      kind: "follow_up_draft",
      body: "Please send a work-authorization document."
    });
    expect(
      ProposalPayloadSchema.parse({
        kind: "follow_up_draft",
        body: "Need years of experience.",
        evidenceGapId: "evidence-gap-1"
      })
    ).toEqual({
      kind: "follow_up_draft",
      body: "Need years of experience.",
      evidenceGapId: "evidence-gap-1"
    });
    expect(ProposalPayloadSchema.parse({ kind: "shortlist_inclusion" })).toEqual({
      kind: "shortlist_inclusion"
    });
    expect(
      ProposalPayloadSchema.parse({
        kind: "ats_stage_change",
        targetStage: " interview "
      })
    ).toEqual({ kind: "ats_stage_change", targetStage: "interview" });
    expect(
      ProposalPayloadSchema.safeParse({ kind: "rejection" }).success
    ).toBe(false);
    expect(
      ProposalPayloadSchema.parse({
        kind: "rejection",
        rationale: " Failed the work-authorization requirement. "
      })
    ).toEqual({
      kind: "rejection",
      rationale: "Failed the work-authorization requirement."
    });
    expect(
      ProposalPayloadSchema.safeParse({
        kind: "follow_up_draft",
        body: "a".repeat(MAXIMUM_PROPOSAL_BODY_LENGTH + 1)
      }).success
    ).toBe(false);
    expect(
      ProposalPayloadSchema.safeParse({
        kind: "ats_stage_change",
        targetStage: "a".repeat(MAXIMUM_ATS_STAGE_LENGTH + 1)
      }).success
    ).toBe(false);
  });

  it("requires a rationale for reject and request_evidence, and keeps the original payload shape on edit", () => {
    expect(ReviewDecisionKindSchema.parse("approve")).toBe("approve");
    expect(ReviewDecisionPayloadSchema.parse({ kind: "approve" })).toEqual({
      kind: "approve"
    });
    expect(
      ReviewDecisionPayloadSchema.safeParse({ kind: "reject" }).success
    ).toBe(false);
    expect(
      ReviewDecisionPayloadSchema.parse({
        kind: "reject",
        rationale: " Duplicate of another shortlist candidate. "
      })
    ).toEqual({
      kind: "reject",
      rationale: "Duplicate of another shortlist candidate."
    });
    expect(
      ReviewDecisionPayloadSchema.parse({
        kind: "request_evidence",
        rationale: "Need the missing work-authorization document."
      }).kind
    ).toBe("request_evidence");
    expect(
      ReviewDecisionPayloadSchema.parse({
        kind: "edit",
        editedPayload: {
          kind: "follow_up_draft",
          body: "Please send a work-authorization document by Friday."
        }
      })
    ).toEqual({
      kind: "edit",
      editedPayload: {
        kind: "follow_up_draft",
        body: "Please send a work-authorization document by Friday."
      }
    });
    expect(
      ReviewDecisionPayloadSchema.safeParse({
        kind: "edit",
        editedPayload: { kind: "shortlist_inclusion", extra: true }
      }).success
    ).toBe(false);
  });
});
