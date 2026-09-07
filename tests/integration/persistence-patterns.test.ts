import { afterEach, describe, expect, it } from "vitest";

import { ok } from "../../packages/core/src/index.js";
import {
  runImmediateTransaction,
  type ImmediateTransactionContext
} from "../../packages/runtime/src/commands/index.js";
import type { RuntimeDatabaseConnection } from "../../packages/runtime/src/db/index.js";
import {
  FIRST_MUTABLE_HEAD_VERSION,
  compareAndSetMutableHead,
  createNullableSubjectUniqueIndexes,
  defineMutableHead,
  initializeMutableHead,
  readMutableHead
} from "../../packages/runtime/src/persistence/index.js";
import {
  nativeDatabase,
  openMigratedDatabase,
  removeTemporaryDatabases
} from "./harness/database.js";
import { expectError, unwrap } from "./harness/results.js";

/**
 * Both helpers are patterns rather than tables: nothing in the product uses
 * them yet, and the migrations do not mention them. They are exercised here
 * against throwaway neutral tables created by the test itself, which is the
 * only way to prove a compare-and-set actually loses a race or that a partial
 * unique index actually refuses a duplicate.
 */

const HEAD_CONFIG = {
  tableName: "throwaway_head",
  identityColumn: "head_identity",
  pointerColumn: "head_pointer",
  versionColumn: "head_version"
};

/** Runs `work` inside a real immediate transaction and returns its value. */
function inTransaction<TValue>(
  connection: RuntimeDatabaseConnection,
  work: (context: ImmediateTransactionContext) => TValue
): TValue {
  return unwrap(runImmediateTransaction(connection, (context) => ok(work(context))));
}

/** A context that passes the transaction guard and then fails on every statement. */
const failingContext = {
  nativeDatabase: {
    inTransaction: true,
    prepare() {
      throw new Error("disk I/O error");
    }
  }
};

const closedContext = { nativeDatabase: { inTransaction: false } };

afterEach(removeTemporaryDatabases);

describe("mutable head pattern", () => {
  it("initializes, reads, and swings a head under expected-version control", async () => {
    const connection = await openMigratedDatabase("mutable-head");
    const definition = unwrap(defineMutableHead(HEAD_CONFIG));
    nativeDatabase(connection).exec(definition.createTableSql);

    inTransaction(connection, (context) => {
      expect(unwrap(initializeMutableHead(context, definition, {
        identity: "subject-1",
        pointer: "version-row-1"
      }))).toEqual({
        identity: "subject-1",
        pointer: "version-row-1",
        version: FIRST_MUTABLE_HEAD_VERSION
      });

      expect(unwrap(readMutableHead(context, definition, "subject-1"))).toEqual({
        identity: "subject-1",
        pointer: "version-row-1",
        version: 1
      });
      expect(unwrap(readMutableHead(context, definition, "subject-absent"))).toBeUndefined();

      expect(
        unwrap(
          compareAndSetMutableHead(context, definition, {
            identity: "subject-1",
            pointer: "version-row-2",
            expectedVersion: 1
          })
        )
      ).toEqual({ identity: "subject-1", pointer: "version-row-2", version: 2 });

      expect(unwrap(readMutableHead(context, definition, "subject-1"))).toEqual({
        identity: "subject-1",
        pointer: "version-row-2",
        version: 2
      });
    });

    expect(connection.close().ok).toBe(true);
  });

  it("returns version_conflict for a stale expected version and for a missing head", async () => {
    const connection = await openMigratedDatabase("mutable-head-conflict");
    const definition = unwrap(defineMutableHead(HEAD_CONFIG));
    nativeDatabase(connection).exec(definition.createTableSql);

    inTransaction(connection, (context) => {
      unwrap(
        initializeMutableHead(context, definition, {
          identity: "subject-1",
          pointer: "version-row-1"
        })
      );
      unwrap(
        compareAndSetMutableHead(context, definition, {
          identity: "subject-1",
          pointer: "version-row-2",
          expectedVersion: 1
        })
      );

      // The loser of the race still holds version 1 and must not overwrite.
      expect(
        expectError(
          compareAndSetMutableHead(context, definition, {
            identity: "subject-1",
            pointer: "version-row-3",
            expectedVersion: 1
          })
        )
      ).toEqual({
        code: "version_conflict",
        message: "Mutable head version conflict",
        retryable: false,
        details: {
          table: "throwaway_head",
          identity: "subject-1",
          expectedVersion: 1,
          actualVersion: 2
        }
      });

      expect(
        expectError(
          compareAndSetMutableHead(context, definition, {
            identity: "subject-never-initialized",
            pointer: "version-row-1",
            expectedVersion: 1
          })
        )
      ).toEqual({
        code: "version_conflict",
        message: "Mutable head version conflict",
        retryable: false,
        details: {
          table: "throwaway_head",
          identity: "subject-never-initialized",
          expectedVersion: 1,
          actualVersion: null
        }
      });

      // The pointer the winner set is still the one on disk.
      expect(unwrap(readMutableHead(context, definition, "subject-1"))).toEqual({
        identity: "subject-1",
        pointer: "version-row-2",
        version: 2
      });
    });

    expect(connection.close().ok).toBe(true);
  });

  it("refuses a second initialization of the same identity", async () => {
    const connection = await openMigratedDatabase("mutable-head-duplicate");
    const definition = unwrap(defineMutableHead(HEAD_CONFIG));
    nativeDatabase(connection).exec(definition.createTableSql);

    inTransaction(connection, (context) => {
      unwrap(
        initializeMutableHead(context, definition, {
          identity: "subject-1",
          pointer: "version-row-1"
        })
      );
      expect(
        expectError(
          initializeMutableHead(context, definition, {
            identity: "subject-1",
            pointer: "version-row-2"
          })
        )
      ).toMatchObject({
        code: "persistence_failed",
        message: "Mutable head initialization failed"
      });
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a stored row whose shape left the head contract", async () => {
    const connection = await openMigratedDatabase("mutable-head-corrupt");
    const definition = unwrap(
      defineMutableHead({
        tableName: "loose_head",
        identityColumn: "loose_identity",
        pointerColumn: "loose_pointer",
        versionColumn: "loose_version"
      })
    );
    const database = nativeDatabase(connection);

    // Deliberately not the helper's own DDL: a non-STRICT table is how on-disk
    // corruption would present a version that is not an integer.
    database.exec(`
      CREATE TABLE loose_head (
        loose_identity TEXT PRIMARY KEY NOT NULL,
        loose_pointer TEXT NOT NULL,
        loose_version TEXT NOT NULL
      );
      INSERT INTO loose_head VALUES ('subject-1', 'version-row-1', 'not-an-integer');
    `);

    inTransaction(connection, (context) => {
      expect(expectError(readMutableHead(context, definition, "subject-1"))).toMatchObject({
        code: "persistence_failed",
        message: "Stored mutable head row is invalid"
      });
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects invalid configurations, definitions, contexts, and inputs", async () => {
    const connection = await openMigratedDatabase("mutable-head-boundaries");
    const definition = unwrap(defineMutableHead(HEAD_CONFIG));
    nativeDatabase(connection).exec(definition.createTableSql);

    expect(
      expectError(defineMutableHead({ ...HEAD_CONFIG, tableName: "Throwaway Head" }))
    ).toMatchObject({ message: "Invalid mutable head configuration" });
    expect(
      expectError(
        defineMutableHead({ ...HEAD_CONFIG, pointerColumn: HEAD_CONFIG.identityColumn })
      )
    ).toMatchObject({ message: "Invalid mutable head configuration" });

    for (const operation of [
      readMutableHead,
      initializeMutableHead,
      compareAndSetMutableHead
    ]) {
      expect(expectError(operation(null, definition, "subject-1"))).toMatchObject({
        message: "Mutable heads require an active command transaction"
      });
      expect(expectError(operation(closedContext, definition, "subject-1"))).toMatchObject({
        message: "Mutable heads require an active command transaction"
      });
    }

    inTransaction(connection, (context) => {
      expect(expectError(readMutableHead(context, null, "subject-1"))).toMatchObject({
        message: "Invalid mutable head definition"
      });
      expect(
        expectError(readMutableHead(context, { ...definition }, "subject-1"))
      ).toMatchObject({ message: "Invalid mutable head definition" });
      expect(expectError(readMutableHead(context, definition, ""))).toMatchObject({
        message: "Invalid mutable head identity"
      });
      expect(
        expectError(
          initializeMutableHead(context, null, {
            identity: "subject-1",
            pointer: "version-row-1"
          })
        )
      ).toMatchObject({ message: "Invalid mutable head definition" });
      expect(
        expectError(
          compareAndSetMutableHead(context, { ...definition }, {
            identity: "subject-1",
            pointer: "version-row-2",
            expectedVersion: 1
          })
        )
      ).toMatchObject({ message: "Invalid mutable head definition" });
      expect(
        expectError(initializeMutableHead(context, definition, { identity: "subject-1" }))
      ).toMatchObject({ message: "Invalid mutable head input" });
      expect(
        expectError(
          compareAndSetMutableHead(context, definition, {
            identity: "subject-1",
            pointer: "version-row-2",
            expectedVersion: 0
          })
        )
      ).toMatchObject({ message: "Invalid mutable head input" });
    });

    expect(expectError(readMutableHead(failingContext, definition, "subject-1"))).toMatchObject(
      { message: "Mutable head read failed" }
    );
    expect(
      expectError(
        initializeMutableHead(failingContext, definition, {
          identity: "subject-1",
          pointer: "version-row-1"
        })
      )
    ).toMatchObject({ message: "Mutable head initialization failed" });
    expect(
      expectError(
        compareAndSetMutableHead(failingContext, definition, {
          identity: "subject-1",
          pointer: "version-row-1",
          expectedVersion: 1
        })
      )
    ).toMatchObject({ message: "Mutable head update failed" });

    expect(connection.close().ok).toBe(true);
  });
});

describe("nullable subject partial unique indexes", () => {
  it("enforces one row per scope with no subject and one row per scope and subject", async () => {
    const connection = await openMigratedDatabase("nullable-subject");
    const database = nativeDatabase(connection);
    database.exec(`
      CREATE TABLE throwaway_scoped_note (
        note_id TEXT PRIMARY KEY NOT NULL,
        scope_id TEXT NOT NULL,
        subject_id TEXT
      ) STRICT
    `);

    const indexes = unwrap(
      createNullableSubjectUniqueIndexes({
        tableName: "throwaway_scoped_note",
        scopeColumns: ["scope_id"],
        subjectColumn: "subject_id"
      })
    );
    expect(indexes.statements[0]).toContain('WHERE "subject_id" IS NOT NULL');
    expect(indexes.statements[1]).toContain('WHERE "subject_id" IS NULL');
    for (const statement of indexes.statements) {
      database.exec(statement);
    }

    const insert = (noteId: string, scopeId: string, subjectId: string | null): void => {
      database
        .prepare(
          "INSERT INTO throwaway_scoped_note (note_id, scope_id, subject_id) VALUES (?, ?, ?)"
        )
        .run(noteId, scopeId, subjectId);
    };

    insert("note-1", "scope-1", "subject-1");
    expect(() => insert("note-2", "scope-1", "subject-1")).toThrow(/UNIQUE constraint/u);
    insert("note-3", "scope-1", "subject-2");

    // Without the second index SQLite would accept every one of these, because
    // NULL never equals NULL in a unique index.
    insert("note-4", "scope-1", null);
    expect(() => insert("note-5", "scope-1", null)).toThrow(/UNIQUE constraint/u);
    insert("note-6", "scope-2", null);

    expect(
      database
        .prepare(
          `SELECT name
           FROM sqlite_schema
           WHERE type = 'index'
             AND tbl_name = 'throwaway_scoped_note'
             AND sql IS NOT NULL
           ORDER BY name`
        )
        .all()
    ).toEqual([
      { name: indexes.absentIndexName },
      { name: indexes.presentIndexName }
    ]);

    expect(connection.close().ok).toBe(true);
  });

  it("rejects configurations it cannot turn into safe index statements", () => {
    expect(
      expectError(
        createNullableSubjectUniqueIndexes({
          tableName: "throwaway_scoped_note",
          scopeColumns: [],
          subjectColumn: "subject_id"
        })
      )
    ).toMatchObject({ message: "Invalid nullable subject index configuration" });
    expect(
      expectError(
        createNullableSubjectUniqueIndexes({
          tableName: "throwaway_scoped_note",
          scopeColumns: ["scope_id", "scope_id"],
          subjectColumn: "subject_id"
        })
      )
    ).toMatchObject({ message: "Invalid nullable subject index configuration" });
    expect(
      expectError(
        createNullableSubjectUniqueIndexes({
          tableName: "throwaway_scoped_note",
          scopeColumns: ["scope_id", "subject_id"],
          subjectColumn: "subject_id"
        })
      )
    ).toMatchObject({ message: "Invalid nullable subject index configuration" });
    expect(
      expectError(
        createNullableSubjectUniqueIndexes({
          tableName: "a".repeat(40),
          scopeColumns: ["scope_id"],
          subjectColumn: "b".repeat(30)
        })
      )
    ).toMatchObject({
      message: "Derived nullable subject index name is not valid SQL"
    });
  });
});
