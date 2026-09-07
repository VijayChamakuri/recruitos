import { afterEach, describe, expect, it } from "vitest";

import {
  countRow,
  localMigrationCount,
  nativeDatabase,
  openMigratedDatabase,
  removeTemporaryDatabases
} from "./harness/database.js";

/**
 * Migration counts only mean something against a real file that a real driver
 * migrated, which is why they live in the integration lane rather than beside
 * the store unit tests they used to ride along with. Re-running `migrate()`
 * inside each case is the idempotency half of the assertion: a second pass must
 * add no table, no trigger, and no journal row.
 */

afterEach(removeTemporaryDatabases);

describe("committed migrations against a real database file", () => {
  it("applies every committed migration exactly once", async () => {
    const connection = await openMigratedDatabase("migration-history");
    const database = nativeDatabase(connection);

    expect(connection.migrate()).toEqual({ ok: true, value: undefined });
    expect(
      countRow(database, "SELECT COUNT(*) AS total FROM __drizzle_migrations")
    ).toBe(localMigrationCount());
    expect(
      database
        .prepare(
          "SELECT applied_count AS appliedCount FROM __recruitos_migration_state WHERE singleton = 1"
        )
        .get()
    ).toEqual({ appliedCount: localMigrationCount() });

    expect(connection.close().ok).toBe(true);
  });

  it("creates the command receipt table exactly once", async () => {
    const connection = await openMigratedDatabase("migration-commands");
    const database = nativeDatabase(connection);

    expect(connection.migrate()).toEqual({ ok: true, value: undefined });
    expect(
      countRow(
        database,
        `SELECT COUNT(*) AS total
         FROM sqlite_schema
         WHERE type = 'table' AND name = 'command_receipt'`
      )
    ).toBe(1);

    expect(connection.close().ok).toBe(true);
  });

  it("creates the audit envelope table and its append-only triggers exactly once", async () => {
    const connection = await openMigratedDatabase("migration-audit");
    const database = nativeDatabase(connection);

    expect(connection.migrate()).toEqual({ ok: true, value: undefined });
    expect(
      countRow(
        database,
        `SELECT COUNT(*) AS total
         FROM sqlite_schema
         WHERE name IN (
           'audit_event',
           'audit_event_reject_replace',
           'audit_event_reject_update',
           'audit_event_reject_delete'
         )`
      )
    ).toBe(4);

    expect(connection.close().ok).toBe(true);
  });

  it("creates every immutable entity table and trigger exactly once", async () => {
    const connection = await openMigratedDatabase("migration-entities");
    const database = nativeDatabase(connection);

    expect(connection.migrate()).toEqual({ ok: true, value: undefined });
    expect(
      countRow(
        database,
        `SELECT COUNT(*) AS total
         FROM sqlite_schema
         WHERE type = 'table'
           AND name IN ('actor', 'candidate', 'source_document', 'candidate_document')`
      )
    ).toBe(4);
    expect(
      countRow(
        database,
        `SELECT COUNT(*) AS total
         FROM sqlite_schema
         WHERE type = 'trigger'
           AND tbl_name IN ('actor', 'candidate', 'source_document', 'candidate_document')`
      )
    ).toBe(12);

    expect(connection.close().ok).toBe(true);
  });

  it("creates every role and rubric table and trigger exactly once", async () => {
    const connection = await openMigratedDatabase("migration-roles");
    const database = nativeDatabase(connection);

    expect(connection.migrate()).toEqual({ ok: true, value: undefined });
    expect(
      countRow(
        database,
        `SELECT COUNT(*) AS total
         FROM sqlite_schema
         WHERE type = 'table'
           AND name IN ('role', 'requirement', 'rubric', 'rubric_dimension')`
      )
    ).toBe(4);
    expect(
      countRow(
        database,
        `SELECT COUNT(*) AS total
         FROM sqlite_schema
         WHERE type = 'trigger'
           AND tbl_name IN ('role', 'requirement', 'rubric', 'rubric_dimension')`
      )
    ).toBe(12);

    expect(connection.close().ok).toBe(true);
  });
});
