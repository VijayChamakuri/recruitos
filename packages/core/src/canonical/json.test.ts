import { describe, expect, it } from "vitest";

import { canonicalJsonSha256 } from "./hash.js";
import { canonicalJsonStringify } from "./json.js";

describe("canonical JSON", () => {
  it("sorts object keys recursively and preserves array order", () => {
    const left = { z: 2, a: { y: true, x: null }, list: ["b", "a"], ready: false, zero: -0 };
    const right = { zero: 0, ready: false, list: ["b", "a"], a: { x: null, y: true }, z: 2 };
    const expected =
      '{"a":{"x":null,"y":true},"list":["b","a"],"ready":false,"z":2,"zero":0}';
    expect(canonicalJsonStringify(left)).toEqual({ ok: true, value: expected });
    expect(canonicalJsonStringify(right)).toEqual({ ok: true, value: expected });
    expect(canonicalJsonSha256(left)).toEqual(canonicalJsonSha256(right));
  });

  it("escapes keys and values with JSON string rules", () => {
    expect(canonicalJsonStringify({ 'a"': "line\nnext" })).toEqual({
      ok: true,
      value: '{"a\\\"":"line\\nnext"}'
    });
  });

  it("allows shared acyclic objects and null-prototype records", () => {
    const shared = { value: 1 };
    expect(canonicalJsonStringify({ a: shared, b: shared }).ok).toBe(true);
    const record = Object.create(null) as Record<string, unknown>;
    record.value = 1;
    expect(canonicalJsonStringify(record)).toEqual({ ok: true, value: '{"value":1}' });
  });

  it.each([
    ["fraction", { value: 1.5 }],
    ["unsafe integer", { value: Number.MAX_SAFE_INTEGER + 1 }],
    ["undefined", { value: undefined }],
    ["function", { value: () => 1 }],
    ["bigint", { value: 1n }],
    ["date", { value: new Date(0) }]
  ])("rejects %s", (_label, value) => {
    const result = canonicalJsonStringify(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_input");
    }
  });

  it("rejects cycles, sparse arrays, symbols, and accessors", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(canonicalJsonStringify(cyclic).ok).toBe(false);

    const sparse = new Array(2);
    sparse[1] = "value";
    expect(canonicalJsonStringify(sparse).ok).toBe(false);
    expect(canonicalJsonStringify([undefined]).ok).toBe(false);

    const withSymbol = { value: 1, [Symbol("hidden")]: 2 };
    expect(canonicalJsonStringify(withSymbol).ok).toBe(false);

    const withAccessor = {};
    Object.defineProperty(withAccessor, "value", { enumerable: true, get: () => 1 });
    expect(canonicalJsonStringify(withAccessor).ok).toBe(false);
  });
});
