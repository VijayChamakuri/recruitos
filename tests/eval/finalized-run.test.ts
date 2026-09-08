import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  CLASS1_KNOWN_LIMITATIONS,
  runClass1EvaluationForFinalizedCandidate
} from "./finalized-run.js";

function finalizedDatabase(sealed = true): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE candidate (
      candidate_id TEXT PRIMARY KEY,
      source_system TEXT NOT NULL,
      source_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      corpus_tag TEXT NOT NULL,
      is_synthetic INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE candidate_head (
      candidate_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      current_result_id TEXT NOT NULL
    );
    CREATE TABLE candidate_triage_result (
      candidate_triage_result_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      availability TEXT NOT NULL,
      status TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      seal_id TEXT NOT NULL
    );
    CREATE TABLE candidate_result_seal (candidate_result_id TEXT NOT NULL);
    CREATE TABLE score_result (
      candidate_result_id TEXT NOT NULL,
      aggregate_text TEXT NOT NULL,
      confidence_text TEXT NOT NULL,
      aggregate_basis_points INTEGER NOT NULL,
      confidence_basis_points INTEGER NOT NULL,
      content_json TEXT NOT NULL
    );
    CREATE TABLE candidate_result_reason (
      candidate_result_id TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      reason_ordinal INTEGER NOT NULL
    );
    CREATE TABLE candidate_result_dimension_assessment (
      candidate_result_id TEXT NOT NULL,
      dimension_id TEXT NOT NULL,
      assessment_ordinal INTEGER NOT NULL
    );
    CREATE TABLE candidate_result_evidence_span (
      candidate_result_id TEXT NOT NULL,
      evidence_span_id TEXT NOT NULL
    );
    CREATE TABLE evidence_span (
      evidence_span_id TEXT PRIMARY KEY,
      dimension_id TEXT NOT NULL
    );
    CREATE TABLE candidate_result_evidence_gap (
      candidate_result_id TEXT NOT NULL,
      dimension_id TEXT NOT NULL
    );
  `);
  database.prepare(
    "INSERT INTO candidate VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run("candidate-1", "synthetic", "tier1-1", "inbound", "variant", 1, 1);
  database.prepare("INSERT INTO candidate_head VALUES (?, ?, ?)").run(
    "candidate-1",
    1,
    "result-1"
  );
  database.prepare(
    "INSERT INTO candidate_triage_result VALUES (?, ?, ?, ?, ?, ?)"
  ).run("result-1", "initial", "complete", "scored", "a".repeat(64), "seal-1");
  if (sealed) {
    database.prepare("INSERT INTO candidate_result_seal VALUES (?)").run("result-1");
  }
  database.prepare("INSERT INTO score_result VALUES (?, ?, ?, ?, ?, ?)").run(
    "result-1",
    "4/5",
    "9/10",
    8000,
    9000,
    JSON.stringify({
      confidenceInput: {
        dimensionsWithLocatedSpan: 5,
        totalDimensions: 6,
        spansLocated: 5,
        spansReturned: 6,
        contradictionCount: 0,
        requiredFieldsMissing: 0,
        totalRequiredFields: 4
      }
    })
  );

  for (let index = 0; index < 6; index += 1) {
    const dimension = `dimension-${index + 1}`;
    database.prepare(
      "INSERT INTO candidate_result_dimension_assessment VALUES (?, ?, ?)"
    ).run("result-1", dimension, index);
    if (index < 5) {
      const spanId = `span-${index + 1}`;
      database.prepare("INSERT INTO evidence_span VALUES (?, ?)").run(spanId, dimension);
      database.prepare(
        "INSERT INTO candidate_result_evidence_span VALUES (?, ?)"
      ).run("result-1", spanId);
    } else {
      database.prepare(
        "INSERT INTO candidate_result_evidence_gap VALUES (?, ?)"
      ).run("result-1", dimension);
    }
  }
  return database;
}

describe("Class 1 finalized-run adapter", () => {
  it("runs the existing gate from persisted sealed-result associations", () => {
    const database = finalizedDatabase();
    const result = runClass1EvaluationForFinalizedCandidate(database, "candidate-1");
    expect(result).toMatchObject({
      ok: true,
      value: {
        passed: true,
        candidateId: "candidate-1",
        locatedSpanCoverageRate: 0.8333,
        allDimensionsAccountedFor: true,
        knownLimitationsCountMet: true
      }
    });
    database.close();
  });

  it("rejects an invalid database and an unsealed result", () => {
    expect(runClass1EvaluationForFinalizedCandidate(null, "candidate-1")).toMatchObject({
      ok: false,
      error: { code: "persistence_failed" }
    });

    const database = finalizedDatabase(false);
    expect(
      runClass1EvaluationForFinalizedCandidate(database, "candidate-1")
    ).toMatchObject({
      ok: false,
      error: { code: "persistence_failed" }
    });
    database.close();
  });

  it("returns read errors and gate failures without replacing the gate", () => {
    const database = finalizedDatabase();
    expect(
      runClass1EvaluationForFinalizedCandidate(database, "missing-candidate")
    ).toMatchObject({ ok: false, error: { code: "not_found" } });

    const failedGate = runClass1EvaluationForFinalizedCandidate(
      database,
      "candidate-1",
      CLASS1_KNOWN_LIMITATIONS.slice(0, 2)
    );
    expect(failedGate).toMatchObject({
      ok: true,
      value: { passed: false, knownLimitationsCountMet: false }
    });

    database.exec("DROP TABLE candidate_result_dimension_assessment");
    expect(
      runClass1EvaluationForFinalizedCandidate(database, "candidate-1")
    ).toMatchObject({ ok: false, error: { code: "persistence_failed" } });
    database.close();
  });
});
