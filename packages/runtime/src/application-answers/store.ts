import {
  CandidateApplicationAnswerIdSchema,
  CandidateIdSchema,
  err,
  ok,
  type Result
} from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  ApplicationAnswerQuestionKeySchema,
  CandidateApplicationAnswerDraftSchema,
  CandidateApplicationAnswerSchema,
  type CandidateApplicationAnswer
} from "./schemas.js";

const preparedAnswers = new WeakSet<object>();

const TRANSACTION_REQUIRED =
  "Candidate application answers require an active command transaction";

const ANSWER_SELECT = `SELECT
  candidate_application_answer_id AS candidateApplicationAnswerId,
  candidate_id AS candidateId,
  question_key AS questionKey,
  selected_option_key AS selectedOptionKey,
  free_text AS freeText,
  collected_by AS collectedBy,
  form_id AS formId,
  question_id AS questionId,
  collected_at AS collectedAt,
  created_at AS createdAt
FROM candidate_application_answer`;

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

function parseStoredAnswer(row: unknown): Result<CandidateApplicationAnswer, RuntimeError> {
  const record = CandidateApplicationAnswerSchema.safeParse(row);
  if (!record.success) {
    return err(persistenceFailure("Stored candidate application answer is invalid"));
  }
  return ok(Object.freeze(record.data));
}

export function prepareCandidateApplicationAnswer(
  draftInput: unknown
): Result<CandidateApplicationAnswer, RuntimeError> {
  try {
    const draft = CandidateApplicationAnswerDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid candidate application answer input"));
    }
    const stored: CandidateApplicationAnswer = {
      ...draft.data,
      freeText: draft.data.freeText ?? null
    };
    return ok(register(preparedAnswers, CandidateApplicationAnswerSchema.parse(stored)));
  } catch {
    return err(persistenceFailure("Candidate application answer preparation failed"));
  }
}

export function insertCandidateApplicationAnswer(
  contextInput: unknown,
  preparedInput: unknown
): Result<CandidateApplicationAnswer, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<CandidateApplicationAnswer>(
      preparedAnswers,
      preparedInput,
      "Invalid prepared candidate application answer"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const record = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO candidate_application_answer (
          candidate_application_answer_id,
          candidate_id,
          question_key,
          selected_option_key,
          free_text,
          collected_by,
          form_id,
          question_id,
          collected_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.candidateApplicationAnswerId,
        record.candidateId,
        record.questionKey,
        record.selectedOptionKey,
        record.freeText,
        record.collectedBy,
        record.formId,
        record.questionId,
        record.collectedAt,
        record.createdAt
      );

    return ok(record);
  } catch {
    return err(persistenceFailure("Candidate application answer insert failed"));
  }
}

export function readCandidateApplicationAnswer(
  contextInput: unknown,
  answerIdInput: unknown
): Result<CandidateApplicationAnswer | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const answerId = CandidateApplicationAnswerIdSchema.safeParse(answerIdInput);
    if (!answerId.success) {
      return err(persistenceFailure("Invalid candidate application answer ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${ANSWER_SELECT} WHERE candidate_application_answer_id = ?`)
      .get(answerId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    return parseStoredAnswer(row);
  } catch {
    return err(persistenceFailure("Candidate application answer read failed"));
  }
}

export function readCandidateApplicationAnswerByCandidateQuestion(
  contextInput: unknown,
  candidateIdInput: unknown,
  questionKeyInput: unknown
): Result<CandidateApplicationAnswer | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const candidateId = CandidateIdSchema.safeParse(candidateIdInput);
    if (!candidateId.success) {
      return err(persistenceFailure("Invalid candidate ID"));
    }
    const questionKey = ApplicationAnswerQuestionKeySchema.safeParse(questionKeyInput);
    if (!questionKey.success) {
      return err(persistenceFailure("Invalid application answer question key"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${ANSWER_SELECT} WHERE candidate_id = ? AND question_key = ?`)
      .get(candidateId.data, questionKey.data);
    if (row === undefined) {
      return ok(undefined);
    }
    return parseStoredAnswer(row);
  } catch {
    return err(persistenceFailure("Candidate application answer read failed"));
  }
}
