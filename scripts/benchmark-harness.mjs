#!/usr/bin/env node
/**
 * Benchmark harness for RecruitOS CLI and Web Shell.
 * Measures:
 * 1. CLI command latency (triage, review, packet, status)
 * 2. Web Shell SSR latency across the 5 locked routes
 * 3. Span validation throughput (ops/sec)
 */

import { performance } from "node:perf_hooks";
import { runCli } from "../apps/cli/dist/index.js";
import { handleRequest } from "../apps/web/dist/index.js";

const ITERATIONS = 200;

async function benchmarkCli() {
  const commands = [
    ["status", "--json"],
    ["triage", "--json"],
    ["review", "--json"],
    ["packet", "candidate-1", "--json"]
  ];

  const results = [];

  for (const cmd of commands) {
    // Warmup
    for (let i = 0; i < 10; i++) {
      await runCli(cmd);
    }

    const t0 = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      await runCli(cmd);
    }
    const t1 = performance.now();
    const totalMs = t1 - t0;
    const avgMs = totalMs / ITERATIONS;
    const opsPerSec = Math.round((ITERATIONS / totalMs) * 1000);

    results.push({
      benchmark: `CLI: recruitos ${cmd.join(" ")}`,
      avgMs: Number(avgMs.toFixed(3)),
      opsPerSec
    });
  }

  return results;
}

async function benchmarkWeb() {
  const routes = [
    "/triage",
    "/review",
    "/packet/candidate-1",
    "/runs",
    "/status"
  ];

  const results = [];

  for (const route of routes) {
    const params = new URLSearchParams();

    // Warmup
    for (let i = 0; i < 10; i++) {
      await handleRequest(route, params);
    }

    const t0 = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      await handleRequest(route, params);
    }
    const t1 = performance.now();
    const totalMs = t1 - t0;
    const avgMs = totalMs / ITERATIONS;
    const opsPerSec = Math.round((ITERATIONS / totalMs) * 1000);

    results.push({
      benchmark: `Web SSR: ${route}`,
      avgMs: Number(avgMs.toFixed(3)),
      opsPerSec
    });
  }

  return results;
}

async function main() {
  console.log("Running RecruitOS Benchmark Harness (n=" + ITERATIONS + " per task)...");
  console.log("=".repeat(60));

  const cliResults = await benchmarkCli();
  const webResults = await benchmarkWeb();
  const allResults = [...cliResults, ...webResults];

  console.log(
    "Benchmark".padEnd(40) +
    "Avg (ms)".padStart(10) +
    "Throughput (ops/s)".padStart(20)
  );
  console.log("-".repeat(70));

  for (const r of allResults) {
    console.log(
      r.benchmark.padEnd(40) +
      String(r.avgMs).padStart(10) +
      String(r.opsPerSec).padStart(20)
    );
  }

  console.log("=".repeat(60));
  console.log("Benchmark harness completed successfully.");
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
