import {
  ActorIdSchema,
  deriveResolutionTaskStatus,
  err,
  ok,
  type Result
} from "@recruitos/core";
import { z } from "zod";

import {
  insertAttemptWorkItem,
  insertTriageAttempt,
  prepareAttemptWorkItem,
  prepareTriageAttempt,
  readAttemptWorkItems,
  readTriageAttempt,
  type AttemptWorkItem
} from "../attempts/index.js";
import { appendAuditEvent, prepareAuditEvent } from "../audit/index.js";
import type { ImmediateTransactionContext } from "../commands/index.js";
import type { IdGenerator } from "../composition/index.js";
import { insertActor, prepareActor, readActor, SYSTEM_ACTOR_ID } from "../entities/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  insertResolutionAction,
  prepareResolutionAction,
  readResolutionAction,
  readResolutionTask,
  readResolutionTaskHead,
  readResolutionTaskStatus
} from "../resolution/index.js";
import { readCandidateHead, readCandidateTriageResult } from "../results/index.js";
import {
  runUseCaseCommand,
  type UseCaseComposition,
  type UseCaseResult
} from "./contract.js";

/**
 * Human `request_re_extraction` on an open resolution task. One command
 * transaction inserts the immutable action, version-qualifies the task head,
 * and opens a `candidate_correction` attempt scoped to that candidate. No
 * official run or run membership is created. Extraction runs later, outside
 * this writer lock.
 */

export const REQUEST_RE_EXTRACTION_COMMAND_NAME = "resolution.request_re_extraction";

const FAILED_WORK_ITEM_STATES = new Set([
  "reviewable_failure",
  "retryable_failure",
  "blocked_failure"
]);

export const RequestReExtractionPayloadSchema = z
  .object({
    resolutionTaskId: z.string().min(1),
    expectedTaskHeadVersion: z.number().int().nonnegative(),
    expectedCandidateHeadVersion: z.number().int().nonnegative()
  })
  .strict();

export const RequestReExtractionResultSchema = z
  .object({
    resolutionTaskId: z.string().min(1),
    resolutionActionId: z.string().min(1),
    triageAttemptId: z.string().min(1),
    workItemCount: z.number().int().nonnegative(),
    taskHeadVersion: z.number().int().positive(),
    derivedStatus: z.literal("open")
  })
  .strict();

export type RequestReExtractionPayload = z.infer<typeof RequestReExtractionPayloadSchema>;
export type RequestReExtractionResult = z.infer<typeof RequestReExtractionResultSchema>;

export type RequestReExtractionInput = Readonly<{
  actorId: string;
  resolutionTaskId: string;
  expectedTaskHeadVersion: number;
  expectedCandidateHeadVersion: number;
}>;

type OriginAttemptRow = Readonly<{
  originAttemptId: string;
  originRunId: string;
  snapshotId: string;
  corpusManifestId: string;
  candidateId: string;
  reasonCode: string;
  baseResultId: string;
}>;

function requestFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function versionConflict(
  table: string,
  identity: string,
  expectedVersion: number,
  actualVersion: number | null
): RuntimeError {
  return createRuntimeError("version_conflict", "Mutable head version conflict", false, {
    table,
    identity,
    expectedVersion,
    actualVersion
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function replayCommandId(idGenerator: IdGenerator, commandId: string): IdGenerator {
  let replayed = false;
  return {
    next: () => {
      if (!replayed) {
        replayed = true;
        return commandId;
      }
      return idGenerator.next();
    }
  };
}

export function requestReExtraction(
  composition: UseCaseComposition,
  input: RequestReExtractionInput
): UseCaseResult<RequestReExtractionResult> {
  if (!isObject(composition)) {
    return err(requestFailure("Invalid runtime composition"));
  }
  if (!isObject(composition.connection)) {
    return err(requestFailure("Invalid runtime composition"));
  }
  if (!isObject(composition.clock) || typeof composition.clock.now !== "function") {
    return err(requestFailure("Invalid runtime clock"));
  }
  if (!isObject(composition.idGenerator) || typeof composition.idGenerator.next !== "function") {
    return err(requestFailure("Invalid runtime id generator"));
  }
  if (!isObject(input)) {
    return err(requestFailure("Invalid request re-extraction input"));
  }
  if (typeof input.actorId !== "string" || input.actorId.trim().length === 0) {
    return err(requestFailure("Request re-extraction requires an actor id"));
  }
  if (!ActorIdSchema.safeParse(input.actorId).success) {
    return err(requestFailure("Request re-extraction requires a valid actor id"));
  }
  if (input.actorId === SYSTEM_ACTOR_ID) {
    return err(
      createRuntimeError(
        "command_conflict",
        "request_re_extraction is a human action",
        false
      )
    );
  }
  if (typeof input.resolutionTaskId !== "string" || input.resolutionTaskId.trim().length === 0) {
    return err(requestFailure("Request re-extraction requires a resolution task id"));
  }
  if (
    typeof input.expectedTaskHeadVersion !== "number" ||
    !Number.isInteger(input.expectedTaskHeadVersion) ||
    input.expectedTaskHeadVersion < 0
  ) {
    return err(requestFailure("expectedTaskHeadVersion must be a nonnegative integer"));
  }
  if (
    typeof input.expectedCandidateHeadVersion !== "number" ||
    !Number.isInteger(input.expectedCandidateHeadVersion) ||
    input.expectedCandidateHeadVersion < 0
  ) {
    return err(requestFailure("expectedCandidateHeadVersion must be a nonnegative integer"));
  }

  const createdAt = composition.clock.now();
  const commandId = composition.idGenerator.next();
  const payload: RequestReExtractionPayload = {
    resolutionTaskId: input.resolutionTaskId,
    expectedTaskHeadVersion: input.expectedTaskHeadVersion,
    expectedCandidateHeadVersion: input.expectedCandidateHeadVersion
  };

  const writingGenerator = replayCommandId(composition.idGenerator, commandId);
  return runUseCaseCommand(
    { ...composition, idGenerator: writingGenerator },
    {
      actorId: input.actorId,
      commandName: REQUEST_RE_EXTRACTION_COMMAND_NAME,
      expectedVersion: 0,
      payload,
      payloadSchema: RequestReExtractionPayloadSchema,
      resultSchema: RequestReExtractionResultSchema,
      readVersion: () => ok(0),
      mutate: (context) =>
        commitRequest({
          composition: { ...composition, idGenerator: writingGenerator },
          context,
          actorId: input.actorId,
          createdAt,
          commandId,
          payload
        })
    }
  );
}

function commitRequest(args: {
  composition: UseCaseComposition;
  context: ImmediateTransactionContext;
  actorId: string;
  createdAt: number;
  commandId: string;
  payload: RequestReExtractionPayload;
}): Result<RequestReExtractionResult, RuntimeError> {
  const { context, payload } = args;
  const nextId = () => args.composition.idGenerator.next();

  const taskResult = readResolutionTask(context, payload.resolutionTaskId);
  if (!taskResult.ok) {
    return taskResult;
  }
  if (taskResult.value === undefined) {
    return err(
      createRuntimeError("not_found", `Resolution task "${payload.resolutionTaskId}" not found`, false)
    );
  }
  const task = taskResult.value;

  const statusResult = readResolutionTaskStatus(context, payload.resolutionTaskId);
  if (!statusResult.ok) {
    return statusResult;
  }
  const status = statusResult.value ?? "open";

  const headResult = readResolutionTaskHead(context, payload.resolutionTaskId);
  if (!headResult.ok) {
    return headResult;
  }
  const actualTaskVersion = headResult.value === undefined ? 0 : headResult.value.version;
  if (actualTaskVersion !== payload.expectedTaskHeadVersion) {
    return err(
      versionConflict(
        "resolution_task_head",
        payload.resolutionTaskId,
        payload.expectedTaskHeadVersion,
        actualTaskVersion === 0 ? null : actualTaskVersion
      )
    );
  }

  if (headResult.value !== undefined) {
    const currentAction = readResolutionAction(context, headResult.value.currentActionId);
    if (!currentAction.ok) {
      return currentAction;
    }
    if (currentAction.value?.actionKind === "request_re_extraction") {
      return err(
        createRuntimeError(
          "command_conflict",
          "A re-extraction request is already in flight for this task",
          false
        )
      );
    }
  }

  if (status !== "open") {
    return err(
      createRuntimeError(
        "command_conflict",
        `Resolution task "${payload.resolutionTaskId}" is ${status}, not open`,
        false
      )
    );
  }

  const storedResult = readCandidateTriageResult(context, task.candidateResultId);
  if (!storedResult.ok) {
    return storedResult;
  }
  /* v8 ignore next 5 -- resolution_task.candidate_result_id is a non-null FK */
  if (storedResult.value === undefined) {
    return err(
      createRuntimeError("not_found", `Candidate result "${task.candidateResultId}" not found`, false)
    );
  }
  const candidateId = storedResult.value.candidateId;

  const candidateHead = readCandidateHead(context, candidateId);
  if (!candidateHead.ok) {
    return candidateHead;
  }
  /* v8 ignore next 5 -- finalize writes candidate_head before any resolution task exists */
  if (candidateHead.value === undefined) {
    return err(
      createRuntimeError("not_found", `Candidate head for "${candidateId}" not found`, false)
    );
  }
  if (candidateHead.value.version !== payload.expectedCandidateHeadVersion) {
    return err(
      versionConflict(
        "candidate_head",
        candidateId,
        payload.expectedCandidateHeadVersion,
        candidateHead.value.version
      )
    );
  }
  if (candidateHead.value.currentResultId !== task.candidateResultId) {
    return err(
      versionConflict(
        "candidate_head",
        candidateId,
        payload.expectedCandidateHeadVersion,
        candidateHead.value.version
      )
    );
  }

  const origin = loadOriginAttempt(context, payload.resolutionTaskId);
  if (!origin.ok) {
    return origin;
  }

  const originAttempt = readTriageAttempt(context, origin.value.originAttemptId);
  if (!originAttempt.ok) {
    return originAttempt;
  }
  /* v8 ignore next 8 -- the origin lookup already joined a stored triage_attempt row */
  if (originAttempt.value === undefined) {
    return err(
      createRuntimeError(
        "not_found",
        `Origin triage attempt "${origin.value.originAttemptId}" not found`,
        false
      )
    );
  }

  const originItems = readAttemptWorkItems(context, origin.value.originAttemptId);
  if (!originItems.ok) {
    return originItems;
  }
  const selected = selectCorrectionWorkItems(
    originItems.value,
    origin.value.candidateId,
    origin.value.reasonCode
  );
  if (selected.length === 0) {
    return err(requestFailure("Correction scope produced no work items"));
  }

  const actorEnsured = ensureHumanActor(context, args.actorId, args.createdAt);
  if (!actorEnsured.ok) {
    return actorEnsured;
  }

  const resolutionActionId = nextId();
  const preparedAction = prepareResolutionAction({
    resolutionActionId,
    resolutionTaskId: payload.resolutionTaskId,
    actorId: args.actorId,
    actionOrdinal: headResult.value === undefined ? 0 : actualTaskVersion,
    payload: { kind: "request_re_extraction" },
    createdAt: args.createdAt
  });
  if (!preparedAction.ok) {
    return preparedAction;
  }
  const insertedAction = insertResolutionAction(
    context,
    preparedAction.value,
    payload.expectedTaskHeadVersion
  );
  if (!insertedAction.ok) {
    return insertedAction;
  }

  const triageAttemptId = nextId();
  const preparedAttempt = prepareTriageAttempt({
    triageAttemptId,
    kind: "candidate_correction",
    snapshotId: origin.value.snapshotId,
    corpusManifestId: origin.value.corpusManifestId,
    originRunId: origin.value.originRunId,
    baseResultId: origin.value.baseResultId,
    requestActionId: resolutionActionId,
    scopeCandidateId: origin.value.candidateId,
    status: "in_progress",
    version: 1,
    createdAt: args.createdAt,
    updatedAt: args.createdAt
  });
  if (!preparedAttempt.ok) {
    return preparedAttempt;
  }
  const insertedAttempt = insertTriageAttempt(context, preparedAttempt.value);
  if (!insertedAttempt.ok) {
    return insertedAttempt;
  }

  for (const [index, item] of selected.entries()) {
    const preparedItem = prepareAttemptWorkItem({
      attemptWorkItemId: nextId(),
      triageAttemptId,
      workItemKey: item.workItemKey,
      manifestOrdinal: index,
      candidateId: item.candidateId,
      candidateDocumentId: item.candidateDocumentId,
      dimensionId: item.dimensionId,
      extractionSpecId: item.extractionSpecId,
      createdAt: args.createdAt
    });
    if (!preparedItem.ok) {
      return preparedItem;
    }
    const insertedItem = insertAttemptWorkItem(context, preparedItem.value);
    if (!insertedItem.ok) {
      return insertedItem;
    }
  }

  const audit = prepareAuditEvent(args.composition.clock, {
    auditEventId: nextId(),
    commandId: args.commandId,
    eventOrdinal: 0,
    actorId: args.actorId,
    actorDisplayName: args.actorId,
    eventName: "resolution.reextraction_requested",
    eventVersion: 1,
    occurredAt: args.createdAt,
    payload: {
      resolutionTaskId: payload.resolutionTaskId,
      resolutionActionId,
      triageAttemptId,
      candidateId,
      workItemCount: selected.length
    }
  });
  if (!audit.ok) {
    return audit;
  }
  const appended = appendAuditEvent(context, audit.value);
  if (!appended.ok) {
    return appended;
  }

  return ok({
    resolutionTaskId: payload.resolutionTaskId,
    resolutionActionId,
    triageAttemptId,
    workItemCount: selected.length,
    taskHeadVersion: payload.expectedTaskHeadVersion + 1,
    derivedStatus: deriveResolutionTaskStatus("request_re_extraction") as "open"
  });
}

function ensureHumanActor(
  context: ImmediateTransactionContext,
  actorId: string,
  createdAt: number
): Result<void, RuntimeError> {
  const existing = readActor(context, actorId);
  if (!existing.ok) {
    return existing;
  }
  if (existing.value !== undefined) {
    return ok(undefined);
  }
  const prepared = prepareActor({
    actorId,
    displayName: actorId,
    createdAt
  });
  if (!prepared.ok) {
    return prepared;
  }
  const inserted = insertActor(context, prepared.value);
  if (!inserted.ok) {
    return inserted;
  }
  return ok(undefined);
}

function loadOriginAttempt(
  context: ImmediateTransactionContext,
  resolutionTaskId: string
): Result<OriginAttemptRow, RuntimeError> {
  const row = context.nativeDatabase
    .prepare(
      `SELECT
        a.triage_attempt_id AS originAttemptId,
        run.triage_run_id AS originRunId,
        a.snapshot_id AS snapshotId,
        a.corpus_manifest_id AS corpusManifestId,
        r.candidate_id AS candidateId,
        cr.reason_code AS reasonCode,
        r.candidate_triage_result_id AS baseResultId
       FROM resolution_task t
       JOIN candidate_result_reason cr
         ON cr.candidate_result_reason_id = t.candidate_result_reason_id
       JOIN candidate_triage_result r
         ON r.candidate_triage_result_id = t.candidate_result_id
       JOIN triage_run_member m
         ON m.initial_result_id = r.candidate_triage_result_id
       JOIN triage_run run
         ON run.triage_run_id = m.triage_run_id
       JOIN triage_attempt a
         ON a.snapshot_id = run.snapshot_id
        AND a.corpus_manifest_id = run.corpus_manifest_id
        AND a.kind IN ('main_run', 'variant_run')
       WHERE t.resolution_task_id = ?
       ORDER BY CASE a.kind WHEN 'main_run' THEN 0 ELSE 1 END
       LIMIT 1`
    )
    .get(resolutionTaskId) as OriginAttemptRow | undefined;
  if (row === undefined) {
    return err(
      requestFailure("No official origin attempt exists for this resolution task")
    );
  }
  return ok(row);
}

export function selectCorrectionWorkItems(
  originItems: readonly AttemptWorkItem[],
  candidateId: string,
  reasonCode: string
): AttemptWorkItem[] {
  const scoped = originItems.filter((item) => item.candidateId === candidateId);
  const failed = scoped.filter((item) => FAILED_WORK_ITEM_STATES.has(item.state));
  if (failed.length > 0) {
    return failed;
  }
  const missingPrefix = "missing_evidence:";
  if (reasonCode.startsWith(missingPrefix)) {
    const dimensionId = reasonCode.slice(missingPrefix.length);
    const matching = scoped.filter((item) => item.dimensionId === dimensionId);
    if (matching.length > 0) {
      return matching;
    }
  }
  return [...scoped];
}
