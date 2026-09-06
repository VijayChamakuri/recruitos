import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { checkCoreArchitecture } from "./check-architecture.mjs";

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
    ["self-import", "forbidden import @recruitos/core"]
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

  it("rejects every forbidden runtime effect", () => {
    const violations = fixture("runtime-effects");
    for (const effect of [
      "clock access",
      "clock construction",
      "randomness",
      "process access",
      "browser window",
      "browser document",
      "browser storage",
      "browser navigator",
      "ambient crypto",
      "binary runtime buffer",
      "network fetch",
      "web socket",
      "performance clock",
      "timer"
    ]) {
      expect(violations).toEqual(expect.arrayContaining([expect.stringContaining(effect)]));
    }
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
