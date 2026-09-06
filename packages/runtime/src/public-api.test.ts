import { describe, expect, it } from "vitest";

import * as runtime from "./index.js";

describe("runtime public API", () => {
  it("exports only the connection, schema, and typed error foundation", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "RuntimeDatabaseOptionsSchema",
      "RuntimeErrorSchema",
      "SqliteConfigurationSchema",
      "createRuntimeError",
      "openRuntimeDatabase",
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
