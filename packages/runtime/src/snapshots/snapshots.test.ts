import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_JSON_MAX_NODES,
  EXTRACTION_LIMITS,
  SCORING_POLICY_V1,
  canonicalJsonStringify,
  ok,
  sha256Hex,
  type Result
} from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runImmediateTransaction, type ImmediateTransactionContext } from "../commands/index.js";
import { openRuntimeDatabase, type RuntimeDatabaseConnection } from "../db/index.js";
import { type RuntimeError } from "../errors/index.js";
import { insertRole, prepareRole } from "../roles/index.js";
import {
  hashRunInputSnapshotContent,
  insertRunInputSnapshot,
  prepareRunInputSnapshot,
  readRunInputSnapshot,
  readRunInputSnapshotByContentHash,
  validateRunInputSnapshotContent
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const TRANSACTION_REQUIRED = "Run input snapshot rows require an active command transaction";

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-run-input-snapshot-test-"));
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

function unwrap<T>(result: Result<T, RuntimeError>): T {
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

function dimension(
  ordinal: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    dimensionId: ordinal === 0 ? "evaluation_practice" : "systems_thinking",
    weight: ordinal === 0 ? 2 : 1,
    required: ordinal === 0,
    definition:
      ordinal === 0
        ? "Evidence of structured evaluation practice."
        : "Evidence of systems thinking in production work.",
    jobRelatedJustification:
      ordinal === 0
        ? "Hiring managers review evaluation quality."
        : "The role operates coupled systems.",
    ordinal,
    ...overrides
  };
}

function snapshotContent(overrides: Record<string, unknown> = {}) {
  return {
    frozenDate: "2026-09-07",
    roleId: "role-applied-ai-engineer",
    rubricVersion: "draft-v1",
    dimensions: [dimension(0), dimension(1)],
    scoringPolicy: {
      levelValues: { ...SCORING_POLICY_V1.levelValues },
      confidenceWeights: { ...SCORING_POLICY_V1.confidenceWeights },
      escalateThreshold: SCORING_POLICY_V1.escalateThreshold,
      shortlistN: SCORING_POLICY_V1.shortlistN,
      requiredFieldIds: [...SCORING_POLICY_V1.requiredFieldIds]
    },
    extractorVersion: "extractor-v1",
    promptTemplateVersion: "prompt-v1",
    limits: { ...EXTRACTION_LIMITS },
    ...overrides
  };
}

function snapshotDraft(overrides: Record<string, unknown> = {}) {
  return {
    runInputSnapshotId: "run-input-snapshot-1",
    content: snapshotContent(),
    createdAt: CREATED_AT,
    ...overrides
  };
}

function roleDraft(overrides: Record<string, unknown> = {}) {
  return {
    roleId: "role-applied-ai-engineer",
    title: "Applied AI Engineer",
    createdAt: CREATED_AT,
    ...overrides
  };
}

function seedRole(context: ImmediateTransactionContext): void {
  unwrap(insertRole(context, unwrap(prepareRole(roleDraft()))));
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("run input snapshot preparation", () => {
  it("hashes frozen date, weights, and versions independently of field and dimension order", () => {
    const snapshot = unwrap(
      prepareRunInputSnapshot(
        snapshotDraft({
          content: snapshotContent({
            extractorVersion: "  extractor-v1  ",
            dimensions: [dimension(1), dimension(0)]
          })
        })
      )
    );
    expect(snapshot.extractorVersion).toBe("extractor-v1");
    expect(snapshot.frozenDate).toBe("2026-09-07");
    expect(snapshot.content.dimensions.map((item) => item.ordinal)).toEqual([0, 1]);
    const canonicalContent = canonicalJsonStringify(snapshot.content);
    expect(canonicalContent.ok).toBe(true);
    if (canonicalContent.ok) {
      expect(snapshot.contentJson).toBe(canonicalContent.value);
    }
    expect(snapshot.contentHash).toBe(unwrap(hashRunInputSnapshotContent(snapshotContent())));
    expect(Object.isFrozen(snapshot)).toBe(true);

    const reordered = unwrap(
      hashRunInputSnapshotContent({
        limits: { ...EXTRACTION_LIMITS },
        promptTemplateVersion: "prompt-v1",
        extractorVersion: "extractor-v1",
        scoringPolicy: snapshotContent().scoringPolicy,
        dimensions: [dimension(1), dimension(0)],
        rubricVersion: "draft-v1",
        roleId: "role-applied-ai-engineer",
        frozenDate: "2026-09-07"
      })
    );
    expect(reordered).toBe(snapshot.contentHash);
    expect(
      unwrap(hashRunInputSnapshotContent(snapshotContent({ frozenDate: "2026-09-08" })))
    ).not.toBe(snapshot.contentHash);
    expect(
      unwrap(
        hashRunInputSnapshotContent(
          snapshotContent({ dimensions: [dimension(0, { weight: 3 }), dimension(1)] })
        )
      )
    ).not.toBe(snapshot.contentHash);
  });

  it("rejects invalid dates, non-v1 policy, unknown fields, and ordinal gaps", () => {
    expect(validateRunInputSnapshotContent(snapshotContent({ frozenDate: "2023-02-29" }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid run input snapshot content" })
    });
    expect(
      validateRunInputSnapshotContent(
        snapshotContent({
          scoringPolicy: {
            ...snapshotContent().scoringPolicy,
            escalateThreshold: 5400
          }
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid run input snapshot content" })
    });
    expect(validateRunInputSnapshotContent(snapshotContent({ extra: true }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid run input snapshot content" })
    });
    expect(
      validateRunInputSnapshotContent(snapshotContent({ dimensions: [dimension(1)] }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Run input snapshot dimension ordinals must start at 0"
      })
    });
    expect(
      validateRunInputSnapshotContent(
        snapshotContent({ dimensions: [dimension(0), dimension(2, { dimensionId: "systems_thinking" })] })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Run input snapshot dimension ordinals must be contiguous"
      })
    });
    expect(
      validateRunInputSnapshotContent(
        snapshotContent({
          dimensions: [dimension(0), dimension(1, { dimensionId: "evaluation_practice" })]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Run input snapshot dimension ids must be unique"
      })
    });
    expect(prepareRunInputSnapshot(snapshotDraft({ runInputSnapshotId: "" }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid run input snapshot input" })
    });
    expect(
      prepareRunInputSnapshot(snapshotDraft({ content: snapshotContent({ frozenDate: "2023-02-29" }) }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid run input snapshot content" })
    });
    expect(hashRunInputSnapshotContent(snapshotContent({ rubricVersion: "" }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid run input snapshot content" })
    });

    const oversized: Record<string, unknown> = snapshotContent();
    for (let index = 0; index < CANONICAL_JSON_MAX_NODES; index += 1) {
      oversized[`extra-${index}`] = index;
    }
    expect(hashRunInputSnapshotContent(oversized)).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Run input snapshot content is not canonical JSON"
      })
    });
  });
});

describe("run input snapshot persistence", () => {
  it("stores and reads snapshots by ID and content hash", async () => {
    const connection = await openMigratedDatabase();
    const snapshot = unwrap(prepareRunInputSnapshot(snapshotDraft()));

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRole(context);
        expect(insertRunInputSnapshot(context, snapshot)).toEqual({ ok: true, value: snapshot });
        expect(readRunInputSnapshot(context, snapshot.runInputSnapshotId)).toEqual({
          ok: true,
          value: snapshot
        });
        expect(readRunInputSnapshotByContentHash(context, snapshot.contentHash)).toEqual({
          ok: true,
          value: snapshot
        });
        expect(readRunInputSnapshot(context, "missing-snapshot")).toEqual({
          ok: true,
          value: undefined
        });
        expect(readRunInputSnapshotByContentHash(context, sha256Hex("missing"))).toEqual({
          ok: true,
          value: undefined
        });
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("rejects snapshots that lack their role or collide on content hash", async () => {
    const connection = await openMigratedDatabase();
    const snapshot = unwrap(prepareRunInputSnapshot(snapshotDraft()));
    const duplicate = unwrap(
      prepareRunInputSnapshot(snapshotDraft({ runInputSnapshotId: "run-input-snapshot-2" }))
    );

    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(insertRunInputSnapshot(context, snapshot)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Run input snapshot requires a stored role"
          })
        });
        seedRole(context);
        expect(insertRunInputSnapshot(context, snapshot).ok).toBe(true);
        expect(insertRunInputSnapshot(context, duplicate)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Run input snapshot insert failed" })
        });
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });
});

describe("run input snapshot database constraints", () => {
  it("rejects updates, deletes, and replacements of stored rows", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const snapshot = unwrap(prepareRunInputSnapshot(snapshotDraft()));

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRole(context);
        unwrap(insertRunInputSnapshot(context, snapshot));
        return ok(undefined);
      })
    );

    expect(() =>
      database.prepare("UPDATE run_input_snapshot SET rubric_version = ?").run("other")
    ).toThrow(/immutable/u);
    expect(() => database.prepare("DELETE FROM run_input_snapshot").run()).toThrow(/immutable/u);
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO run_input_snapshot (
            run_input_snapshot_id, content_json, content_hash, frozen_date, rubric_version,
            role_id, extractor_version, prompt_template_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          snapshot.runInputSnapshotId,
          snapshot.contentJson,
          snapshot.contentHash,
          snapshot.frozenDate,
          snapshot.rubricVersion,
          snapshot.roleId,
          snapshot.extractorVersion,
          snapshot.promptTemplateVersion,
          snapshot.createdAt
        )
    ).toThrow(/immutable/u);

    expect(connection.close().ok).toBe(true);
  });

  it("enforces JSON shape, unique hashes, and calendar-shaped frozen dates", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const snapshot = unwrap(prepareRunInputSnapshot(snapshotDraft()));

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRole(context);
        unwrap(insertRunInputSnapshot(context, snapshot));
        return ok(undefined);
      })
    );

    expect(() =>
      database
        .prepare(
          `INSERT INTO run_input_snapshot (
            run_input_snapshot_id, content_json, content_hash, frozen_date, rubric_version,
            role_id, extractor_version, prompt_template_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "run-input-snapshot-bad-json",
          "[]",
          sha256Hex("[]"),
          "2026-09-07",
          "draft-v1",
          "role-applied-ai-engineer",
          "extractor-v1",
          "prompt-v1",
          CREATED_AT
        )
    ).toThrow(/content_json/u);

    expect(() =>
      database
        .prepare(
          `INSERT INTO run_input_snapshot (
            run_input_snapshot_id, content_json, content_hash, frozen_date, rubric_version,
            role_id, extractor_version, prompt_template_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "run-input-snapshot-bad-date",
          snapshot.contentJson,
          sha256Hex("other-hash-body"),
          "2026-9-7",
          "draft-v1",
          "role-applied-ai-engineer",
          "extractor-v1",
          "prompt-v1",
          CREATED_AT
        )
    ).toThrow(/frozen_date/u);

    expect(connection.close().ok).toBe(true);
  });

  it("declares the run input snapshot table STRICT", async () => {
    const connection = await openMigratedDatabase();
    expect(
      nativeDatabase(connection)
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("run_input_snapshot")
    ).toEqual({ sql: expect.stringContaining("STRICT") });
    expect(connection.close().ok).toBe(true);
  });
});

describe("run input snapshot boundary failures", () => {
  it("converts hostile draft getters into typed preparation errors", () => {
    expect(
      prepareRunInputSnapshot(withThrowingGetter(snapshotDraft(), "runInputSnapshotId"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Run input snapshot preparation failed" })
    });
  });

  it("refuses every read and write outside an active transaction", () => {
    const snapshot = unwrap(prepareRunInputSnapshot(snapshotDraft()));
    const contexts = [undefined, null, {}, { nativeDatabase: null }];

    for (const context of contexts) {
      expect(insertRunInputSnapshot(context, snapshot)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readRunInputSnapshot(context, "run-input-snapshot-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readRunInputSnapshotByContentHash(context, snapshot.contentHash)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
    }
  });

  it("rejects unprepared records, invalid IDs, and storage faults", () => {
    const snapshot = unwrap(prepareRunInputSnapshot(snapshotDraft()));

    expect(insertRunInputSnapshot(failingContext(), snapshot)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Run input snapshot insert failed" })
    });
    expect(
      insertRunInputSnapshot(failingContext(), { runInputSnapshotId: "run-input-snapshot-1" })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid prepared run input snapshot" })
    });
    expect(readRunInputSnapshot(failingContext(), "run-input-snapshot-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Run input snapshot read failed" })
    });
    expect(readRunInputSnapshot(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid run input snapshot ID" })
    });
    expect(readRunInputSnapshotByContentHash(failingContext(), "not-a-hash")).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Invalid run input snapshot content hash"
      })
    });
    expect(readRunInputSnapshotByContentHash(failingContext(), snapshot.contentHash)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Run input snapshot read failed" })
    });
  });
});

describe("stored run input snapshot validation", () => {
  it("rejects a stored snapshot whose denormalized identity drifted from hashed content", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const snapshot = unwrap(prepareRunInputSnapshot(snapshotDraft()));

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRole(context);
        unwrap(insertRole(context, unwrap(prepareRole(roleDraft({ roleId: "role-other" })))));
        unwrap(insertRunInputSnapshot(context, snapshot));
        return ok(undefined);
      })
    );

    database.exec("DROP TRIGGER run_input_snapshot_reject_update");
    const columns = [
      ["frozen_date", "2026-09-08"],
      ["rubric_version", "other-v1"],
      ["extractor_version", "extractor-v2"],
      ["prompt_template_version", "prompt-v2"]
    ] as const;
    for (const [column, value] of columns) {
      database
        .prepare(
          `UPDATE run_input_snapshot SET frozen_date = ?, rubric_version = ?, extractor_version = ?, prompt_template_version = ?`
        )
        .run(
          snapshot.frozenDate,
          snapshot.rubricVersion,
          snapshot.extractorVersion,
          snapshot.promptTemplateVersion
        );
      database.prepare(`UPDATE run_input_snapshot SET ${column} = ?`).run(value);
      expect(
        runImmediateTransaction(connection, (context) =>
          readRunInputSnapshot(context, snapshot.runInputSnapshotId)
        )
      ).toEqual({
        ok: false,
        error: expect.objectContaining({
          message: "Stored run input snapshot failed integrity validation"
        })
      });
    }

    database
      .prepare(
        "UPDATE run_input_snapshot SET frozen_date = ?, rubric_version = ?, extractor_version = ?, prompt_template_version = ?"
      )
      .run(
        snapshot.frozenDate,
        snapshot.rubricVersion,
        snapshot.extractorVersion,
        snapshot.promptTemplateVersion
      );
    database.prepare("UPDATE run_input_snapshot SET role_id = ?").run("role-other");
    expect(
      runImmediateTransaction(connection, (context) =>
        readRunInputSnapshot(context, snapshot.runInputSnapshotId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored run input snapshot failed integrity validation"
      })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored snapshot content that fails integrity or schema validation", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const snapshot = unwrap(prepareRunInputSnapshot(snapshotDraft()));

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRole(context);
        unwrap(insertRunInputSnapshot(context, snapshot));
        return ok(undefined);
      })
    );

    database.exec(`
      DROP TRIGGER run_input_snapshot_reject_update;
      DROP TRIGGER run_input_snapshot_reject_delete;
      DROP TRIGGER run_input_snapshot_reject_replace;
      CREATE TABLE run_input_snapshot_rebuilt (
        run_input_snapshot_id text PRIMARY KEY NOT NULL,
        content_json text NOT NULL,
        content_hash text NOT NULL,
        frozen_date text NOT NULL,
        rubric_version text NOT NULL,
        role_id text NOT NULL,
        extractor_version text NOT NULL,
        prompt_template_version text NOT NULL,
        created_at integer NOT NULL
      ) STRICT;
      INSERT INTO run_input_snapshot_rebuilt SELECT * FROM run_input_snapshot;
      DROP TABLE run_input_snapshot;
      ALTER TABLE run_input_snapshot_rebuilt RENAME TO run_input_snapshot;
    `);
    database
      .prepare("UPDATE run_input_snapshot SET content_json = ?")
      .run("not-json");
    expect(
      runImmediateTransaction(connection, (context) =>
        readRunInputSnapshot(context, snapshot.runInputSnapshotId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored run input snapshot content is not valid JSON"
      })
    });

    const pretty = `{\n  "not": "canonical"\n}`;
    database
      .prepare("UPDATE run_input_snapshot SET content_json = ?, content_hash = ?")
      .run(pretty, sha256Hex(pretty));
    expect(
      runImmediateTransaction(connection, (context) =>
        readRunInputSnapshotByContentHash(context, sha256Hex(pretty))
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored run input snapshot failed integrity validation"
      })
    });

    const nonInteger = '{"x":1.5}';
    database
      .prepare("UPDATE run_input_snapshot SET content_json = ?, content_hash = ?")
      .run(nonInteger, sha256Hex(nonInteger));
    expect(
      runImmediateTransaction(connection, (context) =>
        readRunInputSnapshot(context, snapshot.runInputSnapshotId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored run input snapshot failed integrity validation"
      })
    });

    const invalidObject = '{"frozenDate":"2026-09-07"}';
    database
      .prepare("UPDATE run_input_snapshot SET content_json = ?, content_hash = ?")
      .run(invalidObject, sha256Hex(invalidObject));
    expect(
      runImmediateTransaction(connection, (context) =>
        readRunInputSnapshot(context, snapshot.runInputSnapshotId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored run input snapshot is invalid"
      })
    });

    expect(connection.close().ok).toBe(true);
  });
});
