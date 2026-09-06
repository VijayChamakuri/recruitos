import { sql } from "drizzle-orm";
import {
  check,
  integer,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core";

export const runtimeMigrationSmoke = sqliteTable("runtime_migration_smoke", {
  singleton: integer("singleton").primaryKey(),
  applied: integer("applied").notNull().default(1)
});

export const commandReceipts = sqliteTable(
  "command_receipt",
  {
    commandId: text("command_id").primaryKey(),
    commandName: text("command_name").notNull(),
    actorId: text("actor_id").notNull(),
    expectedVersion: integer("expected_version").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status", { enum: ["in_progress", "succeeded", "failed"] }).notNull(),
    resultJson: text("result_json"),
    resultHash: text("result_hash"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at")
  },
  (table) => [
    check("command_receipt_expected_version", sql`${table.expectedVersion} >= 0`),
    check("command_receipt_created_at", sql`${table.createdAt} >= 0`),
    check(
      "command_receipt_completed_at",
      sql`${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt}`
    ),
    check(
      "command_receipt_status",
      sql`${table.status} IN ('in_progress', 'succeeded', 'failed')`
    ),
    check(
      "command_receipt_terminal_shape",
      sql`(
        ${table.status} = 'in_progress'
        AND ${table.resultJson} IS NULL
        AND ${table.resultHash} IS NULL
        AND ${table.errorCode} IS NULL
        AND ${table.errorMessage} IS NULL
        AND ${table.completedAt} IS NULL
      ) OR (
        ${table.status} = 'succeeded'
        AND ${table.resultJson} IS NOT NULL
        AND ${table.resultHash} IS NOT NULL
        AND ${table.errorCode} IS NULL
        AND ${table.errorMessage} IS NULL
        AND ${table.completedAt} IS NOT NULL
      ) OR (
        ${table.status} = 'failed'
        AND ${table.resultJson} IS NULL
        AND ${table.resultHash} IS NULL
        AND ${table.errorCode} IS NOT NULL
        AND ${table.errorMessage} IS NOT NULL
        AND ${table.completedAt} IS NOT NULL
      )`
    )
  ]
);

export const auditEvents = sqliteTable(
  "audit_event",
  {
    auditEventId: text("audit_event_id").primaryKey(),
    commandId: text("command_id").references(() => commandReceipts.commandId),
    eventOrdinal: integer("event_ordinal"),
    actorId: text("actor_id").notNull(),
    actorDisplayName: text("actor_display_name").notNull(),
    eventName: text("event_name").notNull(),
    eventVersion: integer("event_version").notNull(),
    payloadJson: text("payload_json").notNull(),
    payloadHash: text("payload_hash").notNull(),
    occurredAt: integer("occurred_at").notNull(),
    recordedAt: integer("recorded_at").notNull()
  },
  (table) => [
    uniqueIndex("audit_event_command_ordinal_unique").on(
      table.commandId,
      table.eventOrdinal
    ),
    check(
      "audit_event_command_ordinal_pair",
      sql`(${table.commandId} IS NULL AND ${table.eventOrdinal} IS NULL) OR (${table.commandId} IS NOT NULL AND ${table.eventOrdinal} IS NOT NULL)`
    ),
    check(
      "audit_event_event_ordinal",
      sql`${table.eventOrdinal} IS NULL OR ${table.eventOrdinal} >= 0`
    ),
    check(
      "audit_event_actor_display_name",
      sql`length(${table.actorDisplayName}) BETWEEN 1 AND 200`
    ),
    check(
      "audit_event_name",
      sql`length(${table.eventName}) BETWEEN 1 AND 128`
    ),
    check("audit_event_version", sql`${table.eventVersion} > 0`),
    check(
      "audit_event_payload_hash",
      sql`length(${table.payloadHash}) = 64 AND ${table.payloadHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check("audit_event_occurred_at", sql`${table.occurredAt} >= 0`),
    check(
      "audit_event_recorded_at",
      sql`${table.recordedAt} >= ${table.occurredAt}`
    )
  ]
);
