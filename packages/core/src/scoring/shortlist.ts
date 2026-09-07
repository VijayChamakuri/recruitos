import { z } from "zod";

import { compareRationals, RationalSchema } from "../canonical/rational.js";
import { CandidateIdSchema } from "../domain/ids.js";
import { PositiveIntegerSchema } from "../domain/integers.js";
import { CandidateTriageStatusSchema } from "../domain/status.js";
import { createDomainError, type DomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";
import { SHORTLIST_N } from "./constants.js";

const ShortlistCandidateSchema = z
  .object({
    candidateId: CandidateIdSchema,
    status: CandidateTriageStatusSchema,
    aggregate: RationalSchema
  })
  .strict()
  .readonly();

export type ShortlistCandidate = z.infer<typeof ShortlistCandidateSchema>;

const ShortlistCandidatesSchema = z.array(ShortlistCandidateSchema);

/**
 * Total order for the shortlist: aggregate score descending, then candidate id
 * ascending as a deterministic tie break. Candidate ids are unique across the
 * input, so the tie break never compares equal ids.
 */
export function compareShortlist(left: ShortlistCandidate, right: ShortlistCandidate): number {
  const byScore = compareRationals(right.aggregate, left.aggregate);
  if (byScore !== 0) {
    return byScore;
  }
  return left.candidateId < right.candidateId ? -1 : 1;
}

/**
 * Takes candidates with status scored, orders them by aggregate descending with
 * candidate id as the deterministic tie break, and returns the top `limit`
 * (default SHORTLIST_N). Escalated and rejected candidates are excluded here;
 * the caller surfaces escalated candidates separately.
 */
export function shortlistCut(
  input: unknown,
  limit: number = SHORTLIST_N
): Result<readonly ShortlistCandidate[], DomainError> {
  const parsed = ShortlistCandidatesSchema.safeParse(input);
  if (!parsed.success) {
    return err(createDomainError("invalid_input", "Invalid shortlist candidates"));
  }
  const limitParsed = PositiveIntegerSchema.safeParse(limit);
  if (!limitParsed.success) {
    return err(createDomainError("invalid_input", "Shortlist limit must be a positive integer"));
  }

  const seen = new Set<string>();
  for (const candidate of parsed.data) {
    if (seen.has(candidate.candidateId)) {
      return err(createDomainError("invalid_input", "Shortlist candidate ids must be unique"));
    }
    seen.add(candidate.candidateId);
  }

  const scored = parsed.data.filter((candidate) => candidate.status === "scored");
  const ordered = [...scored].sort(compareShortlist);
  return ok(Object.freeze(ordered.slice(0, limitParsed.data)));
}
