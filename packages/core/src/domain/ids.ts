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

export const ExtractionRunIdSchema = printableAsciiId.brand<"ExtractionRunId">();
export type ExtractionRunId = z.infer<typeof ExtractionRunIdSchema>;

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

export const RubricDimensionIdSchema = printableAsciiId.brand<"RubricDimensionId">();
export type RubricDimensionId = z.infer<typeof RubricDimensionIdSchema>;

export const RubricIdSchema = printableAsciiId.brand<"RubricId">();
export type RubricId = z.infer<typeof RubricIdSchema>;

export const ScoreResultIdSchema = printableAsciiId.brand<"ScoreResultId">();
export type ScoreResultId = z.infer<typeof ScoreResultIdSchema>;

export const SourceDocumentIdSchema = printableAsciiId.brand<"SourceDocumentId">();
export type SourceDocumentId = z.infer<typeof SourceDocumentIdSchema>;

export const TriageRunIdSchema = printableAsciiId.brand<"TriageRunId">();
export type TriageRunId = z.infer<typeof TriageRunIdSchema>;
