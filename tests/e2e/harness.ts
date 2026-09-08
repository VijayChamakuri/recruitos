import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface TestServerEnvironment {
  readonly port: number;
  readonly serverUrl: string;
  readonly tempDir: string;
  readonly dbPath: string;
}

export interface RecruitOsTestFixtures {
  testEnvironment: TestServerEnvironment;
}

function allocateAvailablePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (!address || typeof address === "string") {
        srv.close(() => rejectPort(new Error("Unable to obtain port address")));
        return;
      }
      const port = address.port;
      srv.close((err) => {
        if (err) rejectPort(err);
        else resolvePort(port);
      });
    });
    srv.on("error", rejectPort);
  });
}

function waitForServerReady(url: string, timeoutMs = 15_000): Promise<void> {
  const startTime = Date.now();
  return new Promise((resolveReady, rejectReady) => {
    const check = (): void => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolveReady();
        } else if (Date.now() - startTime > timeoutMs) {
          rejectReady(
            new Error(
              `Server at ${url} did not become ready within ${timeoutMs}ms (HTTP ${res.statusCode ?? 0})`
            )
          );
        } else {
          setTimeout(check, 100);
        }
      });
      req.on("error", () => {
        if (Date.now() - startTime > timeoutMs) {
          rejectReady(new Error(`Server at ${url} did not respond within ${timeoutMs}ms`));
        } else {
          setTimeout(check, 100);
        }
      });
      req.end();
    };
    check();
  });
}

export const test = base.extend<RecruitOsTestFixtures>({
  testEnvironment: async ({}, use) => {
    const tempDir = mkdtempSync(join(tmpdir(), "recruitos-e2e-"));
    const dbPath = join(tempDir, "recruitos.db");
    const port = await allocateAvailablePort();
    const serverUrl = `http://127.0.0.1:${port}`;

    // Path to repository root and production web server entrypoint
    const repoRoot = resolve(import.meta.dirname, "../..");
    const serverScript = resolve(repoRoot, "apps/web/dist/server/server.js");

    const serverProcess = spawn("node", [serverScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        DATABASE_PATH: dbPath
      },
      stdio: "pipe"
    });

    try {
      await waitForServerReady(`${serverUrl}/status`);
      await use({
        port,
        serverUrl,
        tempDir,
        dbPath
      });
    } finally {
      // Teardown: terminate server process with no hidden reset endpoint
      serverProcess.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        const killTimer = setTimeout(() => {
          serverProcess.kill("SIGKILL");
          resolveExit();
        }, 3000);
        serverProcess.on("exit", () => {
          clearTimeout(killTimer);
          resolveExit();
        });
      });

      // Remove isolated per-test database and directory
      rmSync(tempDir, { recursive: true, force: true });
    }
  },

  baseURL: async ({ testEnvironment }, use) => {
    await use(testEnvironment.serverUrl);
  }
});

export { expect, type BrowserContext, type Page };
