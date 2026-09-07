import { describe, expect, it } from "vitest";

import {
  ActorIdSchema,
  AttemptClaimIdSchema,
  AttemptWorkItemIdSchema,
  AuditEventIdSchema,
  CandidateIdSchema,
  CandidateResultDimensionAssessmentIdSchema,
  CandidateResultEvidenceGapIdSchema,
  CandidateResultEvidenceSpanIdSchema,
  CandidateResultFactConflictIdSchema,
  CandidateResultHardRequirementAssessmentIdSchema,
  CandidateResultReasonIdSchema,
  CandidateResultSealIdSchema,
  CandidateResultStructuredFactIdSchema,
  CandidateTriageResultIdSchema,
  CommandIdSchema,
  CorpusManifestIdSchema,
  CorpusManifestSealIdSchema,
  CorpusMemberDocumentIdSchema,
  CorpusMemberIdSchema,
  DimensionAssessmentEvidenceSpanIdSchema,
  DimensionAssessmentIdSchema,
  EvidenceGapIdSchema,
  EvidenceSpanIdSchema,
  ExtractionArtifactIdSchema,
  ExtractionFailureIdSchema,
  ExtractionRunIdSchema,
  ExtractionSpecIdSchema,
  FactConflictIdSchema,
  FactConflictMemberIdSchema,
  HardRequirementAssessmentFactIdSchema,
  HardRequirementAssessmentIdSchema,
  ProposalEvidenceSpanIdSchema,
  ProposalIdSchema,
  RequirementIdSchema,
  ResolutionActionIdSchema,
  ResolutionTaskIdSchema,
  ReviewDecisionIdSchema,
  RoleIdSchema,
  RunInputSnapshotIdSchema,
  RubricDimensionIdSchema,
  RubricIdSchema,
  ScoreResultIdSchema,
  SourceDocumentIdSchema,
  StructuredFactEvidenceSpanIdSchema,
  StructuredFactIdSchema,
  StructuredFactProvenanceIdSchema,
  TriageAttemptIdSchema,
  TriageRunIdSchema,
  TriageRunMemberIdSchema,
  TriageRunSealIdSchema,
  type CandidateId,
  type SourceDocumentId
} from "./ids.js";

const schemas = [
  ActorIdSchema,
  AttemptClaimIdSchema,
  AttemptWorkItemIdSchema,
  AuditEventIdSchema,
  CandidateIdSchema,
  CandidateResultDimensionAssessmentIdSchema,
  CandidateResultEvidenceGapIdSchema,
  CandidateResultEvidenceSpanIdSchema,
  CandidateResultFactConflictIdSchema,
  CandidateResultHardRequirementAssessmentIdSchema,
  CandidateResultReasonIdSchema,
  CandidateResultSealIdSchema,
  CandidateResultStructuredFactIdSchema,
  CandidateTriageResultIdSchema,
  CommandIdSchema,
  CorpusManifestIdSchema,
  CorpusManifestSealIdSchema,
  CorpusMemberDocumentIdSchema,
  CorpusMemberIdSchema,
  DimensionAssessmentEvidenceSpanIdSchema,
  DimensionAssessmentIdSchema,
  EvidenceGapIdSchema,
  EvidenceSpanIdSchema,
  ExtractionArtifactIdSchema,
  ExtractionFailureIdSchema,
  ExtractionRunIdSchema,
  ExtractionSpecIdSchema,
  FactConflictIdSchema,
  FactConflictMemberIdSchema,
  HardRequirementAssessmentFactIdSchema,
  HardRequirementAssessmentIdSchema,
  ProposalEvidenceSpanIdSchema,
  ProposalIdSchema,
  RequirementIdSchema,
  ResolutionActionIdSchema,
  ResolutionTaskIdSchema,
  ReviewDecisionIdSchema,
  RoleIdSchema,
  RunInputSnapshotIdSchema,
  RubricDimensionIdSchema,
  RubricIdSchema,
  ScoreResultIdSchema,
  SourceDocumentIdSchema,
  StructuredFactEvidenceSpanIdSchema,
  StructuredFactIdSchema,
  StructuredFactProvenanceIdSchema,
  TriageAttemptIdSchema,
  TriageRunIdSchema,
  TriageRunMemberIdSchema,
  TriageRunSealIdSchema
] as const;

describe("branded ID schemas", () => {
  it("accept printable ASCII IDs", () => {
    for (const schema of schemas) {
      expect(schema.parse("entity_01:test")).toBe("entity_01:test");
    }
  });

  it.each(["", "contains space", "café", "line\nbreak", "a".repeat(129)])(
    "rejects invalid ID %j",
    (value) => {
      for (const schema of schemas) {
        expect(schema.safeParse(value).success).toBe(false);
      }
    }
  );

  it("keeps ID types distinct at compile time", () => {
    const candidateId: CandidateId = CandidateIdSchema.parse("candidate_1");
    const documentId: SourceDocumentId = SourceDocumentIdSchema.parse("document_1");
    expect(candidateId).not.toBe(documentId);

    // @ts-expect-error Candidate IDs cannot be assigned as source document IDs.
    const invalidDocumentId: SourceDocumentId = candidateId;
    expect(invalidDocumentId).toBe(candidateId);
  });
});
