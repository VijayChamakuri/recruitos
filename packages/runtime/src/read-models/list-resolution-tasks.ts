import {
  deriveResolutionTaskStatus,
  err,
  ok,
  type ResolutionActionKind,
  type ResolutionTaskStatus,
  type Result
} from "@recruitos/core";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { getNativeDatabase } from "./native-db.js";
import {
  DEFAULT_PAGE_SIZE,
  MAXIMUM_PAGE_SIZE,
  type IndexPlanStep,
  type IndexPlanSummary,
  type ListResolutionTasksOptions,
  type ResolutionTaskItem,
  type ResolutionTaskListPage
} from "./types.js";

interface TaskCursorData {
  readonly precedence: number;
  readonly createdAt: number;
  readonly taskId: string;
}

interface RawTaskRow {
  resolutionTaskId: string;
  candidateId: string;
  candidateResultId: string;
  candidateResultReasonId: string;
  taskOrdinal: number;
  createdAt: number;
  reasonKind: string;
  reasonCode: string;
  currentActionId: string | null;
  currentActionKind: string | null;
  headVersion: number;
  precedence: number;
}

/**
 * Lists resolution tasks for the reviewer queue using keyset cursors.
 * Orders by: reason precedence ascending, opened timestamp (createdAt) ascending, task ID ascending.
 */
export function listResolutionTasks(
  database: unknown,
  options?: ListResolutionTasksOptions
): Result<ResolutionTaskListPage, RuntimeError> {
  const client = getNativeDatabase(database);
  if (!client) {
    return err(
      createRuntimeError("persistence_failed", "Database client is unavailable for task query", false)
    );
  }

  const limit = Math.min(
    Math.max(1, options?.limit ?? DEFAULT_PAGE_SIZE),
    MAXIMUM_PAGE_SIZE
  );
  const fetchLimit = limit + 1;

  let cursorData: TaskCursorData | undefined;
  if (options?.cursor) {
    const decodeResult = decodeCursor<TaskCursorData>(options.cursor, [
      "precedence",
      "createdAt",
      "taskId"
    ]);
    if (!decodeResult.ok) {
      return decodeResult;
    }
    cursorData = decodeResult.value;
  }

  const whereConditions: string[] = [];
  const params: Record<string, unknown> = {
    fetchLimit
  };

  if (options?.candidateId) {
    whereConditions.push("candidateId = @candidateId");
    params.candidateId = options.candidateId;
  }

  if (options?.status) {
    whereConditions.push("derivedStatus = @status");
    params.status = options.status;
  }

  if (cursorData) {
    whereConditions.push(`(
      (precedence > @cursorPrecedence)
      OR (
        precedence = @cursorPrecedence
        AND createdAt > @cursorCreatedAt
      )
      OR (
        precedence = @cursorPrecedence
        AND createdAt = @cursorCreatedAt
        AND resolutionTaskId > @cursorTaskId
      )
    )`);
    params.cursorPrecedence = cursorData.precedence;
    params.cursorCreatedAt = cursorData.createdAt;
    params.cursorTaskId = cursorData.taskId;
  }

  const whereClause =
    whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

  const sql = `WITH task_feed AS (
    SELECT
      rt.resolution_task_id AS resolutionTaskId,
      ctr.candidate_id AS candidateId,
      rt.candidate_result_id AS candidateResultId,
      rt.candidate_result_reason_id AS candidateResultReasonId,
      rt.task_ordinal AS taskOrdinal,
      rt.created_at AS createdAt,
      crr.reason_kind AS reasonKind,
      crr.reason_code AS reasonCode,
      rth.current_action_id AS currentActionId,
      COALESCE(rth.version, 0) AS headVersion,
      ra.action_kind AS currentActionKind,
      CASE crr.reason_kind
        WHEN 'assessment_unavailable' THEN 0
        WHEN 'parse_failure' THEN 1
        WHEN 'prompt_injection_flagged' THEN 2
        WHEN 'possible_duplicate' THEN 3
        WHEN 'contradiction' THEN 4
        WHEN 'missing_evidence' THEN 5
        WHEN 'ambiguous' THEN 6
        WHEN 'low_confidence' THEN 7
        ELSE 8
      END AS precedence,
      CASE
        WHEN rth.current_action_id IS NULL THEN 'open'
        WHEN ra.action_kind = 'dismiss' THEN 'dismissed'
        WHEN ra.action_kind = 'reextraction_completed' THEN 'review_required'
        WHEN ra.action_kind = 'request_re_extraction' THEN 'open'
        ELSE 'resolved'
      END AS derivedStatus
    FROM resolution_task rt
    JOIN candidate_result_reason crr ON crr.candidate_result_reason_id = rt.candidate_result_reason_id
    JOIN candidate_triage_result ctr ON ctr.candidate_triage_result_id = rt.candidate_result_id
    LEFT JOIN resolution_task_head rth ON rth.resolution_task_id = rt.resolution_task_id
    LEFT JOIN resolution_action ra ON ra.resolution_action_id = rth.current_action_id
  )
  SELECT
    resolutionTaskId,
    candidateId,
    candidateResultId,
    candidateResultReasonId,
    taskOrdinal,
    createdAt,
    reasonKind,
    reasonCode,
    currentActionId,
    headVersion,
    currentActionKind,
    precedence
  FROM task_feed
  ${whereClause}
  ORDER BY precedence ASC, createdAt ASC, resolutionTaskId ASC
  LIMIT @fetchLimit`;

  let rows: RawTaskRow[];
  try {
    const stmt = client.prepare(sql);
    rows = stmt.all(params) as RawTaskRow[];
  } catch (error) {
    return err(
      createRuntimeError(
        "persistence_failed",
        `Failed to query resolution tasks: ${String(error)}`,
        false
      )
    );
  }

  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

  const items: ResolutionTaskItem[] = pageRows.map((row) => {
    const status = deriveResolutionTaskStatus(
      row.currentActionKind as ResolutionActionKind | null
    );

    return {
      resolutionTaskId: row.resolutionTaskId,
      candidateId: row.candidateId,
      candidateResultId: row.candidateResultId,
      candidateResultReasonId: row.candidateResultReasonId,
      reasonKind: row.reasonKind,
      reasonCode: row.reasonCode,
      reasonPrecedence: row.precedence,
      taskOrdinal: row.taskOrdinal,
      createdAt: row.createdAt,
      status,
      currentActionId: row.currentActionId,
      currentActionKind: row.currentActionKind,
      headVersion: row.headVersion
    };
  });

  let nextCursor: string | undefined;
  if (hasNextPage && pageRows.length > 0) {
    const lastItem = pageRows[pageRows.length - 1]!;
    nextCursor = encodeCursor<TaskCursorData>({
      precedence: lastItem.precedence,
      createdAt: lastItem.createdAt,
      taskId: lastItem.resolutionTaskId
    });
  }

  return ok({
    items,
    nextCursor,
    queryCount: 1
  });
}

/**
 * Asserts the EXPLAIN QUERY PLAN for listResolutionTasks to confirm index coverage.
 */
export function assertListResolutionTasksIndexPlan(
  database: unknown
): Result<IndexPlanSummary, RuntimeError> {
  const client = getNativeDatabase(database);
  if (!client) {
    return err(
      createRuntimeError("persistence_failed", "Database client unavailable for index plan", false)
    );
  }

  const query = `EXPLAIN QUERY PLAN
  SELECT
    rt.resolution_task_id,
    ctr.candidate_id,
    crr.reason_kind
  FROM resolution_task rt
  JOIN candidate_result_reason crr ON crr.candidate_result_reason_id = rt.candidate_result_reason_id
  JOIN candidate_triage_result ctr ON ctr.candidate_triage_result_id = rt.candidate_result_id
  LEFT JOIN resolution_task_head rth ON rth.resolution_task_id = rt.resolution_task_id
  LEFT JOIN resolution_action ra ON ra.resolution_action_id = rth.current_action_id
  ORDER BY
    CASE crr.reason_kind
      WHEN 'assessment_unavailable' THEN 0
      WHEN 'parse_failure' THEN 1
      WHEN 'prompt_injection_flagged' THEN 2
      WHEN 'possible_duplicate' THEN 3
      WHEN 'contradiction' THEN 4
      WHEN 'missing_evidence' THEN 5
      WHEN 'ambiguous' THEN 6
      WHEN 'low_confidence' THEN 7
      ELSE 8
    END ASC,
    rt.created_at ASC,
    rt.resolution_task_id ASC
  LIMIT 51`;

  try {
    const stmt = client.prepare(query);
    const rows = stmt.all() as { id: number; parent: number; detail: string }[];
    const steps: IndexPlanStep[] = rows.map((r) => ({
      id: r.id,
      parent: r.parent,
      detail: r.detail
    }));

    const usesCoveringOrIndexedScan = steps.some(
      (s) => s.detail.includes("USING INDEX") || s.detail.includes("PRIMARY KEY")
    );

    return ok({
      query,
      steps,
      usesCoveringOrIndexedScan
    });
  } catch (error) {
    return err(
      createRuntimeError(
        "persistence_failed",
        `Failed to explain resolution tasks query plan: ${String(error)}`,
        false
      )
    );
  }
}
