import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntime,
  demoCompositionOptions,
  demoPrepare,
  type RuntimeComposition
} from "../../packages/runtime/src/index.js";
import {
  CLASS1_KNOWN_LIMITATIONS,
  runClass1EvaluationForFinalizedCandidate
} from "./finalized-run.js";

const temporaryDirectories: string[] = [];

async function preparedDemo(): Promise<{
  runtime: RuntimeComposition;
  candidateId: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-class1-demo-"));
  temporaryDirectories.push(directory);
  const runtimeResult = createRuntime(
    demoCompositionOptions({
      database: { filename: join(directory, "runtime.db") }
    })
  );
  if (!runtimeResult.ok) throw new Error(runtimeResult.error.message);
  const prepared = await demoPrepare(runtimeResult.value);
  if (!prepared.ok) throw new Error(prepared.error.message);
  const candidateId = prepared.value.candidateIds[0];
  if (!candidateId) throw new Error("Demo preparation returned no candidate");
  return { runtime: runtimeResult.value, candidateId };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Class 1 finalized-run adapter", () => {
  it("runs the existing gate against a real demoPrepare sealed result", async () => {
    const { runtime, candidateId } = await preparedDemo();
    const result = runClass1EvaluationForFinalizedCandidate(
      runtime.connection.database,
      candidateId
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        passed: true,
        candidateId,
        locatedSpanCoverageRate: 1,
        coverageRequirementMet: true,
        allDimensionsAccountedFor: true,
        knownLimitationsCountMet: true,
        violations: []
      }
    });
    runtime.close();
  });

  it("keeps the shared known-limitations gate active", async () => {
    const { runtime, candidateId } = await preparedDemo();
    const result = runClass1EvaluationForFinalizedCandidate(
      runtime.connection.database,
      candidateId,
      CLASS1_KNOWN_LIMITATIONS.slice(0, 2)
    );
    expect(result).toMatchObject({
      ok: true,
      value: { passed: false, knownLimitationsCountMet: false }
    });
    runtime.close();
  });

  it("rejects an invalid database", () => {
    expect(runClass1EvaluationForFinalizedCandidate(null, "candidate-1")).toMatchObject({
      ok: false,
      error: { code: "persistence_failed" }
    });
  });
});
