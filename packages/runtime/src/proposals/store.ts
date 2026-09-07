import {
  CandidateTriageResultIdSchema,
  NonnegativeIntegerSchema,
  ProposalIdSchema,
  ReviewDecisionIdSchema,
  canonicalJsonStringify,
  deriveProposalStatus,
  err,
  isScoreBasedProposalKind,
  ok,
  sha256Hex,
  type ProposalStatus,
  type Result
} from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { SYSTEM_ACTOR_ID } from "../entities/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  compareAndSetMutableHead,
  defineMutableHead,
  initializeMutableHead,
  readMutableHead,
  type MutableHeadDefinition
} from "../persistence/index.js";
import {
  ProposalDraftSchema,
  ProposalEvidenceSpanSchema,
  ProposalHeadSchema,
  ProposalSchema,
  ReviewDecisionDraftSchema,
  ReviewDecisionSchema,
  type Proposal,
  type ProposalEvidenceSpan,
  type ProposalHead,
  type ReviewDecision
} from "./schemas.js";

const preparedProposals = new WeakSet<object>();
const preparedDecisions = new WeakSet<object>();

const PROPOSAL_TRANSACTION_REQUIRED = "Proposal rows require an active command transaction";
const DECISION_TRANSACTION_REQUIRED =
  "Review decision rows require an active command transaction";
const HEAD_TRANSACTION_REQUIRED = "Proposal head rows require an active command transaction";

const PROPOSAL_HEAD: MutableHeadDefinition = (
  defineMutableHead({
    tableName: "proposal_head",
    identityColumn: "proposal_id",
    pointerColumn: "current_decision_id",
    versionColumn: "version"
  }) as { ok: true; value: MutableHeadDefinition }
).value;

type ProposalRow = Readonly<{
  proposalId: string;
  candidateResultId: string;
  proposalKind: string;
  proposalOrdinal: number;
  payloadJson: string;
  payloadHash: string;
  createdAt: number;
}>;

type DecisionRow = Readonly<{
  reviewDecisionId: string;
  proposalId: string;
  actorId: string;
  decisionKind: string;
  decisionOrdinal: number;
  payloadJson: string;
  payloadHash: string;
  createdAt: number;
}>;

const PROPOSAL_SELECT = `SELECT
          proposal_id AS proposalId,
          candidate_result_id AS candidateResultId,
          proposal_kind AS proposalKind,
          proposal_ordinal AS proposalOrdinal,
          payload_json AS payloadJson,
          payload_hash AS payloadHash,
          created_at AS createdAt
        FROM proposal`;

const DECISION_SELECT = `SELECT
          review_decision_id AS reviewDecisionId,
          proposal_id AS proposalId,
          actor_id AS actorId,
          decision_kind AS decisionKind,
          decision_ordinal AS decisionOrdinal,
          payload_json AS payloadJson,
          payload_hash AS payloadHash,
          created_at AS createdAt
        FROM review_decision`;

const SPAN_SELECT = `SELECT
          proposal_evidence_span_id AS proposalEvidenceSpanId,
          evidence_span_id AS evidenceSpanId,
          span_ordinal AS spanOrdinal,
          created_at AS createdAt
        FROM proposal_evidence_span`;

function persistenceFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function versionConflict(
  identity: string,
  expectedVersion: number,
  actualVersion: number | null
): RuntimeError {
  return createRuntimeError("version_conflict", "Mutable head version conflict", false, {
    table: "proposal_head",
    identity,
    expectedVersion,
    actualVersion
  });
}

function validateContext(
  contextInput: unknown,
  message: string
): Result<ImmediateTransactionContext, RuntimeError> {
  if (typeof contextInput !== "object" || contextInput === null) {
    return err(persistenceFailure(message));
  }
  const context = contextInput as Partial<ImmediateTransactionContext>;
  if (
    typeof context.nativeDatabase !== "object" ||
    context.nativeDatabase === null ||
    context.nativeDatabase.inTransaction !== true
  ) {
    return err(persistenceFailure(message));
  }
  return ok(context as ImmediateTransactionContext);
}

function requirePrepared<TRecord>(
  registry: WeakSet<object>,
  preparedInput: unknown,
  message: string
): Result<TRecord, RuntimeError> {
  if (
    typeof preparedInput !== "object" ||
    preparedInput === null ||
    !registry.has(preparedInput)
  ) {
    return err(persistenceFailure(message));
  }
  return ok(preparedInput as TRecord);
}

function register<TRecord extends object>(
  registry: WeakSet<object>,
  record: TRecord
): TRecord {
  const frozen = Object.freeze(record);
  registry.add(frozen);
  return frozen;
}

function uniqueIds(ids: readonly string[], message: string): Result<void, RuntimeError> {
  if (new Set(ids).size !== ids.length) {
    return err(persistenceFailure(message));
  }
  return ok(undefined);
}

function rowExists(
  context: ImmediateTransactionContext,
  sql: string,
  id: string
): boolean {
  return context.nativeDatabase.prepare(sql).get(id) !== undefined;
}

function decodeCanonicalJson(
  json: string,
  hash: string,
  invalidJsonMessage: string,
  integrityMessage: string
): Result<unknown, RuntimeError> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    return err(persistenceFailure(invalidJsonMessage));
  }
  const canonical = canonicalJsonStringify(decoded);
  if (!canonical.ok || canonical.value !== json || sha256Hex(json) !== hash) {
    return err(persistenceFailure(integrityMessage));
  }
  return ok(decoded);
}

export function prepareProposal(draftInput: unknown): Result<Proposal, RuntimeError> {
  try {
    const draft = ProposalDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid proposal input"));
    }
    const uniqueSpans = uniqueIds(
      draft.data.evidenceSpans.map((span) => span.evidenceSpanId),
      "Proposal evidence spans must be unique"
    );
    if (!uniqueSpans.ok) {
      return uniqueSpans;
    }
    const uniqueRecords = uniqueIds(
      draft.data.evidenceSpans.map((span) => span.proposalEvidenceSpanId),
      "Proposal evidence span IDs must be unique"
    );
    if (!uniqueRecords.ok) {
      return uniqueRecords;
    }
    const payloadJson = canonicalJsonStringify(draft.data.payload);
    if (!payloadJson.ok) {
      return err(persistenceFailure("Proposal payload is not canonical JSON"));
    }
    const evidenceSpans = draft.data.evidenceSpans.map((span, index) =>
      Object.freeze({
        proposalEvidenceSpanId: span.proposalEvidenceSpanId,
        evidenceSpanId: span.evidenceSpanId,
        spanOrdinal: index,
        createdAt: draft.data.createdAt
      })
    );
    const proposal = ProposalSchema.safeParse({
      proposalId: draft.data.proposalId,
      candidateResultId: draft.data.candidateResultId,
      proposalKind: draft.data.payload.kind,
      proposalOrdinal: draft.data.proposalOrdinal,
      payload: draft.data.payload,
      payloadJson: payloadJson.value,
      payloadHash: sha256Hex(payloadJson.value),
      evidenceSpans,
      createdAt: draft.data.createdAt
    });
    if (!proposal.success) {
      return err(persistenceFailure("Invalid proposal input"));
    }
    return ok(
      register(preparedProposals, {
        ...proposal.data,
        evidenceSpans: proposal.data.evidenceSpans.map((span) => Object.freeze(span))
      })
    );
  } catch {
    return err(persistenceFailure("Proposal preparation failed"));
  }
}

export function prepareReviewDecision(
  draftInput: unknown
): Result<ReviewDecision, RuntimeError> {
  try {
    const draft = ReviewDecisionDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid review decision input"));
    }
    if (draft.data.actorId === SYSTEM_ACTOR_ID) {
      return err(persistenceFailure("Review decision actor must be a human actor"));
    }
    const payloadJson = canonicalJsonStringify(draft.data.payload);
    if (!payloadJson.ok) {
      return err(persistenceFailure("Review decision payload is not canonical JSON"));
    }
    const decision = ReviewDecisionSchema.safeParse({
      reviewDecisionId: draft.data.reviewDecisionId,
      proposalId: draft.data.proposalId,
      actorId: draft.data.actorId,
      decisionKind: draft.data.payload.kind,
      decisionOrdinal: draft.data.decisionOrdinal,
      payload: draft.data.payload,
      payloadJson: payloadJson.value,
      payloadHash: sha256Hex(payloadJson.value),
      createdAt: draft.data.createdAt
    });
    if (!decision.success) {
      return err(persistenceFailure("Invalid review decision input"));
    }
    return ok(register(preparedDecisions, decision.data));
  } catch {
    return err(persistenceFailure("Review decision preparation failed"));
  }
}

export function insertProposal(
  contextInput: unknown,
  preparedInput: unknown
): Result<Proposal, RuntimeError> {
  try {
    const context = validateContext(contextInput, PROPOSAL_TRANSACTION_REQUIRED);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<Proposal>(
      preparedProposals,
      preparedInput,
      "Invalid prepared proposal"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const proposal = prepared.value;
    const parent = context.value.nativeDatabase
      .prepare(
        `SELECT availability
         FROM candidate_triage_result
         WHERE candidate_triage_result_id = ?`
      )
      .get(proposal.candidateResultId) as { availability: string } | undefined;
    if (parent === undefined) {
      return err(persistenceFailure("Proposal requires a stored candidate result"));
    }
    if (
      isScoreBasedProposalKind(proposal.proposalKind) &&
      parent.availability === "unavailable"
    ) {
      return err(
        persistenceFailure("Score-based proposals are not valid on unavailable results")
      );
    }
    for (const span of proposal.evidenceSpans) {
      if (
        !rowExists(
          context.value,
          "SELECT evidence_span_id FROM evidence_span WHERE evidence_span_id = ?",
          span.evidenceSpanId
        )
      ) {
        return err(persistenceFailure("Proposal requires a stored evidence span"));
      }
      const owned = context.value.nativeDatabase
        .prepare(
          `SELECT 1
           FROM candidate_result_evidence_span
           WHERE candidate_result_id = ? AND evidence_span_id = ?`
        )
        .get(proposal.candidateResultId, span.evidenceSpanId);
      if (owned === undefined) {
        return err(
          persistenceFailure("Proposal evidence span must belong to the candidate result")
        );
      }
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO proposal (
          proposal_id,
          candidate_result_id,
          proposal_kind,
          proposal_ordinal,
          payload_json,
          payload_hash,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        proposal.proposalId,
        proposal.candidateResultId,
        proposal.proposalKind,
        proposal.proposalOrdinal,
        proposal.payloadJson,
        proposal.payloadHash,
        proposal.createdAt
      );
    const insertSpan = context.value.nativeDatabase.prepare(
      `INSERT INTO proposal_evidence_span (
        proposal_evidence_span_id,
        proposal_id,
        evidence_span_id,
        span_ordinal,
        created_at
      ) VALUES (?, ?, ?, ?, ?)`
    );
    for (const span of proposal.evidenceSpans) {
      insertSpan.run(
        span.proposalEvidenceSpanId,
        proposal.proposalId,
        span.evidenceSpanId,
        span.spanOrdinal,
        span.createdAt
      );
    }
    return ok(proposal);
  } catch {
    return err(persistenceFailure("Proposal insert failed"));
  }
}

function swingHead(
  context: ImmediateTransactionContext,
  proposalId: string,
  decisionId: string,
  expectedHeadVersion: number
): Result<{ identity: string; pointer: string; version: number }, RuntimeError> {
  if (expectedHeadVersion === 0) {
    return initializeMutableHead(context, PROPOSAL_HEAD, {
      identity: proposalId,
      pointer: decisionId
    });
  }
  return compareAndSetMutableHead(context, PROPOSAL_HEAD, {
    identity: proposalId,
    pointer: decisionId,
    expectedVersion: expectedHeadVersion
  });
}

export function insertReviewDecision(
  contextInput: unknown,
  preparedInput: unknown,
  expectedHeadVersionInput: unknown
): Result<ReviewDecision, RuntimeError> {
  try {
    const context = validateContext(contextInput, DECISION_TRANSACTION_REQUIRED);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<ReviewDecision>(
      preparedDecisions,
      preparedInput,
      "Invalid prepared review decision"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const expectedHeadVersion = NonnegativeIntegerSchema.safeParse(expectedHeadVersionInput);
    if (!expectedHeadVersion.success) {
      return err(persistenceFailure("Invalid expected head version"));
    }
    const decision = prepared.value;
    const proposal = context.value.nativeDatabase
      .prepare("SELECT proposal_kind AS proposalKind FROM proposal WHERE proposal_id = ?")
      .get(decision.proposalId) as { proposalKind: string } | undefined;
    if (proposal === undefined) {
      return err(persistenceFailure("Review decision requires a stored proposal"));
    }
    if (
      !rowExists(context.value, "SELECT actor_id FROM actor WHERE actor_id = ?", decision.actorId)
    ) {
      return err(persistenceFailure("Review decision requires a stored actor"));
    }
    if (
      decision.decisionKind === "edit" &&
      decision.payload.kind === "edit" &&
      decision.payload.editedPayload.kind !== proposal.proposalKind
    ) {
      return err(
        persistenceFailure("Edited payload kind must match the stored proposal kind")
      );
    }

    const currentHead = readMutableHead(context.value, PROPOSAL_HEAD, decision.proposalId);
    if (!currentHead.ok) {
      return currentHead;
    }
    const actualVersion = currentHead.value === undefined ? null : currentHead.value.version;
    if (expectedHeadVersion.data === 0) {
      if (actualVersion !== null) {
        return err(versionConflict(decision.proposalId, 0, actualVersion));
      }
    } else if (actualVersion !== expectedHeadVersion.data) {
      return err(versionConflict(decision.proposalId, expectedHeadVersion.data, actualVersion));
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO review_decision (
          review_decision_id,
          proposal_id,
          actor_id,
          decision_kind,
          decision_ordinal,
          payload_json,
          payload_hash,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        decision.reviewDecisionId,
        decision.proposalId,
        decision.actorId,
        decision.decisionKind,
        decision.decisionOrdinal,
        decision.payloadJson,
        decision.payloadHash,
        decision.createdAt
      );

    const swung = swingHead(
      context.value,
      decision.proposalId,
      decision.reviewDecisionId,
      expectedHeadVersion.data
    );
    if (!swung.ok) {
      return swung;
    }
    return ok(decision);
  } catch {
    return err(persistenceFailure("Review decision insert failed"));
  }
}

function hydrateSpans(
  context: ImmediateTransactionContext,
  proposalId: string
): Result<ProposalEvidenceSpan[], RuntimeError> {
  const rows = context.nativeDatabase
    .prepare(
      `${SPAN_SELECT}
      WHERE proposal_id = ?
      ORDER BY span_ordinal ASC, proposal_evidence_span_id ASC`
    )
    .all(proposalId) as ProposalEvidenceSpan[];
  const spans: ProposalEvidenceSpan[] = [];
  for (const row of rows) {
    const parsed = ProposalEvidenceSpanSchema.safeParse(row);
    if (!parsed.success) {
      return err(persistenceFailure("Stored proposal evidence span is invalid"));
    }
    spans.push(Object.freeze(parsed.data));
  }
  return ok(spans);
}

function hydrateProposal(
  context: ImmediateTransactionContext,
  row: ProposalRow
): Result<Proposal, RuntimeError> {
  const decoded = decodeCanonicalJson(
    row.payloadJson,
    row.payloadHash,
    "Stored proposal payload is not valid JSON",
    "Stored proposal failed integrity validation"
  );
  if (!decoded.ok) {
    return decoded;
  }
  const spans = hydrateSpans(context, row.proposalId);
  if (!spans.ok) {
    return spans;
  }
  const proposal = ProposalSchema.safeParse({
    ...row,
    payload: decoded.value,
    evidenceSpans: spans.value
  });
  if (!proposal.success) {
    return err(persistenceFailure("Stored proposal is invalid"));
  }
  if (proposal.data.payload.kind !== proposal.data.proposalKind) {
    return err(persistenceFailure("Stored proposal failed integrity validation"));
  }
  return ok(
    Object.freeze({
      ...proposal.data,
      evidenceSpans: proposal.data.evidenceSpans.map((span) => Object.freeze(span))
    })
  );
}

function hydrateDecision(row: DecisionRow): Result<ReviewDecision, RuntimeError> {
  const decoded = decodeCanonicalJson(
    row.payloadJson,
    row.payloadHash,
    "Stored review decision payload is not valid JSON",
    "Stored review decision failed integrity validation"
  );
  if (!decoded.ok) {
    return decoded;
  }
  const decision = ReviewDecisionSchema.safeParse({
    ...row,
    payload: decoded.value
  });
  if (!decision.success) {
    return err(persistenceFailure("Stored review decision is invalid"));
  }
  if (
    decision.data.payload.kind !== decision.data.decisionKind ||
    decision.data.actorId === SYSTEM_ACTOR_ID
  ) {
    return err(persistenceFailure("Stored review decision failed integrity validation"));
  }
  return ok(Object.freeze(decision.data));
}

export function readProposal(
  contextInput: unknown,
  proposalIdInput: unknown
): Result<Proposal | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput, PROPOSAL_TRANSACTION_REQUIRED);
    if (!context.ok) {
      return context;
    }
    const proposalId = ProposalIdSchema.safeParse(proposalIdInput);
    if (!proposalId.success) {
      return err(persistenceFailure("Invalid proposal ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${PROPOSAL_SELECT} WHERE proposal_id = ?`)
      .get(proposalId.data) as ProposalRow | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    return hydrateProposal(context.value, row);
  } catch {
    return err(persistenceFailure("Proposal read failed"));
  }
}

export function readProposals(
  contextInput: unknown,
  candidateTriageResultIdInput: unknown
): Result<readonly Proposal[], RuntimeError> {
  try {
    const context = validateContext(contextInput, PROPOSAL_TRANSACTION_REQUIRED);
    if (!context.ok) {
      return context;
    }
    const resultId = CandidateTriageResultIdSchema.safeParse(candidateTriageResultIdInput);
    if (!resultId.success) {
      return err(persistenceFailure("Invalid candidate result ID"));
    }
    const rows = context.value.nativeDatabase
      .prepare(
        `${PROPOSAL_SELECT}
        WHERE candidate_result_id = ?
        ORDER BY proposal_ordinal ASC, proposal_id ASC`
      )
      .all(resultId.data) as ProposalRow[];
    const proposals: Proposal[] = [];
    for (const row of rows) {
      const hydrated = hydrateProposal(context.value, row);
      if (!hydrated.ok) {
        return hydrated;
      }
      proposals.push(hydrated.value);
    }
    return ok(Object.freeze(proposals));
  } catch {
    return err(persistenceFailure("Proposal read failed"));
  }
}

export function readReviewDecision(
  contextInput: unknown,
  reviewDecisionIdInput: unknown
): Result<ReviewDecision | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput, DECISION_TRANSACTION_REQUIRED);
    if (!context.ok) {
      return context;
    }
    const decisionId = ReviewDecisionIdSchema.safeParse(reviewDecisionIdInput);
    if (!decisionId.success) {
      return err(persistenceFailure("Invalid review decision ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${DECISION_SELECT} WHERE review_decision_id = ?`)
      .get(decisionId.data) as DecisionRow | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    return hydrateDecision(row);
  } catch {
    return err(persistenceFailure("Review decision read failed"));
  }
}

export function readReviewDecisions(
  contextInput: unknown,
  proposalIdInput: unknown
): Result<readonly ReviewDecision[], RuntimeError> {
  try {
    const context = validateContext(contextInput, DECISION_TRANSACTION_REQUIRED);
    if (!context.ok) {
      return context;
    }
    const proposalId = ProposalIdSchema.safeParse(proposalIdInput);
    if (!proposalId.success) {
      return err(persistenceFailure("Invalid proposal ID"));
    }
    const rows = context.value.nativeDatabase
      .prepare(
        `${DECISION_SELECT}
        WHERE proposal_id = ?
        ORDER BY decision_ordinal ASC, review_decision_id ASC`
      )
      .all(proposalId.data) as DecisionRow[];
    const decisions: ReviewDecision[] = [];
    for (const row of rows) {
      const hydrated = hydrateDecision(row);
      if (!hydrated.ok) {
        return hydrated;
      }
      decisions.push(hydrated.value);
    }
    return ok(Object.freeze(decisions));
  } catch {
    return err(persistenceFailure("Review decision read failed"));
  }
}

export function readProposalHead(
  contextInput: unknown,
  proposalIdInput: unknown
): Result<ProposalHead | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput, HEAD_TRANSACTION_REQUIRED);
    if (!context.ok) {
      return context;
    }
    const proposalId = ProposalIdSchema.safeParse(proposalIdInput);
    if (!proposalId.success) {
      return err(persistenceFailure("Invalid proposal ID"));
    }
    const head = readMutableHead(context.value, PROPOSAL_HEAD, proposalId.data);
    if (!head.ok) {
      return head;
    }
    if (head.value === undefined) {
      return ok(undefined);
    }
    const parsed = ProposalHeadSchema.safeParse({
      proposalId: head.value.identity,
      currentDecisionId: head.value.pointer,
      version: head.value.version
    });
    if (!parsed.success) {
      return err(persistenceFailure("Stored proposal head is invalid"));
    }
    return ok(Object.freeze(parsed.data));
  } catch {
    return err(persistenceFailure("Proposal head read failed"));
  }
}

export function readProposalStatus(
  contextInput: unknown,
  proposalIdInput: unknown
): Result<ProposalStatus | undefined, RuntimeError> {
  const proposal = readProposal(contextInput, proposalIdInput);
  if (!proposal.ok) {
    return proposal;
  }
  if (proposal.value === undefined) {
    return ok(undefined);
  }
  const head = readProposalHead(contextInput, proposalIdInput);
  if (!head.ok) {
    return head;
  }
  if (head.value === undefined) {
    return ok(deriveProposalStatus(null));
  }
  const decision = readReviewDecision(contextInput, head.value.currentDecisionId);
  if (!decision.ok) {
    return decision;
  }
  if (decision.value === undefined) {
    return err(
      persistenceFailure("Proposal head current_decision_id must belong to the proposal")
    );
  }
  return ok(deriveProposalStatus(decision.value.decisionKind));
}
