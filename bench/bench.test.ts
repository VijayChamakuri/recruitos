import { describe, expect, it } from "vitest";
import { computePercentile, computeStats, getMachineProfile, getMemorySnapshot } from "./stats.js";
import { runBenchmarkTask } from "./runner.js";

describe("Benchmark Statistics", () => {
  it("computes percentiles accurately on sorted arrays", () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(computePercentile(samples, 0)).toBe(10);
    expect(computePercentile(samples, 50)).toBe(55);
    expect(computePercentile(samples, 100)).toBe(100);
  });

  it("handles empty and single element percentile computations", () => {
    expect(computePercentile([], 50)).toBe(0);
    expect(computePercentile([42], 50)).toBe(42);
  });

  it("computes complete stats for samples", () => {
    const samples = [1.0, 2.0, 3.0, 4.0, 5.0];
    const totalMs = 15.0;
    const stats = computeStats("Test Task", samples, totalMs);

    expect(stats.name).toBe("Test Task");
    expect(stats.iterations).toBe(5);
    expect(stats.totalMs).toBe(15.0);
    expect(stats.avgMs).toBe(3.0);
    expect(stats.minMs).toBe(1.0);
    expect(stats.maxMs).toBe(5.0);
    expect(stats.p50Ms).toBe(3.0);
    expect(stats.opsPerSec).toBeGreaterThan(0);
  });

  it("retrieves valid machine profile and memory snapshot", () => {
    const profile = getMachineProfile();
    expect(profile.platform).toBeTruthy();
    expect(profile.cpuCount).toBeGreaterThan(0);
    expect(profile.totalMemoryBytes).toBeGreaterThan(0);

    const mem = getMemorySnapshot();
    expect(mem.heapUsedBytes).toBeGreaterThan(0);
  });
});

describe("Benchmark Runner", () => {
  it("executes a benchmark task with warmup and returns metrics", async () => {
    let callCount = 0;
    const metric = await runBenchmarkTask({
      name: "Dummy Task",
      warmupIterations: 2,
      iterations: 5,
      fn: () => {
        callCount++;
      }
    });

    expect(callCount).toBe(7); // 2 warmup + 5 measurement
    expect(metric.iterations).toBe(5);
    expect(metric.opsPerSec).toBeGreaterThan(0);
  });
});
