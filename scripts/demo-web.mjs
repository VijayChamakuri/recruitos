#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "AZURE_OPENAI_API_KEY"
];

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repoRoot, "apps/cli/dist/bin.js");
const webServer = join(repoRoot, "apps/web/dist/server/server.js");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function hermeticEnv(base) {
  const env = { ...base };
  for (const key of PROVIDER_KEYS) {
    delete env[key];
  }
  return env;
}

function parseArgs(argv) {
  const dbIndex = argv.indexOf("--db");
  if (dbIndex >= 0) {
    const database = argv[dbIndex + 1];
    if (!database) {
      fail("Usage: node scripts/demo-web.mjs --db <path>");
    }
    return { database, ownsDirectory: false };
  }
  const directory = mkdtempSync(join(tmpdir(), "recruitos-demo-web."));
  return {
    database: join(directory, "runtime.db"),
    ownsDirectory: true,
    directory
  };
}

function waitForServer(url, timeoutMs = 20_000) {
  const start = Date.now();
  return new Promise((resolveReady, rejectReady) => {
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolveReady();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          rejectReady(new Error(`Server at ${url} was not ready within ${timeoutMs}ms`));
          return;
        }
        setTimeout(check, 100);
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          rejectReady(new Error(`Server at ${url} did not respond within ${timeoutMs}ms`));
          return;
        }
        setTimeout(check, 100);
      });
      req.end();
    };
    check();
  });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`Invalid PORT: ${process.env.PORT ?? ""}`);
  }

  if (!existsSync(cli) || !existsSync(webServer)) {
    fail("CLI or web binaries missing. Run corepack pnpm build first.");
  }

  const env = hermeticEnv(process.env);
  const prepare = spawnSync(
    process.execPath,
    [cli, "demo:prepare", "--db", parsed.database],
    { encoding: "utf8", cwd: repoRoot, env }
  );
  if (prepare.status !== 0) {
    if (prepare.stdout) process.stderr.write(prepare.stdout);
    if (prepare.stderr) process.stderr.write(prepare.stderr);
    if (parsed.ownsDirectory && parsed.directory) {
      rmSync(parsed.directory, { recursive: true, force: true });
    }
    fail("demo:prepare failed. Fixture extraction only; no provider calls are made.");
  }

  const url = `http://127.0.0.1:${port}/triage?theme=light&density=default`;
  const server = spawn(
    process.execPath,
    [webServer, "--db", parsed.database, "--port", String(port)],
    { cwd: repoRoot, env, stdio: "inherit" }
  );

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGTERM");
    }
    if (parsed.ownsDirectory && parsed.directory) {
      rmSync(parsed.directory, { recursive: true, force: true });
    }
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  server.on("exit", (code, signal) => {
    cleanup();
    if (signal) {
      process.exit(1);
    }
    process.exit(code ?? 1);
  });

  try {
    await waitForServer(`http://127.0.0.1:${port}/triage`);
  } catch (error) {
    cleanup();
    fail(error instanceof Error ? error.message : String(error));
  }

  process.stdout.write(`\nRecruitOS demo web\n`);
  process.stdout.write(`Open ${url}\n`);
  process.stdout.write(`Database ${parsed.database}\n`);
  process.stdout.write(`Fixture extraction only. Zero provider calls. Ctrl-C stops the server.\n`);
}

await main();
