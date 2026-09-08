import { execSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Global setup for Playwright E2E suite.
 * Executes a single production build before any test executes.
 */
export default function globalSetup(): void {
  const repoRoot = resolve(import.meta.dirname, "../..");
  execSync("corepack pnpm --filter @recruitos/web build", {
    cwd: repoRoot,
    stdio: "inherit"
  });
}
