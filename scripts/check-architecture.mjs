import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const repositoryRoot = resolve(import.meta.dirname, "..");
const coreSourceRoot = resolve(repositoryRoot, "packages/core/src");

const supportedSourceExtension = /\.(?:cts|mts|ts|tsx)$/u;
const testSourceExtension = /\.(?:spec|test)\.(?:cts|mts|ts|tsx)$/u;

const forbiddenBareImports = new Set([
  "better-sqlite3",
  "crypto",
  "drizzle-orm",
  "fs",
  "next",
  "path",
  "react"
]);

function displayPath(file, displayRoot) {
  const path = relative(displayRoot, file);
  return path === "" ? "." : path;
}

function sourceFiles(directory, displayRoot, violations) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const shownPath = displayPath(path, displayRoot);
    if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) {
      violations.push(`${shownPath}: symbolic links are not allowed in core source`);
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path, displayRoot, violations));
      continue;
    }
    if (
      entry.isFile() &&
      supportedSourceExtension.test(entry.name) &&
      !testSourceExtension.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

function scriptKind(file) {
  return file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function stringLiteralText(node) {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

function moduleSpecifier(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier === undefined ? undefined : stringLiteralText(node.moduleSpecifier);
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression === undefined
      ? undefined
      : stringLiteralText(node.moduleReference.expression);
  }
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) {
    return undefined;
  }
  const [argument] = node.arguments;
  if (argument === undefined) {
    return undefined;
  }
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return stringLiteralText(argument);
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
    return stringLiteralText(argument);
  }
  return undefined;
}

function isModuleLoadCall(node) {
  return (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  );
}

function isForbiddenImport(specifier) {
  return (
    specifier.startsWith("node:") ||
    forbiddenBareImports.has(specifier) ||
    [...forbiddenBareImports].some((name) => specifier.startsWith(`${name}/`)) ||
    specifier.startsWith("@recruitos/") ||
    (!specifier.startsWith(".") && specifier !== "zod")
  );
}

function accessPath(node) {
  if (ts.isIdentifier(node)) {
    return [node.text];
  }
  if (ts.isPropertyAccessExpression(node)) {
    const base = accessPath(node.expression);
    return base === undefined ? undefined : [...base, node.name.text];
  }
  if (ts.isElementAccessExpression(node)) {
    const base = accessPath(node.expression);
    const property =
      node.argumentExpression === undefined ? undefined : stringLiteralText(node.argumentExpression);
    return base === undefined || property === undefined ? undefined : [...base, property];
  }
  return undefined;
}

function runtimeEffect(node) {
  if (ts.isCallExpression(node)) {
    const path = accessPath(node.expression)?.join(".");
    if (path === "Date.now") return "clock access";
    if (path === "Date") return "clock construction";
    if (path === "Math.random") return "randomness";
    if (path === "randomUUID" || path?.endsWith(".randomUUID") === true) return "random UUID";
    if (path === "fetch") return "network fetch";
    if (path === "performance.now") return "performance clock";
    if (path === "setTimeout" || path === "setInterval") return "timer";
    if (path === "WebSocket") return "web socket";
  }
  if (ts.isNewExpression(node)) {
    const path = accessPath(node.expression)?.join(".");
    if (path === "Date") return "clock construction";
    if (path === "WebSocket") return "web socket";
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const path = accessPath(node);
    const root = path?.[0];
    if (root === "process") return "process access";
    if (root === "window") return "browser window";
    if (root === "document") return "browser document";
    if (root === "localStorage") return "browser storage";
    if (root === "navigator") return "browser navigator";
    if (root === "Buffer") return "binary runtime buffer";
    if (root === "crypto" || path?.join(".") === "globalThis.crypto") return "ambient crypto";
  }
  return undefined;
}

export function checkCoreArchitecture({
  sourceRoot = coreSourceRoot,
  displayRoot = repositoryRoot
} = {}) {
  const resolvedSourceRoot = resolve(sourceRoot);
  const resolvedDisplayRoot = resolve(displayRoot);
  const violations = [];

  for (const file of sourceFiles(resolvedSourceRoot, resolvedDisplayRoot, violations)) {
    const source = readFileSync(file, "utf8");
    const relativeFile = displayPath(file, resolvedDisplayRoot);
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file)
    );

    function visit(node) {
      const specifier = moduleSpecifier(node);
      if (specifier !== undefined && isForbiddenImport(specifier)) {
        violations.push(`${relativeFile}: forbidden import ${specifier}`);
      } else if (specifier === undefined && isModuleLoadCall(node)) {
        violations.push(`${relativeFile}: nonliteral module loads are not allowed`);
      }
      const effect = runtimeEffect(node);
      if (effect !== undefined) {
        violations.push(`${relativeFile}: forbidden ${effect}`);
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return violations;
}

function run() {
  const violations = checkCoreArchitecture();
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Core architecture boundary passed");
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  run();
}
