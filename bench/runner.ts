import { performance } from "node:perf_hooks";
import { computeStats } from "./stats.js";
import type { BenchmarkMetric, BenchmarkTask } from "./types.js";

/**
 * Runs a single benchmark task with warmup and accurate latency sampling.
 */
export async function runBenchmarkTask(task: BenchmarkTask): Promise<BenchmarkMetric> {
  const warmup = task.warmupIterations ?? Math.min(10, Math.floor(task.iterations * 0.1));

  for (let i = 0; i < warmup; i++) {
    await task.fn();
  }

  const samples: number[] = new Array(task.iterations);
  const suiteStart = performance.now();

  for (let i = 0; i < task.iterations; i++) {
    const t0 = performance.now();
    await task.fn();
    const t1 = performance.now();
    samples[i] = t1 - t0;
  }

  const suiteEnd = performance.now();
  const totalMs = suiteEnd - suiteStart;

  return computeStats(task.name, samples, totalMs);
}
