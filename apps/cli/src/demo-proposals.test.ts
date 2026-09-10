import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptPath = join(repoRoot, "scripts/demo-proposals.mjs");
const cliPath = join(repoRoot, "apps/cli/dist/bin.js");

describe("demo-proposals sitting", () => {
  it("runs approve, edit, and reject while preserving the demo run", () => {
    if (!existsSync(cliPath)) {
      const built = spawnSync("corepack", ["pnpm", "build"], { cwd: repoRoot, encoding: "utf8" });
      expect(built.status, built.stderr).toBe(0);
    }
    const result = spawnSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("RecruitOS proposal demo: PASS");
    expect(result.stdout).toContain("Approve: demo/route-1-scored -> approved");
    expect(result.stdout).toContain("Edit: demo/route-7-quote-grounding -> edited");
    expect(result.stdout).toContain("Reject: demo/route-5-missing-evidence -> rejected");
    expect(result.stdout).toContain("Run integrity: 1 variant triage run and 7 members");
    expect(result.stdout).toContain("NO OUTBOUND EFFECT");

    const makefile = readFileSync(join(repoRoot, "Makefile"), "utf8");
    expect(makefile).toContain("demo-proposals:");
    expect(makefile).toContain("scripts/demo-proposals.mjs");
  });
});
