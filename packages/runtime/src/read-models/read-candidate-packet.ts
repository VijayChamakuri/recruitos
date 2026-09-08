import { ConfidenceInputSchema, err, ok, type Result } from "@recruitos/core";

import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import { getNativeDatabase } from "./native-db.js";
import type { CandidatePacketConfidenceInput, CandidatePacketModel } from "./types.js";

interface CandidateHeadRow {
  candidateId: string;
  sourceSystem: string;
  sourceKey: string;
  channel: "inbound" | "sourced";
  corpusTag: "main" | "variant";
  isSynthetic: number;
  createdAt: number;
  headVersion: number | null;
  currentResultId: string | null;
}

interface ResultRow {
  resultId: string;
  candidateId: string;
  resultKind: string;
  resultAvailability: string;
  resultStatus: "scored" | "rejected_hard_requirement" | "escalated";
  contentHash: string;
  sealId: string;
}

interface ScoreRow {
  aggregateText: string;
  confidenceText: string;
  aggregateBasisPoints: number;
  confidenceBasisPoints: number;
  contentJson: string;
}

interface ReasonRow {
  reasonCode: string;
}

function packetFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function parseStoredConfidenceInput(
  contentJson: string
): Result<CandidatePacketConfidenceInput, RuntimeError> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(contentJson);
    /* v8 ignore next 4 -- score_result CHECK requires json_valid content. */
  } catch {
    return err(packetFailure("Stored score result content is not valid JSON"));
  }
  /* v8 ignore next 3 -- score_result CHECK requires a JSON object. */
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    return err(packetFailure("Stored score result content is not a JSON object"));
  }
  const parsed = ConfidenceInputSchema.safeParse(
    (decoded as { confidenceInput?: unknown }).confidenceInput
  );
  if (!parsed.success) {
    return err(packetFailure("Stored score confidence input failed integrity validation"));
  }
  return ok({
    contradictionCount: parsed.data.contradictionCount,
    dimensionsWithLocatedSpan: parsed.data.dimensionsWithLocatedSpan,
    requiredFieldsMissing: parsed.data.requiredFieldsMissing,
    spansLocated: parsed.data.spansLocated,
    spansReturned: parsed.data.spansReturned,
    totalDimensions: parsed.data.totalDimensions,
    totalRequiredFields: parsed.data.totalRequiredFields
  });
}

/**
 * Reads a candidate packet. By default the packet is anchored to
 * CandidateHead.currentResultId. Pass `resultId` to inspect a historical
 * sealed result for the same candidate, including a superseded original.
 */
export function readCandidatePacket(
  database: unknown,
  candidateId: string,
  options?: { resultId?: string }
): Result<CandidatePacketModel, RuntimeError> {
  if (typeof candidateId !== "string" || candidateId.trim() === "") {
    return err(
      createRuntimeError(
        "persistence_failed",
        "Candidate ID must be a non-empty string",
        false
      )
    );
  }

  const client = getNativeDatabase(database);
  if (!client) {
    return err(
      createRuntimeError(
        "persistence_failed",
        "Invalid database client provided to readCandidatePacket",
        false
      )
    );
  }

  try {
    const candStmt = client.prepare(
      `SELECT
        c.candidate_id AS candidateId,
        c.source_system AS sourceSystem,
        c.source_key AS sourceKey,
        c.channel AS channel,
        c.corpus_tag AS corpusTag,
        c.is_synthetic AS isSynthetic,
        c.created_at AS createdAt,
        ch.version AS headVersion,
        ch.current_result_id AS currentResultId
      FROM candidate c
      LEFT JOIN candidate_head ch ON ch.candidate_id = c.candidate_id
      WHERE c.candidate_id = ?`
    );
    const candRow = candStmt.get(candidateId) as CandidateHeadRow | undefined;
    if (!candRow) {
      return err(
        createRuntimeError(
          "not_found",
          `Candidate packet not found for "${candidateId}"`,
          false
        )
      );
    }
    if (candRow.currentResultId === null || candRow.headVersion === null) {
      return err(
        createRuntimeError(
          "not_found",
          `Candidate packet not found for "${candidateId}": no triage result head written`,
          false
        )
      );
    }

    const requestedResultId = options?.resultId ?? candRow.currentResultId;

    const resultStmt = client.prepare(
      `SELECT
        candidate_triage_result_id AS resultId,
        candidate_id AS candidateId,
        kind AS resultKind,
        availability AS resultAvailability,
        status AS resultStatus,
        content_hash AS contentHash,
        seal_id AS sealId
      FROM candidate_triage_result
      WHERE candidate_triage_result_id = ?`
    );
    const resultRow = resultStmt.get(requestedResultId) as ResultRow | undefined;
    if (!resultRow) {
      return err(
        createRuntimeError(
          "not_found",
          `Triage result not found for candidate head: ${requestedResultId}`,
          false
        )
      );
    }
    if (resultRow.candidateId !== candidateId) {
      return err(
        createRuntimeError(
          "not_found",
          `Triage result "${requestedResultId}" does not belong to candidate "${candidateId}"`,
          false
        )
      );
    }

    const sealStmt = client.prepare(
      "SELECT count(*) AS count FROM candidate_result_seal WHERE candidate_result_id = ?"
    );
    const sealRow = sealStmt.get(requestedResultId) as { count: number };
    const isSealed = sealRow.count > 0;

    const scoreStmt = client.prepare(
      `SELECT
        aggregate_text AS aggregateText,
        confidence_text AS confidenceText,
        aggregate_basis_points AS aggregateBasisPoints,
        confidence_basis_points AS confidenceBasisPoints,
        content_json AS contentJson
      FROM score_result
      WHERE candidate_result_id = ?`
    );
    const scoreRow = scoreStmt.get(requestedResultId) as ScoreRow | undefined;

    const reasonStmt = client.prepare(
      `SELECT reason_code AS reasonCode
       FROM candidate_result_reason
       WHERE candidate_result_id = ?
       ORDER BY reason_ordinal ASC`
    );
    const reasonRows = reasonStmt.all(requestedResultId) as ReasonRow[];

    let confidenceInput: CandidatePacketConfidenceInput | null = null;
    if (scoreRow !== undefined) {
      const parsedConfidence = parseStoredConfidenceInput(scoreRow.contentJson);
      if (!parsedConfidence.ok) {
        return parsedConfidence;
      }
      confidenceInput = parsedConfidence.value;
    }

    return ok({
      candidateId: candRow.candidateId,
      sourceSystem: candRow.sourceSystem,
      sourceKey: candRow.sourceKey,
      channel: candRow.channel,
      corpusTag: candRow.corpusTag,
      isSynthetic: candRow.isSynthetic === 1,
      createdAt: candRow.createdAt,
      headVersion: candRow.headVersion,
      resultId: resultRow.resultId,
      resultKind: resultRow.resultKind,
      resultAvailability: resultRow.resultAvailability,
      resultStatus: resultRow.resultStatus,
      contentHash: resultRow.contentHash,
      sealId: resultRow.sealId,
      isSealed,
      scoreAggregateText: scoreRow?.aggregateText ?? null,
      scoreConfidenceText: scoreRow?.confidenceText ?? null,
      scoreAggregateBasisPoints: scoreRow?.aggregateBasisPoints ?? null,
      scoreConfidenceBasisPoints: scoreRow?.confidenceBasisPoints ?? null,
      confidenceInput,
      reasons: reasonRows.map((row) => row.reasonCode)
    });
  } catch (error) {
    return err(
      createRuntimeError(
        "persistence_failed",
        `Failed to read candidate packet: ${String(error)}`,
        false
      )
    );
  }
}
