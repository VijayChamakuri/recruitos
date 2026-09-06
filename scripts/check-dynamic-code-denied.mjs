import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";

import { build } from "esbuild";

const result = await build({
  entryPoints: [resolve(import.meta.dirname, "../packages/core/dist/index.js")],
  bundle: true,
  format: "esm",
  logLevel: "silent",
  platform: "browser",
  target: "es2023",
  write: false
});
const output = result.outputFiles[0];
if (result.outputFiles.length !== 1 || output === undefined || output.contents.length === 0) {
  throw new Error("Core browser bundle produced no executable output");
}

const originalFunctionDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Function");
if (originalFunctionDescriptor === undefined) {
  throw new Error("Global Function descriptor is unavailable");
}

const deniedFunction = new Proxy(Function, {
  apply() {
    throw new EvalError("Dynamic code is disabled");
  },
  construct() {
    throw new EvalError("Dynamic code is disabled");
  }
});

Object.defineProperty(globalThis, "Function", {
  ...originalFunctionDescriptor,
  value: deniedFunction
});

try {
  const bundleUrl = `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`;
  const core = await import(bundleUrl);

  assert.equal(core.SafeIntegerSchema.parse(7), 7);
  assert.deepEqual(core.createRational(2n, 4n), {
    ok: true,
    value: { numerator: 1n, denominator: 2n }
  });
} finally {
  Object.defineProperty(globalThis, "Function", originalFunctionDescriptor);
}

console.log("Core browser-bundle dynamic-code-denied check passed");
