import { describe, expect, it } from "vitest";

import { createRational, SHORTLIST_N, type Rational } from "@recruitos/core";

import { selectRunShortlistProposals, type RunShortlistCandidate } from "./select-run-shortlist.js";

function rational(value: number): Rational {
  const result = createRational(BigInt(value), 1n);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function scored(
  candidateId: string,
  score: number,
  evidenceSpanIds: readonly string[] = ["span_1"]
): RunShortlistCandidate {
  return {
    candidateId,
    status: "scored",
    availability: "complete",
    aggregate: rational(score),
    evidenceSpanIds
  };
}

function unwrapSelected(candidates: readonly RunShortlistCandidate[], isVariant = false) {
  const result = selectRunShortlistProposals({ candidates, isVariant });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

describe("selectRunShortlistProposals", () => {
  it("cuts to SHORTLIST_N across the run, not one inclusion per scored candidate", () => {
    const candidates = Array.from({ length: SHORTLIST_N + 4 }, (_unused, index) =>
      scored(`candidate_${index.toString().padStart(2, "0")}`, 100 - index)
    );
    const selected = unwrapSelected(candidates);
    expect(selected.size).toBe(SHORTLIST_N);
    expect(selected.has("candidate_00")).toBe(true);
    expect(selected.has("candidate_09")).toBe(true);
    expect(selected.has("candidate_10")).toBe(false);
    expect(selected.get("candidate_00")?.payload).toEqual({ kind: "shortlist_inclusion" });
  });

  it("breaks score ties by candidate id and carries evidence spans from the cut row", () => {
    const selected = unwrapSelected([
      scored("candidate_b", 70, ["span_b"]),
      scored("candidate_a", 70, ["span_a"]),
      scored("candidate_c", 90, ["span_c"])
    ]);
    expect([...selected.keys()]).toEqual(["candidate_c", "candidate_a", "candidate_b"]);
    expect(selected.get("candidate_a")?.evidenceSpanIds).toEqual(["span_a"]);
  });

  it("excludes escalated and rejected results from the cut", () => {
    const selected = unwrapSelected([
      scored("candidate_scored", 80),
      {
        candidateId: "candidate_escalated",
        status: "escalated",
        availability: "unavailable",
        aggregate: null,
        evidenceSpanIds: []
      },
      {
        candidateId: "candidate_rejected",
        status: "rejected_hard_requirement",
        availability: "complete",
        aggregate: rational(99),
        evidenceSpanIds: ["span_1"]
      }
    ]);
    expect([...selected.keys()]).toEqual(["candidate_scored"]);
  });

  it("emits no shortlist for a variant run", () => {
    const selected = unwrapSelected([scored("candidate_a", 90), scored("candidate_b", 80)], true);
    expect(selected.size).toBe(0);
  });

  it("omits duplicate-suppressed candidates even when their score would rank", () => {
    const result = selectRunShortlistProposals({
      candidates: [scored("candidate_a", 90), scored("candidate_b", 80)],
      isVariant: false,
      duplicateCandidateIds: ["candidate_a"]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect([...result.value.keys()]).toEqual(["candidate_b"]);
  });

  it("fails closed when a scored entry is missing its aggregate", () => {
    const result = selectRunShortlistProposals({
      candidates: [
        {
          candidateId: "candidate_broken",
          status: "scored",
          availability: "complete",
          aggregate: null,
          evidenceSpanIds: []
        }
      ],
      isVariant: false
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.message).toContain("Run-level shortlist derivation failed");
  });

  it("fails closed when duplicate-suppressed ids are not candidate ids", () => {
    const result = selectRunShortlistProposals({
      candidates: [scored("candidate_a", 90)],
      isVariant: false,
      duplicateCandidateIds: ["not a valid id"]
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.message).toContain("Invalid proposal settings");
  });
});
