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
  DEMO_CANDIDATE_SOURCE_KEYS,
  DEMO_EXPECTED_OUTCOMES,
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

function nativeClient(runtime: RuntimeComposition): {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
} {
  return (runtime.connection.database as unknown as { $client: ReturnType<typeof nativeClient> })
    .$client;
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
  it("stands up the seven-route demo spine and returns the run identifiers", async () => {
    const runtime = await demoRuntime();
    const result = unwrap(await demoPrepare(runtime));

    expect(result.candidateIds).toHaveLength(DEMO_CANDIDATE_SOURCE_KEYS.length);
    expect(result.resultIds).toHaveLength(DEMO_CANDIDATE_SOURCE_KEYS.length);
    expect(result.triageAttemptId).toMatch(/\S/);
    expect(result.triageRunId).toMatch(/\S/);

    const roleRow = nativeClient(runtime)
      .prepare("SELECT role_id AS roleId FROM role WHERE role_id = ?")
      .get(DEMO_ROLE_ID) as { roleId: string };
    expect(roleRow.roleId).toBe(DEMO_ROLE_ID);

    unwrap(runtime.close());
  });

  it("seals every route to its expected outcome", async () => {
    const runtime = await demoRuntime();
    const result = unwrap(await demoPrepare(runtime));

    const candidateIdBySourceKey = new Map(
      (
        nativeClient(runtime)
          .prepare("SELECT candidate_id AS candidateId, source_key AS sourceKey FROM candidate")
          .all() as ReadonlyArray<{ candidateId: string; sourceKey: string }>
      ).map((row) => [row.sourceKey, row.candidateId])
    );

    for (const expected of DEMO_EXPECTED_OUTCOMES) {
      const candidateId = candidateIdBySourceKey.get(expected.sourceKey)!;
      const packet = unwrap(readCandidatePacket(runtime.connection.database, candidateId));

      expect(packet.resultStatus, expected.sourceKey).toBe(expected.status);
      expect(packet.resultAvailability, expected.sourceKey).toBe(expected.availability);
      expect(packet.isSealed, expected.sourceKey).toBe(expected.sealed);
      expect([...packet.reasons], expected.sourceKey).toEqual([...expected.reasonCodes]);

      if (expected.hasScore) {
        expect(packet.scoreAggregateText, expected.sourceKey).toMatch(/^\d+\/\d+$/);
      } else {
        expect(packet.scoreAggregateText, expected.sourceKey).toBeNull();
      }
      if (expected.hasConfidence) {
        expect(packet.scoreConfidenceText, expected.sourceKey).toMatch(/^\d+\/\d+$/);
      } else {
        expect(packet.scoreConfidenceText, expected.sourceKey).toBeNull();
      }
      if (expected.resolutionShortfall === true) {
        expect(
          packet.confidenceInput!.spansReturned,
          expected.sourceKey
        ).toBeGreaterThan(packet.confidenceInput!.spansLocated);
      }
    }

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
    const row = nativeClient(runtime)
      .prepare("SELECT DISTINCT actor_id AS actorId FROM command_receipt")
      .get() as { actorId: string };
    expect(row.actorId).toBe("actor-custom-demo");
    unwrap(runtime.close());
  });

  it("blocks when fixtures do not cover a work item", async () => {
    const runtime = await demoRuntime({ extraction: createFixtureExtractionAdapter() });
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
