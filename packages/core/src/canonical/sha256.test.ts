import { describe, expect, it } from "vitest";

import { sha256Hex } from "./sha256.js";

describe("SHA-256", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["hello", "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"],
    ["é", "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c"],
    ["😀", "f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9"]
  ])("hashes %j using standard UTF-8 bytes", (value, expected) => {
    expect(sha256Hex(value)).toBe(expected);
  });

  it("encodes unmatched surrogates as the replacement character", () => {
    expect(sha256Hex("\ud800")).toBe(sha256Hex("�"));
    expect(sha256Hex("\udc00")).toBe(sha256Hex("�"));
  });

  it("hashes inputs spanning multiple blocks", () => {
    expect(sha256Hex("a".repeat(1_000))).toBe(
      "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"
    );
  });
});
