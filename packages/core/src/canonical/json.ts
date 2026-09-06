import type { DomainError } from "../errors/domain-error.js";
import { createDomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";
import { compareCodeUnits } from "./comparator.js";

type CanonicalizationState = Readonly<{
  ancestors: Set<object>;
  depth: number;
  nodes: { count: number };
  path: string;
}>;

export const CANONICAL_JSON_MAX_DEPTH = 128;
export const CANONICAL_JSON_MAX_NODES = 10_000;

function invalidJson(path: string, reason: string): Result<never, DomainError> {
  return err(createDomainError("invalid_input", "Value is not canonical JSON", { path, reason }));
}

function canonicalize(value: unknown, state: CanonicalizationState): Result<string, DomainError> {
  state.nodes.count += 1;
  if (state.nodes.count > CANONICAL_JSON_MAX_NODES) {
    return invalidJson(state.path, "maximum node count exceeded");
  }
  if (state.depth > CANONICAL_JSON_MAX_DEPTH) {
    return invalidJson(state.path, "maximum depth exceeded");
  }
  if (value === null) {
    return ok("null");
  }
  if (typeof value === "boolean") {
    return ok(value ? "true" : "false");
  }
  if (typeof value === "string") {
    return ok(JSON.stringify(value));
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      return invalidJson(state.path, "numbers must be safe integers");
    }
    return ok(Object.is(value, -0) ? "0" : value.toString(10));
  }
  if (typeof value !== "object") {
    return invalidJson(state.path, `unsupported type ${typeof value}`);
  }
  if (state.ancestors.has(value)) {
    return invalidJson(state.path, "cyclic reference");
  }

  state.ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      // Native arrays always have a nonnegative safe-integer length data property.
      // Proxy invariant violations throw and are converted at the public boundary.
      /* v8 ignore next 9 */
      if (
        lengthDescriptor === undefined ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        return invalidJson(state.path, "array length is invalid");
      }
      const length = lengthDescriptor.value;
      const expectedKeys = new Set<string>(["length"]);
      const parts: string[] = [];
      for (let index = 0; index < length; index += 1) {
        const key = index.toString(10);
        expectedKeys.add(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined) {
          return invalidJson(`${state.path}[${index}]`, "sparse arrays are not supported");
        }
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
          return invalidJson(`${state.path}[${index}]`, "accessor properties are not supported");
        }
        const item = canonicalize(descriptor.value, {
          ancestors: state.ancestors,
          depth: state.depth + 1,
          nodes: state.nodes,
          path: `${state.path}[${index}]`
        });
        if (!item.ok) {
          return item;
        }
        parts.push(item.value);
      }
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !expectedKeys.has(key)) {
          return invalidJson(state.path, "unexpected array properties are not supported");
        }
      }
      return ok(`[${parts.join(",")}]`);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidJson(state.path, "objects must use a plain or null prototype");
    }

    const entries: [string, unknown][] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        return invalidJson(state.path, "symbol keys are not supported");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        return invalidJson(`${state.path}.${key}`, "accessor properties are not supported");
      }
      if (descriptor.enumerable !== true) {
        return invalidJson(`${state.path}.${key}`, "non-enumerable properties are not supported");
      }
      entries.push([key, descriptor.value]);
    }

    entries.sort(([left], [right]) => compareCodeUnits(left, right));
    const parts: string[] = [];
    for (const [key, entryValue] of entries) {
      const item = canonicalize(entryValue, {
        ancestors: state.ancestors,
        depth: state.depth + 1,
        nodes: state.nodes,
        path: `${state.path}.${key}`
      });
      if (!item.ok) {
        return item;
      }
      parts.push(`${JSON.stringify(key)}:${item.value}`);
    }
    return ok(`{${parts.join(",")}}`);
  } finally {
    state.ancestors.delete(value);
  }
}

export function canonicalJsonStringify(value: unknown): Result<string, DomainError> {
  try {
    return canonicalize(value, { ancestors: new Set(), depth: 0, nodes: { count: 0 }, path: "$" });
  } catch {
    return invalidJson("$", "value inspection failed");
  }
}
