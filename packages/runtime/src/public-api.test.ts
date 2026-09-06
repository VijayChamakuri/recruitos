import { describe, expect, it } from "vitest";

import * as runtime from "./index.js";

describe("runtime public API", () => {
  it("exports the connection, command protocol, schema, and typed error foundation", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "CommandConflictReasonSchema",
      "CommandEnvelopeSchema",
      "CommandExecutionMetadataSchema",
      "CommandNameSchema",
      "CommandReceiptSchema",
      "CommandStatusSchema",
      "RuntimeDatabaseOptionsSchema",
      "RuntimeErrorSchema",
      "SqliteConfigurationSchema",
      "commandReceipts",
      "createRuntimeError",
      "executeCommand",
      "openRuntimeDatabase",
      "runImmediateTransaction",
      "runtimeMigrationSmoke"
    ]);
  });

  it("creates errors with optional safe details", () => {
    expect(
      runtime.createRuntimeError("migration_required", "Migration required", false, {
        schemaVersion: 0
      })
    ).toEqual({
      code: "migration_required",
      message: "Migration required",
      retryable: false,
      details: { schemaVersion: 0 }
    });
  });
});
