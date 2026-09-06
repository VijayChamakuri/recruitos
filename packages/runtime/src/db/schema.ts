import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
