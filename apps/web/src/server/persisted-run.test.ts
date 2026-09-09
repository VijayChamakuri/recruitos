import { describe, expect, it } from "vitest";
import { overlayPersistedRunStatus, readPersistedTriageRun } from "./persisted-run.js";

const baseStatus = {
  databasePath: "/tmp/runtime.db",
  schemaVersion: 21,
  activeRunId: "run-999",
  candidateCount: 7,
  openTasksCount: 0,
  pendingProposalsCount: 0,
  auditEventsCount: 0,
  knownLimitationsCount: 3,
  isSealed: false
};

function databaseWithRows(rows: unknown) {
  return {
    prepare: () => ({
      all: () => rows
    })
  };
}

describe("persisted triage run overlay", () => {
  it("returns none when no triage_run row exists", () => {
    const persisted = readPersistedTriageRun(databaseWithRows([]));
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;
    expect(persisted.value).toBeNull();
    const overlaid = overlayPersistedRunStatus(baseStatus, databaseWithRows([]));
    expect(overlaid.ok).toBe(true);
    if (!overlaid.ok) return;
    expect(overlaid.value.activeRunId).toBe("none");
    expect(overlaid.value.isSealed).toBe(false);
  });

  it("derives id and seal from the newest triage_run row", () => {
    const overlaid = overlayPersistedRunStatus(
      baseStatus,
      databaseWithRows([
        { runId: "demo-0000000096", sealId: "seal-1" },
        { runId: "older", sealId: null }
      ])
    );
    expect(overlaid.ok).toBe(true);
    if (!overlaid.ok) return;
    expect(overlaid.value.activeRunId).toBe("demo-0000000096");
    expect(overlaid.value.isSealed).toBe(true);
  });

  it("treats a null seal_id as unsealed even if candidate seals exist elsewhere", () => {
    const overlaid = overlayPersistedRunStatus(
      { ...baseStatus, isSealed: true },
      databaseWithRows([{ runId: "run-open", sealId: null }])
    );
    expect(overlaid.ok).toBe(true);
    if (!overlaid.ok) return;
    expect(overlaid.value.isSealed).toBe(false);
    expect(overlaid.value.activeRunId).toBe("run-open");
  });

  it("reads through a drizzle $client wrapper", () => {
    const persisted = readPersistedTriageRun({
      $client: databaseWithRows([{ runId: "wrapped", sealId: "s" }])
    });
    expect(persisted.ok).toBe(true);
    if (!persisted.ok || persisted.value === null) return;
    expect(persisted.value.runId).toBe("wrapped");
    expect(persisted.value.sealed).toBe(true);
  });

  it("fails closed without a native client", () => {
    const persisted = readPersistedTriageRun(null);
    expect(persisted.ok).toBe(false);
    const overlaid = overlayPersistedRunStatus(baseStatus, {});
    expect(overlaid.ok).toBe(false);
  });

  it("fails closed when the query does not return a list", () => {
    const persisted = readPersistedTriageRun(databaseWithRows("nope"));
    expect(persisted.ok).toBe(false);
  });

  it("fails closed when the stored id is missing", () => {
    const persisted = readPersistedTriageRun(databaseWithRows([{ sealId: "s" }]));
    expect(persisted.ok).toBe(false);
  });

  it("fails closed when prepare throws", () => {
    const persisted = readPersistedTriageRun({
      prepare: () => {
        throw new Error("boom");
      }
    });
    expect(persisted.ok).toBe(false);
    if (persisted.ok) return;
    expect(persisted.error.message).toContain("boom");
  });
});
