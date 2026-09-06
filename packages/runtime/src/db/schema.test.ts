import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { auditEvents, commandReceipts } from "./schema.js";

describe("runtime Drizzle schema", () => {
  it("exposes every command receipt integrity constraint", () => {
    expect(
      getTableConfig(commandReceipts)
        .checks.map((constraint) => constraint.name)
        .sort()
    ).toEqual([
      "command_receipt_completed_at",
      "command_receipt_created_at",
      "command_receipt_expected_version",
      "command_receipt_status",
      "command_receipt_terminal_shape"
    ]);
  });

  it("exposes the neutral audit constraints and command ordering index", () => {
    const config = getTableConfig(auditEvents);
    expect(config.checks.map((constraint) => constraint.name).sort()).toEqual([
      "audit_event_actor_display_name",
      "audit_event_command_ordinal_pair",
      "audit_event_event_ordinal",
      "audit_event_name",
      "audit_event_occurred_at",
      "audit_event_payload_hash",
      "audit_event_recorded_at",
      "audit_event_version"
    ]);
    expect(config.indexes.map((index) => index.config.name)).toEqual([
      "audit_event_command_ordinal_unique"
    ]);
    expect(config.foreignKeys).toHaveLength(1);
  });
});
