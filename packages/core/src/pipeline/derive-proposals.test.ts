import { describe, expect, it } from "vitest";

import { createRational, type Rational } from "../canonical/rational.js";
import { isScoreBasedProposalKind } from "../domain/proposal.js";
import { SHORTLIST_N } from "../scoring/constants.js";
import {
  DEFAULT_PROPOSAL_SETTINGS,
  deriveShortlistProposals,
  ProposalSettingsSchema,
  type ProposalDerivation
} from "./derive-proposals.js";

function rational(value: number): Rational {
  const result = createRational(BigInt(value), 1n);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

type EntryInput = Readonly<{
  candidateId: string;
  corpusTag: string;
  status: string;
  availability: string;
  aggregate: Rational | null;
  evidenceSpanIds: readonly string[];
}>;

function entry(
  candidateId: string,
  score: number | null,
  overrides: Partial<EntryInput> = {}
): EntryInput {
  return {
    candidateId,
    corpusTag: "main",
    status: score === null ? "escalated" : "scored",
    availability: score === null ? "unavailable" : "complete",
    aggregate: score === null ? null : rational(score),
    evidenceSpanIds: ["span_1"],
    ...overrides
  };
}

function settings(overrides: Record<string, unknown> = {}) {
  return ProposalSettingsSchema.parse({
    shortlistLimit: SHORTLIST_N,
    duplicateCandidateIds: [],
    ...overrides
  });
}

function derive(
  entries: readonly EntryInput[],
  overrides: Record<string, unknown> = {}
): ProposalDerivation {
  const result = deriveShortlistProposals(entries, settings(overrides));
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function proposedIds(derivation: ProposalDerivation): readonly string[] {
  return derivation.proposals.map((proposal) => proposal.candidateId);
}

describe("deriveShortlistProposals input validation", () => {
  it("rejects entries that are not candidate results", () => {
    expect(deriveShortlistProposals("nope")).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "Invalid candidate result entries" }
    });
    expect(deriveShortlistProposals([{ candidateId: "candidate_1" }]).ok).toBe(false);
  });

  it("rejects settings that are not the committed shape", () => {
    expect(
      deriveShortlistProposals([], { shortlistLimit: 0, duplicateCandidateIds: [] } as never)
    ).toMatchObject({ ok: false, error: { message: "Invalid proposal settings" } });
  });

  it("rejects a scored result that carries no aggregate", () => {
    expect(
      deriveShortlistProposals([
        entry("candidate_1", null, { status: "scored", availability: "complete" })
      ])
    ).toMatchObject({
      ok: false,
      error: { message: "A scored result must be complete and carry an aggregate" }
    });
  });

  it("rejects a scored result that is not complete", () => {
    expect(
      deriveShortlistProposals([
        entry("candidate_1", 80, { availability: "unavailable" })
      ]).ok
    ).toBe(false);
  });

  it("propagates a duplicate candidate id from the shortlist cut", () => {
    expect(
      deriveShortlistProposals([entry("candidate_1", 80), entry("candidate_1", 70)])
    ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("deriveShortlistProposals eligibility", () => {
  it("proposes only scored results", () => {
    const derivation = derive([
      entry("candidate_scored", 90),
      entry("candidate_escalated", null),
      entry("candidate_rejected", 95, {
        status: "rejected_hard_requirement",
        availability: "complete"
      })
    ]);
    expect(proposedIds(derivation)).toEqual(["candidate_scored"]);
  });

  it("produces no proposal at all when nothing is scored", () => {
    const derivation = derive([entry("candidate_escalated", null)]);
    expect(derivation.proposals).toEqual([]);
  });

  it("excludes perturbation variants from the cut", () => {
    const derivation = derive([
      entry("candidate_variant", 99, { corpusTag: "variant" }),
      entry("candidate_main", 10)
    ]);
    expect(proposedIds(derivation)).toEqual(["candidate_main"]);
  });

  it("excludes candidates dedupe already suppressed", () => {
    const derivation = derive([entry("candidate_1", 90), entry("candidate_2", 80)], {
      duplicateCandidateIds: ["candidate_1"]
    });
    expect(proposedIds(derivation)).toEqual(["candidate_2"]);
  });

  it("surfaces escalated candidates as pending resolution instead of losing them", () => {
    const derivation = derive([
      entry("candidate_b", null),
      entry("candidate_a", null),
      entry("candidate_scored", 90),
      entry("candidate_rejected", 95, {
        status: "rejected_hard_requirement",
        availability: "complete"
      })
    ]);
    expect(derivation.pendingResolutionCandidateIds).toEqual(["candidate_a", "candidate_b"]);
  });
});

describe("deriveShortlistProposals cut and ordering", () => {
  it("ranks by score descending with candidate id as the tie break", () => {
    const derivation = derive([
      entry("candidate_b", 70),
      entry("candidate_a", 70),
      entry("candidate_c", 90)
    ]);
    expect(proposedIds(derivation)).toEqual(["candidate_c", "candidate_a", "candidate_b"]);
    expect(derivation.proposals.map((proposal) => proposal.rank)).toEqual([1, 2, 3]);
  });

  it("caps the cut at the committed limit", () => {
    const entries = Array.from({ length: SHORTLIST_N + 4 }, (_unused, index) =>
      entry(`candidate_${index.toString().padStart(2, "0")}`, 100 - index)
    );
    const derivation = derive(entries);
    expect(derivation.proposals).toHaveLength(SHORTLIST_N);
    expect(proposedIds(derivation)[SHORTLIST_N - 1]).toBe("candidate_09");
  });

  it("honours a smaller limit from the settings", () => {
    const derivation = derive([entry("candidate_a", 90), entry("candidate_b", 80)], {
      shortlistLimit: 1
    });
    expect(proposedIds(derivation)).toEqual(["candidate_a"]);
  });

  it("is order independent", () => {
    const entries = [entry("candidate_a", 70), entry("candidate_b", 90), entry("candidate_c", 80)];
    expect(derive([...entries].reverse())).toEqual(derive(entries));
  });
});

describe("deriveShortlistProposals payloads", () => {
  it("emits the closed shortlist_inclusion payload and carries its evidence", () => {
    const derivation = derive([
      entry("candidate_a", 90, { evidenceSpanIds: ["span_2", "span_1"] })
    ]);
    expect(derivation.proposals[0]).toEqual({
      candidateId: "candidate_a",
      rank: 1,
      payload: { kind: "shortlist_inclusion" },
      evidenceSpanIds: ["span_2", "span_1"]
    });
  });

  it("keeps shortlist_inclusion a score-based kind, so unavailable results cannot carry it", () => {
    expect(isScoreBasedProposalKind("shortlist_inclusion")).toBe(true);
    const derivation = derive([entry("candidate_unavailable", null)]);
    expect(derivation.proposals).toEqual([]);
  });

  it("defaults to the committed shortlist settings", () => {
    expect(DEFAULT_PROPOSAL_SETTINGS).toEqual({
      shortlistLimit: SHORTLIST_N,
      duplicateCandidateIds: []
    });
    const result = deriveShortlistProposals([entry("candidate_a", 90)]);
    expect(result).toMatchObject({ ok: true, value: { proposals: [{ rank: 1 }] } });
  });
});
