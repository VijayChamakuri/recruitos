import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntime,
  type RuntimeComposition
} from "../../packages/runtime/src/composition/index.js";

/**
 * The shared composition root is what CLI, web, and eval entry points build.
 * These assertions only mean something against a real SQLite file: that
 * `createRuntime` brings up the full committed schema through the production
 * connection factory, that a second open is a clean no-op, and that state
 * written under one composition is visible to the next.
 */

type NativeStatement = Readonly<{
  run: (...parameters: readonly unknown[]) => { changes: number };
  all: (...parameters: readonly unknown[]) => unknown[];
}>;

type NativeDatabase = Readonly<{
  prepare: (sql: string) => NativeStatement;
}>;

const temporaryDirectories: string[] = [];

async function databaseFilename(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "recruitos-composition-integration-")
  );
  temporaryDirectories.push(directory);
  return join(directory, "runtime.db");
}

function nativeDatabase(runtime: RuntimeComposition): NativeDatabase {
  return (runtime.connection.database as unknown as { $client: NativeDatabase })
    .$client;
}

function tableNames(runtime: RuntimeComposition): ReadonlySet<string> {
  const rows = nativeDatabase(runtime)
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as ReadonlyArray<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("shared composition root against a real database file", () => {
  it("brings up the full committed schema on first open", async () => {
    const result = createRuntime({
      database: { filename: await databaseFilename() }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const names = tableNames(result.value);
    for (const expected of [
      "actor",
      "candidate",
      "source_document",
      "command_receipt",
      "audit_event",
      "corpus_manifest",
      "role",
      "rubric",
      "extraction_run",
      "structured_fact",
      "candidate_triage_result",
      "resolution_task",
      "proposal",
      "candidate_head",
      "candidate_result_seal",
      "__drizzle_migrations"
    ]) {
      expect(names).toContain(expected);
    }
    expect(result.value.close().ok).toBe(true);
  });

  it("re-migrates idempotently and persists state across compositions", async () => {
    const filename = await databaseFilename();

    const first = createRuntime({ database: { filename } });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error(first.error.message);
    }
    nativeDatabase(first.value)
      .prepare(
        `INSERT INTO actor (actor_id, actor_kind, display_name, created_at)
         VALUES ('actor-integration', 'human', 'Integration Actor', 1788700000000)`
      )
      .run();
    expect(first.value.close().ok).toBe(true);

    const second = createRuntime({ database: { filename } });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      throw new Error(second.error.message);
    }
    const rows = nativeDatabase(second.value)
      .prepare(
        "SELECT display_name AS displayName FROM actor WHERE actor_id = 'actor-integration'"
      )
      .all() as ReadonlyArray<{ displayName: string }>;
    expect(rows).toEqual([{ displayName: "Integration Actor" }]);
    expect(second.value.close().ok).toBe(true);
  });
});
