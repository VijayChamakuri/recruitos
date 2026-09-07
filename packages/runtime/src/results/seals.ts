import { CandidateResultSealIdSchema, err, ok, type Result } from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  CandidateResultSealDraftSchema,
  CandidateResultSealSchema,
  type CandidateResultSeal
} from "./schemas.js";

const preparedCandidateResultSeals = new WeakSet<object>();

const TRANSACTION_REQUIRED = "Candidate result seal rows require an active command transaction";

function persistenceFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function validateContext(
  contextInput: unknown
): Result<ImmediateTransactionContext, RuntimeError> {
  if (typeof contextInput !== "object" || contextInput === null) {
    return err(persistenceFailure(TRANSACTION_REQUIRED));
  }
  const context = contextInput as Partial<ImmediateTransactionContext>;
  if (
    typeof context.nativeDatabase !== "object" ||
    context.nativeDatabase === null ||
    context.nativeDatabase.inTransaction !== true
  ) {
    return err(persistenceFailure(TRANSACTION_REQUIRED));
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

export function prepareCandidateResultSeal(
  draftInput: unknown
): Result<CandidateResultSeal, RuntimeError> {
  try {
    const draft = CandidateResultSealDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid candidate result seal input"));
    }
    return ok(register(preparedCandidateResultSeals, draft.data));
  } catch {
    return err(persistenceFailure("Candidate result seal preparation failed"));
  }
}

/**
 * Seal insert is the commit-time completeness proof. SQL triggers enforce
 * lineage, six-dimension completeness, score availability, ownership,
 * provenance, conflict cardinality, requirement support, reason uniqueness,
 * task creation, proposal eligibility, and contiguous association ordinals.
 */
export function insertCandidateResultSeal(
  contextInput: unknown,
  preparedInput: unknown
): Result<CandidateResultSeal, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<CandidateResultSeal>(
      preparedCandidateResultSeals,
      preparedInput,
      "Invalid prepared candidate result seal"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const seal = prepared.value;

    const resultRow = context.value.nativeDatabase
      .prepare(
        `SELECT seal_id AS sealId
         FROM candidate_triage_result
         WHERE candidate_triage_result_id = ?`
      )
      .get(seal.candidateResultId) as { sealId: string } | undefined;
    if (resultRow === undefined) {
      return err(persistenceFailure("Candidate result seal requires a stored candidate result"));
    }
    if (resultRow.sealId !== seal.candidateResultSealId) {
      return err(
        persistenceFailure("Candidate result seal ID does not match the result seal_id")
      );
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO candidate_result_seal (
          candidate_result_seal_id,
          candidate_result_id,
          created_at
        ) VALUES (?, ?, ?)`
      )
      .run(seal.candidateResultSealId, seal.candidateResultId, seal.createdAt);

    return ok(seal);
  } catch {
    return err(persistenceFailure("Candidate result seal insert failed"));
  }
}

export function readCandidateResultSeal(
  contextInput: unknown,
  candidateResultSealIdInput: unknown
): Result<CandidateResultSeal | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const candidateResultSealId = CandidateResultSealIdSchema.safeParse(
      candidateResultSealIdInput
    );
    if (!candidateResultSealId.success) {
      return err(persistenceFailure("Invalid candidate result seal ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          candidate_result_seal_id AS candidateResultSealId,
          candidate_result_id AS candidateResultId,
          created_at AS createdAt
        FROM candidate_result_seal
        WHERE candidate_result_seal_id = ?`
      )
      .get(candidateResultSealId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const seal = CandidateResultSealSchema.safeParse(row);
    if (!seal.success) {
      return err(persistenceFailure("Stored candidate result seal is invalid"));
    }
    return ok(Object.freeze(seal.data));
  } catch {
    return err(persistenceFailure("Candidate result seal read failed"));
  }
}
