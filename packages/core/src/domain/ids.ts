import { z } from "zod";

const printableAsciiId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u, "ID must contain printable ASCII without spaces");

export const ActorIdSchema = printableAsciiId.brand<"ActorId">();
export type ActorId = z.infer<typeof ActorIdSchema>;

export const AuditEventIdSchema = printableAsciiId.brand<"AuditEventId">();
export type AuditEventId = z.infer<typeof AuditEventIdSchema>;

export const CandidateIdSchema = printableAsciiId.brand<"CandidateId">();
export type CandidateId = z.infer<typeof CandidateIdSchema>;

export const CandidateDocumentIdSchema = printableAsciiId.brand<"CandidateDocumentId">();
export type CandidateDocumentId = z.infer<typeof CandidateDocumentIdSchema>;

export const CandidateResultDimensionAssessmentIdSchema =
  printableAsciiId.brand<"CandidateResultDimensionAssessmentId">();
export type CandidateResultDimensionAssessmentId = z.infer<
  typeof CandidateResultDimensionAssessmentIdSchema
>;

export const CandidateResultEvidenceGapIdSchema =
  printableAsciiId.brand<"CandidateResultEvidenceGapId">();
export type CandidateResultEvidenceGapId = z.infer<typeof CandidateResultEvidenceGapIdSchema>;

export const CandidateResultEvidenceSpanIdSchema =
  printableAsciiId.brand<"CandidateResultEvidenceSpanId">();
export type CandidateResultEvidenceSpanId = z.infer<typeof CandidateResultEvidenceSpanIdSchema>;

export const CandidateResultFactConflictIdSchema =
  printableAsciiId.brand<"CandidateResultFactConflictId">();
export type CandidateResultFactConflictId = z.infer<typeof CandidateResultFactConflictIdSchema>;

export const CandidateResultHardRequirementAssessmentIdSchema =
  printableAsciiId.brand<"CandidateResultHardRequirementAssessmentId">();
export type CandidateResultHardRequirementAssessmentId = z.infer<
  typeof CandidateResultHardRequirementAssessmentIdSchema
>;

export const CandidateResultStructuredFactIdSchema =
  printableAsciiId.brand<"CandidateResultStructuredFactId">();
export type CandidateResultStructuredFactId = z.infer<
  typeof CandidateResultStructuredFactIdSchema
>;

export const CandidateTriageResultIdSchema = printableAsciiId.brand<"CandidateTriageResultId">();
export type CandidateTriageResultId = z.infer<typeof CandidateTriageResultIdSchema>;

export const CommandIdSchema = printableAsciiId.brand<"CommandId">();
export type CommandId = z.infer<typeof CommandIdSchema>;

export const CorpusManifestIdSchema = printableAsciiId.brand<"CorpusManifestId">();
export type CorpusManifestId = z.infer<typeof CorpusManifestIdSchema>;

export const CorpusManifestSealIdSchema = printableAsciiId.brand<"CorpusManifestSealId">();
export type CorpusManifestSealId = z.infer<typeof CorpusManifestSealIdSchema>;

export const CorpusMemberIdSchema = printableAsciiId.brand<"CorpusMemberId">();
export type CorpusMemberId = z.infer<typeof CorpusMemberIdSchema>;

export const CorpusMemberDocumentIdSchema = printableAsciiId.brand<"CorpusMemberDocumentId">();
export type CorpusMemberDocumentId = z.infer<typeof CorpusMemberDocumentIdSchema>;

export const DimensionAssessmentIdSchema = printableAsciiId.brand<"DimensionAssessmentId">();
export type DimensionAssessmentId = z.infer<typeof DimensionAssessmentIdSchema>;

export const DimensionAssessmentEvidenceSpanIdSchema =
  printableAsciiId.brand<"DimensionAssessmentEvidenceSpanId">();
export type DimensionAssessmentEvidenceSpanId = z.infer<
  typeof DimensionAssessmentEvidenceSpanIdSchema
>;

export const EvidenceGapIdSchema = printableAsciiId.brand<"EvidenceGapId">();
export type EvidenceGapId = z.infer<typeof EvidenceGapIdSchema>;

export const EvidenceSpanIdSchema = printableAsciiId.brand<"EvidenceSpanId">();
export type EvidenceSpanId = z.infer<typeof EvidenceSpanIdSchema>;

export const ExtractionArtifactIdSchema = printableAsciiId.brand<"ExtractionArtifactId">();
export type ExtractionArtifactId = z.infer<typeof ExtractionArtifactIdSchema>;

export const ExtractionFailureIdSchema = printableAsciiId.brand<"ExtractionFailureId">();
export type ExtractionFailureId = z.infer<typeof ExtractionFailureIdSchema>;

export const ExtractionRunIdSchema = printableAsciiId.brand<"ExtractionRunId">();
export type ExtractionRunId = z.infer<typeof ExtractionRunIdSchema>;

export const ExtractionSpecIdSchema = printableAsciiId.brand<"ExtractionSpecId">();
export type ExtractionSpecId = z.infer<typeof ExtractionSpecIdSchema>;

export const FactConflictIdSchema = printableAsciiId.brand<"FactConflictId">();
export type FactConflictId = z.infer<typeof FactConflictIdSchema>;

export const FactConflictMemberIdSchema = printableAsciiId.brand<"FactConflictMemberId">();
export type FactConflictMemberId = z.infer<typeof FactConflictMemberIdSchema>;

export const HardRequirementAssessmentFactIdSchema =
  printableAsciiId.brand<"HardRequirementAssessmentFactId">();
export type HardRequirementAssessmentFactId = z.infer<
  typeof HardRequirementAssessmentFactIdSchema
>;

export const HardRequirementAssessmentIdSchema =
  printableAsciiId.brand<"HardRequirementAssessmentId">();
export type HardRequirementAssessmentId = z.infer<typeof HardRequirementAssessmentIdSchema>;

export const ProposalIdSchema = printableAsciiId.brand<"ProposalId">();
export type ProposalId = z.infer<typeof ProposalIdSchema>;

export const RequirementIdSchema = printableAsciiId.brand<"RequirementId">();
export type RequirementId = z.infer<typeof RequirementIdSchema>;

export const ResolutionTaskIdSchema = printableAsciiId.brand<"ResolutionTaskId">();
export type ResolutionTaskId = z.infer<typeof ResolutionTaskIdSchema>;

export const ReviewDecisionIdSchema = printableAsciiId.brand<"ReviewDecisionId">();
export type ReviewDecisionId = z.infer<typeof ReviewDecisionIdSchema>;

export const RoleIdSchema = printableAsciiId.brand<"RoleId">();
export type RoleId = z.infer<typeof RoleIdSchema>;

export const RunInputSnapshotIdSchema = printableAsciiId.brand<"RunInputSnapshotId">();
export type RunInputSnapshotId = z.infer<typeof RunInputSnapshotIdSchema>;

export const RubricDimensionIdSchema = printableAsciiId.brand<"RubricDimensionId">();
export type RubricDimensionId = z.infer<typeof RubricDimensionIdSchema>;

export const RubricIdSchema = printableAsciiId.brand<"RubricId">();
export type RubricId = z.infer<typeof RubricIdSchema>;

export const ScoreResultIdSchema = printableAsciiId.brand<"ScoreResultId">();
export type ScoreResultId = z.infer<typeof ScoreResultIdSchema>;

export const SourceDocumentIdSchema = printableAsciiId.brand<"SourceDocumentId">();
export type SourceDocumentId = z.infer<typeof SourceDocumentIdSchema>;

export const StructuredFactEvidenceSpanIdSchema =
  printableAsciiId.brand<"StructuredFactEvidenceSpanId">();
export type StructuredFactEvidenceSpanId = z.infer<typeof StructuredFactEvidenceSpanIdSchema>;

export const StructuredFactIdSchema = printableAsciiId.brand<"StructuredFactId">();
export type StructuredFactId = z.infer<typeof StructuredFactIdSchema>;

export const StructuredFactProvenanceIdSchema =
  printableAsciiId.brand<"StructuredFactProvenanceId">();
export type StructuredFactProvenanceId = z.infer<typeof StructuredFactProvenanceIdSchema>;

export const TriageRunIdSchema = printableAsciiId.brand<"TriageRunId">();
export type TriageRunId = z.infer<typeof TriageRunIdSchema>;
