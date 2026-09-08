import {
  ActorIdSchema,
  RUBRIC_V1,
  deriveResolutionTaskStatus,
  err,
  ok,
  type HardRequirementPolicy,
  type LockedRubric,
  type Result
} from "@recruitos/core";
import { z } from "zod";

import { readCandidateApplicationAnswerByCandidateQuestion } from "../application-answers/index.js";
import type { CandidateApplicationAnswer } from "../application-answers/index.js";
import {
  readAttemptWorkItems,
  readTriageAttempt,
  type AttemptWorkItem,
  type TriageAttempt
} from "../attempts/index.js";
import { appendAuditEvent, prepareAuditEvent, type AuditEvent } from "../audit/index.js";
import {
  runDeferredTransaction,
  type ImmediateTransactionContext
} from "../commands/index.js";
import type { IdGenerator } from "../composition/index.js";
import { SYSTEM_ACTOR_ID } from "../entities/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import type { ExtractionArtifact } from "../extraction/index.js";
import { createHardRequirementPolicyV1 } from "../policy/index.js";
import {
  insertResolutionAction,
  prepareResolutionAction,
  readResolutionAction,
  readResolutionTaskHead
} from "../resolution/index.js";
import * as candidateResults from "../results/index.js";
import { readCandidateHead } from "../results/index.js";
import { readRunInputSnapshot } from "../snapshots/index.js";
import {
  runUseCaseCommand,
  type UseCaseComposition,
  type UseCaseResult
} from "./contract.js";
import {
  groupCandidates,
  hydrateWorkItems,
  loadCandidateDocuments,
  persistCandidateResult,
  toBridgeDocument,
  type CandidateDocumentRow,
  type HydratedWorkItem
} from "./finalize-triage-run.js";

/**
 * System-only completion of a `candidate_correction` attempt. Derives the
 * superseding packet outside the writer lock, then in one command transaction
 * persists a `kind: "correction"` result, version-qualifies the candidate head,
 * records `reextraction_completed`, and projects the original task to
 * `review_required`. Identical output still creates a new result. No official
 * run or run membership is written.
 */

export const COMPLETE_RE_EXTRACTION_COMMAND_NAME = "resolution.complete_re_extraction";

const WORK_AUTHORIZATION_QUESTION_KEY = "work_authorization";

export const CompleteReExtractionPayloadSchema = z
  .object({
    triageAttemptId: z.string().min(1),
    expectedTaskHeadVersion: z.number().int().nonnegative(),
    expectedCandidateHeadVersion: z.number().int().nonnegative()
  })
  .strict();

export const CompleteReExtractionResultSchema = z
  .object({
    triageAttemptId: z.string().min(1),
    resolutionTaskId: z.string().min(1),
    resolutionActionId: z.string().min(1),
    resultId: z.string().min(1),
    baseResultId: z.string().min(1),
    candidateHeadVersion: z.number().int().positive(),
    taskHeadVersion: z.number().int().positive(),
    derivedStatus: z.literal("review_required")
  })
  .strict();

export type CompleteReExtractionPayload = z.infer<typeof CompleteReExtractionPayloadSchema>;
export type CompleteReExtractionResult = z.infer<typeof CompleteReExtractionResultSchema>;

export type CompleteReExtractionInput = Readonly<{
  actorId: string;
  triageAttemptId: string;
  expectedTaskHeadVersion: number;
  expectedCandidateHeadVersion: number;
  rubric?: LockedRubric;
}>;

type PlannedWorkItemIdentity = Readonly<{
  attemptWorkItemId: string;
  version: number;
  state: AttemptWorkItem["state"];
  candidateId: string;
  candidateDocumentId: string;
  dimensionId: string;
  extractionArtifactId: string | null;
  extractionFailureId: string | null;
}>;

type CompleteSnapshot = Readonly<{
  attempt: TriageAttempt;
  originAttempt: TriageAttempt;
  workItemIdentities: readonly PlannedWorkItemIdentity[];
  extractorVersion: string;
  frozenYearMonth: string;
  candidateId: string;
  documents: readonly CandidateDocumentRow[];
  overlay: readonly HydratedWorkItem[];
  workAuthorization: CandidateApplicationAnswer | undefined;
  resolutionTaskId: string;
}>;

type CompletePlan = Readonly<{
  attempt: TriageAttempt;
  workItemIdentities: readonly PlannedWorkItemIdentity[];
  extractorVersion: string;
  policy: HardRequirementPolicy;
  candidateId: string;
  documents: readonly CandidateDocumentRow[];
  artifacts: readonly ExtractionArtifact[];
  decision: candidateResults.CandidateDecisionOutput;
  resultId: string;
  resolutionTaskId: string;
}>;

function completeFailure(message: string): RuntimeError {
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

export function completeReExtraction(
  composition: UseCaseComposition,
  input: CompleteReExtractionInput
): UseCaseResult<CompleteReExtractionResult> {
  if (!isObject(composition)) {
    return err(completeFailure("Invalid runtime composition"));
  }
  if (!isObject(composition.connection)) {
    return err(completeFailure("Invalid runtime composition"));
  }
  if (!isObject(composition.clock) || typeof composition.clock.now !== "function") {
    return err(completeFailure("Invalid runtime clock"));
  }
  if (!isObject(composition.idGenerator) || typeof composition.idGenerator.next !== "function") {
    return err(completeFailure("Invalid runtime id generator"));
  }
  if (!isObject(input)) {
    return err(completeFailure("Invalid complete re-extraction input"));
  }
  if (typeof input.actorId !== "string" || input.actorId.trim().length === 0) {
    return err(completeFailure("Complete re-extraction requires an actor id"));
  }
  if (!ActorIdSchema.safeParse(input.actorId).success) {
    return err(completeFailure("Complete re-extraction requires a valid actor id"));
  }
  if (input.actorId !== SYSTEM_ACTOR_ID) {
    return err(
      createRuntimeError(
        "command_conflict",
        "reextraction_completed is a system-only action",
        false
      )
    );
  }
  if (typeof input.triageAttemptId !== "string" || input.triageAttemptId.trim().length === 0) {
    return err(completeFailure("Complete re-extraction requires a triage attempt id"));
  }
  if (
    typeof input.expectedTaskHeadVersion !== "number" ||
    !Number.isInteger(input.expectedTaskHeadVersion) ||
    input.expectedTaskHeadVersion < 0
  ) {
    return err(completeFailure("expectedTaskHeadVersion must be a nonnegative integer"));
  }
  if (
    typeof input.expectedCandidateHeadVersion !== "number" ||
    !Number.isInteger(input.expectedCandidateHeadVersion) ||
    input.expectedCandidateHeadVersion < 0
  ) {
    return err(completeFailure("expectedCandidateHeadVersion must be a nonnegative integer"));
  }
  if (input.rubric !== undefined && input.rubric !== RUBRIC_V1) {
    return err(completeFailure("completeReExtraction requires RUBRIC_V1"));
  }

  const rubric = input.rubric ?? RUBRIC_V1;
  const createdAt = composition.clock.now();
  const commandId = composition.idGenerator.next();
  const payload: CompleteReExtractionPayload = {
    triageAttemptId: input.triageAttemptId,
    expectedTaskHeadVersion: input.expectedTaskHeadVersion,
    expectedCandidateHeadVersion: input.expectedCandidateHeadVersion
  };

  const plan = planComplete({
    composition,
    triageAttemptId: input.triageAttemptId,
    rubric
  });
  if (!plan.ok) {
    return plan;
  }

  const audits = prepareCompleteAuditEvents({
    clock: composition.clock,
    nextId: () => composition.idGenerator.next(),
    commandId,
    actorId: input.actorId,
    createdAt,
    plan: plan.value
  });
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!audits.ok) {
    return audits;
  }

  const writingGenerator = replayCommandId(composition.idGenerator, commandId);
  return runUseCaseCommand(
    { ...composition, idGenerator: writingGenerator },
    {
      actorId: input.actorId,
      commandName: COMPLETE_RE_EXTRACTION_COMMAND_NAME,
      expectedVersion: 0,
      payload,
      payloadSchema: CompleteReExtractionPayloadSchema,
      resultSchema: CompleteReExtractionResultSchema,
      readVersion: () => ok(0),
      mutate: (context) =>
        commitComplete({
          composition: { ...composition, idGenerator: writingGenerator },
          context,
          createdAt,
          payload,
          plan: plan.value,
          auditEvents: audits.value
        })
    }
  );
}

function planComplete(args: {
  composition: UseCaseComposition;
  triageAttemptId: string;
  rubric: LockedRubric;
}): Result<CompletePlan, RuntimeError> {
  const snapshot = snapshotCompleteInputs(args.composition, args.triageAttemptId);
  if (!snapshot.ok) {
    return snapshot;
  }
  return deriveCompletePlan({
    composition: args.composition,
    snapshot: snapshot.value,
    rubric: args.rubric
  });
}

function snapshotCompleteInputs(
  composition: UseCaseComposition,
  triageAttemptId: string
): Result<CompleteSnapshot, RuntimeError> {
  return runDeferredTransaction(composition.connection, (context) => {
    const loaded = loadReadyCorrectionAttempt(context, triageAttemptId);
    if (!loaded.ok) {
      return loaded;
    }
    const { attempt, workItems, originAttempt, originItems, resolutionTaskId } = loaded.value;
    const candidateId = attempt.scopeCandidateId;
    /* v8 ignore next 4 -- loadReadyCorrectionAttempt already rejected a correction without scope */
    if (candidateId === null || attempt.baseResultId === null || attempt.requestActionId === null) {
      return err(completeFailure("Correction attempt is missing required scope fields"));
    }

    const snapshotResult = readRunInputSnapshot(context, attempt.snapshotId);
    /* v8 ignore next 3 -- store readers fail only on invalid stored rows */
    if (!snapshotResult.ok) {
      return snapshotResult;
    }
    /* v8 ignore next 5 -- triage_attempt.snapshot_id is a non-null FK */
    if (snapshotResult.value === undefined) {
      return err(
        createRuntimeError("not_found", `Run input snapshot "${attempt.snapshotId}" not found`, false)
      );
    }

    const originHydrated = hydrateWorkItems(
      context,
      originItems.filter((item) => item.candidateId === candidateId)
    );
    /* v8 ignore next 3 -- hydrateWorkItems fails only on unreachable DB-integrity faults */
    if (!originHydrated.ok) {
      return originHydrated;
    }
    const correctionHydrated = hydrateWorkItems(context, workItems);
    /* v8 ignore next 3 -- hydrateWorkItems fails only on unreachable DB-integrity faults */
    if (!correctionHydrated.ok) {
      return correctionHydrated;
    }
    const overlay = overlayWorkItems(originHydrated.value, correctionHydrated.value, candidateId);

    const documents = loadCandidateDocuments(context, candidateId);
    /* v8 ignore next 3 -- every imported demo candidate has at least one document */
    if (documents.length === 0) {
      return err(completeFailure(`Candidate "${candidateId}" has no documents`));
    }
    const workAuthResult = readCandidateApplicationAnswerByCandidateQuestion(
      context,
      candidateId,
      WORK_AUTHORIZATION_QUESTION_KEY
    );
    /* v8 ignore next 3 -- store readers fail only on invalid stored rows */
    if (!workAuthResult.ok) {
      return workAuthResult;
    }

    return ok({
      attempt,
      originAttempt,
      workItemIdentities: workItems.map(toWorkItemIdentity),
      extractorVersion: snapshotResult.value.extractorVersion,
      frozenYearMonth: snapshotResult.value.frozenDate.slice(0, 7),
      candidateId,
      documents,
      overlay,
      workAuthorization: workAuthResult.value,
      resolutionTaskId
    });
  });
}

function deriveCompletePlan(args: {
  composition: UseCaseComposition;
  snapshot: CompleteSnapshot;
  rubric: LockedRubric;
}): Result<CompletePlan, RuntimeError> {
  const policyResult = createHardRequirementPolicyV1(args.snapshot.frozenYearMonth);
  /* v8 ignore next 3 -- demo snapshots always carry a valid YYYY-MM frozen date */
  if (!policyResult.ok) {
    return policyResult;
  }

  const groups = groupCandidates(args.snapshot.overlay);
  /* v8 ignore next 3 -- overlay is built from one scoped candidate's work items */
  if (groups.length !== 1) {
    return err(completeFailure("Correction overlay must cover exactly one candidate"));
  }
  const group = groups[0]!;
  /* v8 ignore next 3 -- overlayWorkItems keeps only the attempt's scope candidate */
  if (group.candidateId !== args.snapshot.candidateId) {
    return err(completeFailure("Correction overlay candidate does not match attempt scope"));
  }

  const bridgeDocuments = args.snapshot.documents.map(toBridgeDocument);
  const decisionResult = candidateResults.deriveCandidateDecision({
    candidateId: args.snapshot.candidateId,
    documents: bridgeDocuments,
    extractions: group.extractions,
    applicationAnswers:
      args.snapshot.workAuthorization === undefined
        ? undefined
        : { workAuthorization: args.snapshot.workAuthorization },
    rawFactProposals: candidateResults.parseResumeFacts(bridgeDocuments),
    rubric: args.rubric,
    hardRequirementPolicy: policyResult.value,
    isVariant: false,
    resolutionSpanCounts: group.resolutionSpanCounts
  });
  /* v8 ignore next 3 -- overlay extractions are already trusted scheduled artifacts */
  if (!decisionResult.ok) {
    return decisionResult;
  }

  return ok({
    attempt: args.snapshot.attempt,
    workItemIdentities: args.snapshot.workItemIdentities,
    extractorVersion: args.snapshot.extractorVersion,
    policy: policyResult.value,
    candidateId: args.snapshot.candidateId,
    documents: args.snapshot.documents,
    artifacts: group.artifacts,
    decision: decisionResult.value,
    resultId: args.composition.idGenerator.next(),
    resolutionTaskId: args.snapshot.resolutionTaskId
  });
}

function commitComplete(args: {
  composition: UseCaseComposition;
  context: ImmediateTransactionContext;
  createdAt: number;
  payload: CompleteReExtractionPayload;
  plan: CompletePlan;
  auditEvents: readonly AuditEvent[];
}): Result<CompleteReExtractionResult, RuntimeError> {
  const { context, payload, plan } = args;
  const nextId = () => args.composition.idGenerator.next();

  const loaded = loadReadyCorrectionAttempt(context, plan.attempt.triageAttemptId);
  /* v8 ignore next 3 -- planComplete already loaded this attempt in a deferred snapshot */
  if (!loaded.ok) {
    return loaded;
  }
  if (loaded.value.attempt.version !== plan.attempt.version) {
    return err(
      createRuntimeError("version_conflict", "Complete plan is stale: attempt version changed", false)
    );
  }
  if (
    workItemIdentityFingerprint(loaded.value.workItems.map(toWorkItemIdentity)) !==
    workItemIdentityFingerprint(plan.workItemIdentities)
  ) {
    return err(
      createRuntimeError(
        "command_conflict",
        "Complete plan is stale: work item identities changed",
        false
      )
    );
  }

  const taskHead = readResolutionTaskHead(context, plan.resolutionTaskId);
  /* v8 ignore next 3 -- store readers fail only on invalid stored rows */
  if (!taskHead.ok) {
    return taskHead;
  }
  const actualTaskVersion = taskHead.value === undefined ? 0 : taskHead.value.version;
  if (actualTaskVersion !== payload.expectedTaskHeadVersion) {
    return err(
      versionConflict(
        "resolution_task_head",
        plan.resolutionTaskId,
        payload.expectedTaskHeadVersion,
        actualTaskVersion === 0 ? null : actualTaskVersion
      )
    );
  }

  const candidateHead = readCandidateHead(context, plan.candidateId);
  /* v8 ignore next 3 -- store readers fail only on invalid stored rows */
  if (!candidateHead.ok) {
    return candidateHead;
  }
  if (candidateHead.value === undefined) {
    return err(
      createRuntimeError("not_found", `Candidate head for "${plan.candidateId}" not found`, false)
    );
  }
  if (candidateHead.value.version !== payload.expectedCandidateHeadVersion) {
    return err(
      versionConflict(
        "candidate_head",
        plan.candidateId,
        payload.expectedCandidateHeadVersion,
        candidateHead.value.version
      )
    );
  }
  if (candidateHead.value.currentResultId !== plan.attempt.baseResultId) {
    return err(
      versionConflict(
        "candidate_head",
        plan.candidateId,
        payload.expectedCandidateHeadVersion,
        candidateHead.value.version
      )
    );
  }

  const persisted = persistCandidateResult({
    context,
    nextId,
    createdAt: args.createdAt,
    candidateId: plan.candidateId,
    documents: plan.documents,
    artifacts: plan.artifacts,
    extractorVersion: plan.extractorVersion,
    decision: plan.decision,
    resultId: plan.resultId,
    kind: "correction",
    supersedesResultId: plan.attempt.baseResultId,
    expectedCandidateHeadVersion: payload.expectedCandidateHeadVersion,
    skipExistingSpans: true
  });
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!persisted.ok) {
    return persisted;
  }

  const resolutionActionId = nextId();
  const preparedAction = prepareResolutionAction({
    resolutionActionId,
    resolutionTaskId: plan.resolutionTaskId,
    actorId: SYSTEM_ACTOR_ID,
    actionOrdinal: payload.expectedTaskHeadVersion,
    payload: {
      kind: "reextraction_completed",
      resultingResultId: plan.resultId
    },
    createdAt: args.createdAt
  });
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!preparedAction.ok) {
    return preparedAction;
  }
  const insertedAction = insertResolutionAction(
    context,
    preparedAction.value,
    payload.expectedTaskHeadVersion
  );
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!insertedAction.ok) {
    return insertedAction;
  }

  for (const event of args.auditEvents) {
    const appended = appendAuditEvent(context, event);
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!appended.ok) {
      return appended;
    }
  }

  return ok({
    triageAttemptId: plan.attempt.triageAttemptId,
    resolutionTaskId: plan.resolutionTaskId,
    resolutionActionId,
    resultId: plan.resultId,
    baseResultId: plan.attempt.baseResultId!,
    candidateHeadVersion: payload.expectedCandidateHeadVersion + 1,
    taskHeadVersion: payload.expectedTaskHeadVersion + 1,
    derivedStatus: deriveResolutionTaskStatus("reextraction_completed") as "review_required"
  });
}

function prepareCompleteAuditEvents(args: {
  clock: UseCaseComposition["clock"];
  nextId: () => string;
  commandId: string;
  actorId: string;
  createdAt: number;
  plan: CompletePlan;
}): Result<AuditEvent[], RuntimeError> {
  const published = prepareAuditEvent(args.clock, {
    auditEventId: args.nextId(),
    commandId: args.commandId,
    eventOrdinal: 0,
    actorId: args.actorId,
    actorDisplayName: args.actorId,
    eventName: "candidate.result.published",
    eventVersion: 1,
    occurredAt: args.createdAt,
    payload: {
      candidateId: args.plan.candidateId,
      resultId: args.plan.resultId,
      status: args.plan.decision.routing.status,
      availability: args.plan.decision.dimensionDerivation.availability,
      kind: "correction",
      supersedesResultId: args.plan.attempt.baseResultId
    }
  });
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!published.ok) {
    return published;
  }
  const completed = prepareAuditEvent(args.clock, {
    auditEventId: args.nextId(),
    commandId: args.commandId,
    eventOrdinal: 1,
    actorId: args.actorId,
    actorDisplayName: args.actorId,
    eventName: "resolution.reextraction_completed",
    eventVersion: 1,
    occurredAt: args.createdAt,
    payload: {
      resolutionTaskId: args.plan.resolutionTaskId,
      triageAttemptId: args.plan.attempt.triageAttemptId,
      resultId: args.plan.resultId
    }
  });
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!completed.ok) {
    return completed;
  }
  return ok([published.value, completed.value]);
}

function loadReadyCorrectionAttempt(
  context: ImmediateTransactionContext,
  triageAttemptId: string
): Result<
  {
    attempt: TriageAttempt;
    workItems: readonly AttemptWorkItem[];
    originAttempt: TriageAttempt;
    originItems: readonly AttemptWorkItem[];
    resolutionTaskId: string;
  },
  RuntimeError
> {
  const attemptResult = readTriageAttempt(context, triageAttemptId);
  /* v8 ignore next 3 -- store readers fail only on invalid stored rows */
  if (!attemptResult.ok) {
    return attemptResult;
  }
  if (attemptResult.value === undefined) {
    return err(createRuntimeError("not_found", `Triage attempt "${triageAttemptId}" not found`, false));
  }
  const attempt = attemptResult.value;
  if (attempt.kind !== "candidate_correction") {
    return err(
      createRuntimeError(
        "command_conflict",
        "completeReExtraction requires a candidate_correction attempt",
        false
      )
    );
  }
  /* v8 ignore next 3 -- candidate_correction CHECK requires scope, base result, and request action */
  if (attempt.requestActionId === null || attempt.baseResultId === null || attempt.scopeCandidateId === null) {
    return err(completeFailure("Correction attempt is missing required scope fields"));
  }

  const requestAction = readResolutionAction(context, attempt.requestActionId);
  /* v8 ignore next 3 -- store readers fail only on invalid stored rows */
  if (!requestAction.ok) {
    return requestAction;
  }
  /* v8 ignore next 9 -- request_action_id is a required FK on candidate_correction */
  if (requestAction.value === undefined) {
    return err(
      createRuntimeError(
        "not_found",
        `Request action "${attempt.requestActionId}" not found`,
        false
      )
    );
  }
  const resolutionTaskId = requestAction.value.resolutionTaskId;

  const workItemsResult = readAttemptWorkItems(context, triageAttemptId);
  /* v8 ignore next 3 -- store readers fail only on invalid stored rows */
  if (!workItemsResult.ok) {
    return workItemsResult;
  }
  const workItems = workItemsResult.value;
  if (workItems.length === 0) {
    return err(completeFailure(`Correction attempt "${triageAttemptId}" has no work items`));
  }
  const blocked = workItems.find((item) => item.state === "blocked_failure");
  if (blocked !== undefined) {
    return err(
      completeFailure(`Cannot complete while work item ${blocked.attemptWorkItemId} is blocked_failure`)
    );
  }
  const unfinished = workItems.find(
    (item) => item.state !== "succeeded" && item.state !== "reviewable_failure"
  );
  if (unfinished !== undefined) {
    return err(
      completeFailure(
        `Cannot complete while work item ${unfinished.attemptWorkItemId} is ${unfinished.state}`
      )
    );
  }

  const origin = loadOriginAttemptFromBase(context, attempt.baseResultId, attempt.scopeCandidateId);
  if (!origin.ok) {
    return origin;
  }
  const originAttempt = readTriageAttempt(context, origin.value);
  /* v8 ignore next 3 -- store readers fail only on invalid stored rows */
  if (!originAttempt.ok) {
    return originAttempt;
  }
  /* v8 ignore next 3 -- the origin lookup already joined a stored triage_attempt row */
  if (originAttempt.value === undefined) {
    return err(createRuntimeError("not_found", `Origin triage attempt "${origin.value}" not found`, false));
  }
  const originItems = readAttemptWorkItems(context, origin.value);
  /* v8 ignore next 3 -- store readers fail only on invalid stored rows */
  if (!originItems.ok) {
    return originItems;
  }

  return ok({
    attempt,
    workItems,
    originAttempt: originAttempt.value,
    originItems: originItems.value,
    resolutionTaskId
  });
}

function loadOriginAttemptFromBase(
  context: ImmediateTransactionContext,
  baseResultId: string,
  candidateId: string
): Result<string, RuntimeError> {
  const row = context.nativeDatabase
    .prepare(
      `SELECT a.triage_attempt_id AS originAttemptId
       FROM triage_run_member m
       JOIN triage_run run ON run.triage_run_id = m.triage_run_id
       JOIN triage_attempt a
         ON a.snapshot_id = run.snapshot_id
        AND a.corpus_manifest_id = run.corpus_manifest_id
        AND a.kind IN ('main_run', 'variant_run')
       WHERE m.initial_result_id = ? AND m.candidate_id = ?
       ORDER BY CASE a.kind WHEN 'main_run' THEN 0 ELSE 1 END
       LIMIT 1`
    )
    .get(baseResultId, candidateId) as { originAttemptId: string } | undefined;
  if (row === undefined) {
    return err(completeFailure("No official origin attempt exists for this correction"));
  }
  return ok(row.originAttemptId);
}

function overlayWorkItems(
  origin: readonly HydratedWorkItem[],
  correction: readonly HydratedWorkItem[],
  candidateId: string
): HydratedWorkItem[] {
  const byKey = new Map<string, HydratedWorkItem>();
  for (const item of origin) {
    if (item.workItem.candidateId === candidateId) {
      byKey.set(item.workItem.workItemKey, item);
    }
  }
  for (const item of correction) {
    byKey.set(item.workItem.workItemKey, item);
  }
  return [...byKey.values()];
}

function toWorkItemIdentity(item: AttemptWorkItem): PlannedWorkItemIdentity {
  return {
    attemptWorkItemId: item.attemptWorkItemId,
    version: item.version,
    state: item.state,
    candidateId: item.candidateId,
    candidateDocumentId: item.candidateDocumentId,
    dimensionId: item.dimensionId,
    extractionArtifactId: item.extractionArtifactId,
    extractionFailureId: item.extractionFailureId
  };
}

function workItemIdentityFingerprint(items: readonly PlannedWorkItemIdentity[]): string {
  return items
    .map((item) =>
      [
        item.attemptWorkItemId,
        String(item.version),
        item.state,
        item.candidateId,
        item.candidateDocumentId,
        item.dimensionId,
        item.extractionArtifactId ?? "",
        item.extractionFailureId ?? ""
      ].join("\u0000")
    )
    .sort()
    .join("\n");
}
