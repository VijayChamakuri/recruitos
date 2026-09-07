import {
  CandidateResultReasonIdSchema,
  CandidateTriageResultIdSchema,
  err,
  formatReasonCode,
  ok,
  parseReasonCode,
  reasonCodePrecedence,
  reasonCodeSubject,
  type Result
} from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  CandidateResultReasonDraftSchema,
  CandidateResultReasonSchema,
  type CandidateResultReason
} from "./schemas.js";

const preparedReasons = new WeakSet<object>();

const TRANSACTION_REQUIRED =
  "Candidate result reason rows require an active command transaction";

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

function compareReasons(
  left: CandidateResultReason,
  right: CandidateResultReason
): number {
  const precedence =
    reasonCodePrecedence(left.reasonKind) - reasonCodePrecedence(right.reasonKind);
  if (precedence !== 0) {
    return precedence;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.candidateResultReasonId.localeCompare(right.candidateResultReasonId);
}

/**
 * Validates the formatted reason string against the closed vocabulary and
 * denormalizes kind plus subject. Parameterized forms cannot be a SQL enum,
 * so membership is enforced here and re-checked on read.
 */
export function prepareCandidateResultReason(
  draftInput: unknown
): Result<CandidateResultReason, RuntimeError> {
  try {
    const draft = CandidateResultReasonDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid candidate result reason input"));
    }
    const reasonCode = parseReasonCode(draft.data.reasonCode);
    if (!reasonCode.ok) {
      return err(
        persistenceFailure(
          "Candidate result reason code is not in the closed vocabulary"
        )
      );
    }
    const formatted = formatReasonCode(reasonCode.value);
    const reason = CandidateResultReasonSchema.parse({
      candidateResultReasonId: draft.data.candidateResultReasonId,
      candidateResultId: draft.data.candidateResultId,
      reasonKind: reasonCode.value.kind,
      subjectId: reasonCodeSubject(reasonCode.value),
      reasonCode: formatted,
      reasonOrdinal: draft.data.reasonOrdinal,
      createdAt: draft.data.createdAt
    });
    return ok(register(preparedReasons, reason));
  } catch {
    return err(persistenceFailure("Candidate result reason preparation failed"));
  }
}

export function insertCandidateResultReason(
  contextInput: unknown,
  preparedInput: unknown
): Result<CandidateResultReason, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<CandidateResultReason>(
      preparedReasons,
      preparedInput,
      "Invalid prepared candidate result reason"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const reason = prepared.value;
    const parent = context.value.nativeDatabase
      .prepare(
        `SELECT availability
         FROM candidate_triage_result
         WHERE candidate_triage_result_id = ?`
      )
      .get(reason.candidateResultId) as { availability: string } | undefined;
    if (parent === undefined) {
      return err(
        persistenceFailure("Candidate result reason requires a stored candidate result")
      );
    }
    if (parent.availability === "unavailable" && reason.reasonKind !== "assessment_unavailable") {
      return err(
        persistenceFailure("Unavailable results only accept the assessment_unavailable reason")
      );
    }
    if (parent.availability === "complete" && reason.reasonKind === "assessment_unavailable") {
      return err(
        persistenceFailure("assessment_unavailable is only valid on unavailable results")
      );
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO candidate_result_reason (
          candidate_result_reason_id,
          candidate_result_id,
          reason_kind,
          subject_id,
          reason_code,
          reason_ordinal,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        reason.candidateResultReasonId,
        reason.candidateResultId,
        reason.reasonKind,
        reason.subjectId,
        reason.reasonCode,
        reason.reasonOrdinal,
        reason.createdAt
      );
    return ok(reason);
  } catch {
    return err(persistenceFailure("Candidate result reason insert failed"));
  }
}

function hydrateReason(row: {
  candidateResultReasonId: string;
  candidateResultId: string;
  reasonKind: string;
  subjectId: string | null;
  reasonCode: string;
  reasonOrdinal: number;
  createdAt: number;
}): Result<CandidateResultReason, RuntimeError> {
  const parsed = parseReasonCode(row.reasonCode);
  if (!parsed.ok) {
    return err(persistenceFailure("Stored candidate result reason is invalid"));
  }
  if (
    parsed.value.kind !== row.reasonKind ||
    reasonCodeSubject(parsed.value) !== row.subjectId
  ) {
    return err(
      persistenceFailure("Stored candidate result reason failed integrity validation")
    );
  }
  const reason = CandidateResultReasonSchema.safeParse(row);
  if (!reason.success) {
    return err(persistenceFailure("Stored candidate result reason is invalid"));
  }
  return ok(Object.freeze(reason.data));
}

export function readCandidateResultReason(
  contextInput: unknown,
  candidateResultReasonIdInput: unknown
): Result<CandidateResultReason | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const reasonId = CandidateResultReasonIdSchema.safeParse(candidateResultReasonIdInput);
    if (!reasonId.success) {
      return err(persistenceFailure("Invalid candidate result reason ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          candidate_result_reason_id AS candidateResultReasonId,
          candidate_result_id AS candidateResultId,
          reason_kind AS reasonKind,
          subject_id AS subjectId,
          reason_code AS reasonCode,
          reason_ordinal AS reasonOrdinal,
          created_at AS createdAt
        FROM candidate_result_reason
        WHERE candidate_result_reason_id = ?`
      )
      .get(reasonId.data) as
      | {
          candidateResultReasonId: string;
          candidateResultId: string;
          reasonKind: string;
          subjectId: string | null;
          reasonCode: string;
          reasonOrdinal: number;
          createdAt: number;
        }
      | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    return hydrateReason(row);
  } catch {
    return err(persistenceFailure("Candidate result reason read failed"));
  }
}

export function readCandidateResultReasons(
  contextInput: unknown,
  candidateTriageResultIdInput: unknown
): Result<readonly CandidateResultReason[], RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const resultId = CandidateTriageResultIdSchema.safeParse(candidateTriageResultIdInput);
    if (!resultId.success) {
      return err(persistenceFailure("Invalid candidate result ID"));
    }
    const rows = context.value.nativeDatabase
      .prepare(
        `SELECT
          candidate_result_reason_id AS candidateResultReasonId,
          candidate_result_id AS candidateResultId,
          reason_kind AS reasonKind,
          subject_id AS subjectId,
          reason_code AS reasonCode,
          reason_ordinal AS reasonOrdinal,
          created_at AS createdAt
        FROM candidate_result_reason
        WHERE candidate_result_id = ?`
      )
      .all(resultId.data) as Array<{
      candidateResultReasonId: string;
      candidateResultId: string;
      reasonKind: string;
      subjectId: string | null;
      reasonCode: string;
      reasonOrdinal: number;
      createdAt: number;
    }>;
    const reasons: CandidateResultReason[] = [];
    for (const row of rows) {
      const hydrated = hydrateReason(row);
      if (!hydrated.ok) {
        return hydrated;
      }
      reasons.push(hydrated.value);
    }
    reasons.sort(compareReasons);
    return ok(Object.freeze(reasons));
  } catch {
    return err(persistenceFailure("Candidate result reason read failed"));
  }
}
