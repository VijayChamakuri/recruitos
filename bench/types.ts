/**
 * Type definitions for RecruitOS Benchmark Harness.
 * Follows D23 benchmark specifications from the implementation plan.
 */

export interface BenchmarkMetric {
  readonly name: string;
  readonly iterations: number;
  readonly totalMs: number;
  readonly avgMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly opsPerSec: number;
}

export interface MachineProfile {
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly totalMemoryBytes: number;
}

export interface MemorySnapshot {
  readonly heapUsedBytes: number;
  readonly heapTotalBytes: number;
  readonly rssBytes: number;
}

export interface BenchmarkArtifact {
  readonly version: string;
  readonly timestamp: string;
  readonly suiteName: string;
  readonly machineProfile: MachineProfile;
  readonly memorySnapshot: MemorySnapshot;
  readonly metrics: readonly BenchmarkMetric[];
}

export type BenchmarkFn = () => Promise<void> | void;

export interface BenchmarkTask {
  readonly name: string;
  readonly warmupIterations?: number;
  readonly iterations: number;
  readonly fn: BenchmarkFn;
}
