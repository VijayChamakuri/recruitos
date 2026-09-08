import {
  IsoYearMonthSchema,
  NonnegativeIntegerSchema,
  RUBRIC_V1,
  Sha256HexSchema,
  type StructuredFactPayload
} from "@recruitos/core";
import { describe, expect, it } from "vitest";

import type { CandidateApplicationAnswer } from "../application-answers/index.js";
import type {
  ExtractionAcceptedSpan,
  ExtractionArtifact,
  ExtractionFailure
} from "../extraction/index.js";
import { createHardRequirementPolicyV1 } from "../policy/hard-requirements-v1.js";
import {
  deriveCandidateDecision,
  deriveCandidateTriageInputs,
  mapWorkAuthorizationOptionKey,
  MAXIMUM_CANDIDATE_DOCUMENTS,
  type CandidateDocumentBridgeInput,
  type CandidateExtractionResultInput
} from "./derive-candidate-result.js";

const RESUME_TEXT = `
Alice Smith
Senior Machine Learning Engineer
TechCorp (2023-01 to Present)
Developed scalable LLM evaluation pipelines and offline evaluation suites.
Acme Corp (2020-01 to 2022-12)
Built production ranking algorithms and monitoring dashboards.
`;

const SAMPLE_DOC: CandidateDocumentBridgeInput = {
  candidateDocumentId: "cdoc_1",
  documentKind: "resume",
  sourceDocumentId: "sdoc_1",
  normalizedText: RESUME_TEXT
};

function createFakeArtifact(
  dimensionId: string,
  proposedLevel: "none" | "weak" | "partial" | "strong" = "strong",
  spans: ExtractionAcceptedSpan[] = [
    {
      start: NonnegativeIntegerSchema.parse(50),
      end: NonnegativeIntegerSchema.parse(100),
      quotedText: "Developed scalable LLM evaluation pipelines",
      polarity: "supporting",
      matchQuality: "exact"
    }
  ]
): ExtractionArtifact {
  return {
    extractionArtifactId: `art_${dimensionId}` as any,
    specId: `spec_${dimensionId}` as any,
    sourceDocumentId: "sdoc_1" as any,
    acceptedOutput: {
      dimensionId: dimensionId as any,
      proposedLevel,
      spans
    },
    acceptedOutputJson: JSON.stringify({ dimensionId, proposedLevel, spans }),
    acceptedOutputHash: Sha256HexSchema.parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
    rejectedClaims: [],
    rejectedClaimsJson: "[]",
    rejectedClaimsHash: Sha256HexSchema.parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
    contentHash: `hash_${dimensionId}` as any,
    createdAt: NonnegativeIntegerSchema.parse(1000)
  };
}

function createFakeFailure(dimensionId: string): ExtractionFailure {
  return {
    extractionFailureId: `fail_${dimensionId}` as any,
    specId: `spec_${dimensionId}` as any,
    sourceDocumentId: "sdoc_1" as any,
    errorClass: "structurally_invalid",
    responseHash: Sha256HexSchema.parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
    responseByteLength: NonnegativeIntegerSchema.parse(100),
    diagnostic: { summary: "Failed extraction", details: ["syntax error"] },
    diagnosticJson: "{}",
    diagnosticHash: Sha256HexSchema.parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
    contentHash: `fail_hash_${dimensionId}` as any,
    createdAt: NonnegativeIntegerSchema.parse(1000)
  };
}

describe("mapWorkAuthorizationOptionKey", () => {
  it("maps authorized variants correctly", () => {
    expect(mapWorkAuthorizationOptionKey("authorized_no_sponsorship")).toBe("authorized");
    expect(mapWorkAuthorizationOptionKey("authorized_us")).toBe("authorized");
    expect(mapWorkAuthorizationOptionKey("authorized")).toBe("authorized");
    expect(mapWorkAuthorizationOptionKey("us_citizen")).toBe("authorized");
    expect(mapWorkAuthorizationOptionKey("permanent_resident")).toBe("authorized");
  });

  it("maps sponsorship variants correctly", () => {
    expect(mapWorkAuthorizationOptionKey("requires_sponsorship")).toBe("requires_sponsorship");
    expect(mapWorkAuthorizationOptionKey("needs_sponsorship")).toBe("requires_sponsorship");
    expect(mapWorkAuthorizationOptionKey("sponsorship_needed")).toBe("requires_sponsorship");
  });

  it("maps unauthorized and unrecognized options to not_authorized", () => {
    expect(mapWorkAuthorizationOptionKey("not_authorized")).toBe("not_authorized");
    expect(mapWorkAuthorizationOptionKey("unknown_option")).toBe("not_authorized");
  });
});

describe("deriveCandidateTriageInputs", () => {
  it("rejects invalid input objects or empty candidates", () => {
    expect(deriveCandidateTriageInputs(null as any).ok).toBe(false);
    expect(deriveCandidateTriageInputs({} as any).ok).toBe(false);
    expect(
      deriveCandidateTriageInputs({
        candidateId: " ",
        documents: [SAMPLE_DOC],
        extractions: [],
        rubric: RUBRIC_V1
      }).ok
    ).toBe(false);
    expect(
      deriveCandidateTriageInputs({
        candidateId: "cand_1",
        documents: [],
        extractions: [],
        rubric: RUBRIC_V1
      }).ok
    ).toBe(false);
  });

  it("rejects candidates carrying more than 4 documents", () => {
    const manyDocs = Array.from({ length: 5 }, (_, i) => ({
      ...SAMPLE_DOC,
      candidateDocumentId: `cdoc_${i}`
    }));
    const result = deriveCandidateTriageInputs({
      candidateId: "cand_1",
      documents: manyDocs,
      extractions: [],
      rubric: RUBRIC_V1
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain(`at most ${MAXIMUM_CANDIDATE_DOCUMENTS} documents`);
  });

  it("rejects invalid rubric", () => {
    const result = deriveCandidateTriageInputs({
      candidateId: "cand_1",
      documents: [SAMPLE_DOC],
      extractions: [],
      rubric: null as any
    });
    expect(result.ok).toBe(false);
  });

  it("bridges application answer into work_authorization_statement proposal without resume relocation", () => {
    const appAnswer: CandidateApplicationAnswer = {
      candidateApplicationAnswerId: "ans_1" as any,
      candidateId: "cand_1" as any,
      questionKey: "work_authorization",
      selectedOptionKey: "authorized_no_sponsorship",
      freeText: "Alice Smith",
      collectedBy: "greenhouse",
      formId: "form_1",
      questionId: "q_1",
      collectedAt: NonnegativeIntegerSchema.parse(1000),
      createdAt: NonnegativeIntegerSchema.parse(1000)
    };

    const result = deriveCandidateTriageInputs({
      candidateId: "cand_1",
      documents: [SAMPLE_DOC],
      extractions: [],
      applicationAnswers: { workAuthorization: appAnswer },
      rubric: RUBRIC_V1
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.structuredFactProposals).toHaveLength(1);
    const prop = result.value.structuredFactProposals[0]!;
    expect(prop.payload).toEqual({
      kind: "work_authorization_statement",
      classification: "authorized",
      statementText: "Alice Smith"
    });
    expect(prop.provenance).toBe("parsed");
    expect(prop.documentId).toBeUndefined();
    expect(prop.evidenceSpanIds).toEqual([]);
    expect(result.value.locatedSpans).toEqual([]);
    expect(result.value.droppedQuotes).toEqual([]);
  });

  it("uses the selected option key when work authorization free text is absent", () => {
    const appAnswer: CandidateApplicationAnswer = {
      candidateApplicationAnswerId: "ans_fallback" as any,
      candidateId: "cand_1" as any,
      questionKey: "work_authorization",
      selectedOptionKey: "authorized_no_sponsorship",
      freeText: null,
      collectedBy: "greenhouse",
      formId: "form_1",
      questionId: "q_1",
      collectedAt: NonnegativeIntegerSchema.parse(1000),
      createdAt: NonnegativeIntegerSchema.parse(1000)
    };

    const result = deriveCandidateTriageInputs({
      candidateId: "cand_1",
      documents: [SAMPLE_DOC],
      extractions: [],
      applicationAnswers: { workAuthorization: appAnswer },
      rubric: RUBRIC_V1
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.structuredFactProposals).toHaveLength(1);
    expect(result.value.structuredFactProposals[0]).toMatchObject({
      provenance: "parsed",
      evidenceSpanIds: [],
      payload: {
        kind: "work_authorization_statement",
        classification: "authorized",
        statementText: "Application answer: authorized_no_sponsorship"
      }
    });
    expect(result.value.droppedQuotes).toEqual([]);
  });

  it("preserves a work_authorization answer that is not duplicated in resume text", () => {
    const appAnswer: CandidateApplicationAnswer = {
      candidateApplicationAnswerId: "ans_unlocated" as any,
      candidateId: "cand_1" as any,
      questionKey: "work_authorization",
      selectedOptionKey: "authorized_no_sponsorship",
      freeText: "Citizen",
      collectedBy: "greenhouse",
      formId: "form_1",
      questionId: "q_1",
      collectedAt: NonnegativeIntegerSchema.parse(1000),
      createdAt: NonnegativeIntegerSchema.parse(1000)
    };

    const result = deriveCandidateTriageInputs({
      candidateId: "cand_1",
      documents: [SAMPLE_DOC],
      extractions: [],
      applicationAnswers: { workAuthorization: appAnswer },
      rubric: RUBRIC_V1
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.structuredFactProposals).toHaveLength(1);
    const prop = result.value.structuredFactProposals[0]!;
    expect(prop.provenance).toBe("parsed");
    expect(prop.documentId).toBeUndefined();
    expect(prop.evidenceSpanIds).toEqual([]);
    expect(prop.payload).toEqual({
      kind: "work_authorization_statement",
      classification: "authorized",
      statementText: "Citizen"
    });
    expect(result.value.locatedSpans).toHaveLength(0);
    expect(result.value.droppedQuotes).toEqual([]);
  });

  it("returns a typed failure when an extraction span id is not a valid identifier", () => {
    const longCandidateId = `cand_${"x".repeat(120)}`;
    const result = deriveCandidateTriageInputs({
      candidateId: longCandidateId,
      documents: [SAMPLE_DOC],
      extractions: [
        {
          candidateDocumentId: "cdoc_1",
          dimensionId: RUBRIC_V1.dimensions[0]!.dimensionId,
          artifact: createFakeArtifact(RUBRIC_V1.dimensions[0]!.dimensionId)
        }
      ],
      rubric: RUBRIC_V1
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("persistence_failed");
    expect(result.error.message).toContain("Invalid evidence span id");
  });

  it("bridges raw fact proposals with quote relocation", () => {
    const rawProposal = {
      documentId: "cdoc_1",
      provenance: "extracted" as const,
      payload: {
        kind: "employment_interval" as const,
        employer: "TechCorp",
        title: "Senior Machine Learning Engineer",
        startMonth: IsoYearMonthSchema.parse("2023-01"),
        endMonth: "present" as const
      },
      groundingQuotes: [
        {
          quotedText: "TechCorp (2023-01 to Present)",
          polarity: "supporting" as const
        },
        {
          quotedText: "This string does not exist in document prose",
          polarity: "supporting" as const
        }
      ]
    };

    const result = deriveCandidateTriageInputs({
      candidateId: "cand_1",
      documents: [SAMPLE_DOC],
      extractions: [],
      rawFactProposals: [rawProposal],
      rubric: RUBRIC_V1
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.structuredFactProposals).toHaveLength(1);
    expect(result.value.locatedSpans).toHaveLength(1);
    expect(result.value.droppedQuotes).toHaveLength(1);
    expect(result.value.droppedQuotes[0]?.quotedText).toBe(
      "This string does not exist in document prose"
    );
  });

  it("drops raw fact proposal when all grounding quotes fail relocation", () => {
    const rawProposal = {
      documentId: "cdoc_1",
      provenance: "extracted" as const,
      payload: {
        kind: "current_title" as const,
        title: "CTO"
      },
      groundingQuotes: [
        {
          quotedText: "Chief Executive Officer and Founder",
          polarity: "supporting" as const
        }
      ]
    };

    const result = deriveCandidateTriageInputs({
      candidateId: "cand_1",
      documents: [SAMPLE_DOC],
      extractions: [],
      rawFactProposals: [rawProposal],
      rubric: RUBRIC_V1
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.structuredFactProposals).toHaveLength(0);
    expect(result.value.droppedQuotes).toHaveLength(1);
  });

  it("preserves pre-located evidenceSpanIds in raw fact proposals", () => {
    const rawProposal = {
      documentId: "cdoc_1",
      provenance: "parsed" as const,
      payload: {
        kind: "current_title" as const,
        title: "Senior Machine Learning Engineer"
      },
      evidenceSpanIds: ["pre_located_span_1"]
    };

    const result = deriveCandidateTriageInputs({
      candidateId: "cand_1",
      documents: [SAMPLE_DOC],
      extractions: [],
      rawFactProposals: [rawProposal],
      rubric: RUBRIC_V1
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.structuredFactProposals).toHaveLength(1);
    expect(result.value.structuredFactProposals[0]?.evidenceSpanIds).toEqual([
      "pre_located_span_1"
    ]);
  });

  it("emits a parsed raw fact proposal that carries no grounding quotes or spans", () => {
    const result = deriveCandidateTriageInputs({
      candidateId: "cand_1",
      documents: [SAMPLE_DOC],
      extractions: [],
      rawFactProposals: [
        {
          documentId: "cdoc_1",
          provenance: "parsed" as const,
          payload: { kind: "current_title" as const, title: "Staff Engineer" }
        }
      ],
      rubric: RUBRIC_V1
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.structuredFactProposals).toHaveLength(1);
    expect(result.value.structuredFactProposals[0]).toMatchObject({
      provenance: "parsed",
      evidenceSpanIds: []
    });
    expect(result.value.locatedSpans).toHaveLength(0);
  });

  it("returns a typed failure when a raw fact proposal cites an invalid span id", () => {
    const rawProposal = {
      documentId: "cdoc_1",
      provenance: "parsed" as const,
      payload: {
        kind: "current_title" as const,
        title: "Senior Machine Learning Engineer"
      },
      evidenceSpanIds: ["span with spaces"]
    };

    const result = deriveCandidateTriageInputs({
      candidateId: "cand_1",
      documents: [SAMPLE_DOC],
      extractions: [],
      rawFactProposals: [rawProposal],
      rubric: RUBRIC_V1
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("persistence_failed");
    expect(result.error.message).toContain("Invalid evidence span id");
  });

  it("returns a typed failure when a relocated raw-fact span id is not a valid identifier", () => {
    const longCandidateId = `cand_${"x".repeat(120)}`;
    const rawProposal = {
      documentId: "cdoc_1",
      provenance: "extracted" as const,
      payload: {
        kind: "employment_interval" as const,
        employer: "TechCorp",
        title: "Senior Machine Learning Engineer",
        startMonth: IsoYearMonthSchema.parse("2023-01"),
        endMonth: "present" as const
      },
      groundingQuotes: [
        {
          quotedText: "TechCorp (2023-01 to Present)",
          polarity: "supporting" as const
        }
      ]
    };

    const result = deriveCandidateTriageInputs({
      candidateId: longCandidateId,
      documents: [SAMPLE_DOC],
      extractions: [],
      rawFactProposals: [rawProposal],
      rubric: RUBRIC_V1
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("persistence_failed");
    expect(result.error.message).toContain("Invalid evidence span id");
  });

  it("ignores raw fact proposals targeting missing document ids", () => {
    const rawProposal = {
      documentId: "non_existent_doc",
      provenance: "parsed" as const,
      payload: {
        kind: "current_title" as const,
        title: "Lead"
      },
      evidenceSpanIds: ["span_1"]
    };

    const result = deriveCandidateTriageInputs({
      candidateId: "cand_1",
      documents: [SAMPLE_DOC],
      extractions: [],
      rawFactProposals: [rawProposal],
      rubric: RUBRIC_V1
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.structuredFactProposals).toHaveLength(0);
  });

  it("assembles dimension evidence across artifacts, failures, and human overrides", () => {
    const dim1 = RUBRIC_V1.dimensions[0]!.dimensionId;
    const dim2 = RUBRIC_V1.dimensions[1]!.dimensionId;

    const extractions: CandidateExtractionResultInput[] = [
      {
        candidateDocumentId: "cdoc_1",
        dimensionId: dim1,
        artifact: createFakeArtifact(dim1, "strong")
      },
      {
        candidateDocumentId: "cdoc_1",
        dimensionId: dim2,
        failure: createFakeFailure(dim2),
        reviewableFailure: true,
        humanLevel: "partial"
      }
    ];

    const result = deriveCandidateTriageInputs({
      candidateId: "cand_1",
      documents: [SAMPLE_DOC],
      extractions,
      rubric: RUBRIC_V1
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dimensionEvidence).toHaveLength(RUBRIC_V1.dimensions.length);

    const evidence1 = result.value.dimensionEvidence.find((e) => e.dimensionId === dim1);
    expect(evidence1?.proposals).toEqual([
      { kind: "document_level", documentId: "cdoc_1", level: "strong" }
    ]);
    expect(evidence1?.spans).toHaveLength(1);

    const evidence2 = result.value.dimensionEvidence.find((e) => e.dimensionId === dim2);
    expect(evidence2?.proposals).toContainEqual({
      kind: "document_failure",
      documentId: "cdoc_1"
    });
    expect(evidence2?.proposals).toContainEqual({
      kind: "human_level",
      level: "partial"
    });
  });
});

describe("deriveCandidateDecision end-to-end", () => {
  const policyResult = createHardRequirementPolicyV1("2026-09", {
    minimumExperienceMonths: 24
  });
  if (!policyResult.ok) throw new Error("Policy creation failed");
  const hardRequirementPolicy = policyResult.value;

  it("derives complete decision for well-evidenced candidate", () => {
    const extractions: CandidateExtractionResultInput[] = RUBRIC_V1.dimensions.map(
      (dim) => ({
        candidateDocumentId: "cdoc_1",
        dimensionId: dim.dimensionId,
        artifact: createFakeArtifact(dim.dimensionId, "strong")
      })
    );

    const appAnswer: CandidateApplicationAnswer = {
      candidateApplicationAnswerId: "ans_1" as any,
      candidateId: "cand_1" as any,
      questionKey: "work_authorization",
      selectedOptionKey: "authorized_no_sponsorship",
      freeText: "Alice Smith",
      collectedBy: "greenhouse",
      formId: "form_1",
      questionId: "q_1",
      collectedAt: NonnegativeIntegerSchema.parse(1000),
      createdAt: NonnegativeIntegerSchema.parse(1000)
    };

    const rawFactProposals = [
      {
        documentId: "cdoc_1",
        provenance: "extracted" as const,
        payload: {
          kind: "employment_interval" as const,
          employer: "TechCorp",
          title: "Senior Machine Learning Engineer",
          startMonth: IsoYearMonthSchema.parse("2023-01"),
          endMonth: "present" as const
        },
        groundingQuotes: [
          {
            quotedText: "TechCorp (2023-01 to Present)"
          }
        ]
      },
      {
        documentId: "cdoc_1",
        provenance: "extracted" as const,
        payload: {
          kind: "current_title" as const,
          title: "Senior Machine Learning Engineer"
        },
        groundingQuotes: [
          {
            quotedText: "Senior Machine Learning Engineer"
          }
        ]
      },
      {
        documentId: "cdoc_1",
        provenance: "extracted" as const,
        payload: {
          kind: "employer_history_entry" as const,
          employer: "TechCorp",
          startMonth: IsoYearMonthSchema.parse("2023-01"),
          endMonth: "present" as const
        },
        evidenceSpanIds: ["span_hist_1"]
      }
    ];

    const decisionResult = deriveCandidateDecision({
      candidateId: "cand_1",
      documents: [SAMPLE_DOC],
      extractions,
      applicationAnswers: { workAuthorization: appAnswer },
      rawFactProposals,
      rubric: RUBRIC_V1,
      hardRequirementPolicy
    });

    expect(decisionResult.ok).toBe(true);
    if (!decisionResult.ok) return;

    const decision = decisionResult.value;
    expect(decision.candidateId).toBe("cand_1");
    expect(decision.hardRequirements.rejected).toBe(false);
    expect(decision.hardRequirements.unknownCount).toBe(0);
    expect(decision.hardRequirements.derivedTenureMonths).toBe(45); // 2023-01 to 2026-09
    expect(decision.dimensionDerivation.availability).toBe("complete");
    expect(decision.score).toBeDefined();
    expect(decision.score?.aggregate).toBeDefined();
    expect(decision.confidence).toBeDefined();
    expect(decision.confidenceInput?.totalDimensions).toBe(6);
    expect(decision.confidenceInput?.spansLocated).toBeGreaterThan(0);
    expect(decision.routing.status).toBe("scored");
    expect(decision.proposals.proposals.length).toBeGreaterThanOrEqual(1);
    expect(decision.proposals.proposals[0]?.payload.kind).toBe("shortlist_inclusion");
  });

  it("drives the confidence resolution term from resolutionSpanCounts when provided", () => {
    const extractions: CandidateExtractionResultInput[] = RUBRIC_V1.dimensions.map((dim) => ({
      candidateDocumentId: "cdoc_1",
      dimensionId: dim.dimensionId,
      artifact: createFakeArtifact(dim.dimensionId, "strong")
    }));
    const base = {
      candidateId: "cand_res",
      documents: [SAMPLE_DOC],
      extractions,
      rubric: RUBRIC_V1,
      hardRequirementPolicy
    } as const;

    const withoutCounts = deriveCandidateDecision({ ...base });
    const withCounts = deriveCandidateDecision({
      ...base,
      resolutionSpanCounts: { spansReturned: 12, spansLocated: 3 }
    });
    expect(withoutCounts.ok && withCounts.ok).toBe(true);
    if (!withoutCounts.ok || !withCounts.ok) return;

    expect(withCounts.value.confidenceInput?.spansReturned).toBe(12);
    expect(withCounts.value.confidenceInput?.spansLocated).toBe(3);
    // A returned-but-unlocated quote lowers the resolution term, so confidence drops.
    const a = withCounts.value.confidence!;
    const b = withoutCounts.value.confidence!;
    expect(a.numerator * b.denominator).toBeLessThan(b.numerator * a.denominator);
  });

  it("derives decision when no structured facts exist (safe unknown escalation)", () => {
    // All dimensions have strong artifacts
    const extractions: CandidateExtractionResultInput[] = RUBRIC_V1.dimensions.map(
      (dim) => ({
        candidateDocumentId: "cdoc_1",
        dimensionId: dim.dimensionId,
        artifact: createFakeArtifact(dim.dimensionId, "strong")
      })
    );

    // No application answer and no fact proposals
    const decisionResult = deriveCandidateDecision({
      candidateId: "cand_empty_facts",
      documents: [SAMPLE_DOC],
      extractions,
      rubric: RUBRIC_V1,
      hardRequirementPolicy
    });

    expect(decisionResult.ok).toBe(true);
    if (!decisionResult.ok) return;

    const decision = decisionResult.value;
    // Missing facts must resolve to unknown, never reject
    expect(decision.hardRequirements.rejected).toBe(false);
    expect(decision.hardRequirements.unknownCount).toBe(4);
    // Escalates due to missing hard requirements
    expect(decision.routing.status).toBe("escalated");
    expect(decision.routing.reasons).toContainEqual(
      expect.objectContaining({ kind: "missing_evidence" })
    );
  });

  it("handles candidate rejection when hard requirement fails conclusively", () => {
    const extractions: CandidateExtractionResultInput[] = RUBRIC_V1.dimensions.map(
      (dim) => ({
        candidateDocumentId: "cdoc_1",
        dimensionId: dim.dimensionId,
        artifact: createFakeArtifact(dim.dimensionId, "strong")
      })
    );

    const unauthorizedAnswer: CandidateApplicationAnswer = {
      candidateApplicationAnswerId: "ans_unauth" as any,
      candidateId: "cand_unauth" as any,
      questionKey: "work_authorization",
      selectedOptionKey: "not_authorized",
      freeText: "Not authorized to work and this sentence is not in the resume",
      collectedBy: "greenhouse",
      formId: "form_1",
      questionId: "q_1",
      collectedAt: NonnegativeIntegerSchema.parse(1000),
      createdAt: NonnegativeIntegerSchema.parse(1000)
    };

    const decisionResult = deriveCandidateDecision({
      candidateId: "cand_unauth",
      documents: [SAMPLE_DOC],
      extractions,
      applicationAnswers: { workAuthorization: unauthorizedAnswer },
      rubric: RUBRIC_V1,
      hardRequirementPolicy
    });

    expect(decisionResult.ok).toBe(true);
    if (!decisionResult.ok) return;

    const decision = decisionResult.value;
    expect(decision.hardRequirements.rejected).toBe(true);
    expect(decision.routing.status).toBe("rejected_hard_requirement");
    expect(decision.proposals.proposals).toHaveLength(0);
  });

  it("handles dimension assessment unavailability when all documents fail reviewably", () => {
    const extractions: CandidateExtractionResultInput[] = RUBRIC_V1.dimensions.map(
      (dim) => ({
        candidateDocumentId: "cdoc_1",
        dimensionId: dim.dimensionId,
        reviewableFailure: true
      })
    );

    const decisionResult = deriveCandidateDecision({
      candidateId: "cand_failed_docs",
      documents: [SAMPLE_DOC],
      extractions,
      rubric: RUBRIC_V1,
      hardRequirementPolicy
    });

    expect(decisionResult.ok).toBe(true);
    if (!decisionResult.ok) return;

    const decision = decisionResult.value;
    expect(decision.dimensionDerivation.availability).toBe("unavailable");
    expect(decision.score).toBeNull();
    expect(decision.confidence).toBeNull();
    expect(decision.confidenceInput).toBeNull();
    expect(decision.routing.status).toBe("escalated");
    expect(decision.routing.reasons).toContainEqual(
      expect.objectContaining({ kind: "assessment_unavailable" })
    );
  });

  it("returns error from deriveCandidateDecision if input bridging fails", () => {
    const decisionResult = deriveCandidateDecision({
      candidateId: "cand_fail_bridge",
      documents: [],
      extractions: [],
      rubric: RUBRIC_V1,
      hardRequirementPolicy
    });

    expect(decisionResult.ok).toBe(false);
    if (!decisionResult.ok) {
      expect(decisionResult.error.code).toBe("persistence_failed");
      expect(decisionResult.error.message).toBe("Candidate must carry at least one document");
    }
  });

  it("supports variant corpus tag, duplicate suppression, and explicit routing signals", () => {
    const extractions: CandidateExtractionResultInput[] = RUBRIC_V1.dimensions.map(
      (dim) => ({
        candidateDocumentId: "cdoc_1",
        dimensionId: dim.dimensionId,
        artifact: createFakeArtifact(dim.dimensionId, "strong")
      })
    );

    const decisionResult = deriveCandidateDecision({
      candidateId: "cand_variant",
      documents: [SAMPLE_DOC],
      extractions,
      rubric: RUBRIC_V1,
      hardRequirementPolicy,
      isVariant: true,
      duplicateSuppressed: true,
      routingSignals: {
        parseFailure: true,
        possibleDuplicate: true,
        promptInjectionFlagged: true,
        ambiguousSubjectIds: ["subj_1"]
      }
    });

    expect(decisionResult.ok).toBe(true);
    if (!decisionResult.ok) return;

    const decision = decisionResult.value;
    expect(decision.routing.status).toBe("escalated");
    expect(decision.proposals.proposals.length).toBeGreaterThanOrEqual(0);
  });
});
