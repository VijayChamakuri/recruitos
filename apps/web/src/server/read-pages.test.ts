import { describe, expect, it } from "vitest";
import { err, ok } from "@recruitos/core";
import { createRuntimeError } from "@recruitos/runtime";
import { drainPagedRead } from "./read-pages.js";

describe("drainPagedRead", () => {
  it("concatenates pages until nextCursor is absent", () => {
    const pages = new Map<string | undefined, { items: number[]; nextCursor: string | undefined }>([
      [undefined, { items: [1, 2], nextCursor: "c1" }],
      ["c1", { items: [3], nextCursor: undefined }]
    ]);
    const drained = drainPagedRead((cursor) => ok(pages.get(cursor)!));
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(drained.value).toEqual([1, 2, 3]);
  });

  it("fails closed when pagination does not advance", () => {
    const drained = drainPagedRead(() => ok({ items: [1], nextCursor: "stuck" }));
    expect(drained.ok).toBe(false);
    if (drained.ok) return;
    expect(drained.error.message).toContain("did not advance");
  });

  it("propagates a page error", () => {
    const drained = drainPagedRead(() =>
      err(createRuntimeError("persistence_failed", "page failed", false))
    );
    expect(drained.ok).toBe(false);
  });
});
