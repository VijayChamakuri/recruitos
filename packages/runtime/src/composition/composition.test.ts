import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CandidateSourceAdapter, ExtractionAdapter } from "../adapters/index.js";
import {
  createIncrementingIdGenerator,
  createRuntime,
  fixedClock,
  systemClock,
  type CreateRuntimeOptions
} from "./index.js";

const temporaryDirectories: string[] = [];

async function databaseFilename(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-composition-"));
  temporaryDirectories.push(directory);
  return join(directory, "runtime.db");
}

function tableNames(runtime: {
  connection: { database: unknown };
}): string[] {
  const client = (
    runtime.connection.database as {
      $client: { prepare: (sql: string) => { all: () => unknown[] } };
    }
  ).$client;
  const rows = client
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as ReadonlyArray<{ name: string }>;
  return rows.map((row) => row.name);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("systemClock", () => {
  it("returns the host time in milliseconds", () => {
    const before = Date.now();
    const value = systemClock.now();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });
});

describe("fixedClock", () => {
  it("returns the same instant every call", () => {
    const clock = fixedClock(1_788_700_000_100);
    expect(clock.now()).toBe(1_788_700_000_100);
    expect(clock.now()).toBe(1_788_700_000_100);
  });

  it("rejects values that are not nonnegative integer milliseconds", () => {
    expect(() => fixedClock(-1)).toThrow(TypeError);
    expect(() => fixedClock(1.5)).toThrow(TypeError);
    expect(() => fixedClock(Number.NaN)).toThrow(TypeError);
  });
});

describe("createIncrementingIdGenerator", () => {
  it("yields distinct zero-padded sequential ids", () => {
    const generator = createIncrementingIdGenerator("cmd");
    expect(generator.next()).toBe("cmd-0000000001");
    expect(generator.next()).toBe("cmd-0000000002");
    expect(generator.next()).toBe("cmd-0000000003");
  });

  it("rejects an empty, non-string, or non printable ASCII prefix", () => {
    expect(() => createIncrementingIdGenerator("")).toThrow(TypeError);
    expect(() =>
      createIncrementingIdGenerator(42 as unknown as string)
    ).toThrow(TypeError);
    expect(() => createIncrementingIdGenerator("has space")).toThrow(TypeError);
  });
});

describe("createRuntime", () => {
  it("rejects a non-object options value", () => {
    expect(createRuntime(null as unknown as CreateRuntimeOptions)).toMatchObject({
      ok: false,
      error: {
        code: "persistence_failed",
        message: "Invalid runtime composition options"
      }
    });
    expect(createRuntime(42 as unknown as CreateRuntimeOptions)).toMatchObject({
      ok: false,
      error: { message: "Invalid runtime composition options" }
    });
  });

  it("rejects an invalid clock", async () => {
    const database = { filename: await databaseFilename() };
    expect(
      createRuntime({ database, clock: null as unknown as never })
    ).toMatchObject({ ok: false, error: { message: "Invalid runtime clock" } });
    expect(
      createRuntime({ database, clock: { now: 5 } as unknown as never })
    ).toMatchObject({ ok: false, error: { message: "Invalid runtime clock" } });
  });

  it("rejects an invalid id generator", async () => {
    const database = { filename: await databaseFilename() };
    expect(
      createRuntime({ database, idGenerator: { next: 5 } as unknown as never })
    ).toMatchObject({
      ok: false,
      error: { message: "Invalid runtime id generator" }
    });
  });

  it("rejects a non-object adapter override", async () => {
    const database = { filename: await databaseFilename() };
    expect(
      createRuntime({ database, extraction: 5 as unknown as ExtractionAdapter })
    ).toMatchObject({
      ok: false,
      error: { message: "Invalid extraction adapter" }
    });
    expect(
      createRuntime({
        database,
        candidateSource: 5 as unknown as CandidateSourceAdapter
      })
    ).toMatchObject({
      ok: false,
      error: { message: "Invalid candidate source adapter" }
    });
  });

  it("propagates a database open failure", () => {
    expect(createRuntime({ database: { filename: ":memory:" } })).toMatchObject({
      ok: false,
      error: { code: "persistence_failed" }
    });
  });

  it("propagates a migration failure and closes the connection", async () => {
    const result = createRuntime({
      database: {
        filename: await databaseFilename(),
        migrationsFolder: join(await databaseFilename(), "does-not-exist")
      }
    });
    expect(result.ok).toBe(false);
  });

  it("builds a migrated runtime with defaults", async () => {
    const result = createRuntime({ database: { filename: await databaseFilename() } });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const runtime = result.value;
    expect(runtime.clock).toBe(systemClock);
    expect(typeof runtime.idGenerator.next()).toBe("string");
    expect(runtime.extraction).toBeTypeOf("object");
    expect(runtime.candidateSource).toBeTypeOf("object");
    expect(tableNames(runtime)).toContain("actor");
    expect(runtime.close()).toEqual({ ok: true, value: undefined });
  });

  it("skips migration when migrate is false", async () => {
    const result = createRuntime({
      database: { filename: await databaseFilename() },
      migrate: false
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(tableNames(result.value)).not.toContain("actor");
    expect(result.value.close().ok).toBe(true);
  });

  it("passes injected dependencies through unchanged", async () => {
    const clock = fixedClock(1_788_700_000_100);
    const idGenerator = createIncrementingIdGenerator("test");
    const extraction = { id: "custom-extraction" } as unknown as ExtractionAdapter;
    const candidateSource = {
      id: "custom-source"
    } as unknown as CandidateSourceAdapter;
    const result = createRuntime({
      database: { filename: await databaseFilename() },
      clock,
      idGenerator,
      extraction,
      candidateSource
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.clock).toBe(clock);
    expect(result.value.idGenerator).toBe(idGenerator);
    expect(result.value.extraction).toBe(extraction);
    expect(result.value.candidateSource).toBe(candidateSource);
    expect(result.value.close().ok).toBe(true);
  });
});
