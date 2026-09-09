import { err, ok, type Result } from "@recruitos/core";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { getNativeDatabase } from "./native-db.js";
import {
  DEFAULT_PAGE_SIZE,
  MAXIMUM_PAGE_SIZE,
  type AuditEventItem,
  type AuditEventListPage,
  type IndexPlanStep,
  type IndexPlanSummary,
  type ListAuditEventsOptions
} from "./types.js";

interface AuditCursorData {
  readonly occurredAt: number;
  readonly commandId: string;
  readonly eventOrdinal: number;
  readonly auditEventId: string;
}

interface RawAuditRow {
  auditEventId: string;
  commandId: string | null;
  eventOrdinal: number | null;
  occurredAt: number;
  actorId: string;
  eventName: string;
  payloadHash: string;
  sortCommandId: string;
  sortEventOrdinal: number;
}

/**
 * Lists persisted audit_event rows using a keyset cursor.
 * Orders by occurred_at DESC, coalesced command_id DESC, coalesced event_ordinal
 * DESC, then audit_event_id DESC. Null command/ordinal pairs sort as empty
 * string and -1 so the keyset stays deterministic without a new index.
 */
export function listAuditEvents(
  database: unknown,
  options?: ListAuditEventsOptions
): Result<AuditEventListPage, RuntimeError> {
  const client = getNativeDatabase(database);
  if (!client) {
    return err(
      createRuntimeError(
        "persistence_failed",
        "Database client is unavailable for audit event query",
        false
      )
    );
  }

  const limit = Math.min(
    Math.max(1, options?.limit ?? DEFAULT_PAGE_SIZE),
    MAXIMUM_PAGE_SIZE
  );
  const fetchLimit = limit + 1;

  let cursorData: AuditCursorData | undefined;
  if (options?.cursor) {
    const decodeResult = decodeCursor<AuditCursorData>(options.cursor, [
      "occurredAt",
      "commandId",
      "eventOrdinal",
      "auditEventId"
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

  if (cursorData) {
    whereConditions.push(`(
      (occurred_at < @cursorOccurredAt)
      OR (
        occurred_at = @cursorOccurredAt
        AND COALESCE(command_id, '') < @cursorCommandId
      )
      OR (
        occurred_at = @cursorOccurredAt
        AND COALESCE(command_id, '') = @cursorCommandId
        AND COALESCE(event_ordinal, -1) < @cursorEventOrdinal
      )
      OR (
        occurred_at = @cursorOccurredAt
        AND COALESCE(command_id, '') = @cursorCommandId
        AND COALESCE(event_ordinal, -1) = @cursorEventOrdinal
        AND audit_event_id < @cursorAuditEventId
      )
    )`);
    params.cursorOccurredAt = cursorData.occurredAt;
    params.cursorCommandId = cursorData.commandId;
    params.cursorEventOrdinal = cursorData.eventOrdinal;
    params.cursorAuditEventId = cursorData.auditEventId;
  }

  const whereClause =
    whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

  const sql = `SELECT
    audit_event_id AS auditEventId,
    command_id AS commandId,
    event_ordinal AS eventOrdinal,
    occurred_at AS occurredAt,
    actor_id AS actorId,
    event_name AS eventName,
    payload_hash AS payloadHash,
    COALESCE(command_id, '') AS sortCommandId,
    COALESCE(event_ordinal, -1) AS sortEventOrdinal
  FROM audit_event
  ${whereClause}
  ORDER BY
    occurred_at DESC,
    COALESCE(command_id, '') DESC,
    COALESCE(event_ordinal, -1) DESC,
    audit_event_id DESC
  LIMIT @fetchLimit`;

  let rows: RawAuditRow[];
  try {
    const stmt = client.prepare(sql);
    rows = stmt.all(params) as RawAuditRow[];
  } catch (error) {
    return err(
      createRuntimeError(
        "persistence_failed",
        `Failed to query audit events: ${String(error)}`,
        false
      )
    );
  }

  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

  const items: AuditEventItem[] = pageRows.map((row) => ({
    auditEventId: row.auditEventId,
    commandId: row.commandId,
    eventOrdinal: row.eventOrdinal,
    occurredAt: row.occurredAt,
    actorId: row.actorId,
    eventName: row.eventName,
    payloadHash: row.payloadHash
  }));

  let nextCursor: string | undefined;
  if (hasNextPage && pageRows.length > 0) {
    const lastRow = pageRows[pageRows.length - 1]!;
    nextCursor = encodeCursor<AuditCursorData>({
      occurredAt: lastRow.occurredAt,
      commandId: lastRow.sortCommandId,
      eventOrdinal: lastRow.sortEventOrdinal,
      auditEventId: lastRow.auditEventId
    });
  }

  return ok({
    items,
    nextCursor,
    queryCount: 1
  });
}

/**
 * Reports EXPLAIN QUERY PLAN for listAuditEvents. The current schema has no
 * covering index on the keyset tuple. This assertion records that fact; it
 * does not add a migration.
 */
export function assertListAuditEventsIndexPlan(
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
    audit_event_id,
    command_id,
    event_ordinal,
    occurred_at
  FROM audit_event
  ORDER BY
    occurred_at DESC,
    COALESCE(command_id, '') DESC,
    COALESCE(event_ordinal, -1) DESC,
    audit_event_id DESC
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
        `Failed to explain audit events query plan: ${String(error)}`,
        false
      )
    );
  }
}
