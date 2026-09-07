import {
  AttemptClaimIdSchema,
  AttemptWorkItemIdSchema,
  CandidateDocumentIdSchema,
  CandidateIdSchema,
  CandidateTriageResultIdSchema,
  CorpusManifestIdSchema,
  ExtractionArtifactIdSchema,
  ExtractionFailureIdSchema,
  ExtractionSpecIdSchema,
  NonnegativeIntegerSchema,
  PositiveIntegerSchema,
  ResolutionActionIdSchema,
  RubricDimensionIdSchema,
  RunInputSnapshotIdSchema,
  TriageAttemptIdSchema,
  TriageRunIdSchema
} from "@recruitos/core";
import { z } from "zod";

/** Plan capacity: distinct candidates per attempt. */
export const MAXIMUM_ATTEMPT_CANDIDATES = 200;

export const TriageAttemptKindSchema = z.enum([
  "main_run",
  "variant_run",
  "candidate_correction"
]);
export type TriageAttemptKind = z.infer<typeof TriageAttemptKindSchema>;

export const TriageAttemptStatusSchema = z.enum(["in_progress", "ready", "blocked"]);
export type TriageAttemptStatus = z.infer<typeof TriageAttemptStatusSchema>;

export const AttemptWorkItemStateSchema = z.enum([
  "pending",
  "claimed",
  "succeeded",
  "reviewable_failure",
  "retryable_failure",
  "blocked_failure"
]);
export type AttemptWorkItemState = z.infer<typeof AttemptWorkItemStateSchema>;

const workItemKey = z.string().min(1).max(200);

const triageAttemptShape = {
  triageAttemptId: TriageAttemptIdSchema,
  kind: TriageAttemptKindSchema,
  snapshotId: RunInputSnapshotIdSchema,
  corpusManifestId: CorpusManifestIdSchema,
  originRunId: TriageRunIdSchema.nullable(),
  baseResultId: CandidateTriageResultIdSchema.nullable(),
  requestActionId: ResolutionActionIdSchema.nullable(),
  scopeCandidateId: CandidateIdSchema.nullable(),
  status: TriageAttemptStatusSchema,
  version: PositiveIntegerSchema,
  createdAt: NonnegativeIntegerSchema,
  updatedAt: NonnegativeIntegerSchema
};

export function isTriageAttemptKindShape(data: {
  kind: TriageAttemptKind;
  baseResultId: string | null;
  requestActionId: string | null;
  scopeCandidateId: string | null;
  updatedAt: number;
  createdAt: number;
}): boolean {
  if (data.updatedAt < data.createdAt) {
    return false;
  }
  if (data.kind === "candidate_correction") {
    return (
      data.baseResultId !== null &&
      data.requestActionId !== null &&
      data.scopeCandidateId !== null
    );
  }
  return (
    data.baseResultId === null &&
    data.requestActionId === null &&
    data.scopeCandidateId === null
  );
}

export const TriageAttemptDraftSchema = z.object(triageAttemptShape).strict();
export type TriageAttemptDraft = z.infer<typeof TriageAttemptDraftSchema>;

export const TriageAttemptSchema = z.object(triageAttemptShape).strict();
export type TriageAttempt = z.infer<typeof TriageAttemptSchema>;

const attemptWorkItemDraftShape = {
  attemptWorkItemId: AttemptWorkItemIdSchema,
  triageAttemptId: TriageAttemptIdSchema,
  workItemKey,
  manifestOrdinal: NonnegativeIntegerSchema,
  candidateId: CandidateIdSchema,
  candidateDocumentId: CandidateDocumentIdSchema,
  dimensionId: RubricDimensionIdSchema,
  extractionSpecId: ExtractionSpecIdSchema,
  createdAt: NonnegativeIntegerSchema
};

export const AttemptWorkItemDraftSchema = z.object(attemptWorkItemDraftShape).strict();
export type AttemptWorkItemDraft = z.infer<typeof AttemptWorkItemDraftSchema>;

const attemptWorkItemShape = {
  ...attemptWorkItemDraftShape,
  state: AttemptWorkItemStateSchema,
  claimId: AttemptClaimIdSchema.nullable(),
  claimedAt: NonnegativeIntegerSchema.nullable(),
  claimExpiresAt: NonnegativeIntegerSchema.nullable(),
  attemptCount: NonnegativeIntegerSchema,
  extractionArtifactId: ExtractionArtifactIdSchema.nullable(),
  extractionFailureId: ExtractionFailureIdSchema.nullable(),
  version: PositiveIntegerSchema,
  updatedAt: NonnegativeIntegerSchema
};

export const AttemptWorkItemSchema = z.object(attemptWorkItemShape).strict();
export type AttemptWorkItem = z.infer<typeof AttemptWorkItemSchema>;

export const ClaimAttemptWorkItemInputSchema = z
  .object({
    attemptWorkItemId: AttemptWorkItemIdSchema,
    claimId: AttemptClaimIdSchema,
    claimedAt: NonnegativeIntegerSchema,
    claimExpiresAt: NonnegativeIntegerSchema,
    expectedVersion: PositiveIntegerSchema
  })
  .strict();
export type ClaimAttemptWorkItemInput = z.infer<typeof ClaimAttemptWorkItemInputSchema>;

export const CompleteAttemptWorkItemInputSchema = z
  .object({
    attemptWorkItemId: AttemptWorkItemIdSchema,
    extractionArtifactId: ExtractionArtifactIdSchema,
    completedAt: NonnegativeIntegerSchema,
    expectedVersion: PositiveIntegerSchema
  })
  .strict();
export type CompleteAttemptWorkItemInput = z.infer<typeof CompleteAttemptWorkItemInputSchema>;

export const FailAttemptWorkItemInputSchema = z
  .object({
    attemptWorkItemId: AttemptWorkItemIdSchema,
    state: z.enum(["reviewable_failure", "retryable_failure", "blocked_failure"]),
    extractionFailureId: ExtractionFailureIdSchema,
    failedAt: NonnegativeIntegerSchema,
    expectedVersion: PositiveIntegerSchema
  })
  .strict();
export type FailAttemptWorkItemInput = z.infer<typeof FailAttemptWorkItemInputSchema>;
