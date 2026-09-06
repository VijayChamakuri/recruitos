import { accessSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { build } from "esbuild";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageRoot = resolve(repositoryRoot, "packages/core");
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));

for (const [specifier, conditions] of Object.entries(packageJson.exports)) {
  if (typeof conditions !== "object" || conditions === null || !("browser" in conditions)) {
    throw new Error(`Missing browser export condition for ${specifier}`);
  }
  if (conditions.browser !== conditions.import) {
    throw new Error(`Browser and import exports differ for ${specifier}`);
  }
  accessSync(resolve(packageRoot, conditions.browser));
}

const result = await build({
  entryPoints: [resolve(packageRoot, packageJson.exports["."].browser)],
  bundle: true,
  format: "esm",
  logLevel: "silent",
  platform: "browser",
  target: "es2023",
  write: false
});

if (result.outputFiles.length !== 1 || result.outputFiles[0].contents.length === 0) {
  throw new Error("Core browser bundle smoke test produced no output");
}

console.log("Core browser export-map smoke test passed");
