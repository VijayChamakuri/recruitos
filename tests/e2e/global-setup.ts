import { execSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Global setup for Playwright E2E suite.
 * Builds CLI and web so demo:prepare and the production server exist.
 */
export default function globalSetup(): void {
  const repoRoot = resolve(import.meta.dirname, "../..");
  execSync("corepack pnpm build", {
    cwd: repoRoot,
    stdio: "inherit"
  });
}
