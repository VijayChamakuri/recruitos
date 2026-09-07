/**
 * Playwright E2E configuration for RecruitOS browser workflows.
 * Enforces single worker, zero CI retries, and failure-only trace retention.
 */

export const config = {
  testDir: "./",
  testMatch: /.*\.e2e\.ts$/,
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  workers: 1,
  retries: 0,
  fullyParallel: false,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }]
  ],
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 900 }
      }
    }
  ],
  webServer: {
    command: "node apps/web/dist/server/server.js",
    port: 3000,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
};

export default config;
