import {
  CandidateIdSchema,
  NonnegativeIntegerSchema,
  err,
  ok,
  type Result
} from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  compareAndSetMutableHead,
  defineMutableHead,
  initializeMutableHead,
  readMutableHead,
  type MutableHeadDefinition
} from "../persistence/index.js";
import {
  CandidateHeadDraftSchema,
  CandidateHeadSchema,
  type CandidateHead,
  type CandidateHeadDraft
} from "./schemas.js";

const TRANSACTION_REQUIRED = "Candidate head rows require an active command transaction";

const CANDIDATE_HEAD: MutableHeadDefinition = (
  defineMutableHead({
    tableName: "candidate_head",
    identityColumn: "candidate_id",
    pointerColumn: "current_result_id",
    versionColumn: "version"
  }) as { ok: true; value: MutableHeadDefinition }
).value;

function persistenceFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function versionConflict(
  identity: string,
  expectedVersion: number,
  actualVersion: number | null
): RuntimeError {
  return createRuntimeError("version_conflict", "Mutable head version conflict", false, {
    table: "candidate_head",
    identity,
    expectedVersion,
    actualVersion
  });
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

function rowExists(
  context: ImmediateTransactionContext,
  sql: string,
  id: string
): boolean {
  return context.nativeDatabase.prepare(sql).get(id) !== undefined;
}

function toHead(
  identity: string,
  pointer: string,
  version: number
): Result<CandidateHead, RuntimeError> {
  const parsed = CandidateHeadSchema.safeParse({
    candidateId: identity,
    currentResultId: pointer,
    version
  });
  if (!parsed.success) {
    return err(persistenceFailure("Stored candidate head is invalid"));
  }
  return ok(Object.freeze(parsed.data));
}

function swingHead(
  context: ImmediateTransactionContext,
  draft: CandidateHeadDraft,
  expectedHeadVersion: number
): Result<{ identity: string; pointer: string; version: number }, RuntimeError> {
  if (expectedHeadVersion === 0) {
    return initializeMutableHead(context, CANDIDATE_HEAD, {
      identity: draft.candidateId,
      pointer: draft.currentResultId
    });
  }
  return compareAndSetMutableHead(context, CANDIDATE_HEAD, {
    identity: draft.candidateId,
    pointer: draft.currentResultId,
    expectedVersion: expectedHeadVersion
  });
}

export function setCandidateHead(
  contextInput: unknown,
  headInput: unknown,
  expectedHeadVersionInput: unknown
): Result<CandidateHead, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const draft = CandidateHeadDraftSchema.safeParse(headInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid candidate head input"));
    }
    const expectedHeadVersion = NonnegativeIntegerSchema.safeParse(expectedHeadVersionInput);
    if (!expectedHeadVersion.success) {
      return err(persistenceFailure("Invalid expected head version"));
    }
    if (
      !rowExists(
        context.value,
        "SELECT candidate_id FROM candidate WHERE candidate_id = ?",
        draft.data.candidateId
      )
    ) {
      return err(persistenceFailure("Candidate head requires a stored candidate"));
    }
    const result = context.value.nativeDatabase
      .prepare(
        `SELECT candidate_id AS candidateId
         FROM candidate_triage_result
         WHERE candidate_triage_result_id = ?`
      )
      .get(draft.data.currentResultId) as { candidateId: string } | undefined;
    if (result === undefined) {
      return err(persistenceFailure("Candidate head requires a stored candidate result"));
    }
    if (result.candidateId !== draft.data.candidateId) {
      return err(
        persistenceFailure("Candidate head current_result_id must belong to the candidate")
      );
    }

    const currentHead = readMutableHead(context.value, CANDIDATE_HEAD, draft.data.candidateId);
    if (!currentHead.ok) {
      return currentHead;
    }
    const actualVersion = currentHead.value === undefined ? null : currentHead.value.version;
    if (expectedHeadVersion.data === 0) {
      if (actualVersion !== null) {
        return err(versionConflict(draft.data.candidateId, 0, actualVersion));
      }
    } else if (actualVersion !== expectedHeadVersion.data) {
      return err(
        versionConflict(draft.data.candidateId, expectedHeadVersion.data, actualVersion)
      );
    }

    const swung = swingHead(context.value, draft.data, expectedHeadVersion.data);
    if (!swung.ok) {
      return swung;
    }
    return toHead(swung.value.identity, swung.value.pointer, swung.value.version);
  } catch {
    return err(persistenceFailure("Candidate head update failed"));
  }
}

export function readCandidateHead(
  contextInput: unknown,
  candidateIdInput: unknown
): Result<CandidateHead | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const candidateId = CandidateIdSchema.safeParse(candidateIdInput);
    if (!candidateId.success) {
      return err(persistenceFailure("Invalid candidate ID"));
    }
    const head = readMutableHead(context.value, CANDIDATE_HEAD, candidateId.data);
    if (!head.ok) {
      return head;
    }
    if (head.value === undefined) {
      return ok(undefined);
    }
    return toHead(head.value.identity, head.value.pointer, head.value.version);
  } catch {
    return err(persistenceFailure("Candidate head read failed"));
  }
}
