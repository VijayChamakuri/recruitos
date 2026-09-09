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
        expect(output).toContain("=== Route 1 packet ===");
        expect(output).toContain("Status:       scored");
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
        expect(output).toContain("=== Route 4 before correction ===");
        expect(output).toContain("Status:       escalated");
        expect(output).toContain("assessment_unavailable");
        expect(output).toContain("=== Open task ===");
        expect(output).toContain("=== Request re-extraction ===");
        expect(output).toContain("stakeholder-request-1");
        expect(output).toContain("=== Fixture extraction ===");
        expect(output).toContain("=== Complete correction ===");
        expect(output).toContain("stakeholder-complete-1");
        expect(output).toContain("=== Route 4 current packet ===");
        expect(output).toContain("Result kind:  correction");
        expect(output).toContain("Outstanding review: required (review_required)");
        expect(output).toContain("=== Route 4 original packet ===");
        expect(output).toContain("Inspecting: historical result");
        expect(output).toContain(
          "current candidate work, not a decision on this historical result"
        );
        expect(output).toContain("=== Resolution task ===");
        expect(output).toContain("review_required");
        expect(output).toContain("=== Final checks ===");
        expect(output).toContain("triage_run count: 1");
        expect(output).toContain("triage_run_member count: 7");
        expect(output).toContain("=== Executive summary ===");
        expect(output).toContain("Promise 1: PASS");
        expect(output).toContain("Initial route-1 result: scored");
        expect(output).toContain("Score: 467/6 (approximately 77.83/100)");
        expect(output).toContain("Evidence resolution: 6/6");
        expect(output).toContain(
          "Class 1: PASS (sealed arithmetic and evidence consistency check)"
        );
        expect(output).toContain("Promise 2: PASS");
        expect(output).toContain(
          "Route 4: escalated -> human-requested re-extraction -> correction/scored"
        );
        expect(output).toContain("Human review after correction: review_required");
        expect(output).toContain("Original result preserved: yes");
        expect(output).toContain("Run integrity: 1 triage run and 7 members");
        expect(output).toContain("Stakeholder demo checks passed.");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    180_000
  );
});
