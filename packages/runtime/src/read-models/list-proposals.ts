import {
  ProposalStatusSchema,
  ReviewDecisionKindSchema,
  deriveProposalStatus,
  err,
  ok,
  type Result
} from "@recruitos/core";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { getNativeDatabase } from "./native-db.js";
import {
  DEFAULT_PAGE_SIZE,
  MAXIMUM_PAGE_SIZE,
  type IndexPlanStep,
  type IndexPlanSummary,
  type ListProposalsOptions,
  type ProposalListItem,
  type ProposalListPage
} from "./types.js";

interface ProposalCursorData {
  readonly createdAt: number;
  readonly proposalId: string;
}

interface RawProposalRow {
  proposalId: string;
  candidateId: string;
  candidateResultId: string;
  proposalOrdinal: number;
  proposalKind: string;
  createdAt: number;
  currentDecisionKind: string | null;
  headVersion: number;
}

/**
 * Lists persisted proposals using a keyset cursor.
 * Orders by creation timestamp ascending, then proposal ID ascending.
 * Status is derived from the current review decision, or pending when the
 * proposal has no head row.
 */
export function listProposals(
  database: unknown,
  options?: ListProposalsOptions
): Result<ProposalListPage, RuntimeError> {
  const client = getNativeDatabase(database);
  if (!client) {
    return err(
      createRuntimeError(
        "persistence_failed",
        "Database client is unavailable for proposal query",
        false
      )
    );
  }

  if (options?.status !== undefined) {
    const parsedStatus = ProposalStatusSchema.safeParse(options.status);
    if (!parsedStatus.success) {
      return err(
        createRuntimeError("persistence_failed", "Invalid proposal status filter", false)
      );
    }
  }

  const limit = Math.min(
    Math.max(1, options?.limit ?? DEFAULT_PAGE_SIZE),
    MAXIMUM_PAGE_SIZE
  );
  const fetchLimit = limit + 1;

  let cursorData: ProposalCursorData | undefined;
  if (options?.cursor) {
    const decodeResult = decodeCursor<ProposalCursorData>(options.cursor, [
      "createdAt",
      "proposalId"
    ]);
    if (!decodeResult.ok) {
      return decodeResult;
    }
    cursorData = decodeResult.value;
  }

  const whereConditions: string[] = [];
  const params: Record<string, unknown> = {
    fetchLimit
  };

  if (options?.candidateId) {
    whereConditions.push("candidateId = @candidateId");
    params.candidateId = options.candidateId;
  }

  if (options?.status) {
    whereConditions.push("derivedStatus = @status");
    params.status = options.status;
  }

  if (cursorData) {
    whereConditions.push(`(
      (createdAt > @cursorCreatedAt)
      OR (
        createdAt = @cursorCreatedAt
        AND proposalId > @cursorProposalId
      )
    )`);
    params.cursorCreatedAt = cursorData.createdAt;
    params.cursorProposalId = cursorData.proposalId;
  }

  const whereClause =
    whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

  const sql = `WITH proposal_feed AS (
    SELECT
      p.proposal_id AS proposalId,
      ctr.candidate_id AS candidateId,
      p.candidate_result_id AS candidateResultId,
      p.proposal_ordinal AS proposalOrdinal,
      p.proposal_kind AS proposalKind,
      p.created_at AS createdAt,
      rd.decision_kind AS currentDecisionKind,
      COALESCE(ph.version, 0) AS headVersion,
      CASE
        WHEN rd.decision_kind IS NULL THEN 'pending'
        WHEN rd.decision_kind = 'approve' THEN 'approved'
        WHEN rd.decision_kind = 'reject' THEN 'rejected'
        WHEN rd.decision_kind = 'edit' THEN 'edited'
        WHEN rd.decision_kind = 'request_evidence' THEN 'evidence_requested'
        ELSE 'pending'
      END AS derivedStatus
    FROM proposal p
    JOIN candidate_triage_result ctr
      ON ctr.candidate_triage_result_id = p.candidate_result_id
    LEFT JOIN proposal_head ph ON ph.proposal_id = p.proposal_id
    LEFT JOIN review_decision rd ON rd.review_decision_id = ph.current_decision_id
  )
  SELECT
    proposalId,
    candidateId,
    candidateResultId,
    proposalOrdinal,
    proposalKind,
    createdAt,
    currentDecisionKind,
    headVersion
  FROM proposal_feed
  ${whereClause}
  ORDER BY createdAt ASC, proposalId ASC
  LIMIT @fetchLimit`;

  let rows: RawProposalRow[];
  try {
    const stmt = client.prepare(sql);
    rows = stmt.all(params) as RawProposalRow[];
  } catch (error) {
    return err(
      createRuntimeError(
        "persistence_failed",
        `Failed to query proposals: ${String(error)}`,
        false
      )
    );
  }

  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

  const items: ProposalListItem[] = pageRows.map((row) => {
    const parsedKind =
      row.currentDecisionKind === null
        ? null
        : ReviewDecisionKindSchema.safeParse(row.currentDecisionKind);
    const status = deriveProposalStatus(
      parsedKind === null ? null : parsedKind.success ? parsedKind.data : null
    );
    return {
      proposalId: row.proposalId,
      candidateId: row.candidateId,
      candidateResultId: row.candidateResultId,
      proposalOrdinal: row.proposalOrdinal,
      kind: row.proposalKind,
      status,
      proposedChange: row.proposalKind,
      version: row.headVersion,
      createdAt: row.createdAt
    };
  });

  let nextCursor: string | undefined;
  if (hasNextPage && pageRows.length > 0) {
    const lastItem = pageRows[pageRows.length - 1]!;
    nextCursor = encodeCursor<ProposalCursorData>({
      createdAt: lastItem.createdAt,
      proposalId: lastItem.proposalId
    });
  }

  return ok({
    items,
    nextCursor,
    queryCount: 1
  });
}

/**
 * Reports EXPLAIN QUERY PLAN for listProposals. The existing
 * `proposal_result_created` index covers per-result access. The global queue
 * joins the parent result so SQLite can use a primary key; this assertion
 * records that plan and does not add a migration.
 */
export function assertListProposalsIndexPlan(
  database: unknown
): Result<IndexPlanSummary, RuntimeError> {
  const client = getNativeDatabase(database);
  if (!client) {
    return err(
      createRuntimeError(
        "persistence_failed",
        "Database client unavailable for index plan",
        false
      )
    );
  }

  const query = `EXPLAIN QUERY PLAN
  SELECT
    p.proposal_id,
    p.created_at,
    ctr.candidate_id
  FROM proposal p
  JOIN candidate_triage_result ctr
    ON ctr.candidate_triage_result_id = p.candidate_result_id
  LEFT JOIN proposal_head ph ON ph.proposal_id = p.proposal_id
  LEFT JOIN review_decision rd ON rd.review_decision_id = ph.current_decision_id
  ORDER BY p.created_at ASC, p.proposal_id ASC
  LIMIT 51`;

  try {
    const stmt = client.prepare(query);
    const rows = stmt.all() as { id: number; parent: number; detail: string }[];
    const steps: IndexPlanStep[] = rows.map((r) => ({
      id: r.id,
      parent: r.parent,
      detail: r.detail
    }));

    const usesCoveringOrIndexedScan = steps.some(
      (s) => s.detail.includes("USING INDEX") || s.detail.includes("PRIMARY KEY")
    );

    return ok({
      query,
      steps,
      usesCoveringOrIndexedScan
    });
  } catch (error) {
    return err(
      createRuntimeError(
        "persistence_failed",
        `Failed to explain proposals query plan: ${String(error)}`,
        false
      )
    );
  }
}
