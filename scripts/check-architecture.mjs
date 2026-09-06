import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const repositoryRoot = resolve(import.meta.dirname, "..");
const coreSourceRoot = resolve(repositoryRoot, "packages/core/src");

const supportedSourceExtension = /\.(?:cts|mts|ts|tsx)$/u;
const testSourceExtension = /\.(?:spec|test)\.(?:cts|mts|ts|tsx)$/u;

const ambientEffects = new Map([
  ["Buffer", "binary runtime buffer"],
  ["crypto", "ambient crypto"],
  ["document", "browser document"],
  ["fetch", "network fetch"],
  ["globalThis", "ambient global object"],
  ["localStorage", "browser storage"],
  ["navigator", "browser navigator"],
  ["performance", "performance clock"],
  ["process", "process access"],
  ["randomUUID", "random UUID"],
  ["setInterval", "timer"],
  ["setTimeout", "timer"],
  ["WebSocket", "web socket"],
  ["window", "browser window"]
]);

const globalThisEffects = new Map([
  ["Buffer", "binary runtime buffer"],
  ["crypto", "ambient crypto"],
  ["Date", "clock construction"],
  ["document", "browser document"],
  ["fetch", "network fetch"],
  ["localStorage", "browser storage"],
  ["Math", "randomness capability"],
  ["navigator", "browser navigator"],
  ["performance", "performance clock"],
  ["process", "process access"],
  ["setInterval", "timer"],
  ["setTimeout", "timer"],
  ["WebSocket", "web socket"],
  ["window", "browser window"]
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

function isInside(root, target) {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function importViolation(specifier, file, sourceRoot) {
  if (specifier.startsWith(".")) {
    const target = resolve(dirname(file), specifier);
    return isInside(sourceRoot, target) ? undefined : `relative import escapes core: ${specifier}`;
  }
  return specifier === "zod" ? undefined : `forbidden import ${specifier}`;
}

function symbolIsLocal(symbol, checker, sourceFiles) {
  if (symbol === undefined) {
    return false;
  }
  const resolved =
    (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
  return (
    resolved.declarations?.some((declaration) =>
      sourceFiles.has(resolve(declaration.getSourceFile().fileName))
    ) === true
  );
}

function isAmbientIdentifier(node, checker, sourceFiles) {
  return (
    ts.isIdentifier(node) &&
    !symbolIsLocal(checker.getSymbolAtLocation(node), checker, sourceFiles)
  );
}

function accessedProperty(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined) {
    return stringLiteralText(node.argumentExpression);
  }
  return undefined;
}

function globalThisEffect(node, checker, sourceFiles) {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) {
    return undefined;
  }
  if (
    !isAmbientIdentifier(node.expression, checker, sourceFiles) ||
    node.expression.text !== "globalThis"
  ) {
    return undefined;
  }
  const property = accessedProperty(node);
  return property === undefined ? "dynamic ambient global access" : globalThisEffects.get(property);
}

function dateEffect(node) {
  const parent = node.parent;
  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.expression === node
  ) {
    return "clock construction";
  }
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === node &&
    accessedProperty(parent) === "now"
  ) {
    return "clock access";
  }
  return "retained clock capability";
}

function mathEffect(node) {
  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  ) {
    return accessedProperty(parent) === "random" ? "randomness" : undefined;
  }
  return "retained randomness capability";
}

function runtimeEffect(node, checker, sourceFiles) {
  const globalEffect = globalThisEffect(node, checker, sourceFiles);
  if (globalEffect !== undefined) {
    return globalEffect;
  }
  if (!isAmbientIdentifier(node, checker, sourceFiles)) {
    return undefined;
  }
  if (node.text === "Date") {
    return dateEffect(node);
  }
  if (node.text === "Math") {
    return mathEffect(node);
  }
  return ambientEffects.get(node.text);
}

export function checkCoreArchitecture({
  sourceRoot = coreSourceRoot,
  displayRoot = repositoryRoot
} = {}) {
  const resolvedSourceRoot = resolve(sourceRoot);
  const resolvedDisplayRoot = resolve(displayRoot);
  const violations = [];
  if (lstatSync(resolvedSourceRoot).isSymbolicLink()) {
    return [
      `${displayPath(resolvedSourceRoot, resolvedDisplayRoot)}: symbolic links are not allowed in core source`
    ];
  }
  const files = sourceFiles(resolvedSourceRoot, resolvedDisplayRoot, violations);
  const sourceFileSet = new Set(files.map((file) => resolve(file)));
  const program = ts.createProgram({
    rootNames: files,
    options: {
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2023,
      types: ["node"]
    }
  });
  const checker = program.getTypeChecker();

  for (const file of files) {
    const relativeFile = displayPath(file, resolvedDisplayRoot);
    const sourceFile =
      program.getSourceFile(file) ??
      ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        scriptKind(file)
      );

    function visit(node) {
      const specifier = moduleSpecifier(node);
      const moduleViolation =
        specifier === undefined ? undefined : importViolation(specifier, file, resolvedSourceRoot);
      if (moduleViolation !== undefined) {
        violations.push(`${relativeFile}: ${moduleViolation}`);
      } else if (specifier === undefined && isModuleLoadCall(node)) {
        violations.push(`${relativeFile}: nonliteral module loads are not allowed`);
      }
      const effect = runtimeEffect(node, checker, sourceFileSet);
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
