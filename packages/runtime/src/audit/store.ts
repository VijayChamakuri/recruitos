import {
  AuditEventIdSchema,
  NonnegativeIntegerSchema,
  canonicalJsonStringify,
  err,
  ok,
  sha256Hex,
  type Result
} from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  AuditEventDraftSchema,
  AuditEventSchema,
  type AuditEvent
} from "./schemas.js";

export type AuditClock = Readonly<{
  now: () => number;
}>;

type AuditEventRow = Readonly<{
  auditEventId: unknown;
  commandId: unknown;
  eventOrdinal: unknown;
  actorId: unknown;
  actorDisplayName: unknown;
  eventName: unknown;
  eventVersion: unknown;
  payloadJson: unknown;
  payloadHash: unknown;
  occurredAt: unknown;
  recordedAt: unknown;
}>;

function persistenceFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function validateContext(
  context: ImmediateTransactionContext
): Result<ImmediateTransactionContext, RuntimeError> {
  if (
    typeof context !== "object" ||
    context === null ||
    typeof context.nativeDatabase !== "object" ||
    context.nativeDatabase === null ||
    context.nativeDatabase.inTransaction !== true
  ) {
    return err(persistenceFailure("Audit events require an active command transaction"));
  }
  return ok(context);
}

export function appendAuditEvent(
  context: ImmediateTransactionContext,
  clock: AuditClock,
  draftInput: unknown
): Result<AuditEvent, RuntimeError> {
  const validatedContext = validateContext(context);
  if (!validatedContext.ok) {
    return validatedContext;
  }
  if (
    typeof clock !== "object" ||
    clock === null ||
    typeof clock.now !== "function"
  ) {
    return err(persistenceFailure("Invalid audit clock"));
  }

  try {
    const draft = AuditEventDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid audit event input"));
    }
    const payloadJson = canonicalJsonStringify(draft.data.payload);
    if (!payloadJson.ok) {
      return err(persistenceFailure("Audit event payload is not canonical JSON"));
    }
    const recordedAt = NonnegativeIntegerSchema.safeParse(clock.now());
    if (!recordedAt.success) {
      return err(persistenceFailure("Audit clock returned an invalid timestamp"));
    }
    const event = AuditEventSchema.safeParse({
      auditEventId: draft.data.auditEventId,
      commandId: draft.data.commandId,
      eventOrdinal: draft.data.eventOrdinal,
      actorId: draft.data.actorId,
      actorDisplayName: draft.data.actorDisplayName,
      eventName: draft.data.eventName,
      eventVersion: draft.data.eventVersion,
      payloadJson: payloadJson.value,
      payloadHash: sha256Hex(payloadJson.value),
      occurredAt: draft.data.occurredAt,
      recordedAt: recordedAt.data
    });
    if (!event.success) {
      return err(persistenceFailure("Invalid audit event input"));
    }

    validatedContext.value.nativeDatabase
      .prepare(
        `INSERT INTO audit_event (
          audit_event_id,
          command_id,
          event_ordinal,
          actor_id,
          actor_display_name,
          event_name,
          event_version,
          payload_json,
          payload_hash,
          occurred_at,
          recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.data.auditEventId,
        event.data.commandId,
        event.data.eventOrdinal,
        event.data.actorId,
        event.data.actorDisplayName,
        event.data.eventName,
        event.data.eventVersion,
        event.data.payloadJson,
        event.data.payloadHash,
        event.data.occurredAt,
        event.data.recordedAt
      );

    return ok(Object.freeze(event.data));
  } catch {
    return err(persistenceFailure("Audit event append failed"));
  }
}

export function readAuditEvent(
  context: ImmediateTransactionContext,
  auditEventIdInput: unknown
): Result<AuditEvent | undefined, RuntimeError> {
  const validatedContext = validateContext(context);
  if (!validatedContext.ok) {
    return validatedContext;
  }

  try {
    const auditEventId = AuditEventIdSchema.safeParse(auditEventIdInput);
    if (!auditEventId.success) {
      return err(persistenceFailure("Invalid audit event ID"));
    }
    const row = validatedContext.value.nativeDatabase
      .prepare(
        `SELECT
          audit_event_id AS auditEventId,
          command_id AS commandId,
          event_ordinal AS eventOrdinal,
          actor_id AS actorId,
          actor_display_name AS actorDisplayName,
          event_name AS eventName,
          event_version AS eventVersion,
          payload_json AS payloadJson,
          payload_hash AS payloadHash,
          occurred_at AS occurredAt,
          recorded_at AS recordedAt
        FROM audit_event
        WHERE audit_event_id = ?`
      )
      .get(auditEventId.data) as AuditEventRow | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    const event = AuditEventSchema.safeParse(row);
    if (!event.success) {
      return err(persistenceFailure("Stored audit event is invalid"));
    }

    let payload: unknown;
    try {
      payload = JSON.parse(event.data.payloadJson);
    } catch {
      return err(persistenceFailure("Stored audit event payload is not valid JSON"));
    }
    const canonical = canonicalJsonStringify(payload);
    if (
      !canonical.ok ||
      canonical.value !== event.data.payloadJson ||
      sha256Hex(event.data.payloadJson) !== event.data.payloadHash
    ) {
      return err(persistenceFailure("Stored audit event failed integrity validation"));
    }
    return ok(Object.freeze(event.data));
  } catch {
    return err(persistenceFailure("Audit event read failed"));
  }
}
