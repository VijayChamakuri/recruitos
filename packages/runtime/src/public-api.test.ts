import { describe, expect, it } from "vitest";

import * as runtime from "./index.js";

describe("runtime public API", () => {
  it("exports the audit, connection, command protocol, schema, and error foundation", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "AuditEventDraftSchema",
      "AuditEventNameSchema",
      "AuditEventSchema",
      "CommandConflictReasonSchema",
      "CommandEnvelopeSchema",
      "CommandExecutionMetadataSchema",
      "CommandNameSchema",
      "CommandReceiptSchema",
      "CommandStatusSchema",
      "RuntimeDatabaseOptionsSchema",
      "RuntimeErrorSchema",
      "SqliteConfigurationSchema",
      "appendAuditEvent",
      "auditEvents",
      "commandReceipts",
      "createRuntimeError",
      "executeCommand",
      "openRuntimeDatabase",
      "readAuditEvent",
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
