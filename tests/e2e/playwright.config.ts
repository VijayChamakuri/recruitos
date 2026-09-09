import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Playwright E2E configuration for RecruitOS browser workflows.
 * Enforces single worker, zero CI retries, Chromium project, and failure-only trace retention.
 */
export default defineConfig({
  testDir: "./",
  testMatch: /.*\.e2e\.ts$/,
  outputDir: resolve(import.meta.dirname, "../../dist/test-results"),
  timeout: 120_000,
  expect: {
    timeout: 10_000
  },
  workers: 1,
  retries: 0,
  fullyParallel: false,
  globalSetup: resolve(import.meta.dirname, "global-setup.ts"),
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: resolve(import.meta.dirname, "../../dist/playwright-report") }]
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"]
      }
    }
  ]
});
