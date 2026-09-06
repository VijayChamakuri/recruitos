import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { commandReceipts } from "./schema.js";

describe("command receipt Drizzle schema", () => {
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
});
