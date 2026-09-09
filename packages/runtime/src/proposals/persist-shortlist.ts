import {
  canonicalJsonStringify,
  err,
  ok,
  sha256Hex,
  type ProposalPayload,
  type Result
} from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import { insertProposal, prepareProposal } from "./store.js";

const TRANSACTION_REQUIRED = "Proposal rows require an active command transaction";

export type DerivedShortlistProposal = Readonly<{
  payload: ProposalPayload;
  evidenceSpanIds: readonly string[];
}>;

type StoredShortlist = Readonly<{
  proposalId: string;
  payloadHash: string;
  evidenceSpanIds: readonly string[];
}>;

function persistFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function requireContext(
  contextInput: ImmediateTransactionContext
): Result<ImmediateTransactionContext, RuntimeError> {
  if (typeof contextInput !== "object" || contextInput === null) {
    return err(persistFailure(TRANSACTION_REQUIRED));
  }
  if (
    typeof contextInput.nativeDatabase !== "object" ||
    contextInput.nativeDatabase === null ||
    contextInput.nativeDatabase.inTransaction !== true
  ) {
    return err(persistFailure(TRANSACTION_REQUIRED));
  }
  return ok(contextInput);
}

function expectedPayloadHash(payload: ProposalPayload): Result<string, RuntimeError> {
  const canonical = canonicalJsonStringify(payload);
  /* v8 ignore next 3 -- shortlist_inclusion payload is a closed JSON object */
  if (!canonical.ok) {
    return err(persistFailure("Shortlist proposal payload is not canonical JSON"));
  }
  return ok(sha256Hex(canonical.value));
}

function sameSpanIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((spanId, index) => spanId === right[index]);
}

function loadOwnedSpanIds(
  context: ImmediateTransactionContext,
  resultId: string
): Result<Set<string>, RuntimeError> {
  try {
    const rows = context.nativeDatabase
      .prepare(
        `SELECT evidence_span_id AS evidenceSpanId
         FROM candidate_result_evidence_span
         WHERE candidate_result_id = ?
         ORDER BY span_ordinal ASC, evidence_span_id ASC`
      )
      .all(resultId) as Array<{ evidenceSpanId: string }>;
    return ok(new Set(rows.map((row) => row.evidenceSpanId)));
  } catch (error) {
    return err(
      persistFailure(`Failed to read candidate result evidence spans: ${String(error)}`)
    );
  }
}

function loadStoredShortlist(
  context: ImmediateTransactionContext,
  resultId: string
): Result<StoredShortlist | undefined, RuntimeError> {
  try {
    const row = context.nativeDatabase
      .prepare(
        `SELECT proposal_id AS proposalId, payload_hash AS payloadHash
         FROM proposal
         WHERE candidate_result_id = ? AND proposal_kind = 'shortlist_inclusion'`
      )
      .get(resultId) as { proposalId: string; payloadHash: string } | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    const spanRows = context.nativeDatabase
      .prepare(
        `SELECT evidence_span_id AS evidenceSpanId
         FROM proposal_evidence_span
         WHERE proposal_id = ?
         ORDER BY span_ordinal ASC, evidence_span_id ASC`
      )
      .all(row.proposalId) as Array<{ evidenceSpanId: string }>;
    return ok({
      proposalId: row.proposalId,
      payloadHash: row.payloadHash,
      evidenceSpanIds: spanRows.map((span) => span.evidenceSpanId)
    });
  } catch (error) {
    return err(persistFailure(`Failed to read persisted shortlist proposal: ${String(error)}`));
  }
}

function assertStoredMatches(
  stored: StoredShortlist,
  payloadHash: string,
  evidenceSpanIds: readonly string[],
  resultId: string
): Result<void, RuntimeError> {
  if (stored.payloadHash !== payloadHash || !sameSpanIds(stored.evidenceSpanIds, evidenceSpanIds)) {
    return err(
      persistFailure(
        `Persisted shortlist proposal history conflict for candidate result ${resultId}`
      )
    );
  }
  return ok(undefined);
}

/**
 * Writes the derived `shortlist_inclusion` proposal for one candidate result.
 *
 * Pending proposals have no `proposal_head` row. Replay of the same content is
 * a no-op. Divergent content for the same result fails closed so history stays
 * immutable. Insert uses the existing proposal store; uniqueness triggers
 * reject replace.
 */
export function persistDerivedShortlistProposals(args: {
  context: ImmediateTransactionContext;
  nextId: () => string;
  createdAt: number;
  resultId: string;
  proposals: readonly DerivedShortlistProposal[];
}): Result<void, RuntimeError> {
  const context = requireContext(args.context);
  if (!context.ok) {
    return context;
  }
  if (typeof args.resultId !== "string" || args.resultId.length === 0) {
    return err(persistFailure("Shortlist persistence requires a candidate result id"));
  }
  if (typeof args.nextId !== "function") {
    return err(persistFailure("Shortlist persistence requires an id generator"));
  }

  const shortlist = args.proposals.filter(
    (proposal) => proposal.payload.kind === "shortlist_inclusion"
  );
  if (shortlist.length === 0) {
    return ok(undefined);
  }
  if (shortlist.length > 1) {
    return err(
      persistFailure("A candidate result may persist at most one shortlist_inclusion proposal")
    );
  }

  const derived = shortlist[0]!;
  const payloadHash = expectedPayloadHash(derived.payload);
  /* v8 ignore next 3 -- shortlist_inclusion payload is a closed JSON object */
  if (!payloadHash.ok) {
    return payloadHash;
  }

  const uniqueSpanIds = [...new Set(derived.evidenceSpanIds)];
  if (uniqueSpanIds.length !== derived.evidenceSpanIds.length) {
    return err(persistFailure("Shortlist proposal evidence spans must be unique"));
  }

  const owned = loadOwnedSpanIds(context.value, args.resultId);
  if (!owned.ok) {
    return owned;
  }
  for (const spanId of uniqueSpanIds) {
    if (!owned.value.has(spanId)) {
      return err(
        persistFailure("Shortlist proposal evidence span is not associated with the candidate result")
      );
    }
  }

  const prepared = prepareProposal({
    proposalId: args.nextId(),
    candidateResultId: args.resultId,
    proposalOrdinal: 0,
    payload: derived.payload,
    evidenceSpans: uniqueSpanIds.map((evidenceSpanId) => ({
      proposalEvidenceSpanId: args.nextId(),
      evidenceSpanId
    })),
    createdAt: args.createdAt
  });
  if (!prepared.ok) {
    return prepared;
  }

  const inserted = insertProposal(context.value, prepared.value);
  if (inserted.ok) {
    return ok(undefined);
  }

  const stored = loadStoredShortlist(context.value, args.resultId);
  if (!stored.ok) {
    return stored;
  }
  if (stored.value !== undefined) {
    return assertStoredMatches(
      stored.value,
      payloadHash.value,
      uniqueSpanIds,
      args.resultId
    );
  }
  return inserted;
}
