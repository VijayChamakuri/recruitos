import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCompositionFromRuntime,
  createDefaultRuntimeComposition,
  createIncrementingIdGenerator,
  createProcessUniqueIdGenerator,
  createRuntime,
  fixedClock,
  RuntimeRecruitosComposition,
  type RuntimeComposition
} from "./index.js";

const temporaryDirectories: string[] = [];

async function databaseFilename(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-cli-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "runtime.db");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("Runtime Composition Wiring in Apps", () => {
  it("creates default runtime composition with real in-memory SQLite and migrations", async () => {
    const compositionResult = createDefaultRuntimeComposition({
      database: { filename: ":memory:" }
    });

    expect(compositionResult.ok).toBe(true);
    if (!compositionResult.ok) return;

    const composition = compositionResult.value;
    const statusResult = await composition.getStatus();
    expect(statusResult.ok).toBe(true);
    if (!statusResult.ok) return;

    const status = statusResult.value;
    expect(status.databasePath).toBe(":memory:");
    expect(status.schemaVersion).toBeGreaterThanOrEqual(15);
  });

  it("wires createRuntime with fixed clock and incrementing id generator", async () => {
    const clock = fixedClock(1_788_800_000_000);
    const idGen = createIncrementingIdGenerator("test-id");
    const filename = await databaseFilename();

    const runtimeResult = createRuntime({
      database: { filename },
      clock,
      idGenerator: idGen
    });

    expect(runtimeResult.ok).toBe(true);
    if (!runtimeResult.ok) return;

    const runtime: RuntimeComposition = runtimeResult.value;
    expect(runtime.clock.now()).toBe(1_788_800_000_000);
    expect(runtime.idGenerator.next()).toBe("test-id-0000000001");
    expect(runtime.idGenerator.next()).toBe("test-id-0000000002");

    const composition = createCompositionFromRuntime(runtime, filename);
    const statusResult = await composition.getStatus();
    expect(statusResult.ok).toBe(true);
    if (!statusResult.ok) return;
    expect(statusResult.value.databasePath).toBe(filename);

    const closeResult = runtime.close();
    expect(closeResult.ok).toBe(true);
  });

  it("namespaces file-backed ids so a second CLI process does not reuse command ids", async () => {
    const filename = await databaseFilename();
    const first = createDefaultRuntimeComposition({ database: { filename } });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).toBeInstanceOf(RuntimeRecruitosComposition);
    const firstId = (first.value as RuntimeRecruitosComposition).runtime.idGenerator.next();
    expect((first.value as RuntimeRecruitosComposition).runtime.close().ok).toBe(true);

    const second = createDefaultRuntimeComposition({ database: { filename } });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondId = (second.value as RuntimeRecruitosComposition).runtime.idGenerator.next();
    expect(firstId).not.toBe(secondId);
    expect((second.value as RuntimeRecruitosComposition).runtime.close().ok).toBe(true);
  });

  it("yields distinct process-scoped ids within one generator", () => {
    const generator = createProcessUniqueIdGenerator("runtime");
    const first = generator.next();
    const second = generator.next();
    expect(first).toMatch(/^runtime-[0-9a-f]{16}-0000000001$/u);
    expect(second).toMatch(/^runtime-[0-9a-f]{16}-0000000002$/u);
    expect(first.slice(0, 25)).toBe(second.slice(0, 25));
    expect(first).not.toBe(second);
  });

  it("does not surface stub records through an explicitly configured runtime", async () => {
    const compositionResult = createDefaultRuntimeComposition({
      database: { filename: ":memory:" }
    });
    expect(compositionResult.ok).toBe(true);
    if (!compositionResult.ok) return;

    const composition = compositionResult.value;
    const candidatesResult = await composition.listCandidates();
    expect(candidatesResult.ok).toBe(true);
    if (!candidatesResult.ok) return;

    expect(candidatesResult.value).toEqual([]);

    const packetResult = await composition.getCandidatePacket("candidate-1");
    expect(packetResult).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
