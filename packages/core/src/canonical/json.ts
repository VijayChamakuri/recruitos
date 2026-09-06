import type { DomainError } from "../errors/domain-error.js";
import { createDomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";
import { compareCodeUnits } from "./comparator.js";

type CanonicalizationState = Readonly<{
  ancestors: ReadonlySet<object>;
  path: string;
}>;

function invalidJson(path: string, reason: string): Result<never, DomainError> {
  return err(createDomainError("invalid_input", "Value is not canonical JSON", { path, reason }));
}

function canonicalize(value: unknown, state: CanonicalizationState): Result<string, DomainError> {
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

  const nextAncestors = new Set(state.ancestors);
  nextAncestors.add(value);

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        return invalidJson(`${state.path}[${index}]`, "sparse arrays are not supported");
      }
      const item = canonicalize(value[index], {
        ancestors: nextAncestors,
        path: `${state.path}[${index}]`
      });
      if (!item.ok) {
        return item;
      }
      parts.push(item.value);
    }
    return ok(`[${parts.join(",")}]`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidJson(state.path, "objects must use a plain or null prototype");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return invalidJson(state.path, "symbol keys are not supported");
  }

  const keys = Object.keys(value).sort(compareCodeUnits);
  const parts: string[] = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return invalidJson(`${state.path}.${key}`, "accessor properties are not supported");
    }
    const item = canonicalize(descriptor.value, {
      ancestors: nextAncestors,
      path: `${state.path}.${key}`
    });
    if (!item.ok) {
      return item;
    }
    parts.push(`${JSON.stringify(key)}:${item.value}`);
  }
  return ok(`{${parts.join(",")}}`);
}

export function canonicalJsonStringify(value: unknown): Result<string, DomainError> {
  return canonicalize(value, { ancestors: new Set(), path: "$" });
}
