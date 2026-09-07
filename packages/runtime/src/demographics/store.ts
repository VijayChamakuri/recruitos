import { CandidateDemographicsIdSchema, CandidateIdSchema, err, ok, type Result } from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  CandidateDemographicsDraftSchema,
  CandidateDemographicsSchema,
  type CandidateDemographics
} from "./schemas.js";

const preparedDemographics = new WeakSet<object>();

const TRANSACTION_REQUIRED = "Candidate demographics require an active command transaction";

const DEMOGRAPHICS_SELECT = `SELECT
  candidate_demographics_id AS candidateDemographicsId,
  candidate_id AS candidateId,
  sex,
  race_ethnicity AS raceEthnicity,
  created_at AS createdAt
FROM candidate_demographics`;

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

function register<TRecord extends object>(registry: WeakSet<object>, record: TRecord): TRecord {
  const frozen = Object.freeze(record);
  registry.add(frozen);
  return frozen;
}

function parseStoredDemographics(row: unknown): Result<CandidateDemographics, RuntimeError> {
  const record = CandidateDemographicsSchema.safeParse(row);
  if (!record.success) {
    return err(persistenceFailure("Stored candidate demographics are invalid"));
  }
  return ok(Object.freeze(record.data));
}

export function prepareCandidateDemographics(
  draftInput: unknown
): Result<CandidateDemographics, RuntimeError> {
  try {
    const draft = CandidateDemographicsDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid candidate demographics input"));
    }
    return ok(register(preparedDemographics, CandidateDemographicsSchema.parse(draft.data)));
  } catch {
    return err(persistenceFailure("Candidate demographics preparation failed"));
  }
}

export function insertCandidateDemographics(
  contextInput: unknown,
  preparedInput: unknown
): Result<CandidateDemographics, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<CandidateDemographics>(
      preparedDemographics,
      preparedInput,
      "Invalid prepared candidate demographics"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const record = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO candidate_demographics (
          candidate_demographics_id,
          candidate_id,
          sex,
          race_ethnicity,
          created_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        record.candidateDemographicsId,
        record.candidateId,
        record.sex,
        record.raceEthnicity,
        record.createdAt
      );

    return ok(record);
  } catch {
    return err(persistenceFailure("Candidate demographics insert failed"));
  }
}

export function readCandidateDemographics(
  contextInput: unknown,
  candidateDemographicsIdInput: unknown
): Result<CandidateDemographics | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const candidateDemographicsId = CandidateDemographicsIdSchema.safeParse(
      candidateDemographicsIdInput
    );
    if (!candidateDemographicsId.success) {
      return err(persistenceFailure("Invalid candidate demographics ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${DEMOGRAPHICS_SELECT} WHERE candidate_demographics_id = ?`)
      .get(candidateDemographicsId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    return parseStoredDemographics(row);
  } catch {
    return err(persistenceFailure("Candidate demographics read failed"));
  }
}

export function readCandidateDemographicsByCandidate(
  contextInput: unknown,
  candidateIdInput: unknown
): Result<CandidateDemographics | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const candidateId = CandidateIdSchema.safeParse(candidateIdInput);
    if (!candidateId.success) {
      return err(persistenceFailure("Invalid candidate ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${DEMOGRAPHICS_SELECT} WHERE candidate_id = ?`)
      .get(candidateId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    return parseStoredDemographics(row);
  } catch {
    return err(persistenceFailure("Candidate demographics read failed"));
  }
}
