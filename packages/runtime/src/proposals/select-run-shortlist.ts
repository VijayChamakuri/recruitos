import {
  DEFAULT_PROPOSAL_SETTINGS,
  ProposalSettingsSchema,
  deriveShortlistProposals,
  err,
  ok,
  type CandidateResultEntry,
  type Result
} from "@recruitos/core";

import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import type { DerivedShortlistProposal } from "./persist-shortlist.js";

export type RunShortlistCandidate = Readonly<{
  candidateId: string;
  status: CandidateResultEntry["status"];
  availability: CandidateResultEntry["availability"];
  aggregate: CandidateResultEntry["aggregate"];
  evidenceSpanIds: readonly string[];
}>;

/**
 * Derives `shortlist_inclusion` once across a finalize plan.
 *
 * Per-candidate `deriveCandidateDecision` cannot see the rest of the run, so it
 * treats every scored candidate as rank 1. The committed cut is run-level:
 * scored main-corpus candidates, score descending, candidate id as the
 * deterministic tie break, capped at `SHORTLIST_N`. Variant runs are excluded.
 * Correction results do not call this helper; they must not mint a shortlist
 * from the corrected candidate alone.
 */
export function selectRunShortlistProposals(args: {
  readonly candidates: readonly RunShortlistCandidate[];
  readonly isVariant: boolean;
  readonly duplicateCandidateIds?: readonly string[];
}): Result<ReadonlyMap<string, DerivedShortlistProposal>, RuntimeError> {
  const corpusTag = args.isVariant ? ("variant" as const) : ("main" as const);
  const entries = args.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    corpusTag,
    status: candidate.status,
    availability: candidate.availability,
    aggregate: candidate.aggregate,
    evidenceSpanIds: [...candidate.evidenceSpanIds]
  }));

  const settings = ProposalSettingsSchema.safeParse({
    shortlistLimit: DEFAULT_PROPOSAL_SETTINGS.shortlistLimit,
    duplicateCandidateIds: [...(args.duplicateCandidateIds ?? [])]
  });
  if (!settings.success) {
    return err(
      createRuntimeError("persistence_failed", "Run-level shortlist derivation failed: Invalid proposal settings", false)
    );
  }

  const derived = deriveShortlistProposals(entries, settings.data);
  if (!derived.ok) {
    return err(
      createRuntimeError(
        "persistence_failed",
        `Run-level shortlist derivation failed: ${derived.error.message}`,
        false
      )
    );
  }

  const selected = new Map<string, DerivedShortlistProposal>();
  for (const proposal of derived.value.proposals) {
    selected.set(proposal.candidateId, {
      payload: proposal.payload,
      evidenceSpanIds: proposal.evidenceSpanIds
    });
  }
  return ok(selected);
}

export function shortlistProposalsForCandidate(
  selected: ReadonlyMap<string, DerivedShortlistProposal>,
  candidateId: string
): readonly DerivedShortlistProposal[] {
  const selectedProposal = selected.get(candidateId);
  if (selectedProposal === undefined) {
    return [];
  }
  return [selectedProposal];
}
