/**
 * Playwright E2E configuration scaffold for RecruitOS Web Shell.
 * Configured for testing 5 locked destinations:
 * /triage, /review, /packet/:id, /runs, /status.
 */

export const playwrightConfig = {
  testDir: "./",
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  fullyParallel: true,
  webServer: {
    command: "node ../dist/server/server.js",
    port: 3000,
    reuseExistingServer: true
  },
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      use: {
        viewport: { width: 1440, height: 900 }
      }
    }
  ]
};

export default playwrightConfig;
