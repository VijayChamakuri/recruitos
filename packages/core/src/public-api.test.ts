import { describe, expect, it } from "vitest";

import {
  CandidateIdSchema,
  canonicalJsonSha256,
  createRational,
  validateUtf16Slice
} from "./index.js";

describe("public API", () => {
  it("exports the first core foundation slice from one entry point", () => {
    expect(CandidateIdSchema.parse("candidate_1")).toBe("candidate_1");
    expect(createRational(1n, 2n).ok).toBe(true);
    expect(canonicalJsonSha256({ stable: true }).ok).toBe(true);
    expect(validateUtf16Slice("text", { start: 0, end: 4, matchedText: "text" }).ok).toBe(true);
  });
});
