import { describe, expect, it } from "vitest";

import { Sha256HexSchema } from "./hashes.js";

describe("SHA-256 digest schema", () => {
  it("accepts exactly 64 lowercase hexadecimal characters", () => {
    const value = "a".repeat(64);
    expect(Sha256HexSchema.parse(value)).toBe(value);
  });

  it.each(["a".repeat(63), "A".repeat(64), "g".repeat(64)])("rejects invalid digest %s", (value) => {
    expect(Sha256HexSchema.safeParse(value).success).toBe(false);
  });
});
