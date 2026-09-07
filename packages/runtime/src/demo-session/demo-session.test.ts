import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SYNTHETIC_DEMO_SESSION_ID, ok, sha256Hex, type Result } from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runImmediateTransaction } from "../commands/index.js";
import { openRuntimeDatabase, type RuntimeDatabaseConnection } from "../db/index.js";
import { type RuntimeError } from "../errors/index.js";
import {
  DEMO_SESSION_EXPIRY_MS,
  DEMO_SESSION_HEARTBEAT_INTERVAL_MS,
  SYNTHETIC_DEMO_PURPOSE,
  demoSessionExpiryAt,
  insertDemoSession,
  isDemoSessionOwnershipShape,
  prepareDemoSession,
  readDemoSession,
  refreshDemoSessionHeartbeat
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const HEARTBEAT_AT = CREATED_AT + DEMO_SESSION_HEARTBEAT_INTERVAL_MS;
const SEED_HASH = sha256Hex("synthetic-demo-seed-v1");
const TRANSACTION_REQUIRED = "Demo session rows require an active command transaction";

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-demo-session-test-"));
  temporaryDirectories.push(directory);
  const opened = openRuntimeDatabase({
    filename: join(directory, "runtime.db"),
    migrationsFolder
  });
  expect(opened.ok).toBe(true);
  if (!opened.ok) {
    throw new Error(opened.error.message);
  }
  const migrated = opened.value.migrate();
  expect(migrated.ok).toBe(true);
  if (!migrated.ok) {
    throw new Error(migrated.error.message);
  }
  return opened.value;
}

function nativeDatabase(connection: RuntimeDatabaseConnection): BetterSqlite3.Database {
  return (connection.database as unknown as { $client: BetterSqlite3.Database }).$client;
}

function unwrap<T>(result: Result<T, RuntimeError> | Result<T, { message: string }>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function withThrowingGetter(
  base: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const poisoned: Record<string, unknown> = { ...base };
  Object.defineProperty(poisoned, key, {
    get() {
      throw new TypeError("hostile getter");
    },
    enumerable: true
  });
  return poisoned;
}

function failingContext(prepareImpl?: (sql: string) => unknown): object {
  return {
    nativeDatabase: {
      inTransaction: true,
      prepare(sql: string) {
        if (prepareImpl !== undefined) {
          return prepareImpl(sql);
        }
        throw new Error("disk I/O error");
      }
    }
  };
}

function idleDraft(overrides: Record<string, unknown> = {}) {
  return {
    demoSessionId: SYNTHETIC_DEMO_SESSION_ID,
    purpose: SYNTHETIC_DEMO_PURPOSE,
    generation: 1,
    webOwner: null,
    heartbeatAt: null,
    expiresAt: null,
    seedHash: SEED_HASH,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides
  };
}

function ownedDraft(overrides: Record<string, unknown> = {}) {
  return idleDraft({
    webOwner: "web-process-1",
    heartbeatAt: HEARTBEAT_AT,
    expiresAt: HEARTBEAT_AT + DEMO_SESSION_EXPIRY_MS,
    updatedAt: HEARTBEAT_AT,
    ...overrides
  });
}

function storedIdleRow() {
  return {
    demoSessionId: SYNTHETIC_DEMO_SESSION_ID,
    purpose: SYNTHETIC_DEMO_PURPOSE,
    generation: 1,
    webOwner: null,
    heartbeatAt: null,
    expiresAt: null,
    seedHash: SEED_HASH,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT
  };
}

function storedOwnedRow(overrides: Record<string, unknown> = {}) {
  return {
    ...storedIdleRow(),
    webOwner: "web-process-1",
    heartbeatAt: HEARTBEAT_AT,
    expiresAt: HEARTBEAT_AT + DEMO_SESSION_EXPIRY_MS,
    updatedAt: HEARTBEAT_AT,
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("demo session schemas", () => {
  it("pins the five-second refresh interval and fifteen-second expiry window", () => {
    expect(DEMO_SESSION_HEARTBEAT_INTERVAL_MS).toBe(5_000);
    expect(DEMO_SESSION_EXPIRY_MS).toBe(15_000);
    expect(demoSessionExpiryAt(HEARTBEAT_AT)).toBe(HEARTBEAT_AT + 15_000);
    expect(demoSessionExpiryAt(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(demoSessionExpiryAt(-DEMO_SESSION_EXPIRY_MS - 1)).toBeNull();
    expect(
      isDemoSessionOwnershipShape({
        webOwner: "web-process-1",
        heartbeatAt: HEARTBEAT_AT,
        expiresAt: HEARTBEAT_AT + 1,
        createdAt: CREATED_AT,
        updatedAt: HEARTBEAT_AT
      })
    ).toBe(false);
    expect(
      isDemoSessionOwnershipShape({
        webOwner: "web-process-1",
        heartbeatAt: null,
        expiresAt: HEARTBEAT_AT,
        createdAt: CREATED_AT,
        updatedAt: HEARTBEAT_AT
      })
    ).toBe(false);
  });
});

describe("demo session persistence", () => {
  it("prepares the idle singleton and rejects invalid or hostile drafts", () => {
    const session = unwrap(prepareDemoSession(idleDraft()));
    expect(session).toEqual(idleDraft());
    expect(Object.isFrozen(session)).toBe(true);
    expect(unwrap(prepareDemoSession(ownedDraft())).webOwner).toBe("web-process-1");

    expect(prepareDemoSession({ ...idleDraft(), extra: true })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid demo session input" })
    });
    expect(prepareDemoSession(idleDraft({ demoSessionId: "other-demo" }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid demo session input" })
    });
    expect(
      prepareDemoSession(idleDraft({ webOwner: "web-process-1", heartbeatAt: HEARTBEAT_AT }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid demo session input" })
    });
    expect(prepareDemoSession(idleDraft({ updatedAt: CREATED_AT - 1 }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid demo session input" })
    });
    expect(prepareDemoSession(withThrowingGetter(idleDraft(), "seedHash"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Demo session preparation failed" })
    });
  });

  it("inserts the idle singleton and refreshes the web heartbeat", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(unwrap(readDemoSession(context))).toBeUndefined();
        const inserted = unwrap(insertDemoSession(context, unwrap(prepareDemoSession(idleDraft()))));
        expect(inserted).toEqual(idleDraft());
        expect(unwrap(readDemoSession(context, SYNTHETIC_DEMO_SESSION_ID))).toEqual(idleDraft());

        const refreshed = unwrap(
          refreshDemoSessionHeartbeat(context, {
            expectedVersion: 1,
            webOwner: "web-process-1",
            heartbeatAt: HEARTBEAT_AT
          })
        );
        expect(refreshed).toEqual(ownedDraft({ version: 2 }));

        const sameOwner = unwrap(
          refreshDemoSessionHeartbeat(context, {
            expectedVersion: 2,
            webOwner: "web-process-1",
            heartbeatAt: HEARTBEAT_AT + DEMO_SESSION_HEARTBEAT_INTERVAL_MS
          })
        );
        expect(sameOwner.webOwner).toBe("web-process-1");
        expect(sameOwner.version).toBe(3);
        expect(sameOwner.expiresAt).toBe(
          HEARTBEAT_AT + DEMO_SESSION_HEARTBEAT_INTERVAL_MS + DEMO_SESSION_EXPIRY_MS
        );
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("lets an expired lease change owners and refuses an active foreign owner", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertDemoSession(context, unwrap(prepareDemoSession(ownedDraft()))));
        expect(
          refreshDemoSessionHeartbeat(context, {
            expectedVersion: 1,
            webOwner: "web-process-2",
            heartbeatAt: HEARTBEAT_AT + 1
          })
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            code: "demo_session_active",
            message: "Demo session web owner is active",
            details: expect.objectContaining({ webOwner: "web-process-1" })
          })
        });

        const taken = unwrap(
          refreshDemoSessionHeartbeat(context, {
            expectedVersion: 1,
            webOwner: "web-process-2",
            heartbeatAt: HEARTBEAT_AT + DEMO_SESSION_EXPIRY_MS
          })
        );
        expect(taken.webOwner).toBe("web-process-2");
        expect(taken.version).toBe(2);
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("rejects unprepared inserts, duplicates, and version conflicts", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(insertDemoSession(context, idleDraft())).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared demo session" })
        });
        unwrap(insertDemoSession(context, unwrap(prepareDemoSession(idleDraft()))));
        expect(
          insertDemoSession(context, unwrap(prepareDemoSession(idleDraft())))
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Demo session insert failed" })
        });
        expect(
          refreshDemoSessionHeartbeat(context, {
            expectedVersion: 2,
            webOwner: "web-process-1",
            heartbeatAt: HEARTBEAT_AT
          })
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            code: "version_conflict",
            message: "Demo session version conflict",
            details: expect.objectContaining({ expectedVersion: 2, actualVersion: 1 })
          })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("requires an active command transaction for insert, read, and heartbeat", () => {
    const prepared = unwrap(prepareDemoSession(idleDraft()));
    const heartbeat = {
      expectedVersion: 1,
      webOwner: "web-process-1",
      heartbeatAt: HEARTBEAT_AT
    };
    for (const contextInput of [undefined, null, {}, { nativeDatabase: null }]) {
      expect(insertDemoSession(contextInput, prepared)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readDemoSession(contextInput)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(refreshDemoSessionHeartbeat(contextInput, heartbeat)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
    }

    expect(insertDemoSession(failingContext(), prepared)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Demo session insert failed" })
    });
    expect(readDemoSession(failingContext())).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Demo session read failed" })
    });
    expect(refreshDemoSessionHeartbeat(failingContext(), heartbeat)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Demo session heartbeat failed" })
    });
  });

  it("rejects invalid IDs, heartbeat input, and missing rows", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(readDemoSession(context, "other-demo")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid demo session ID" })
        });
        expect(
          refreshDemoSessionHeartbeat(context, {
            expectedVersion: 1,
            webOwner: "web-process-1",
            heartbeatAt: HEARTBEAT_AT
          })
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            code: "not_found",
            message: "Demo session is missing"
          })
        });
        expect(
          refreshDemoSessionHeartbeat(context, {
            expectedVersion: 1,
            webOwner: "web process",
            heartbeatAt: HEARTBEAT_AT
          })
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid demo session heartbeat input" })
        });
        expect(
          refreshDemoSessionHeartbeat(context, {
            expectedVersion: 1,
            webOwner: "web-process-1",
            heartbeatAt: Number.MAX_SAFE_INTEGER
          })
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid demo session heartbeat input" })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("covers invalid stored rows and heartbeat I/O edges", () => {
    expect(
      readDemoSession(failingContext(() => ({ get: () => ({ invalid: true }) })))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored demo session is invalid" })
    });
    expect(
      readDemoSession(
        failingContext(() => ({ get: () => storedOwnedRow({ expiresAt: HEARTBEAT_AT + 1 }) }))
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored demo session is invalid" })
    });
    expect(
      refreshDemoSessionHeartbeat(failingContext(() => ({ get: () => ({ invalid: true }) })), {
        expectedVersion: 1,
        webOwner: "web-process-1",
        heartbeatAt: HEARTBEAT_AT
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored demo session is invalid" })
    });

    let reads = 0;
    expect(
      refreshDemoSessionHeartbeat(
        failingContext((sql) => {
          if (sql.includes("UPDATE")) {
            return { run() {} };
          }
          return {
            get() {
              reads += 1;
              return reads === 1 ? storedIdleRow() : undefined;
            }
          };
        }),
        {
          expectedVersion: 1,
          webOwner: "web-process-1",
          heartbeatAt: HEARTBEAT_AT
        }
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Demo session is missing after heartbeat" })
    });

    let invalidAfterUpdateReads = 0;
    expect(
      refreshDemoSessionHeartbeat(
        failingContext((sql) => {
          if (sql.includes("UPDATE")) {
            return { run() {} };
          }
          return {
            get() {
              invalidAfterUpdateReads += 1;
              return invalidAfterUpdateReads === 1 ? storedIdleRow() : { invalid: true };
            }
          };
        }),
        {
          expectedVersion: 1,
          webOwner: "web-process-1",
          heartbeatAt: HEARTBEAT_AT
        }
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored demo session is invalid" })
    });

    expect(
      refreshDemoSessionHeartbeat(
        failingContext((sql) => {
          if (sql.includes("UPDATE")) {
            throw new Error("disk I/O error");
          }
          return { get: () => storedOwnedRow() };
        }),
        {
          expectedVersion: 1,
          webOwner: "web-process-1",
          heartbeatAt: HEARTBEAT_AT
        }
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Demo session heartbeat failed" })
    });
  });

  it("keeps demo_session STRICT and restores immutability triggers", async () => {
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        const database = nativeDatabase(connection);
        expect(
          database
            .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'demo_session'")
            .pluck()
            .get()
        ).toContain("STRICT");
        const triggerNames = (
          database
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'demo_session_%' ORDER BY name"
            )
            .pluck()
            .all() as string[]
        ).sort();
        expect(triggerNames).toEqual([
          "demo_session_reject_delete",
          "demo_session_reject_pinned_update",
          "demo_session_reject_replace"
        ]);

        unwrap(insertDemoSession(context, unwrap(prepareDemoSession(idleDraft()))));
        expect(() =>
          database.exec("UPDATE demo_session SET purpose = 'other' WHERE demo_session_id = 'synthetic_demo'")
        ).toThrow(/pinned fields are immutable/u);
        expect(() =>
          database.exec("DELETE FROM demo_session WHERE demo_session_id = 'synthetic_demo'")
        ).toThrow(/cannot be deleted/u);
        expect(() =>
          database.exec(
            `INSERT INTO demo_session (
              demo_session_id, purpose, generation, web_owner, heartbeat_at, expires_at,
              seed_hash, version, created_at, updated_at
            ) VALUES (
              'other-demo', 'synthetic_demo', 1, NULL, NULL, NULL,
              '${SEED_HASH}', 1, ${CREATED_AT}, ${CREATED_AT}
            )`
          )
        ).toThrow(/CHECK/u);
        expect(() =>
          database.exec(
            `UPDATE demo_session
             SET web_owner = 'web-process-1',
                 heartbeat_at = ${HEARTBEAT_AT},
                 expires_at = ${HEARTBEAT_AT},
                 version = 2,
                 updated_at = ${HEARTBEAT_AT}
             WHERE demo_session_id = 'synthetic_demo'`
          )
        ).toThrow(/CHECK/u);
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });
});
