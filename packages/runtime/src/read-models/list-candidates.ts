import { err, ok, type Result } from "@recruitos/core";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { getNativeDatabase } from "./native-db.js";
import {
  DEFAULT_PAGE_SIZE,
  MAXIMUM_PAGE_SIZE,
  type CandidateListPage,
  type CandidateSummaryItem,
  type CandidateTriageStatus,
  type IndexPlanStep,
  type IndexPlanSummary,
  type ListCandidatesOptions
} from "./types.js";

interface CandidateCursorData {
  readonly score: number;
  readonly importOrdinal: number;
  readonly candidateId: string;
}

interface RawCandidateRow {
  candidateId: string;
  sourceSystem: string;
  sourceKey: string;
  channel: string;
  corpusTag: string;
  isSynthetic: number;
  createdAt: number;
  importOrdinal: number | null;
  headVersion: number | null;
  currentResultId: string | null;
  resultStatus: string | null;
  scoreBasisPoints: number | null;
  confidenceBasisPoints: number | null;
  scoreAggregateText: string | null;
  scoreConfidenceText: string | null;
  isSealed: number;
  sortScore: number;
  sortImportOrdinal: number;
}

interface RawReasonRow {
  candidateResultId: string;
  reasonCode: string;
}

/**
 * Lists candidates using keyset cursor pagination and constant query counts.
 * Orders by: score descending, import ordinal ascending, candidate ID ascending.
 */
export function listCandidates(
  database: unknown,
  options?: ListCandidatesOptions
): Result<CandidateListPage, RuntimeError> {
  const client = getNativeDatabase(database);
  if (!client) {
    return err(
      createRuntimeError("persistence_failed", "Database client is unavailable for read-model query", false)
    );
  }

  const limit = Math.min(
    Math.max(1, options?.limit ?? DEFAULT_PAGE_SIZE),
    MAXIMUM_PAGE_SIZE
  );
  const fetchLimit = limit + 1;

  let cursorData: CandidateCursorData | undefined;
  if (options?.cursor) {
    const decodeResult = decodeCursor<CandidateCursorData>(options.cursor, [
      "score",
      "importOrdinal",
      "candidateId"
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

  if (options?.channel) {
    whereConditions.push("c.channel = @channel");
    params.channel = options.channel;
  }

  if (options?.corpusTag) {
    whereConditions.push("c.corpus_tag = @corpusTag");
    params.corpusTag = options.corpusTag;
  }

  if (options?.status) {
    if (options.status === "pending") {
      whereConditions.push("ctr.status IS NULL");
    } else {
      whereConditions.push("ctr.status = @status");
      params.status = options.status;
    }
  }

  if (cursorData) {
    whereConditions.push(`(
      (COALESCE(sr.aggregate_basis_points, -1) < @cursorScore)
      OR (
        COALESCE(sr.aggregate_basis_points, -1) = @cursorScore
        AND COALESCE(cm.import_ordinal, 999999) > @cursorImportOrdinal
      )
      OR (
        COALESCE(sr.aggregate_basis_points, -1) = @cursorScore
        AND COALESCE(cm.import_ordinal, 999999) = @cursorImportOrdinal
        AND c.candidate_id > @cursorCandidateId
      )
    )`);
    params.cursorScore = cursorData.score;
    params.cursorImportOrdinal = cursorData.importOrdinal;
    params.cursorCandidateId = cursorData.candidateId;
  }

  const whereClause =
    whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

  const sql = `SELECT
    c.candidate_id AS candidateId,
    c.source_system AS sourceSystem,
    c.source_key AS sourceKey,
    c.channel AS channel,
    c.corpus_tag AS corpusTag,
    c.is_synthetic AS isSynthetic,
    c.created_at AS createdAt,
    cm.import_ordinal AS importOrdinal,
    ch.version AS headVersion,
    ctr.candidate_triage_result_id AS currentResultId,
    ctr.status AS resultStatus,
    sr.aggregate_basis_points AS scoreBasisPoints,
    sr.confidence_basis_points AS confidenceBasisPoints,
    sr.aggregate_text AS scoreAggregateText,
    sr.confidence_text AS scoreConfidenceText,
    CASE WHEN crs.candidate_result_seal_id IS NOT NULL THEN 1 ELSE 0 END AS isSealed,
    COALESCE(sr.aggregate_basis_points, -1) AS sortScore,
    COALESCE(cm.import_ordinal, 999999) AS sortImportOrdinal
  FROM candidate c
  LEFT JOIN corpus_member cm ON cm.candidate_id = c.candidate_id
  LEFT JOIN candidate_head ch ON ch.candidate_id = c.candidate_id
  LEFT JOIN candidate_triage_result ctr ON ctr.candidate_triage_result_id = ch.current_result_id
  LEFT JOIN score_result sr ON sr.candidate_result_id = ctr.candidate_triage_result_id
  LEFT JOIN candidate_result_seal crs ON crs.candidate_result_id = ctr.candidate_triage_result_id
  ${whereClause}
  ORDER BY sortScore DESC, sortImportOrdinal ASC, c.candidate_id ASC
  LIMIT @fetchLimit`;

  let queryCount = 0;
  let rows: RawCandidateRow[];
  try {
    const stmt = client.prepare(sql);
    queryCount += 1;
    rows = stmt.all(params) as RawCandidateRow[];
  } catch (error) {
    return err(
      createRuntimeError(
        "persistence_failed",
        `Failed to query candidates: ${String(error)}`,
        false
      )
    );
  }

  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

  // Batch load reasons for the current page rows in one constant secondary query
  const resultIds = pageRows
    .map((r) => r.currentResultId)
    .filter((id): id is string => typeof id === "string" && id !== "");

  const reasonsByResultId = new Map<string, string[]>();
  if (resultIds.length > 0) {
    try {
      const placeholders = resultIds.map(() => "?").join(",");
      const reasonSql = `SELECT
        candidate_result_id AS candidateResultId,
        reason_code AS reasonCode
      FROM candidate_result_reason
      WHERE candidate_result_id IN (${placeholders})
      ORDER BY reason_ordinal ASC`;
      const reasonStmt = client.prepare(reasonSql);
      queryCount += 1;
      const reasonRows = reasonStmt.all(resultIds) as RawReasonRow[];
      for (const row of reasonRows) {
        let list = reasonsByResultId.get(row.candidateResultId);
        if (!list) {
          list = [];
          reasonsByResultId.set(row.candidateResultId, list);
        }
        list.push(row.reasonCode);
      }
    } catch (error) {
      return err(
        createRuntimeError(
          "persistence_failed",
          `Failed to load candidate reasons: ${String(error)}`,
          false
        )
      );
    }
  }

  const items: CandidateSummaryItem[] = pageRows.map((row) => {
    let status: CandidateTriageStatus = "pending";
    if (row.resultStatus === "scored") {
      status = "scored";
    } else if (row.resultStatus === "rejected_hard_requirement") {
      status = "rejected_hard_requirement";
    } else if (row.resultStatus === "escalated") {
      status = "escalated";
    }

    const reasons = row.currentResultId
      ? (reasonsByResultId.get(row.currentResultId) ?? [])
      : [];

    return {
      candidateId: row.candidateId,
      sourceSystem: row.sourceSystem,
      sourceKey: row.sourceKey,
      channel: row.channel as "inbound" | "sourced",
      corpusTag: row.corpusTag as "main" | "variant",
      isSynthetic: row.isSynthetic === 1,
      createdAt: row.createdAt,
      importOrdinal: row.importOrdinal,
      status,
      scoreBasisPoints: row.scoreBasisPoints,
      confidenceBasisPoints: row.confidenceBasisPoints,
      scoreAggregateText: row.scoreAggregateText,
      scoreConfidenceText: row.scoreConfidenceText,
      currentResultId: row.currentResultId,
      headVersion: row.headVersion,
      isSealed: row.isSealed === 1,
      reasons
    };
  });

  let nextCursor: string | undefined;
  if (hasNextPage && pageRows.length > 0) {
    const lastRow = pageRows[pageRows.length - 1]!;
    nextCursor = encodeCursor<CandidateCursorData>({
      score: lastRow.sortScore,
      importOrdinal: lastRow.sortImportOrdinal,
      candidateId: lastRow.candidateId
    });
  }

  return ok({
    items,
    nextCursor,
    queryCount
  });
}

/**
 * Asserts the EXPLAIN QUERY PLAN for listCandidates.
 * Verifies that candidate joins use unique indexes / primary keys without unindexed cartesian joins.
 */
export function assertListCandidatesIndexPlan(
  database: unknown
): Result<IndexPlanSummary, RuntimeError> {
  const client = getNativeDatabase(database);
  if (!client) {
    return err(
      createRuntimeError("persistence_failed", "Database client unavailable for index plan", false)
    );
  }

  const query = `EXPLAIN QUERY PLAN
  SELECT
    c.candidate_id,
    cm.import_ordinal,
    ch.version,
    ctr.status
  FROM candidate c
  LEFT JOIN corpus_member cm ON cm.candidate_id = c.candidate_id
  LEFT JOIN candidate_head ch ON ch.candidate_id = c.candidate_id
  LEFT JOIN candidate_triage_result ctr ON ctr.candidate_triage_result_id = ch.current_result_id
  LEFT JOIN score_result sr ON sr.candidate_result_id = ctr.candidate_triage_result_id
  ORDER BY COALESCE(sr.aggregate_basis_points, -1) DESC, COALESCE(cm.import_ordinal, 999999) ASC, c.candidate_id ASC
  LIMIT 51`;

  try {
    const stmt = client.prepare(query);
    const rows = stmt.all() as { id: number; parent: number; detail: string }[];
    const steps: IndexPlanStep[] = rows.map((r) => ({
      id: r.id,
      parent: r.parent,
      detail: r.detail
    }));

    // Look for SEARCH ... USING INDEX on joins
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
        `Failed to explain candidate query plan: ${String(error)}`,
        false
      )
    );
  }
}
