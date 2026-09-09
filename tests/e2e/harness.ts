import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
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
  correctionFixture: boolean;
}

const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "AZURE_OPENAI_API_KEY"
] as const;

function hermeticEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of PROVIDER_KEYS) {
    delete env[key];
  }
  return env;
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

function waitForServerReady(url: string, timeoutMs = 20_000): Promise<void> {
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

export function assertFixtureOnlyExtraction(dbPath: string): void {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const require = createRequire(resolve(repoRoot, "packages/runtime/package.json"));
  const Database = require("better-sqlite3") as {
    new (
      filename: string,
      options?: { readonly?: boolean; fileMustExist?: boolean }
    ): {
      prepare: (sql: string) => { get: () => { total: number; live: number | null } };
      close: () => void;
    };
  };
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN fixture_key IS NULL OR fixture_key = '' THEN 1 ELSE 0 END) AS live
         FROM extraction_run`
      )
      .get();
    if (row.total <= 0) {
      throw new Error("Expected extraction_run rows from demo:prepare");
    }
    if (Number(row.live ?? 0) !== 0) {
      throw new Error(`Expected zero live extraction_run rows, found ${row.live}`);
    }
  } finally {
    db.close();
  }
}

export const test = base.extend<RecruitOsTestFixtures>({
  correctionFixture: [false, { option: true }],

  testEnvironment: async ({ correctionFixture }, use) => {
    const tempDir = mkdtempSync(join(tmpdir(), "recruitos-e2e-"));
    const dbPath = join(tempDir, "recruitos.db");
    const port = await allocateAvailablePort();
    const serverUrl = `http://127.0.0.1:${port}`;
    const repoRoot = resolve(import.meta.dirname, "../..");
    const cliScript = resolve(repoRoot, "apps/cli/dist/bin.js");
    const serverScript = resolve(repoRoot, "apps/web/dist/server/server.js");
    const env = hermeticEnv({
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      DATABASE_PATH: dbPath
    });

    const prepared = spawnSync(
      process.execPath,
      [cliScript, "demo:prepare", "--db", dbPath],
      { cwd: repoRoot, encoding: "utf8", env }
    );
    if (prepared.status !== 0) {
      rmSync(tempDir, { recursive: true, force: true });
      throw new Error(
        `demo:prepare failed:\n${prepared.stdout ?? ""}\n${prepared.stderr ?? ""}`
      );
    }

    assertFixtureOnlyExtraction(dbPath);

    const serverArgs = [serverScript, "--db", dbPath, "--port", String(port)];
    if (correctionFixture) {
      serverArgs.push("--correction");
    }
    const serverProcess: ChildProcess = spawn(process.execPath, serverArgs, {
      cwd: repoRoot,
      env,
      stdio: "pipe"
    });

    try {
      await waitForServerReady(`${serverUrl}/triage`);
      await use({
        port,
        serverUrl,
        tempDir,
        dbPath
      });
    } finally {
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
      rmSync(tempDir, { recursive: true, force: true });
    }
  },

  baseURL: async ({ testEnvironment }, use) => {
    await use(testEnvironment.serverUrl);
  }
});

export { expect, type BrowserContext, type Page };
