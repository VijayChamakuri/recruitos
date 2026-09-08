import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ok, type Result } from "@recruitos/core";

import { createFixtureExtractionAdapter } from "../adapters/index.js";
import {
  createRuntime,
  demoCompositionOptions,
  type RuntimeComposition
} from "../composition/index.js";
import {
  DEMO_CANDIDATE_SOURCE_KEY,
  DEMO_EXPECTED_OUTCOME,
  DEMO_ROLE_ID
} from "../corpus/index.js";
import type { RuntimeError } from "../errors/index.js";
import { readCandidatePacket } from "../read-models/index.js";
import { demoPrepare } from "./demo-prepare.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];

function unwrap<T>(result: Result<T, RuntimeError>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

async function demoRuntime(
  overrides: Partial<Parameters<typeof createRuntime>[0]> = {}
): Promise<RuntimeComposition> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-demo-prepare-"));
  temporaryDirectories.push(directory);
  const options = demoCompositionOptions({
    database: { filename: join(directory, "runtime.db"), migrationsFolder },
    ...overrides
  });
  return unwrap(createRuntime(options));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("demoPrepare", () => {
  it("stands up the demo spine and returns the run identifiers", async () => {
    const runtime = await demoRuntime();
    const result = unwrap(await demoPrepare(runtime));

    expect(result.candidateIds).toHaveLength(1);
    expect(result.triageAttemptId).toMatch(/\S/);
    expect(result.triageRunId).toMatch(/\S/);
    expect(result.resultIds).toHaveLength(1);

    const roleRow = (runtime.connection.database as unknown as { $client: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).$client
      .prepare("SELECT role_id AS roleId FROM role WHERE role_id = ?")
      .get(DEMO_ROLE_ID) as { roleId: string };
    expect(roleRow.roleId).toBe(DEMO_ROLE_ID);

    unwrap(runtime.close());
  });

  it("seals a packet that matches the expected demo outcome", async () => {
    const runtime = await demoRuntime();
    const result = unwrap(await demoPrepare(runtime));

    const packet = unwrap(
      readCandidatePacket(runtime.connection.database, result.candidateIds[0]!)
    );
    expect(packet.resultAvailability).toBe(DEMO_EXPECTED_OUTCOME.availability);
    expect(packet.resultStatus).toBe(DEMO_EXPECTED_OUTCOME.status);
    expect(packet.isSealed).toBe(DEMO_EXPECTED_OUTCOME.sealed);
    expect(packet.reasons).toEqual([...DEMO_EXPECTED_OUTCOME.reasonCodes]);
    expect(packet.scoreAggregateText).toMatch(/^\d+\/\d+$/);
    expect(packet.scoreConfidenceText).toMatch(/^\d+\/\d+$/);

    unwrap(runtime.close());
  });

  it("imports the demo candidate under its source key", async () => {
    const runtime = await demoRuntime();
    unwrap(await demoPrepare(runtime));
    const row = (runtime.connection.database as unknown as { $client: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).$client
      .prepare("SELECT source_key AS sourceKey FROM candidate")
      .get() as { sourceKey: string };
    expect(row.sourceKey).toBe(DEMO_CANDIDATE_SOURCE_KEY);
    unwrap(runtime.close());
  });

  it("rejects a composition without a fixture extraction adapter", async () => {
    const liveShaped = {
      descriptor: { adapterId: "not-fixture", mode: "live" as const, contractVersion: 1 },
      extract: () =>
        Promise.resolve(
          ok({
            extractionSpecHash: "x",
            descriptor: { adapterId: "not-fixture", mode: "live" as const, contractVersion: 1 },
            body: "{}",
            bodyHash: "x"
          })
        )
    };
    const runtime = await demoRuntime({ extraction: liveShaped });
    const result = await demoPrepare(runtime);
    expect(result).toMatchObject({
      ok: false,
      error: { message: "demoPrepare requires a FixtureExtractionAdapter" }
    });
    unwrap(runtime.close());
  });

  it("rejects a second run against an already-populated database", async () => {
    const runtime = await demoRuntime();
    unwrap(await demoPrepare(runtime));
    const second = await demoPrepare(runtime);
    expect(second).toMatchObject({
      ok: false,
      error: { message: "Demo corpus imported no candidates" }
    });
    unwrap(runtime.close());
  });

  it("rejects an invalid composition", async () => {
    const result = await demoPrepare({} as RuntimeComposition);
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Invalid runtime composition" }
    });
  });

  it("uses a caller supplied actor id", async () => {
    const runtime = await demoRuntime();
    unwrap(await demoPrepare(runtime, { actorId: "actor-custom-demo" }));
    const row = (runtime.connection.database as unknown as { $client: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).$client
      .prepare("SELECT DISTINCT actor_id AS actorId FROM command_receipt")
      .get() as { actorId: string };
    expect(row.actorId).toBe("actor-custom-demo");
    unwrap(runtime.close());
  });

  it("blocks when fixtures do not cover a work item", async () => {
    // A composition whose extraction adapter is a fresh fixture adapter that
    // demoPrepare never gets to populate, because we swap it after wiring but
    // before the run only leaves the registered fixtures missing.
    const runtime = await demoRuntime({ extraction: createFixtureExtractionAdapter() });
    // Register nothing and monkey-patch registerFixture to a no-op so the
    // scheduler sees fixture misses.
    const adapter = runtime.extraction as unknown as { registerFixture: () => void };
    adapter.registerFixture = (): void => undefined;
    const result = await demoPrepare(runtime);
    expect(result).toMatchObject({
      ok: false,
      error: { message: /blocked failures/ }
    });
    unwrap(runtime.close());
  });
});
