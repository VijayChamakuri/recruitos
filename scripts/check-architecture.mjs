import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const repositoryRoot = resolve(import.meta.dirname, "..");
const coreSourceRoot = resolve(repositoryRoot, "packages/core/src");

const supportedSourceExtension = /\.(?:cts|mts|ts|tsx)$/u;
const testSourceExtension = /\.(?:spec|test)\.(?:cts|mts|ts|tsx)$/u;

const forbiddenDeclarationFile =
  /(?:\/typescript\/lib\/lib\.(?:dom|webworker|scripthost)[^/]*\.d\.ts$|\/node_modules\/(?:@types\/node|undici-types)\/)/u;
const approvedDeclarationFile =
  /(?:\/typescript\/lib\/lib\.(?:es[^/]*|decorators(?:\.legacy)?)\.d\.ts$|\/node_modules\/zod\/)/u;

function portablePath(file) {
  return file.replaceAll("\\", "/");
}

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

function resolvedSymbol(node, checker) {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) {
    return undefined;
  }
  return (symbol.flags & ts.SymbolFlags.Alias) === 0
    ? symbol
    : checker.getAliasedSymbol(symbol);
}

function isPropertyNameIdentifier(node) {
  return ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
}

function declarationIsAmbient(declaration) {
  if (declaration.getSourceFile().isDeclarationFile) {
    return true;
  }
  for (let current = declaration; !ts.isSourceFile(current); current = current.parent) {
    if (current.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
      return true;
    }
  }
  return false;
}

function symbolHasEmittedLocalDeclaration(symbol, sourceFiles) {
  return (
    symbol?.declarations?.some(
      (declaration) =>
        sourceFiles.has(resolve(declaration.getSourceFile().fileName)) &&
        !declarationIsAmbient(declaration)
    ) === true
  );
}

function ambientCapability(node, checker, sourceFiles) {
  if (!ts.isIdentifier(node) || isPropertyNameIdentifier(node)) {
    return undefined;
  }
  const symbol = resolvedSymbol(node, checker);
  if (symbolHasEmittedLocalDeclaration(symbol, sourceFiles)) {
    return undefined;
  }

  const name = symbol?.getName() ?? node.text;
  if (name === "globalThis") {
    return "ambient global object";
  }
  if (name === "Date") {
    return "clock capability Date";
  }
  if (name === "Math") {
    const parent = node.parent;
    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === node
    ) {
      const property = accessedProperty(parent);
      return property !== undefined && property !== "random"
        ? undefined
        : "randomness capability Math";
    }
    return "retained randomness capability Math";
  }
  if (name === "eval" || name === "Function") {
    return `dynamic code capability ${name}`;
  }

  const declarations = symbol?.declarations ?? [];
  const localAmbient = declarations.some(
    (declaration) =>
      sourceFiles.has(resolve(declaration.getSourceFile().fileName)) &&
      declarationIsAmbient(declaration) &&
      (symbol.flags & ts.SymbolFlags.Value) !== 0
  );
  if (localAmbient) {
    return `erased ambient capability ${name}`;
  }
  const ambientDeclarations = declarations.filter(declarationIsAmbient);
  const declarationFile = ambientDeclarations.find((declaration) =>
    forbiddenDeclarationFile.test(portablePath(declaration.getSourceFile().fileName))
  );
  if (declarationFile !== undefined) {
    const origin = portablePath(declarationFile.getSourceFile().fileName).includes(
      "/typescript/lib/lib."
    )
      ? "browser"
      : "Node";
    return `${origin} ambient capability ${name}`;
  }

  const unknownAmbientDeclaration = ambientDeclarations.find(
    (declaration) =>
      !sourceFiles.has(resolve(declaration.getSourceFile().fileName)) &&
      !approvedDeclarationFile.test(portablePath(declaration.getSourceFile().fileName))
  );
  return unknownAmbientDeclaration === undefined
    ? undefined
    : `unknown ambient declaration capability ${name}`;
}

function isAmbientRequire(node, checker, sourceFiles) {
  return (
    ts.isIdentifier(node) &&
    (resolvedSymbol(node, checker)?.getName() ?? node.text) === "require" &&
    ambientCapability(node, checker, sourceFiles) !== undefined
  );
}

function moduleSpecifier(node, checker, sourceFiles) {
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
  if (isAmbientRequire(node.expression, checker, sourceFiles)) {
    return stringLiteralText(argument);
  }
  return undefined;
}

function isModuleLoadCall(node, checker, sourceFiles) {
  return (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      isAmbientRequire(node.expression, checker, sourceFiles))
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

function addReferenceDirectiveViolations(sourceFile, file, sourceRoot, relativeFile, violations) {
  for (const reference of sourceFile.referencedFiles) {
    const target = resolve(dirname(file), reference.fileName);
    if (!isInside(sourceRoot, target)) {
      violations.push(
        `${relativeFile}: external path reference escapes core: ${reference.fileName}`
      );
    }
  }
  for (const reference of sourceFile.typeReferenceDirectives) {
    violations.push(
      `${relativeFile}: external type-reference directives are not allowed: ${reference.fileName}`
    );
  }
  for (const reference of sourceFile.libReferenceDirectives) {
    violations.push(
      `${relativeFile}: external lib-reference directives are not allowed: ${reference.fileName}`
    );
  }
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

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function typeMayBeCallable(type, checker) {
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
    return true;
  }
  if (type.isUnionOrIntersection()) {
    return type.types.some((member) => typeMayBeCallable(member, checker));
  }
  return (
    checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
    checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0
  );
}

function expressionMayBeCallable(node, checker) {
  const expression = unwrapExpression(node);
  return (
    ts.isArrowFunction(expression) ||
    ts.isFunctionExpression(expression) ||
    typeMayBeCallable(checker.getTypeAtLocation(expression), checker)
  );
}

function prototypeReflectionOnCallable(node, checker, sourceFiles) {
  const expression = unwrapExpression(node);
  if (!ts.isCallExpression(expression) || expression.arguments.length < 1) {
    return false;
  }
  const callee = unwrapExpression(expression.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return false;
  }
  const owner = unwrapExpression(callee.expression);
  const property = accessedProperty(callee);
  const argument = expression.arguments[0];
  return (
    ts.isIdentifier(owner) &&
    (owner.text === "Object" || owner.text === "Reflect") &&
    !symbolHasEmittedLocalDeclaration(resolvedSymbol(owner, checker), sourceFiles) &&
    property === "getPrototypeOf" &&
    argument !== undefined &&
    expressionMayBeCallable(argument, checker)
  );
}

function expressionResolvesToAmbientReflect(node, checker, sourceFiles, seenSymbols = new Set()) {
  const expression = unwrapExpression(node);
  if (!ts.isIdentifier(expression)) {
    return false;
  }
  const symbol = resolvedSymbol(expression, checker);
  if (!symbolHasEmittedLocalDeclaration(symbol, sourceFiles)) {
    return (symbol?.getName() ?? expression.text) === "Reflect";
  }
  if (symbol === undefined || seenSymbols.has(symbol)) {
    return false;
  }
  seenSymbols.add(symbol);
  return (
    symbol.declarations?.some(
      (declaration) =>
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined &&
        expressionResolvesToAmbientReflect(
          declaration.initializer,
          checker,
          sourceFiles,
          seenSymbols
        )
    ) === true
  );
}

function bindingElementProperty(declaration) {
  const property = declaration.propertyName ?? declaration.name;
  if (ts.isIdentifier(property)) {
    return property.text;
  }
  return stringLiteralText(ts.isComputedPropertyName(property) ? property.expression : property);
}

function expressionResolvesToAmbientReflectGet(
  node,
  checker,
  sourceFiles,
  seenSymbols = new Set()
) {
  const expression = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const property = accessedProperty(expression);
    return (
      expressionResolvesToAmbientReflect(
        expression.expression,
        checker,
        sourceFiles,
        seenSymbols
      ) &&
      (property === "get" || (ts.isElementAccessExpression(expression) && property === undefined))
    );
  }
  if (!ts.isIdentifier(expression)) {
    return false;
  }
  const symbol = resolvedSymbol(expression, checker);
  if (symbol === undefined || seenSymbols.has(symbol)) {
    return false;
  }
  seenSymbols.add(symbol);
  return (
    symbol.declarations?.some((declaration) => {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
        return expressionResolvesToAmbientReflectGet(
          declaration.initializer,
          checker,
          sourceFiles,
          seenSymbols
        );
      }
      if (
        ts.isBindingElement(declaration) &&
        ts.isObjectBindingPattern(declaration.parent) &&
        ts.isVariableDeclaration(declaration.parent.parent) &&
        declaration.parent.parent.initializer !== undefined &&
        bindingElementProperty(declaration) === "get"
      ) {
        return expressionResolvesToAmbientReflect(
          declaration.parent.parent.initializer,
          checker,
          sourceFiles,
          seenSymbols
        );
      }
      return false;
    }) === true
  );
}

function ambientReflectGetCapability(node, checker, sourceFiles) {
  return expressionResolvesToAmbientReflectGet(node, checker, sourceFiles);
}

function indirectDynamicCodeCapability(node, checker, sourceFiles) {
  if (prototypeReflectionOnCallable(node, checker, sourceFiles)) {
    return "prototype reflection on callable value";
  }
  if (ambientReflectGetCapability(node, checker, sourceFiles)) {
    return "reflective property access capability Reflect.get";
  }
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) {
    return undefined;
  }
  const property = accessedProperty(node);
  if (property !== "constructor" && !(ts.isElementAccessExpression(node) && property === undefined)) {
    return undefined;
  }
  return expressionMayBeCallable(node.expression, checker)
    ? "indirect Function constructor capability"
    : undefined;
}

function runtimeEffect(node, checker, sourceFiles) {
  return (
    ambientCapability(node, checker, sourceFiles) ??
    indirectDynamicCodeCapability(node, checker, sourceFiles)
  );
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

    addReferenceDirectiveViolations(
      sourceFile,
      file,
      resolvedSourceRoot,
      relativeFile,
      violations
    );

    function visit(node) {
      const specifier = moduleSpecifier(node, checker, sourceFileSet);
      const moduleViolation =
        specifier === undefined ? undefined : importViolation(specifier, file, resolvedSourceRoot);
      if (moduleViolation !== undefined) {
        violations.push(`${relativeFile}: ${moduleViolation}`);
      } else if (specifier === undefined && isModuleLoadCall(node, checker, sourceFileSet)) {
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

const retiredDraftRubricExport = ["DRAFT", "RUBRIC", "V1"].join("_");
const retiredDraftRubricModule = ["draft", "v1"].join("-");
const retiredDraftRubricFileName = `${retiredDraftRubricModule}.ts`;
const skippedScanDirectoryNames = new Set([
  ".git",
  "architecture-fixtures",
  "coverage",
  "dist",
  "node_modules"
]);
const retiredDraftRubricSourceExtension = /\.(?:cjs|cts|js|mjs|mts|ts|tsx)$/u;

function sourceContainsRetiredDraftRubricImport(source) {
  if (source.includes(retiredDraftRubricExport)) {
    return true;
  }
  const modulePattern = new RegExp(
    String.raw`(?:from|import\s*\(|require\s*\()\s*['"][^'"]*${retiredDraftRubricModule}(?:\.js)?['"]`,
    "u"
  );
  const exportStarPattern = new RegExp(
    String.raw`export\s+\*\s+from\s*['"][^'"]*${retiredDraftRubricModule}(?:\.js)?['"]`,
    "u"
  );
  return modulePattern.test(source) || exportStarPattern.test(source);
}

function walkRetiredDraftRubricFiles(directory, displayRoot) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (skippedScanDirectoryNames.has(entry.name)) {
        continue;
      }
      files.push(...walkRetiredDraftRubricFiles(path, displayRoot));
      continue;
    }
    if (entry.isFile() && retiredDraftRubricSourceExtension.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

export function checkRetiredDraftRubricImports({
  sourceRoot = repositoryRoot,
  displayRoot = repositoryRoot
} = {}) {
  const resolvedSourceRoot = resolve(sourceRoot);
  const resolvedDisplayRoot = resolve(displayRoot);
  const violations = [];
  const scanRoots = ["packages", "tests", "apps", "bench", "scripts"].map((directory) =>
    resolve(resolvedSourceRoot, directory)
  );
  const roots = scanRoots.filter((root) => {
    try {
      return lstatSync(root).isDirectory();
    } catch {
      return false;
    }
  });
  const files =
    roots.length === 0
      ? walkRetiredDraftRubricFiles(resolvedSourceRoot, resolvedDisplayRoot)
      : roots.flatMap((root) =>
          walkRetiredDraftRubricFiles(root, resolvedDisplayRoot)
        );

  for (const file of files) {
    const relativeFile = displayPath(file, resolvedDisplayRoot);
    if (file.endsWith(sep + retiredDraftRubricFileName) || file.endsWith(`/${retiredDraftRubricFileName}`)) {
      violations.push(`${relativeFile}: retired draft rubric module is not allowed`);
      continue;
    }
    const source = readFileSync(file, "utf8");
    if (sourceContainsRetiredDraftRubricImport(source)) {
      violations.push(`${relativeFile}: retired draft rubric import`);
    }
  }
  return violations;
}

function run() {
  const violations = [...checkCoreArchitecture(), ...checkRetiredDraftRubricImports()];
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
