import { err, ok, type Result } from "@recruitos/core";

import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import { getNativeDatabase } from "./native-db.js";
import type { CandidatePacketModel } from "./types.js";

interface CandidateHeadRow {
  candidateId: string;
  sourceSystem: string;
  sourceKey: string;
  channel: "inbound" | "sourced";
  corpusTag: "main" | "variant";
  isSynthetic: number;
  createdAt: number;
  headVersion: number;
  currentResultId: string;
}

interface ResultRow {
  resultId: string;
  resultKind: string;
  resultAvailability: string;
  resultStatus: "scored" | "rejected_hard_requirement" | "escalated";
  contentHash: string;
  sealId: string;
}

/**
 * Reads a candidate packet anchored to CandidateHead.currentResultId.
 * Returns persistence_failed with a clear message when the candidate or head is missing.
 */
export function readCandidatePacket(
  database: unknown,
  candidateId: string
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
      JOIN candidate_head ch ON ch.candidate_id = c.candidate_id
      WHERE c.candidate_id = ?`
    );
    const candRow = candStmt.get(candidateId) as CandidateHeadRow | undefined;
    if (!candRow) {
      return err(
        createRuntimeError(
          "persistence_failed",
          `Candidate packet not found for "${candidateId}": no triage result head written`,
          false
        )
      );
    }

    const resultStmt = client.prepare(
      `SELECT
        candidate_triage_result_id AS resultId,
        kind AS resultKind,
        availability AS resultAvailability,
        status AS resultStatus,
        content_hash AS contentHash,
        seal_id AS sealId
      FROM candidate_triage_result
      WHERE candidate_triage_result_id = ?`
    );
    const resultRow = resultStmt.get(candRow.currentResultId) as ResultRow | undefined;
    if (!resultRow) {
      return err(
        createRuntimeError(
          "persistence_failed",
          `Triage result not found for candidate head: ${candRow.currentResultId}`,
          false
        )
      );
    }

    const sealStmt = client.prepare(
      "SELECT count(*) AS count FROM candidate_result_seal WHERE candidate_result_id = ?"
    );
    const sealRow = sealStmt.get(candRow.currentResultId) as { count: number };
    const isSealed = sealRow.count > 0;

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
      isSealed
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
