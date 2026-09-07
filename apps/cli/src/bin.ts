#!/usr/bin/env node
import { runCli } from "./cli.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const result = await runCli(argv);

  if (result.stdout) {
    process.stdout.write(result.stdout + "\n");
  }
  if (result.stderr) {
    process.stderr.write(result.stderr + "\n");
  }

  process.exit(result.exitCode);
}

main().catch((err) => {
  process.stderr.write(`Fatal runtime error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(3);
});
