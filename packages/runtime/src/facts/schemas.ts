import {
  ActorIdSchema,
  CandidateIdSchema,
  EvidencePolaritySchema,
  EvidenceSpanIdSchema,
  FactConflictIdSchema,
  FactConflictMemberIdSchema,
  FactProvenanceSourceSchema,
  HardRequirementAssessmentFactIdSchema,
  HardRequirementAssessmentIdSchema,
  HardRequirementFieldIdSchema,
  HardRequirementOutcomeSchema,
  NonnegativeIntegerSchema,
  Sha256HexSchema,
  StructuredFactEvidenceSpanIdSchema,
  StructuredFactIdSchema,
  StructuredFactKindSchema,
  StructuredFactPayloadSchema,
  StructuredFactPayloadUnionSchema,
  StructuredFactProvenanceIdSchema
} from "@recruitos/core";
import { z } from "zod";

export {
  FACT_PROVENANCE_SOURCES,
  HARD_REQUIREMENT_FIELD_IDS,
  HARD_REQUIREMENT_OUTCOMES,
  STRUCTURED_FACT_KINDS,
  StructuredFactPayloadSchema,
  structuredFactSemanticKey
} from "@recruitos/core";

const MAXIMUM_EVIDENCE_SPANS_PER_FACT = 12;
const MAXIMUM_PROVENANCES_PER_FACT = 8;
const MAXIMUM_CONFLICT_MEMBERS = 16;
const MAXIMUM_ASSESSMENT_FACTS = 16;

const evidenceSpanRefShape = {
  structuredFactEvidenceSpanId: StructuredFactEvidenceSpanIdSchema,
  evidenceSpanId: EvidenceSpanIdSchema,
  spanOrdinal: NonnegativeIntegerSchema,
  createdAt: NonnegativeIntegerSchema
};

export const StructuredFactEvidenceSpanDraftSchema = z
  .object({
    structuredFactEvidenceSpanId: StructuredFactEvidenceSpanIdSchema,
    evidenceSpanId: EvidenceSpanIdSchema
  })
  .strict();
export type StructuredFactEvidenceSpanDraft = z.infer<
  typeof StructuredFactEvidenceSpanDraftSchema
>;

export const StructuredFactEvidenceSpanSchema = z.object(evidenceSpanRefShape).strict();
export type StructuredFactEvidenceSpan = z.infer<typeof StructuredFactEvidenceSpanSchema>;

const provenanceShape = {
  structuredFactProvenanceId: StructuredFactProvenanceIdSchema,
  source: FactProvenanceSourceSchema,
  actorId: ActorIdSchema.nullable(),
  createdAt: NonnegativeIntegerSchema
};

export const StructuredFactProvenanceDraftSchema = z
  .object({
    structuredFactProvenanceId: StructuredFactProvenanceIdSchema,
    source: FactProvenanceSourceSchema,
    actorId: ActorIdSchema.nullable()
  })
  .strict();
export type StructuredFactProvenanceDraft = z.infer<
  typeof StructuredFactProvenanceDraftSchema
>;

export const StructuredFactProvenanceSchema = z.object(provenanceShape).strict();
export type StructuredFactProvenance = z.infer<typeof StructuredFactProvenanceSchema>;

export const StructuredFactContentSchema = z
  .object({
    candidateId: CandidateIdSchema,
    payload: StructuredFactPayloadSchema,
    semanticKey: z.string().min(1).max(256)
  })
  .strict();
export type StructuredFactContent = z.infer<typeof StructuredFactContentSchema>;

function isParsedWorkAuthorizationFact(value: {
  payload: { kind: string };
  provenances: readonly { source: string }[];
}): boolean {
  return (
    value.payload.kind === "work_authorization_statement" &&
    value.provenances.length > 0 &&
    value.provenances.every((provenance) => provenance.source === "parsed")
  );
}

function refineStructuredFactEvidenceSpans(
  value: {
    payload: { kind: string };
    provenances: readonly { source: string }[];
    evidenceSpans: readonly unknown[];
  },
  context: z.RefinementCtx
): void {
  if (isParsedWorkAuthorizationFact(value)) {
    if (value.evidenceSpans.length !== 0) {
      context.addIssue({
        code: "custom",
        message: "Parsed work-authorization facts must not cite document evidence spans",
        path: ["evidenceSpans"]
      });
    }
    return;
  }
  if (value.evidenceSpans.length < 1) {
    context.addIssue({
      code: "custom",
      message: "Document-grounded facts require at least one evidence span",
      path: ["evidenceSpans"]
    });
  }
}

const structuredFactDraftShape = {
  structuredFactId: StructuredFactIdSchema,
  candidateId: CandidateIdSchema,
  payload: StructuredFactPayloadUnionSchema,
  evidenceSpans: z
    .array(StructuredFactEvidenceSpanDraftSchema)
    .max(MAXIMUM_EVIDENCE_SPANS_PER_FACT),
  provenances: z
    .array(StructuredFactProvenanceDraftSchema)
    .min(1)
    .max(MAXIMUM_PROVENANCES_PER_FACT),
  createdAt: NonnegativeIntegerSchema
};

export const StructuredFactDraftSchema = z
  .object(structuredFactDraftShape)
  .strict()
  .superRefine(refineStructuredFactEvidenceSpans);
export type StructuredFactDraft = z.infer<typeof StructuredFactDraftSchema>;

export const StructuredFactSchema = z
  .object({
    structuredFactId: StructuredFactIdSchema,
    candidateId: CandidateIdSchema,
    kind: StructuredFactKindSchema,
    semanticKey: z.string().min(1).max(256),
    payload: StructuredFactPayloadSchema,
    contentJson: z.string(),
    contentHash: Sha256HexSchema,
    evidenceSpans: z.array(StructuredFactEvidenceSpanSchema),
    provenances: z.array(StructuredFactProvenanceSchema).min(1),
    createdAt: NonnegativeIntegerSchema
  })
  .strict()
  .superRefine(refineStructuredFactEvidenceSpans);
export type StructuredFact = z.infer<typeof StructuredFactSchema>;

export const FactConflictMemberDraftSchema = z
  .object({
    factConflictMemberId: FactConflictMemberIdSchema,
    structuredFactId: StructuredFactIdSchema
  })
  .strict();
export type FactConflictMemberDraft = z.infer<typeof FactConflictMemberDraftSchema>;

export const FactConflictMemberSchema = z
  .object({
    factConflictMemberId: FactConflictMemberIdSchema,
    structuredFactId: StructuredFactIdSchema,
    memberOrdinal: NonnegativeIntegerSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type FactConflictMember = z.infer<typeof FactConflictMemberSchema>;

export const FactConflictContentSchema = z
  .object({
    memberIds: z.array(StructuredFactIdSchema).min(2).max(MAXIMUM_CONFLICT_MEMBERS)
  })
  .strict();
export type FactConflictContent = z.infer<typeof FactConflictContentSchema>;

export const FactConflictDraftSchema = z
  .object({
    factConflictId: FactConflictIdSchema,
    members: z.array(FactConflictMemberDraftSchema).min(2).max(MAXIMUM_CONFLICT_MEMBERS),
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type FactConflictDraft = z.infer<typeof FactConflictDraftSchema>;

export const FactConflictSchema = z
  .object({
    factConflictId: FactConflictIdSchema,
    content: FactConflictContentSchema,
    contentJson: z.string(),
    contentHash: Sha256HexSchema,
    members: z.array(FactConflictMemberSchema).min(2),
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type FactConflict = z.infer<typeof FactConflictSchema>;

export const HardRequirementAssessmentFactDraftSchema = z
  .object({
    hardRequirementAssessmentFactId: HardRequirementAssessmentFactIdSchema,
    structuredFactId: StructuredFactIdSchema,
    polarity: EvidencePolaritySchema
  })
  .strict();
export type HardRequirementAssessmentFactDraft = z.infer<
  typeof HardRequirementAssessmentFactDraftSchema
>;

export const HardRequirementAssessmentFactSchema = z
  .object({
    hardRequirementAssessmentFactId: HardRequirementAssessmentFactIdSchema,
    structuredFactId: StructuredFactIdSchema,
    polarity: EvidencePolaritySchema,
    factOrdinal: NonnegativeIntegerSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type HardRequirementAssessmentFact = z.infer<
  typeof HardRequirementAssessmentFactSchema
>;

export const HardRequirementAssessmentContentSchema = z
  .object({
    candidateId: CandidateIdSchema,
    facts: z.array(
      z
        .object({
          polarity: EvidencePolaritySchema,
          structuredFactId: StructuredFactIdSchema
        })
        .strict()
    ),
    outcome: HardRequirementOutcomeSchema,
    requirementFieldId: HardRequirementFieldIdSchema
  })
  .strict();
export type HardRequirementAssessmentContent = z.infer<
  typeof HardRequirementAssessmentContentSchema
>;

export const HardRequirementAssessmentDraftSchema = z
  .object({
    hardRequirementAssessmentId: HardRequirementAssessmentIdSchema,
    candidateId: CandidateIdSchema,
    requirementFieldId: HardRequirementFieldIdSchema,
    outcome: HardRequirementOutcomeSchema,
    facts: z
      .array(HardRequirementAssessmentFactDraftSchema)
      .max(MAXIMUM_ASSESSMENT_FACTS),
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type HardRequirementAssessmentDraft = z.infer<
  typeof HardRequirementAssessmentDraftSchema
>;

export const HardRequirementAssessmentSchema = z
  .object({
    hardRequirementAssessmentId: HardRequirementAssessmentIdSchema,
    candidateId: CandidateIdSchema,
    requirementFieldId: HardRequirementFieldIdSchema,
    outcome: HardRequirementOutcomeSchema,
    content: HardRequirementAssessmentContentSchema,
    contentJson: z.string(),
    contentHash: Sha256HexSchema,
    facts: z.array(HardRequirementAssessmentFactSchema),
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type HardRequirementAssessment = z.infer<typeof HardRequirementAssessmentSchema>;
