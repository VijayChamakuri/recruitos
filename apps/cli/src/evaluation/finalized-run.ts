import { err, ok, type Result } from "@recruitos/core";
import {
  createRuntimeError,
  readCandidatePacket,
  type RuntimeError
} from "@recruitos/runtime";

import {
  runClass1EvaluationGate,
  type Class1EvaluationReport,
  type DimensionCoverage
} from "./class1.js";

export const CLASS1_KNOWN_LIMITATIONS = Object.freeze([
  "Synthetic candidates do not establish fairness on real applicant populations",
  "Fixture extraction does not measure live provider behavior",
  "Route coverage does not replace practitioner calibration of rubric levels"
]);

type NativeDatabase = Readonly<{
  prepare: (sql: string) => Readonly<{
    all: (...parameters: readonly unknown[]) => unknown[];
  }>;
}>;

type CoverageRow = Readonly<{
  dimension: string;
  locatedSpanCount: number;
  validatedGapCount: number;
}>;

function nativeDatabase(database: unknown): NativeDatabase | null {
  if (typeof database !== "object" || database === null) return null;
  const candidate = "$client" in database
    ? (database as { $client: unknown }).$client
    : database;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("prepare" in candidate) ||
    typeof (candidate as { prepare: unknown }).prepare !== "function"
  ) {
    return null;
  }
  return candidate as NativeDatabase;
}

function loadDimensionCoverage(
  database: NativeDatabase,
  candidateResultId: string
): readonly DimensionCoverage[] {
  const rows = database.prepare(
    `SELECT
      result_assessment.dimension_id AS dimension,
      (
        SELECT COUNT(*)
        FROM candidate_result_evidence_span result_span
        JOIN evidence_span span
          ON span.evidence_span_id = result_span.evidence_span_id
        WHERE result_span.candidate_result_id = result_assessment.candidate_result_id
          AND span.dimension_id = result_assessment.dimension_id
      ) AS locatedSpanCount,
      (
        SELECT COUNT(*)
        FROM candidate_result_evidence_gap result_gap
        WHERE result_gap.candidate_result_id = result_assessment.candidate_result_id
          AND result_gap.dimension_id = result_assessment.dimension_id
      ) AS validatedGapCount
     FROM candidate_result_dimension_assessment result_assessment
     WHERE result_assessment.candidate_result_id = ?
     ORDER BY result_assessment.assessment_ordinal ASC`
  ).all(candidateResultId) as CoverageRow[];

  return rows.map((row) => ({
    dimension: row.dimension,
    locatedSpanCount: row.locatedSpanCount,
    validatedGapCount: row.validatedGapCount,
    isComplete: row.locatedSpanCount > 0 || row.validatedGapCount > 0
  }));
}

/** Reads one sealed runtime result and runs the shared Class 1 gate against it. */
export function runClass1EvaluationForFinalizedCandidate(
  databaseInput: unknown,
  candidateId: string,
  knownLimitations: readonly string[] = CLASS1_KNOWN_LIMITATIONS
): Result<Class1EvaluationReport, RuntimeError> {
  const database = nativeDatabase(databaseInput);
  if (database === null) {
    return err(
      createRuntimeError(
        "persistence_failed",
        "Class 1 evaluation requires a runtime database",
        false
      )
    );
  }

  const packet = readCandidatePacket(databaseInput, candidateId);
  if (!packet.ok) return packet;
  if (!packet.value.isSealed) {
    return err(
      createRuntimeError(
        "persistence_failed",
        `Candidate "${candidateId}" does not have a sealed result`,
        false
      )
    );
  }

  try {
    const dimensionCoverages = loadDimensionCoverage(database, packet.value.resultId);
    return ok(
      runClass1EvaluationGate({
        candidateId,
        tier: 1,
        totalDimensions:
          packet.value.confidenceInput?.totalDimensions ?? dimensionCoverages.length,
        dimensionCoverages,
        knownLimitations
      })
    );
  } catch {
    return err(
      createRuntimeError(
        "persistence_failed",
        "Failed to read finalized Class 1 evaluation inputs",
        false
      )
    );
  }
}
