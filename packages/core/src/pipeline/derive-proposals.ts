import { z } from "zod";

import { compareCodeUnits } from "../canonical/comparator.js";
import { RationalSchema } from "../canonical/rational.js";
import { CandidateIdSchema, EvidenceSpanIdSchema } from "../domain/ids.js";
import { PositiveIntegerSchema } from "../domain/integers.js";
import type { ProposalPayload } from "../domain/proposal.js";
import { CandidateTriageStatusSchema, DecisionAvailabilitySchema } from "../domain/status.js";
import { createDomainError, type DomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";
import { SHORTLIST_N } from "../scoring/constants.js";
import { shortlistCut } from "../scoring/shortlist.js";

/**
 * Mirrors the corpus manifest kind. Perturbation variants execute in their own
 * run and are excluded from the shortlist cut, so a variant can never displace
 * a real candidate from the proposed set.
 */
export const CORPUS_TAGS = ["main", "variant"] as const;

export const CorpusTagSchema = z.enum(CORPUS_TAGS);
export type CorpusTag = z.infer<typeof CorpusTagSchema>;

/** Evidence carried onto one proposal, bounded the way the packet is. */
export const MAXIMUM_PROPOSAL_EVIDENCE_SPANS = 24;

const CandidateResultEntrySchema = z
  .object({
    candidateId: CandidateIdSchema,
    corpusTag: CorpusTagSchema,
    status: CandidateTriageStatusSchema,
    availability: DecisionAvailabilitySchema,
    aggregate: RationalSchema.nullable(),
    evidenceSpanIds: z.array(EvidenceSpanIdSchema).max(MAXIMUM_PROPOSAL_EVIDENCE_SPANS)
  })
  .strict();

export type CandidateResultEntry = z.infer<typeof CandidateResultEntrySchema>;

const CandidateResultEntriesSchema = z.array(CandidateResultEntrySchema);

/**
 * Shortlist and dedupe settings. `shortlistLimit` is the committed cut size.
 * `duplicateCandidateIds` are the candidates dedupe already suppressed: they
 * are near-duplicates of an earlier import, so proposing both would double
 * count one person.
 */
export const ProposalSettingsSchema = z
  .object({
    shortlistLimit: PositiveIntegerSchema,
    duplicateCandidateIds: z.array(CandidateIdSchema)
  })
  .strict();

export type ProposalSettings = z.infer<typeof ProposalSettingsSchema>;

export const DEFAULT_PROPOSAL_SETTINGS: ProposalSettings = Object.freeze(
  ProposalSettingsSchema.parse({ shortlistLimit: SHORTLIST_N, duplicateCandidateIds: [] })
);

/**
 * One proposed shortlist inclusion. `rank` is the candidate's one-based
 * position in the cut, so the packet can show why this candidate is proposed
 * without reprinting the aggregate as a grade.
 */
export type ShortlistInclusionProposal = Readonly<{
  candidateId: string;
  rank: number;
  payload: ProposalPayload;
  evidenceSpanIds: readonly string[];
}>;

export type ProposalDerivation = Readonly<{
  proposals: readonly ShortlistInclusionProposal[];
  pendingResolutionCandidateIds: readonly string[];
}>;

function invalidInput(message: string): DomainError {
  return createDomainError("invalid_input", message);
}

function isScored(entry: CandidateResultEntry): boolean {
  return entry.status === "scored";
}

/** The only payload this slice can produce, pinned to the closed union. */
const SHORTLIST_INCLUSION_PAYLOAD: ProposalPayload = Object.freeze({
  kind: "shortlist_inclusion"
});

/**
 * Derives the `shortlist_inclusion` proposals for one run.
 *
 * A proposal exists only for a candidate whose result is scored: escalated,
 * rejected, and unavailable results produce nothing, because a score-based
 * proposal on a result with no score would be a recommendation with no
 * arithmetic behind it. Perturbation variants and dedupe-suppressed duplicates
 * are excluded from the cut as well.
 *
 * The cut itself is `shortlistCut` from the scoring engine, unchanged: score
 * descending with candidate id as the deterministic tie break, capped at the
 * committed limit. Escalated candidates are not silently lost; they come back
 * as `pendingResolutionCandidateIds` so the caller can surface the "pending
 * resolution, may qualify" list beside the proposed cut.
 *
 * Nothing here is an outbound effect. Every proposal is a suggestion awaiting a
 * review decision.
 */
export function deriveShortlistProposals(
  resultsInput: unknown,
  settings: ProposalSettings = DEFAULT_PROPOSAL_SETTINGS
): Result<ProposalDerivation, DomainError> {
  const parsed = CandidateResultEntriesSchema.safeParse(resultsInput);
  if (!parsed.success) {
    return err(invalidInput("Invalid candidate result entries"));
  }
  const parsedSettings = ProposalSettingsSchema.safeParse(settings);
  if (!parsedSettings.success) {
    return err(invalidInput("Invalid proposal settings"));
  }

  for (const entry of parsed.data) {
    if (isScored(entry) && (entry.availability !== "complete" || entry.aggregate === null)) {
      return err(invalidInput("A scored result must be complete and carry an aggregate"));
    }
  }

  const suppressed = new Set<string>(parsedSettings.data.duplicateCandidateIds);
  const eligible = parsed.data.filter(
    (entry) => isScored(entry) && entry.corpusTag === "main" && !suppressed.has(entry.candidateId)
  );

  const cut = shortlistCut(
    eligible.map((entry) => ({
      candidateId: entry.candidateId,
      status: entry.status,
      aggregate: entry.aggregate
    })),
    parsedSettings.data.shortlistLimit
  );
  if (!cut.ok) {
    return cut;
  }

  const rankByCandidate = new Map<string, number>(
    cut.value.map((candidate, index) => [candidate.candidateId, index])
  );
  const proposals: ShortlistInclusionProposal[] = [];
  for (const entry of eligible) {
    const rank = rankByCandidate.get(entry.candidateId);
    if (rank === undefined) {
      continue;
    }
    proposals.push(
      Object.freeze({
        candidateId: entry.candidateId,
        rank: rank + 1,
        payload: SHORTLIST_INCLUSION_PAYLOAD,
        evidenceSpanIds: Object.freeze([...entry.evidenceSpanIds])
      })
    );
  }
  proposals.sort((left, right) => left.rank - right.rank);

  const pending: string[] = parsed.data
    .filter((entry) => entry.status === "escalated")
    .map((entry) => entry.candidateId);
  pending.sort(compareCodeUnits);

  return ok(
    Object.freeze({
      proposals: Object.freeze(proposals),
      pendingResolutionCandidateIds: Object.freeze(pending)
    })
  );
}
