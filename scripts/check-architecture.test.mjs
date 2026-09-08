import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { checkCoreArchitecture, checkRetiredDraftRubricImports } from "./check-architecture.mjs";

const fixtureRoot = resolve(import.meta.dirname, "architecture-fixtures");

function fixture(name) {
  const sourceRoot = resolve(fixtureRoot, name);
  return checkCoreArchitecture({ sourceRoot, displayRoot: sourceRoot });
}

describe("core architecture boundary", () => {
  it.each([
    ["static-import", "forbidden import node:fs"],
    ["side-effect-import", "forbidden import node:fs"],
    ["dynamic-import", "forbidden import node:fs"],
    ["commonjs-require", "forbidden import node:fs"],
    ["import-assignment", "forbidden import node:fs"],
    ["tsx-source", "forbidden import react"],
    ["mts-source", "forbidden import node:path"],
    ["self-import", "forbidden import @recruitos/core"],
    ["relative-value-escape", "relative import escapes core"],
    ["relative-type-escape", "relative import escapes core"],
    ["date-now", "clock capability Date"],
    ["date-construction", "clock capability Date"],
    ["math-random", "randomness capability Math"],
    ["math-dynamic", "randomness capability Math"],
    ["retained-date", "clock capability Date"],
    ["retained-fetch", "browser ambient capability fetch"],
    ["retained-process", "Node ambient capability process"],
    ["destructured-process", "Node ambient capability process"],
    ["destructured-math", "retained randomness capability Math"],
    ["global-this", "ambient global object"],
    ["global-this-fetch", "ambient global object"],
    ["global-this-process", "ambient global object"],
    ["global-this-timer", "ambient global object"],
    ["browser-xml-http-request", "browser ambient capability XMLHttpRequest"],
    ["browser-indexed-db", "browser ambient capability indexedDB"],
    ["browser-session-storage", "browser ambient capability sessionStorage"],
    ["browser-event-source", "browser ambient capability EventSource"],
    ["browser-worker", "browser ambient capability Worker"],
    ["browser-request", "browser ambient capability Request"],
    ["browser-response", "browser ambient capability Response"],
    ["browser-location", "browser ambient capability location"],
    ["browser-history", "browser ambient capability history"],
    ["browser-caches", "browser ambient capability caches"],
    ["browser-queue-microtask", "browser ambient capability queueMicrotask"],
    ["browser-document", "browser ambient capability document"],
    ["browser-window", "browser ambient capability window"],
    ["browser-local-storage", "browser ambient capability localStorage"],
    ["browser-navigator", "browser ambient capability navigator"],
    ["browser-crypto", "browser ambient capability crypto"],
    ["browser-web-socket", "browser ambient capability WebSocket"],
    ["browser-performance", "browser ambient capability performance"],
    ["browser-timeout", "browser ambient capability setTimeout"],
    ["node-buffer", "Node ambient capability Buffer"],
    ["node-process", "Node ambient capability process"],
    ["erased-buffer", "erased ambient capability Buffer"],
    ["erased-process", "erased ambient capability process"],
    ["erased-require", "forbidden import node:fs"],
    ["module-require", "Node ambient capability module"],
    ["aliased-require-call", "Node ambient capability require"],
    ["retained-require", "Node ambient capability require"],
    ["retained-module-require", "Node ambient capability module"],
    ["external-path-reference", "external path reference escapes core"],
    ["external-type-reference", "external type-reference directives are not allowed"],
    ["external-lib-reference", "external lib-reference directives are not allowed"],
    ["unknown-ambient-loader", "unknown ambient declaration capability loadUnknownModule"],
    ["function-constructor", "indirect Function constructor capability"],
    ["retained-function-constructor", "indirect Function constructor capability"],
    ["constructor-global-access", "indirect Function constructor capability"],
    ["prototype-function-constructor", "prototype reflection on callable value"],
    ["reflect-get-function-constructor", "reflective property access capability Reflect.get"],
    ["retained-reflect-get", "reflective property access capability Reflect.get"],
    ["aliased-reflect-get", "reflective property access capability Reflect.get"],
    ["destructured-reflect-get", "reflective property access capability Reflect.get"],
    ["computed-destructured-reflect-get", "reflective property access capability Reflect.get"]
  ])("rejects the %s fixture", (name, expected) => {
    expect(fixture(name)).toEqual(expect.arrayContaining([expect.stringContaining(expected)]));
  });

  it("allows comments and strings that only mention forbidden APIs", () => {
    expect(fixture("comments-and-strings")).toEqual([]);
  });

  it("rejects nonliteral module loads", () => {
    expect(fixture("dynamic-import")).toEqual(
      expect.arrayContaining([expect.stringContaining("nonliteral module loads are not allowed")])
    );
  });

  it.each([
    "shadowed-fetch",
    "shadowed-date",
    "shadowed-require",
    "local-object-constructor",
    "local-reflect-get"
  ])(
    "allows the locally implemented %s fixture",
    (name) => {
      expect(fixture(name)).toEqual([]);
    }
  );

  it("allows deterministic Math methods", () => {
    expect(fixture("deterministic-math")).toEqual([]);
  });

  it("rejects symbolic links without following them", () => {
    const directory = mkdtempSync(join(tmpdir(), "recruitos-architecture-"));
    try {
      const outside = join(directory, "outside.ts");
      writeFileSync(outside, 'import "node:fs";\n');
      const sourceRoot = join(directory, "src");
      symlinkSync(directory, sourceRoot, "dir");

      expect(checkCoreArchitecture({ sourceRoot: directory, displayRoot: directory })).toEqual(
        expect.arrayContaining([expect.stringContaining("symbolic links are not allowed")])
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("retired draft rubric imports", () => {
  it("rejects a source file that imports the retired draft rubric", () => {
    const directory = mkdtempSync(join(tmpdir(), "recruitos-draft-rubric-"));
    try {
      const retiredExport = ["DRAFT", "RUBRIC", "V1"].join("_");
      const retiredModule = ["./draft", "v1"].join("-") + ".js";
      writeFileSync(
        join(directory, "source.ts"),
        `import { ${retiredExport} } from "${retiredModule}";\n`
      );

      expect(
        checkRetiredDraftRubricImports({ sourceRoot: directory, displayRoot: directory })
      ).toEqual(expect.arrayContaining([expect.stringContaining("retired draft rubric import")]));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("allows source that only mentions the retired names in comments", () => {
    const directory = mkdtempSync(join(tmpdir(), "recruitos-draft-rubric-ok-"));
    try {
      writeFileSync(
        join(directory, "source.ts"),
        "export const version = 1;\n"
      );

      expect(
        checkRetiredDraftRubricImports({ sourceRoot: directory, displayRoot: directory })
      ).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
