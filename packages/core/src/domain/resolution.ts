import { z } from "zod";

import {
  CandidateTriageResultIdSchema,
  DimensionAssessmentIdSchema,
  EvidenceSpanIdSchema
} from "./ids.js";

/**
 * Derived task status. The task row is immutable and has no status column.
 * Status is a function of the current `resolution_task_head` pointer: no
 * action means still open, `reextraction_completed` means the human must
 * review, and the remaining kinds close the task.
 */
export const RESOLUTION_TASK_STATUSES = [
  "open",
  "review_required",
  "resolved",
  "dismissed"
] as const;

export const ResolutionTaskStatusSchema = z.enum(RESOLUTION_TASK_STATUSES);
export type ResolutionTaskStatus = z.infer<typeof ResolutionTaskStatusSchema>;

export const HUMAN_RESOLUTION_ACTION_KINDS = [
  "supply_evidence_and_set_level",
  "correct_parse",
  "confirm_judgment",
  "block",
  "dismiss",
  "request_re_extraction"
] as const;

export const SYSTEM_RESOLUTION_ACTION_KINDS = ["reextraction_completed"] as const;

export const RESOLUTION_ACTION_KINDS = [
  ...HUMAN_RESOLUTION_ACTION_KINDS,
  ...SYSTEM_RESOLUTION_ACTION_KINDS
] as const;

export const ResolutionActionKindSchema = z.enum(RESOLUTION_ACTION_KINDS);
export type ResolutionActionKind = z.infer<typeof ResolutionActionKindSchema>;

export const MAXIMUM_RESOLUTION_RATIONALE_LENGTH = 2000;

const rationale = z.string().trim().min(1).max(MAXIMUM_RESOLUTION_RATIONALE_LENGTH);

export const ResolutionActionPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("supply_evidence_and_set_level"),
      evidenceSpanId: EvidenceSpanIdSchema,
      dimensionAssessmentId: DimensionAssessmentIdSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("confirm_judgment"),
      dimensionAssessmentId: DimensionAssessmentIdSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("correct_parse"),
      rationale: rationale.optional()
    })
    .strict(),
  z.object({ kind: z.literal("block"), rationale }).strict(),
  z.object({ kind: z.literal("dismiss"), rationale }).strict(),
  z.object({ kind: z.literal("request_re_extraction") }).strict(),
  z
    .object({
      kind: z.literal("reextraction_completed"),
      resultingResultId: CandidateTriageResultIdSchema
    })
    .strict()
]);

export type ResolutionActionPayload = z.infer<typeof ResolutionActionPayloadSchema>;

export function isHumanResolutionActionKind(kind: ResolutionActionKind): boolean {
  return (HUMAN_RESOLUTION_ACTION_KINDS as readonly string[]).includes(kind);
}

/**
 * Projects task status from the current action, or `open` when the head has
 * not been initialized. `request_re_extraction` stays open until the system
 * records `reextraction_completed`.
 */
export function deriveResolutionTaskStatus(
  currentActionKind: ResolutionActionKind | null
): ResolutionTaskStatus {
  if (currentActionKind === null) {
    return "open";
  }
  switch (currentActionKind) {
    case "dismiss":
      return "dismissed";
    case "reextraction_completed":
      return "review_required";
    case "request_re_extraction":
      return "open";
    case "supply_evidence_and_set_level":
    case "correct_parse":
    case "confirm_judgment":
    case "block":
      return "resolved";
  }
}
