import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createResultSchema,
  err,
  flatMapResult,
  mapResult,
  matchResult,
  ok,
  type Result
} from "./result.js";

describe("Result", () => {
  it("validates success and failure variants strictly", () => {
    const schema = createResultSchema(z.number().int(), z.literal("failed"));
    expect(schema.parse(ok(3))).toEqual({ ok: true, value: 3 });
    expect(schema.parse(err("failed"))).toEqual({ ok: false, error: "failed" });
    expect(schema.safeParse({ ok: true, value: 3, extra: true }).success).toBe(false);
  });

  it("maps and flat maps successful values", () => {
    expect(mapResult(ok(2), (value) => value * 3)).toEqual(ok(6));
    expect(flatMapResult(ok(2), (value) => ok(value.toString()))).toEqual(ok("2"));
  });

  it("does not run transforms for failures", () => {
    const transform = vi.fn((value: number) => value * 3);
    const failure: Result<number, string> = err("failed");
    expect(mapResult(failure, transform)).toBe(failure);
    expect(flatMapResult(failure, (value) => ok(value.toString()))).toBe(failure);
    expect(transform).not.toHaveBeenCalled();
  });

  it("matches both variants", () => {
    const handlers = {
      ok: (value: number) => `ok:${value}`,
      err: (error: string) => `err:${error}`
    };
    expect(matchResult(ok(4), handlers)).toBe("ok:4");
    expect(matchResult(err("failed"), handlers)).toBe("err:failed");
  });
});
