import { describe, expect, it } from "vitest";

import { createRational, type Rational } from "../canonical/rational.js";
import type { CandidateTriageStatus } from "../domain/status.js";
import { compareShortlist, shortlistCut, type ShortlistCandidate } from "./shortlist.js";

function rational(value: number): Rational {
  const result = createRational(BigInt(value), 1n);
  if (!result.ok) {
    throw new Error("Expected a valid rational in test");
  }
  return result.value;
}

function candidate(candidateId: string, status: CandidateTriageStatus, score: number) {
  return { candidateId, status, aggregate: rational(score) };
}

function shortlistOrThrow(input: unknown, limit?: number) {
  const result = limit === undefined ? shortlistCut(input) : shortlistCut(input, limit);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value.map((entry) => entry.candidateId);
}

describe("compareShortlist", () => {
  const higher = candidate("candidate_a", "scored", 90) as ShortlistCandidate;
  const lower = candidate("candidate_b", "scored", 80) as ShortlistCandidate;
  const tieA = candidate("candidate_a", "scored", 90) as ShortlistCandidate;
  const tieB = candidate("candidate_b", "scored", 90) as ShortlistCandidate;

  it("orders by score descending then candidate id ascending", () => {
    expect(compareShortlist(higher, lower)).toBeLessThan(0);
    expect(compareShortlist(lower, higher)).toBeGreaterThan(0);
    expect(compareShortlist(tieA, tieB)).toBe(-1);
    expect(compareShortlist(tieB, tieA)).toBe(1);
  });
});

describe("shortlistCut", () => {
  it("keeps only scored candidates, ordered deterministically", () => {
    const input = [
      candidate("candidate_c", "scored", 80),
      candidate("candidate_b", "scored", 90),
      candidate("candidate_a", "scored", 90),
      candidate("candidate_d", "escalated", 95),
      candidate("candidate_e", "rejected_hard_requirement", 99)
    ];
    expect(shortlistOrThrow(input)).toEqual(["candidate_a", "candidate_b", "candidate_c"]);
  });

  it("truncates to the limit", () => {
    const input = [
      candidate("candidate_a", "scored", 90),
      candidate("candidate_b", "scored", 80),
      candidate("candidate_c", "scored", 70)
    ];
    expect(shortlistOrThrow(input, 2)).toEqual(["candidate_a", "candidate_b"]);
  });

  it("defaults to the committed shortlist size", () => {
    const input = Array.from({ length: 12 }, (_unused, index) =>
      candidate(`candidate_${(index + 10).toString()}`, "scored", 100 - index)
    );
    expect(shortlistOrThrow(input)).toHaveLength(10);
  });

  it("rejects malformed input", () => {
    expect(shortlistCut("nope")).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("rejects a non-positive limit", () => {
    expect(shortlistCut([], 0)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("rejects duplicate candidate ids", () => {
    const input = [
      candidate("candidate_a", "scored", 90),
      candidate("candidate_a", "escalated", 80)
    ];
    expect(shortlistCut(input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});
