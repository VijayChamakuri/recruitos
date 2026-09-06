import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { canonicalJsonSha256 } from "./hash.js";
import {
  CANONICAL_JSON_MAX_DEPTH,
  CANONICAL_JSON_MAX_NODES,
  canonicalJsonStringify
} from "./json.js";

type SupportedJson = null | boolean | string | number | readonly SupportedJson[] | {
  readonly [key: string]: SupportedJson;
};

const keyArbitrary = fc.oneof(
  fc.constantFrom("A", "a", "é", "e\u0301", "😀", "\ud83d", "\ude00"),
  fc.string({ maxLength: 5 })
);

const supportedJsonArbitrary: fc.Arbitrary<SupportedJson> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.string({ maxLength: 12 }),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    tie("array"),
    tie("record")
  ),
  array: fc.array(tie("value"), { maxLength: 4 }),
  record: fc.dictionary(keyArbitrary, tie("value"), { maxKeys: 4 })
})).value as fc.Arbitrary<SupportedJson>;

function reverseObjectInsertionOrder(value: SupportedJson): SupportedJson {
  if (Array.isArray(value)) {
    return value.map(reverseObjectInsertionOrder);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).reverse();
    return Object.fromEntries(
      entries.map(([key, item]) => [key, reverseObjectInsertionOrder(item)])
    );
  }
  return value;
}

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

  it("sorts code-unit-sensitive keys without locale state", () => {
    const value = { "\ude00": 4, "😀": 3, "\ud83d": 2, a: 1, A: 0 };
    expect(canonicalJsonStringify(value)).toEqual({
      ok: true,
      value: '{"A":0,"a":1,"\\ud83d":2,"😀":3,"\\ude00":4}'
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

  it("rejects array accessors and decorated arrays without executing getters", () => {
    let reads = 0;
    const withAccessor: number[] = [];
    Object.defineProperty(withAccessor, 0, {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads;
      }
    });
    withAccessor.length = 1;
    expect(canonicalJsonStringify(withAccessor).ok).toBe(false);
    expect(canonicalJsonStringify(withAccessor).ok).toBe(false);
    expect(reads).toBe(0);

    const withCustomProperty = [1] as number[] & { extra?: number };
    withCustomProperty.extra = 2;
    expect(canonicalJsonStringify(withCustomProperty).ok).toBe(false);

    const withSymbol = [1];
    Object.defineProperty(withSymbol, Symbol("hidden"), { value: 2 });
    expect(canonicalJsonStringify(withSymbol).ok).toBe(false);
  });

  it("rejects non-enumerable array entries", () => {
    const value: unknown[] = [];
    Object.defineProperty(value, "0", { enumerable: false, value: 1 });
    value.length = 1;
    expect(canonicalJsonStringify(value)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" }
    });
  });

  it("rejects non-enumerable own string properties", () => {
    const value = {};
    Object.defineProperty(value, "hidden", { enumerable: false, value: 1 });
    expect(canonicalJsonStringify(value)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" }
    });
  });

  it("returns typed failures for excessive depth and node count", () => {
    let deep: unknown = 0;
    for (let index = 0; index <= CANONICAL_JSON_MAX_DEPTH; index += 1) {
      deep = [deep];
    }
    expect(canonicalJsonStringify(deep)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" }
    });

    const wide = Array.from({ length: CANONICAL_JSON_MAX_NODES }, () => null);
    expect(canonicalJsonStringify(wide)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" }
    });
  });

  it("converts hostile proxy inspection failures into typed failures", () => {
    const values = [
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error("blocked");
          }
        }
      ),
      new Proxy(
        [],
        {
          getOwnPropertyDescriptor: () => {
            throw new Error("blocked");
          }
        }
      ),
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("blocked");
          }
        }
      )
    ];
    for (const value of values) {
      expect(() => canonicalJsonStringify(value)).not.toThrow();
      expect(canonicalJsonStringify(value)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" }
      });
    }
  });

  it("is stable under recursively shuffled object insertion order", () => {
    fc.assert(
      fc.property(supportedJsonArbitrary, (value) => {
        const shuffled = reverseObjectInsertionOrder(value);
        expect(canonicalJsonStringify(shuffled)).toEqual(canonicalJsonStringify(value));
        expect(canonicalJsonSha256(shuffled)).toEqual(canonicalJsonSha256(value));
      }),
      { numRuns: 250, seed: 20_260_905 }
    );
  });
});
