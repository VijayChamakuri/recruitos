import {
  CandidateTriageResultIdSchema,
  NonnegativeIntegerSchema,
  ResolutionActionIdSchema,
  ResolutionTaskIdSchema,
  canonicalJsonStringify,
  deriveResolutionTaskStatus,
  err,
  ok,
  sha256Hex,
  type ResolutionActionPayload,
  type ResolutionTaskStatus,
  type Result
} from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import { SYSTEM_ACTOR_ID } from "../entities/index.js";
import {
  compareAndSetMutableHead,
  defineMutableHead,
  initializeMutableHead,
  readMutableHead,
  type MutableHeadDefinition
} from "../persistence/index.js";
import {
  ResolutionActionDraftSchema,
  ResolutionActionSchema,
  ResolutionTaskHeadSchema,
  ResolutionTaskSchema,
  type ResolutionAction,
  type ResolutionTask,
  type ResolutionTaskHead
} from "./schemas.js";

const preparedTasks = new WeakSet<object>();
const preparedActions = new WeakSet<object>();

const TASK_TRANSACTION_REQUIRED =
  "Resolution task rows require an active command transaction";
const ACTION_TRANSACTION_REQUIRED =
  "Resolution action rows require an active command transaction";
const HEAD_TRANSACTION_REQUIRED =
  "Resolution task head rows require an active command transaction";

const RESOLUTION_TASK_HEAD: MutableHeadDefinition = (
  defineMutableHead({
    tableName: "resolution_task_head",
    identityColumn: "resolution_task_id",
    pointerColumn: "current_action_id",
    versionColumn: "version"
  }) as { ok: true; value: MutableHeadDefinition }
).value;

type ActionRow = Readonly<{
  resolutionActionId: string;
  resolutionTaskId: string;
  actorId: string;
  actionKind: string;
  actionOrdinal: number;
  payloadJson: string;
  payloadHash: string;
  evidenceSpanId: string | null;
  dimensionAssessmentId: string | null;
  resultingResultId: string | null;
  createdAt: number;
}>;

const ACTION_SELECT = `SELECT
          resolution_action_id AS resolutionActionId,
          resolution_task_id AS resolutionTaskId,
          actor_id AS actorId,
          action_kind AS actionKind,
          action_ordinal AS actionOrdinal,
          payload_json AS payloadJson,
          payload_hash AS payloadHash,
          evidence_span_id AS evidenceSpanId,
          dimension_assessment_id AS dimensionAssessmentId,
          resulting_result_id AS resultingResultId,
          created_at AS createdAt
        FROM resolution_action`;

const TASK_SELECT = `SELECT
          resolution_task_id AS resolutionTaskId,
          candidate_result_id AS candidateResultId,
          candidate_result_reason_id AS candidateResultReasonId,
          task_ordinal AS taskOrdinal,
          created_at AS createdAt
        FROM resolution_task`;

function persistenceFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function versionConflict(
  identity: string,
  expectedVersion: number,
  actualVersion: number | null
): RuntimeError {
  return createRuntimeError("version_conflict", "Mutable head version conflict", false, {
    table: "resolution_task_head",
    identity,
    expectedVersion,
    actualVersion
  });
}

function validateContext(
  contextInput: unknown,
  message: string
): Result<ImmediateTransactionContext, RuntimeError> {
  if (typeof contextInput !== "object" || contextInput === null) {
    return err(persistenceFailure(message));
  }
  const context = contextInput as Partial<ImmediateTransactionContext>;
  if (
    typeof context.nativeDatabase !== "object" ||
    context.nativeDatabase === null ||
    context.nativeDatabase.inTransaction !== true
  ) {
    return err(persistenceFailure(message));
  }
  return ok(context as ImmediateTransactionContext);
}

function requirePrepared<TRecord>(
  registry: WeakSet<object>,
  preparedInput: unknown,
  message: string
): Result<TRecord, RuntimeError> {
  if (
    typeof preparedInput !== "object" ||
    preparedInput === null ||
    !registry.has(preparedInput)
  ) {
    return err(persistenceFailure(message));
  }
  return ok(preparedInput as TRecord);
}

function register<TRecord extends object>(
  registry: WeakSet<object>,
  record: TRecord
): TRecord {
  const frozen = Object.freeze(record);
  registry.add(frozen);
  return frozen;
}

function rowExists(
  context: ImmediateTransactionContext,
  sql: string,
  id: string
): boolean {
  return context.nativeDatabase.prepare(sql).get(id) !== undefined;
}

function actionColumns(payload: ResolutionActionPayload): {
  evidenceSpanId: string | null;
  dimensionAssessmentId: string | null;
  resultingResultId: string | null;
} {
  switch (payload.kind) {
    case "supply_evidence_and_set_level":
      return {
        evidenceSpanId: payload.evidenceSpanId,
        dimensionAssessmentId: payload.dimensionAssessmentId,
        resultingResultId: null
      };
    case "confirm_judgment":
      return {
        evidenceSpanId: null,
        dimensionAssessmentId: payload.dimensionAssessmentId,
        resultingResultId: null
      };
    case "reextraction_completed":
      return {
        evidenceSpanId: null,
        dimensionAssessmentId: null,
        resultingResultId: payload.resultingResultId
      };
    case "correct_parse":
    case "block":
    case "dismiss":
    case "request_re_extraction":
      return {
        evidenceSpanId: null,
        dimensionAssessmentId: null,
        resultingResultId: null
      };
  }
}

function actorMatchesKind(actorId: string, kind: ResolutionActionPayload["kind"]): boolean {
  return (kind === "reextraction_completed") === (actorId === SYSTEM_ACTOR_ID);
}

export function prepareResolutionTask(
  draftInput: unknown
): Result<ResolutionTask, RuntimeError> {
  try {
    const draft = ResolutionTaskSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid resolution task input"));
    }
    return ok(register(preparedTasks, draft.data));
  } catch {
    return err(persistenceFailure("Resolution task preparation failed"));
  }
}

export function prepareResolutionAction(
  draftInput: unknown
): Result<ResolutionAction, RuntimeError> {
  try {
    const draft = ResolutionActionDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid resolution action input"));
    }
    if (!actorMatchesKind(draft.data.actorId, draft.data.payload.kind)) {
      return err(persistenceFailure("Resolution action actor does not match action kind"));
    }
    const payloadJson = canonicalJsonStringify(draft.data.payload);
    if (!payloadJson.ok) {
      return err(persistenceFailure("Resolution action payload is not canonical JSON"));
    }
    const columns = actionColumns(draft.data.payload);
    const action = ResolutionActionSchema.safeParse({
      resolutionActionId: draft.data.resolutionActionId,
      resolutionTaskId: draft.data.resolutionTaskId,
      actorId: draft.data.actorId,
      actionKind: draft.data.payload.kind,
      actionOrdinal: draft.data.actionOrdinal,
      payload: draft.data.payload,
      payloadJson: payloadJson.value,
      payloadHash: sha256Hex(payloadJson.value),
      evidenceSpanId: columns.evidenceSpanId,
      dimensionAssessmentId: columns.dimensionAssessmentId,
      resultingResultId: columns.resultingResultId,
      createdAt: draft.data.createdAt
    });
    if (!action.success) {
      return err(persistenceFailure("Invalid resolution action input"));
    }
    return ok(register(preparedActions, action.data));
  } catch {
    return err(persistenceFailure("Resolution action preparation failed"));
  }
}

export function insertResolutionTask(
  contextInput: unknown,
  preparedInput: unknown
): Result<ResolutionTask, RuntimeError> {
  try {
    const context = validateContext(contextInput, TASK_TRANSACTION_REQUIRED);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<ResolutionTask>(
      preparedTasks,
      preparedInput,
      "Invalid prepared resolution task"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const task = prepared.value;
    if (
      !rowExists(
        context.value,
        "SELECT candidate_triage_result_id FROM candidate_triage_result WHERE candidate_triage_result_id = ?",
        task.candidateResultId
      )
    ) {
      return err(persistenceFailure("Resolution task requires a stored candidate result"));
    }
    const reason = context.value.nativeDatabase
      .prepare(
        `SELECT candidate_result_id AS candidateResultId
         FROM candidate_result_reason
         WHERE candidate_result_reason_id = ?`
      )
      .get(task.candidateResultReasonId) as { candidateResultId: string } | undefined;
    if (reason === undefined) {
      return err(persistenceFailure("Resolution task requires a stored candidate result reason"));
    }
    if (reason.candidateResultId !== task.candidateResultId) {
      return err(
        persistenceFailure("Resolution task reason must belong to the same candidate result")
      );
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO resolution_task (
          resolution_task_id,
          candidate_result_id,
          candidate_result_reason_id,
          task_ordinal,
          created_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        task.resolutionTaskId,
        task.candidateResultId,
        task.candidateResultReasonId,
        task.taskOrdinal,
        task.createdAt
      );
    return ok(task);
  } catch {
    return err(persistenceFailure("Resolution task insert failed"));
  }
}

function swingHead(
  context: ImmediateTransactionContext,
  taskId: string,
  actionId: string,
  expectedHeadVersion: number
): Result<{ identity: string; pointer: string; version: number }, RuntimeError> {
  if (expectedHeadVersion === 0) {
    return initializeMutableHead(context, RESOLUTION_TASK_HEAD, {
      identity: taskId,
      pointer: actionId
    });
  }
  return compareAndSetMutableHead(context, RESOLUTION_TASK_HEAD, {
    identity: taskId,
    pointer: actionId,
    expectedVersion: expectedHeadVersion
  });
}

export function insertResolutionAction(
  contextInput: unknown,
  preparedInput: unknown,
  expectedHeadVersionInput: unknown
): Result<ResolutionAction, RuntimeError> {
  try {
    const context = validateContext(contextInput, ACTION_TRANSACTION_REQUIRED);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<ResolutionAction>(
      preparedActions,
      preparedInput,
      "Invalid prepared resolution action"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const expectedHeadVersion = NonnegativeIntegerSchema.safeParse(expectedHeadVersionInput);
    if (!expectedHeadVersion.success) {
      return err(persistenceFailure("Invalid expected head version"));
    }
    const action = prepared.value;
    if (
      !rowExists(
        context.value,
        "SELECT resolution_task_id FROM resolution_task WHERE resolution_task_id = ?",
        action.resolutionTaskId
      )
    ) {
      return err(persistenceFailure("Resolution action requires a stored resolution task"));
    }
    if (
      !rowExists(context.value, "SELECT actor_id FROM actor WHERE actor_id = ?", action.actorId)
    ) {
      return err(persistenceFailure("Resolution action requires a stored actor"));
    }
    if (
      action.evidenceSpanId !== null &&
      !rowExists(
        context.value,
        "SELECT evidence_span_id FROM evidence_span WHERE evidence_span_id = ?",
        action.evidenceSpanId
      )
    ) {
      return err(persistenceFailure("Resolution action requires a stored evidence span"));
    }
    if (
      action.dimensionAssessmentId !== null &&
      !rowExists(
        context.value,
        "SELECT dimension_assessment_id FROM dimension_assessment WHERE dimension_assessment_id = ?",
        action.dimensionAssessmentId
      )
    ) {
      return err(persistenceFailure("Resolution action requires a stored dimension assessment"));
    }
    if (
      action.resultingResultId !== null &&
      !rowExists(
        context.value,
        "SELECT candidate_triage_result_id FROM candidate_triage_result WHERE candidate_triage_result_id = ?",
        action.resultingResultId
      )
    ) {
      return err(
        persistenceFailure("Resolution action requires a stored resulting candidate result")
      );
    }

    const currentHead = readMutableHead(
      context.value,
      RESOLUTION_TASK_HEAD,
      action.resolutionTaskId
    );
    if (!currentHead.ok) {
      return currentHead;
    }
    const actualVersion = currentHead.value === undefined ? null : currentHead.value.version;
    if (expectedHeadVersion.data === 0) {
      if (actualVersion !== null) {
        return err(versionConflict(action.resolutionTaskId, 0, actualVersion));
      }
    } else if (actualVersion !== expectedHeadVersion.data) {
      return err(
        versionConflict(action.resolutionTaskId, expectedHeadVersion.data, actualVersion)
      );
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO resolution_action (
          resolution_action_id,
          resolution_task_id,
          actor_id,
          action_kind,
          action_ordinal,
          payload_json,
          payload_hash,
          evidence_span_id,
          dimension_assessment_id,
          resulting_result_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        action.resolutionActionId,
        action.resolutionTaskId,
        action.actorId,
        action.actionKind,
        action.actionOrdinal,
        action.payloadJson,
        action.payloadHash,
        action.evidenceSpanId,
        action.dimensionAssessmentId,
        action.resultingResultId,
        action.createdAt
      );

    const swung = swingHead(
      context.value,
      action.resolutionTaskId,
      action.resolutionActionId,
      expectedHeadVersion.data
    );
    if (!swung.ok) {
      return swung;
    }
    return ok(action);
  } catch {
    return err(persistenceFailure("Resolution action insert failed"));
  }
}

function hydrateTask(row: {
  resolutionTaskId: string;
  candidateResultId: string;
  candidateResultReasonId: string;
  taskOrdinal: number;
  createdAt: number;
}): Result<ResolutionTask, RuntimeError> {
  const task = ResolutionTaskSchema.safeParse(row);
  if (!task.success) {
    return err(persistenceFailure("Stored resolution task is invalid"));
  }
  return ok(Object.freeze(task.data));
}

function hydrateAction(row: ActionRow): Result<ResolutionAction, RuntimeError> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.payloadJson);
  } catch {
    return err(persistenceFailure("Stored resolution action payload is not valid JSON"));
  }
  const canonical = canonicalJsonStringify(decoded);
  if (
    !canonical.ok ||
    canonical.value !== row.payloadJson ||
    sha256Hex(row.payloadJson) !== row.payloadHash
  ) {
    return err(persistenceFailure("Stored resolution action failed integrity validation"));
  }
  const action = ResolutionActionSchema.safeParse({
    ...row,
    payload: decoded
  });
  if (!action.success) {
    return err(persistenceFailure("Stored resolution action is invalid"));
  }
  const columns = actionColumns(action.data.payload);
  if (
    action.data.payload.kind !== action.data.actionKind ||
    columns.evidenceSpanId !== action.data.evidenceSpanId ||
    columns.dimensionAssessmentId !== action.data.dimensionAssessmentId ||
    columns.resultingResultId !== action.data.resultingResultId ||
    !actorMatchesKind(action.data.actorId, action.data.actionKind)
  ) {
    return err(persistenceFailure("Stored resolution action failed integrity validation"));
  }
  return ok(Object.freeze(action.data));
}

export function readResolutionTask(
  contextInput: unknown,
  resolutionTaskIdInput: unknown
): Result<ResolutionTask | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput, TASK_TRANSACTION_REQUIRED);
    if (!context.ok) {
      return context;
    }
    const taskId = ResolutionTaskIdSchema.safeParse(resolutionTaskIdInput);
    if (!taskId.success) {
      return err(persistenceFailure("Invalid resolution task ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${TASK_SELECT} WHERE resolution_task_id = ?`)
      .get(taskId.data) as
      | {
          resolutionTaskId: string;
          candidateResultId: string;
          candidateResultReasonId: string;
          taskOrdinal: number;
          createdAt: number;
        }
      | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    return hydrateTask(row);
  } catch {
    return err(persistenceFailure("Resolution task read failed"));
  }
}

export function readResolutionTasks(
  contextInput: unknown,
  candidateTriageResultIdInput: unknown
): Result<readonly ResolutionTask[], RuntimeError> {
  try {
    const context = validateContext(contextInput, TASK_TRANSACTION_REQUIRED);
    if (!context.ok) {
      return context;
    }
    const resultId = CandidateTriageResultIdSchema.safeParse(candidateTriageResultIdInput);
    if (!resultId.success) {
      return err(persistenceFailure("Invalid candidate result ID"));
    }
    const rows = context.value.nativeDatabase
      .prepare(
        `${TASK_SELECT}
        WHERE candidate_result_id = ?
        ORDER BY task_ordinal ASC, resolution_task_id ASC`
      )
      .all(resultId.data) as Array<{
      resolutionTaskId: string;
      candidateResultId: string;
      candidateResultReasonId: string;
      taskOrdinal: number;
      createdAt: number;
    }>;
    const tasks: ResolutionTask[] = [];
    for (const row of rows) {
      const hydrated = hydrateTask(row);
      if (!hydrated.ok) {
        return hydrated;
      }
      tasks.push(hydrated.value);
    }
    return ok(Object.freeze(tasks));
  } catch {
    return err(persistenceFailure("Resolution task read failed"));
  }
}

export function readResolutionAction(
  contextInput: unknown,
  resolutionActionIdInput: unknown
): Result<ResolutionAction | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput, ACTION_TRANSACTION_REQUIRED);
    if (!context.ok) {
      return context;
    }
    const actionId = ResolutionActionIdSchema.safeParse(resolutionActionIdInput);
    if (!actionId.success) {
      return err(persistenceFailure("Invalid resolution action ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${ACTION_SELECT} WHERE resolution_action_id = ?`)
      .get(actionId.data) as ActionRow | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    return hydrateAction(row);
  } catch {
    return err(persistenceFailure("Resolution action read failed"));
  }
}

export function readResolutionActions(
  contextInput: unknown,
  resolutionTaskIdInput: unknown
): Result<readonly ResolutionAction[], RuntimeError> {
  try {
    const context = validateContext(contextInput, ACTION_TRANSACTION_REQUIRED);
    if (!context.ok) {
      return context;
    }
    const taskId = ResolutionTaskIdSchema.safeParse(resolutionTaskIdInput);
    if (!taskId.success) {
      return err(persistenceFailure("Invalid resolution task ID"));
    }
    const rows = context.value.nativeDatabase
      .prepare(
        `${ACTION_SELECT}
        WHERE resolution_task_id = ?
        ORDER BY action_ordinal ASC, resolution_action_id ASC`
      )
      .all(taskId.data) as ActionRow[];
    const actions: ResolutionAction[] = [];
    for (const row of rows) {
      const hydrated = hydrateAction(row);
      if (!hydrated.ok) {
        return hydrated;
      }
      actions.push(hydrated.value);
    }
    return ok(Object.freeze(actions));
  } catch {
    return err(persistenceFailure("Resolution action read failed"));
  }
}

export function readResolutionTaskHead(
  contextInput: unknown,
  resolutionTaskIdInput: unknown
): Result<ResolutionTaskHead | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput, HEAD_TRANSACTION_REQUIRED);
    if (!context.ok) {
      return context;
    }
    const taskId = ResolutionTaskIdSchema.safeParse(resolutionTaskIdInput);
    if (!taskId.success) {
      return err(persistenceFailure("Invalid resolution task ID"));
    }
    const head = readMutableHead(context.value, RESOLUTION_TASK_HEAD, taskId.data);
    if (!head.ok) {
      return head;
    }
    if (head.value === undefined) {
      return ok(undefined);
    }
    const parsed = ResolutionTaskHeadSchema.safeParse({
      resolutionTaskId: head.value.identity,
      currentActionId: head.value.pointer,
      version: head.value.version
    });
    if (!parsed.success) {
      return err(persistenceFailure("Stored resolution task head is invalid"));
    }
    return ok(Object.freeze(parsed.data));
  } catch {
    return err(persistenceFailure("Resolution task head read failed"));
  }
}

export function readResolutionTaskStatus(
  contextInput: unknown,
  resolutionTaskIdInput: unknown
): Result<ResolutionTaskStatus | undefined, RuntimeError> {
  const task = readResolutionTask(contextInput, resolutionTaskIdInput);
  if (!task.ok) {
    return task;
  }
  if (task.value === undefined) {
    return ok(undefined);
  }
  const head = readResolutionTaskHead(contextInput, resolutionTaskIdInput);
  if (!head.ok) {
    return head;
  }
  if (head.value === undefined) {
    return ok(deriveResolutionTaskStatus(null));
  }
  const action = readResolutionAction(contextInput, head.value.currentActionId);
  if (!action.ok) {
    return action;
  }
  if (action.value === undefined) {
    return err(
      persistenceFailure("Resolution task head current_action_id must belong to the task")
    );
  }
  return ok(deriveResolutionTaskStatus(action.value.actionKind));
}
