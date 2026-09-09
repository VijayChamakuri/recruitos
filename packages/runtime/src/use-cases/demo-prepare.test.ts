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
import { demoPrepare, registerDemoCorrectionFixtures } from "./demo-prepare.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];

function unwrap<T>(result: Result<T, RuntimeError>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function nativeClient(runtime: RuntimeComposition): {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes: number };
  };
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

      expect(packet.scoreAggregateText, expected.sourceKey).toBe(expected.scoreText);
      expect(packet.scoreConfidenceText, expected.sourceKey).toBe(expected.confidenceText);

      if (expected.spansReturned === null) {
        expect(packet.confidenceInput, expected.sourceKey).toBeNull();
      } else {
        expect(packet.confidenceInput!.spansReturned, expected.sourceKey).toBe(
          expected.spansReturned
        );
        expect(packet.confidenceInput!.spansLocated, expected.sourceKey).toBe(
          expected.spansLocated
        );
      }
    }

    unwrap(runtime.close());
  });

  it("does not persist shortlist proposals for the seven-route variant_run demo", async () => {
    const runtime = await demoRuntime();
    unwrap(await demoPrepare(runtime));

    const scoredResultIds = nativeClient(runtime)
      .prepare(
        `SELECT candidate_triage_result_id AS resultId
         FROM candidate_triage_result
         WHERE status = 'scored' AND availability = 'complete'`
      )
      .all() as Array<{ resultId: string }>;
    expect(scoredResultIds.length).toBeGreaterThan(0);

    const attempt = nativeClient(runtime)
      .prepare("SELECT kind FROM triage_attempt")
      .get() as { kind: string };
    expect(attempt.kind).toBe("variant_run");

    const proposals = nativeClient(runtime)
      .prepare("SELECT count(*) AS n FROM proposal")
      .get() as { n: number };
    expect(proposals.n).toBe(0);
    expect(
      nativeClient(runtime).prepare("SELECT count(*) AS n FROM proposal_head").get()
    ).toEqual({ n: 0 });

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
      error: { message: "Fixture registration requires a FixtureExtractionAdapter" }
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

  it("rejects correction fixture registration when the attempt has no work items", async () => {
    const runtime = await demoRuntime();
    const prepared = unwrap(await demoPrepare(runtime));
    nativeClient(runtime).prepare("DROP TRIGGER IF EXISTS attempt_work_item_reject_delete").run();
    nativeClient(runtime)
      .prepare("DELETE FROM attempt_work_item WHERE triage_attempt_id = ?")
      .run(prepared.triageAttemptId);
    expect(registerDemoCorrectionFixtures(runtime, prepared.triageAttemptId)).toMatchObject({
      ok: false,
      error: { message: "Triage attempt produced no work items" }
    });
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
