import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const coreSourceRoot = resolve(repositoryRoot, "packages/core/src");

const forbiddenBareImports = new Set([
  "better-sqlite3",
  "crypto",
  "drizzle-orm",
  "fs",
  "next",
  "path",
  "react"
]);

const forbiddenRuntimePatterns = [
  ["process environment", /\bprocess\s*\.\s*env\b/u],
  ["clock access", /\bDate\s*\.\s*now\s*\(/u],
  ["clock construction", /\bnew\s+Date\s*\(/u],
  ["randomness", /\bMath\s*\.\s*random\s*\(/u],
  ["random UUID", /\brandomUUID\s*\(/u],
  ["browser window", /\bwindow\s*\./u],
  ["browser document", /\bdocument\s*\./u],
  ["browser storage", /\blocalStorage\s*\./u],
  ["browser navigator", /\bnavigator\s*\./u],
  ["ambient crypto", /\bglobalThis\s*\.\s*crypto\b/u],
  ["binary runtime buffer", /\bBuffer\s*\./u],
  ["network fetch", /\bfetch\s*\(/u],
  ["web socket", /\bWebSocket\s*\(/u],
  ["performance clock", /\bperformance\s*\.\s*now\s*\(/u],
  ["timer", /\bset(?:Timeout|Interval)\s*\(/u]
];

function sourceFiles(directory) {
  return readdirSync(directory)
    .map((entry) => resolve(directory, entry))
    .flatMap((entry) => (statSync(entry).isDirectory() ? sourceFiles(entry) : [entry]))
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"));
}

const violations = [];

for (const file of sourceFiles(coreSourceRoot)) {
  const source = readFileSync(file, "utf8");
  const relativeFile = file.slice(repositoryRoot.length + 1);
  const importPattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu;

  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (
      specifier.startsWith("node:") ||
      forbiddenBareImports.has(specifier) ||
      [...forbiddenBareImports].some((name) => specifier.startsWith(`${name}/`)) ||
      (specifier.startsWith("@recruitos/") && specifier !== "@recruitos/core") ||
      (!specifier.startsWith(".") && specifier !== "zod")
    ) {
      violations.push(`${relativeFile}: forbidden import ${specifier}`);
    }
  }

  for (const [label, pattern] of forbiddenRuntimePatterns) {
    if (pattern.test(source)) {
      violations.push(`${relativeFile}: forbidden ${label}`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Core architecture boundary passed");
}
