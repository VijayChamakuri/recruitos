import { cpus, totalmem } from "node:os";
import type { BenchmarkMetric, MachineProfile, MemorySnapshot } from "./types.js";

/**
 * Computes percentile from a sorted array of numbers.
 */
export function computePercentile(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  if (percentile <= 0) return sorted[0] ?? 0;
  if (percentile >= 100) return sorted[sorted.length - 1] ?? 0;

  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  const lowerVal = sorted[lower] ?? 0;
  const upperVal = sorted[upper] ?? 0;
  return Number((lowerVal + (upperVal - lowerVal) * weight).toFixed(4));
}

/**
 * Computes complete benchmark metrics from run samples.
 */
export function computeStats(
  name: string,
  samples: readonly number[],
  totalMs: number
): BenchmarkMetric {
  if (samples.length === 0) {
    return {
      name,
      iterations: 0,
      totalMs: 0,
      avgMs: 0,
      minMs: 0,
      maxMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      opsPerSec: 0
    };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const minMs = sorted[0] ?? 0;
  const maxMs = sorted[sorted.length - 1] ?? 0;
  const avgMs = Number((totalMs / samples.length).toFixed(4));
  const p50Ms = computePercentile(sorted, 50);
  const p95Ms = computePercentile(sorted, 95);
  const p99Ms = computePercentile(sorted, 99);
  const opsPerSec = totalMs > 0 ? Math.round((samples.length / totalMs) * 1000) : 0;

  return {
    name,
    iterations: samples.length,
    totalMs: Number(totalMs.toFixed(2)),
    avgMs,
    minMs: Number(minMs.toFixed(4)),
    maxMs: Number(maxMs.toFixed(4)),
    p50Ms,
    p95Ms,
    p99Ms,
    opsPerSec
  };
}

/**
 * Captures host machine profile.
 */
export function getMachineProfile(): MachineProfile {
  const cpuList = cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    cpuModel: cpuList[0]?.model ?? "unknown",
    cpuCount: cpuList.length,
    totalMemoryBytes: totalmem()
  };
}

/**
 * Captures process memory snapshot.
 */
export function getMemorySnapshot(): MemorySnapshot {
  const mem = process.memoryUsage();
  return {
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    rssBytes: mem.rss
  };
}
