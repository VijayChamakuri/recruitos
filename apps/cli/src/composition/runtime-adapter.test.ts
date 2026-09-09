import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCompositionFromRuntime,
  createDefaultRuntimeComposition,
  createDemoRuntimeComposition,
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

    const proposalsResult = await composition.listProposals();
    expect(proposalsResult.ok).toBe(true);
    if (!proposalsResult.ok) return;
    expect(proposalsResult.value).toEqual([]);

    const packetResult = await composition.getCandidatePacket("candidate-1");
    expect(packetResult).toMatchObject({ ok: false, error: { code: "not_found" } });

    const auditResult = await composition.listAuditEvents();
    expect(auditResult.ok).toBe(true);
    if (!auditResult.ok) return;
    expect(auditResult.value).toEqual([]);
    expect(auditResult.value.some((event) => event.eventName === "corpus_sealed")).toBe(false);
  });

  it("lists persisted audit events after demo:prepare, never stub names", async () => {
    const filename = await databaseFilename();
    const created = createDemoRuntimeComposition(filename);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toBeInstanceOf(RuntimeRecruitosComposition);
    const composition = created.value as RuntimeRecruitosComposition;
    expect(composition.prepareDemo).toBeDefined();
    if (!composition.prepareDemo) {
      composition.runtime.close();
      return;
    }
    const prepared = await composition.prepareDemo({});
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      composition.runtime.close();
      return;
    }

    const listed = await composition.listAuditEvents({ limit: 100 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      composition.runtime.close();
      return;
    }
    const names = listed.value.map((event) => event.eventName);
    expect(names).toContain("candidate.result.published");
    expect(names).toContain("triage_run.sealed");
    expect(names).not.toContain("corpus_sealed");
    expect(names).not.toContain("triage_run_started");
    expect(listed.value.every((event) => event.payloadHash.length === 64)).toBe(true);
    expect(listed.value.some((event) => event.commandId !== null)).toBe(true);
    expect(listed.value.some((event) => event.eventOrdinal !== null)).toBe(true);

    expect(composition.runtime.close().ok).toBe(true);
  }, 120_000);

  it("lists persisted proposals from the database after demo:prepare, never stub ids", async () => {
    const filename = await databaseFilename();
    const created = createDemoRuntimeComposition(filename);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const composition = created.value as RuntimeRecruitosComposition;
    expect(composition.prepareDemo).toBeDefined();
    if (!composition.prepareDemo) {
      composition.runtime.close();
      return;
    }
    const prepared = await composition.prepareDemo({});
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      composition.runtime.close();
      return;
    }

    const listed = await composition.listProposals();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      composition.runtime.close();
      return;
    }
    expect(listed.value).toEqual([]);
    expect(listed.value.some((proposal) => proposal.proposalId === "proposal-1")).toBe(false);
    expect(listed.value.some((proposal) => proposal.kind === "stage_advancement")).toBe(false);

    const pendingOnly = await composition.listProposals({ status: "pending" });
    expect(pendingOnly.ok).toBe(true);
    if (pendingOnly.ok) {
      expect(pendingOnly.value).toEqual([]);
    }

    const approvedOnly = await composition.listProposals({ status: "approved" });
    expect(approvedOnly.ok).toBe(true);
    if (approvedOnly.ok) {
      expect(approvedOnly.value).toEqual([]);
    }

    const status = await composition.getStatus();
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.value.pendingProposalsCount).toBe(0);
    }

    expect(composition.runtime.close().ok).toBe(true);
  }, 120_000);
});
