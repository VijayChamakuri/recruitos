import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const makefilePath = join(repoRoot, "Makefile");
const scriptPath = join(repoRoot, "scripts/demo-stakeholder.mjs");
const cliPath = join(repoRoot, "apps/cli/dist/bin.js");

function section(output: string, title: string): string {
  const marker = `=== ${title} ===`;
  const start = output.indexOf(marker);
  expect(start, `missing section ${marker}`).toBeGreaterThan(-1);
  const rest = output.slice(start);
  const next = rest.indexOf("\n=== ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

function ensureCliBuilt(): void {
  if (existsSync(cliPath)) {
    return;
  }
  const runtime = spawnSync(
    "corepack",
    ["pnpm", "--filter", "@recruitos/runtime", "build"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  expect(runtime.status).toBe(0);
  const cli = spawnSync(
    "corepack",
    ["pnpm", "--filter", "@recruitos/cli", "build"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  expect(cli.status).toBe(0);
}

describe("demo-stakeholder sitting", () => {
  it("adds a Makefile target that keeps make demo unchanged", () => {
    const makefile = readFileSync(makefilePath, "utf8");
    const script = readFileSync(scriptPath, "utf8");
    expect(makefile).toContain("demo-stakeholder:");
    expect(makefile).toContain("scripts/demo-stakeholder.mjs");
    expect(makefile).not.toMatch(/demo-stakeholder:[\s\S]*\$\(MAKE\)\s+demo\b/u);
    expect(makefile).not.toMatch(/demo-stakeholder:[\s\S]*\bmake demo\b/u);
    expect(script).toContain("better-sqlite3");
    expect(script).not.toContain('spawnSync("sqlite3"');
    expect(script).toContain("Executive summary");
    expect(script).toContain("human-triggered correction with required review");
    expect(script).toContain("The fixture overlay simulates a corrected extraction response.");
    expect(script).toContain(
      "The human action requests re-extraction but does not manually provide the extracted facts."
    );
    expect(script).not.toContain("Promise 2: human correction");
    expect(script).toContain('runCliJson(database, ["packet", route4.candidateId])');
    expect(script).toContain('currentPacket.status !== "scored"');
    expect(script).toContain('currentPacket.resultKind !== "correction"');
    expect(script).toContain("outstandingReviewRequiredTask(currentPacket)");
    expect(script).toContain('originalPacket.resultKind !== "initial"');
    expect(script).toContain('originalPacket.status !== "escalated"');
    expect(script).toContain('includes("assessment_unavailable")');
    expect(script).toContain("originalPacket.resultId === currentPacket.resultId");
    expect(script).toContain(
      "Route 4: ${originalPacket.status} -> human-requested re-extraction -> ${currentPacket.resultKind}/${currentPacket.status}"
    );
    expect(script).not.toContain(
      "Route 4: escalated -> human-requested re-extraction -> correction/scored"
    );
    const currentStatusCheck = script.indexOf('currentPacket.status !== "scored"');
    const promise2Pass = script.indexOf('"Promise 2: PASS"');
    expect(currentStatusCheck).toBeGreaterThan(-1);
    expect(promise2Pass).toBeGreaterThan(currentStatusCheck);

    const trapOutput = [
      "=== Route 1 packet ===",
      "Status:       scored",
      "=== Route 4 current packet ===",
      "Result kind:  correction",
      "=== Executive summary ===",
      "Promise 2: PASS"
    ].join("\n");
    expect(trapOutput).toContain("Status:       scored");
    expect(section(trapOutput, "Route 4 current packet")).not.toContain("Status:       scored");
    expect(section(trapOutput, "Route 1 packet")).toContain("Status:       scored");

    const operatorCard = readFileSync(join(repoRoot, "docs/operator-card-stakeholder-demo.md"), "utf8");
    expect(operatorCard).toContain("executive summary");
    expect(operatorCard).toContain("human-triggered correction with required review");
    expect(operatorCard).toContain("does not manually provide extracted facts");

    const demoIndex = makefile.indexOf("\ndemo:\n");
    const stakeholderIndex = makefile.indexOf("\ndemo-stakeholder:\n");
    expect(demoIndex).toBeGreaterThan(-1);
    expect(stakeholderIndex).toBeGreaterThan(demoIndex);
    const demoBody = makefile.slice(demoIndex, stakeholderIndex);
    expect(demoBody).toContain("recruitos-demo.XXXXXX");
    expect(demoBody).toContain("eval:class1");
    expect(demoBody).not.toContain("triage:complete-correction");
    expect(demoBody).not.toContain("correction-overlay");
  });

  it(
    "prints both product promises from a clean database",
    () => {
      ensureCliBuilt();
      const directory = mkdtempSync(join(tmpdir(), "recruitos-stakeholder-test-"));
      const database = join(directory, "runtime.db");
      try {
        const result = spawnSync(process.execPath, [scriptPath, "--db", database], {
          cwd: repoRoot,
          encoding: "utf8"
        });
        expect(result.status, result.stderr || result.stdout).toBe(0);
        const output = result.stdout ?? "";
        expect(output).toContain("=== Promise 1: explainable deterministic triage ===");
        const route1Packet = section(output, "Route 1 packet");
        expect(route1Packet).toContain("Status:       scored");
        expect(output).toContain("=== Class 1 ===");
        expect(output).toContain("Passed:                    yes");
        expect(output).toContain(
          "=== Promise 2: human-triggered correction with required review ==="
        );
        expect(output).toContain("The fixture overlay simulates a corrected extraction response.");
        expect(output).toContain(
          "The human action requests re-extraction but does not manually provide the extracted facts."
        );
        expect(output).not.toContain("=== Promise 2: human correction ===");
        const route4Before = section(output, "Route 4 before correction");
        expect(route4Before).toContain("Status:       escalated");
        expect(route4Before).toContain("assessment_unavailable");
        expect(route4Before).not.toContain("Status:       scored");
        expect(output).toContain("=== Open task ===");
        expect(output).toContain("=== Request re-extraction ===");
        expect(output).toContain("stakeholder-request-1");
        expect(output).toContain("=== Fixture extraction ===");
        expect(output).toContain("=== Complete correction ===");
        expect(output).toContain("stakeholder-complete-1");
        const route4Current = section(output, "Route 4 current packet");
        expect(route4Current).toContain("Status:       scored");
        expect(route4Current).toContain("Result kind:  correction");
        expect(route4Current).toContain("Outstanding review: required (review_required)");
        const route4Original = section(output, "Route 4 original packet");
        expect(route4Original).toContain("Inspecting: historical result");
        expect(route4Original).toContain("Result kind:  initial");
        expect(route4Original).toContain("Status:       escalated");
        expect(route4Original).toContain("assessment_unavailable");
        expect(route4Original).toContain(
          "current candidate work, not a decision on this historical result"
        );
        expect(route4Original).not.toContain("Status:       scored");
        expect(output).toContain("=== Resolution task ===");
        expect(output).toContain("review_required");
        expect(output).toContain("=== Final checks ===");
        expect(output).toContain("triage_run count: 1");
        expect(output).toContain("triage_run_member count: 7");
        const summary = section(output, "Executive summary");
        expect(summary).toContain("Promise 1: PASS");
        expect(summary).toContain("Initial route-1 result: scored");
        expect(summary).toContain("Score: 467/6 (approximately 77.83/100)");
        expect(summary).toContain("Evidence resolution: 6/6");
        expect(summary).toContain(
          "Class 1: PASS (sealed arithmetic and evidence consistency check)"
        );
        expect(summary).toContain("Promise 2: PASS");
        expect(summary).toContain(
          "Route 4: escalated -> human-requested re-extraction -> correction/scored"
        );
        expect(summary).toContain("Human review after correction: review_required");
        expect(summary).toContain("Original result preserved: yes");
        expect(summary).toContain("Run integrity: 1 triage run and 7 members");
        expect(output).toContain("Stakeholder demo checks passed.");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    180_000
  );
});
