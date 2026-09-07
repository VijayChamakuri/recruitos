#!/usr/bin/env node
import { getMachineProfile, getMemorySnapshot } from "./stats.js";
import { runBenchmarkTask } from "./runner.js";
import { createCliTasks } from "./suites/cli.js";
import { createWebTasks } from "./suites/web.js";
import { createMatchingTasks } from "./suites/matching.js";
import type { BenchmarkArtifact, BenchmarkMetric } from "./types.js";

export async function runAllBenchmarks(options?: {
  cliIterations?: number;
  webIterations?: number;
  matchingIterations?: number;
}): Promise<BenchmarkArtifact> {
  const tasks = [
    ...createMatchingTasks(options?.matchingIterations ?? 1000),
    ...createCliTasks(options?.cliIterations ?? 50),
    ...createWebTasks(options?.webIterations ?? 50)
  ];

  const metrics: BenchmarkMetric[] = [];
  for (const task of tasks) {
    const metric = await runBenchmarkTask(task);
    metrics.push(metric);
  }

  return {
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    suiteName: "RecruitOS Core & Shell Benchmark Suite",
    machineProfile: getMachineProfile(),
    memorySnapshot: getMemorySnapshot(),
    metrics
  };
}

export function printBenchmarkReport(artifact: BenchmarkArtifact): void {
  console.log("=".repeat(85));
  console.log(`  ${artifact.suiteName}`);
  console.log(`  Timestamp: ${artifact.timestamp}`);
  console.log(`  Platform: ${artifact.machineProfile.platform} (${artifact.machineProfile.arch}) | Node: ${artifact.machineProfile.nodeVersion}`);
  console.log("=".repeat(85));

  console.log(
    "Benchmark".padEnd(42) +
    "Iter".padStart(8) +
    "Avg (ms)".padStart(10) +
    "p50 (ms)".padStart(10) +
    "p95 (ms)".padStart(10) +
    "Throughput".padStart(14)
  );
  console.log("-".repeat(94));

  for (const m of artifact.metrics) {
    console.log(
      m.name.padEnd(42) +
      String(m.iterations).padStart(8) +
      String(m.avgMs.toFixed(3)).padStart(10) +
      String(m.p50Ms.toFixed(3)).padStart(10) +
      String(m.p95Ms.toFixed(3)).padStart(10) +
      `${m.opsPerSec} ops/s`.padStart(14)
    );
  }

  console.log("=".repeat(85));
}

async function main() {
  const artifact = await runAllBenchmarks();
  printBenchmarkReport(artifact);
}

const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("bench/index.ts") || process.argv[1].endsWith("bench/index.js"));

if (isDirectExecution) {
  main().catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
}
