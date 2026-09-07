import {
  ActorIdSchema,
  CandidateResultReasonIdSchema,
  CandidateTriageResultIdSchema,
  DimensionAssessmentIdSchema,
  EvidenceSpanIdSchema,
  NonnegativeIntegerSchema,
  PositiveIntegerSchema,
  ResolutionActionIdSchema,
  ResolutionActionKindSchema,
  ResolutionActionPayloadSchema,
  ResolutionTaskIdSchema,
  Sha256HexSchema
} from "@recruitos/core";
import { z } from "zod";

export {
  HUMAN_RESOLUTION_ACTION_KINDS,
  MAXIMUM_RESOLUTION_RATIONALE_LENGTH,
  RESOLUTION_ACTION_KINDS,
  RESOLUTION_TASK_STATUSES,
  ResolutionActionKindSchema,
  ResolutionActionPayloadSchema,
  ResolutionTaskStatusSchema,
  SYSTEM_RESOLUTION_ACTION_KINDS,
  deriveResolutionTaskStatus,
  isHumanResolutionActionKind
} from "@recruitos/core";

export const ResolutionTaskDraftSchema = z
  .object({
    resolutionTaskId: ResolutionTaskIdSchema,
    candidateResultId: CandidateTriageResultIdSchema,
    candidateResultReasonId: CandidateResultReasonIdSchema,
    taskOrdinal: NonnegativeIntegerSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type ResolutionTaskDraft = z.infer<typeof ResolutionTaskDraftSchema>;

export const ResolutionTaskSchema = ResolutionTaskDraftSchema;
export type ResolutionTask = z.infer<typeof ResolutionTaskSchema>;

export const ResolutionActionDraftSchema = z
  .object({
    resolutionActionId: ResolutionActionIdSchema,
    resolutionTaskId: ResolutionTaskIdSchema,
    actorId: ActorIdSchema,
    actionOrdinal: NonnegativeIntegerSchema,
    payload: ResolutionActionPayloadSchema,
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type ResolutionActionDraft = z.infer<typeof ResolutionActionDraftSchema>;

export const ResolutionActionSchema = z
  .object({
    resolutionActionId: ResolutionActionIdSchema,
    resolutionTaskId: ResolutionTaskIdSchema,
    actorId: ActorIdSchema,
    actionKind: ResolutionActionKindSchema,
    actionOrdinal: NonnegativeIntegerSchema,
    payload: ResolutionActionPayloadSchema,
    payloadJson: z.string().min(2),
    payloadHash: Sha256HexSchema,
    evidenceSpanId: EvidenceSpanIdSchema.nullable(),
    dimensionAssessmentId: DimensionAssessmentIdSchema.nullable(),
    resultingResultId: CandidateTriageResultIdSchema.nullable(),
    createdAt: NonnegativeIntegerSchema
  })
  .strict();
export type ResolutionAction = z.infer<typeof ResolutionActionSchema>;

export const ResolutionTaskHeadSchema = z
  .object({
    resolutionTaskId: ResolutionTaskIdSchema,
    currentActionId: ResolutionActionIdSchema,
    version: PositiveIntegerSchema
  })
  .strict();
export type ResolutionTaskHead = z.infer<typeof ResolutionTaskHeadSchema>;
