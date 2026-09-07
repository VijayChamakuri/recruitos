import {
  TriageRunIdSchema,
  TriageRunMemberIdSchema,
  TriageRunSealIdSchema,
  err,
  ok,
  type Result
} from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  TriageRunDraftSchema,
  TriageRunMemberDraftSchema,
  TriageRunMemberSchema,
  TriageRunSchema,
  TriageRunSealDraftSchema,
  TriageRunSealSchema,
  type TriageRun,
  type TriageRunMember,
  type TriageRunSeal
} from "./schemas.js";

const preparedTriageRuns = new WeakSet<object>();
const preparedTriageRunMembers = new WeakSet<object>();
const preparedTriageRunSeals = new WeakSet<object>();

const TRANSACTION_REQUIRED = "Triage run rows require an active command transaction";

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

export function prepareTriageRun(draftInput: unknown): Result<TriageRun, RuntimeError> {
  try {
    const draft = TriageRunDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid triage run input"));
    }
    return ok(register(preparedTriageRuns, draft.data));
  } catch {
    return err(persistenceFailure("Triage run preparation failed"));
  }
}

export function prepareTriageRunMember(
  draftInput: unknown
): Result<TriageRunMember, RuntimeError> {
  try {
    const draft = TriageRunMemberDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid triage run member input"));
    }
    return ok(register(preparedTriageRunMembers, draft.data));
  } catch {
    return err(persistenceFailure("Triage run member preparation failed"));
  }
}

export function prepareTriageRunSeal(
  draftInput: unknown
): Result<TriageRunSeal, RuntimeError> {
  try {
    const draft = TriageRunSealDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid triage run seal input"));
    }
    return ok(register(preparedTriageRunSeals, draft.data));
  } catch {
    return err(persistenceFailure("Triage run seal preparation failed"));
  }
}

export function insertTriageRun(
  contextInput: unknown,
  preparedInput: unknown
): Result<TriageRun, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<TriageRun>(
      preparedTriageRuns,
      preparedInput,
      "Invalid prepared triage run"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const run = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO triage_run (
          triage_run_id,
          kind,
          snapshot_id,
          corpus_manifest_id,
          seal_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.triageRunId,
        run.kind,
        run.snapshotId,
        run.corpusManifestId,
        run.sealId,
        run.createdAt
      );

    return ok(run);
  } catch {
    return err(persistenceFailure("Triage run insert failed"));
  }
}

export function insertTriageRunMember(
  contextInput: unknown,
  preparedInput: unknown
): Result<TriageRunMember, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<TriageRunMember>(
      preparedTriageRunMembers,
      preparedInput,
      "Invalid prepared triage run member"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const member = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO triage_run_member (
          triage_run_member_id,
          triage_run_id,
          candidate_id,
          import_ordinal,
          initial_result_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        member.triageRunMemberId,
        member.triageRunId,
        member.candidateId,
        member.importOrdinal,
        member.initialResultId,
        member.createdAt
      );

    return ok(member);
  } catch {
    return err(persistenceFailure("Triage run member insert failed"));
  }
}

/**
 * Seal insert is the commit-time completeness proof. SQL triggers enforce
 * snapshot alignment, exact corpus membership, sealed initial results,
 * candidate head pointers, exclusion of correction results, and official
 * attempt readiness.
 */
export function insertTriageRunSeal(
  contextInput: unknown,
  preparedInput: unknown
): Result<TriageRunSeal, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<TriageRunSeal>(
      preparedTriageRunSeals,
      preparedInput,
      "Invalid prepared triage run seal"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const seal = prepared.value;

    const runRow = context.value.nativeDatabase
      .prepare(`SELECT seal_id AS sealId FROM triage_run WHERE triage_run_id = ?`)
      .get(seal.triageRunId) as { sealId: string } | undefined;
    if (runRow === undefined) {
      return err(persistenceFailure("Triage run seal requires a stored triage run"));
    }
    if (runRow.sealId !== seal.triageRunSealId) {
      return err(persistenceFailure("Triage run seal ID does not match the run seal_id"));
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO triage_run_seal (
          triage_run_seal_id,
          triage_run_id,
          created_at
        ) VALUES (?, ?, ?)`
      )
      .run(seal.triageRunSealId, seal.triageRunId, seal.createdAt);

    return ok(seal);
  } catch {
    return err(persistenceFailure("Triage run seal insert failed"));
  }
}

export function readTriageRun(
  contextInput: unknown,
  triageRunIdInput: unknown
): Result<TriageRun | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const triageRunId = TriageRunIdSchema.safeParse(triageRunIdInput);
    if (!triageRunId.success) {
      return err(persistenceFailure("Invalid triage run ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          triage_run_id AS triageRunId,
          kind,
          snapshot_id AS snapshotId,
          corpus_manifest_id AS corpusManifestId,
          seal_id AS sealId,
          created_at AS createdAt
        FROM triage_run
        WHERE triage_run_id = ?`
      )
      .get(triageRunId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const run = TriageRunSchema.safeParse(row);
    if (!run.success) {
      return err(persistenceFailure("Stored triage run is invalid"));
    }
    return ok(Object.freeze(run.data));
  } catch {
    return err(persistenceFailure("Triage run read failed"));
  }
}

export function readTriageRunMember(
  contextInput: unknown,
  triageRunMemberIdInput: unknown
): Result<TriageRunMember | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const triageRunMemberId = TriageRunMemberIdSchema.safeParse(triageRunMemberIdInput);
    if (!triageRunMemberId.success) {
      return err(persistenceFailure("Invalid triage run member ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          triage_run_member_id AS triageRunMemberId,
          triage_run_id AS triageRunId,
          candidate_id AS candidateId,
          import_ordinal AS importOrdinal,
          initial_result_id AS initialResultId,
          created_at AS createdAt
        FROM triage_run_member
        WHERE triage_run_member_id = ?`
      )
      .get(triageRunMemberId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const member = TriageRunMemberSchema.safeParse(row);
    if (!member.success) {
      return err(persistenceFailure("Stored triage run member is invalid"));
    }
    return ok(Object.freeze(member.data));
  } catch {
    return err(persistenceFailure("Triage run member read failed"));
  }
}

export function readTriageRunMembers(
  contextInput: unknown,
  triageRunIdInput: unknown
): Result<readonly TriageRunMember[], RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const triageRunId = TriageRunIdSchema.safeParse(triageRunIdInput);
    if (!triageRunId.success) {
      return err(persistenceFailure("Invalid triage run ID"));
    }
    const rows = context.value.nativeDatabase
      .prepare(
        `SELECT
          triage_run_member_id AS triageRunMemberId,
          triage_run_id AS triageRunId,
          candidate_id AS candidateId,
          import_ordinal AS importOrdinal,
          initial_result_id AS initialResultId,
          created_at AS createdAt
        FROM triage_run_member
        WHERE triage_run_id = ?
        ORDER BY import_ordinal ASC, triage_run_member_id ASC`
      )
      .all(triageRunId.data);
    const members = [];
    for (const row of rows) {
      const member = TriageRunMemberSchema.safeParse(row);
      if (!member.success) {
        return err(persistenceFailure("Stored triage run member is invalid"));
      }
      members.push(Object.freeze(member.data));
    }
    return ok(Object.freeze(members));
  } catch {
    return err(persistenceFailure("Triage run member read failed"));
  }
}

export function readTriageRunSeal(
  contextInput: unknown,
  triageRunSealIdInput: unknown
): Result<TriageRunSeal | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const triageRunSealId = TriageRunSealIdSchema.safeParse(triageRunSealIdInput);
    if (!triageRunSealId.success) {
      return err(persistenceFailure("Invalid triage run seal ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          triage_run_seal_id AS triageRunSealId,
          triage_run_id AS triageRunId,
          created_at AS createdAt
        FROM triage_run_seal
        WHERE triage_run_seal_id = ?`
      )
      .get(triageRunSealId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const seal = TriageRunSealSchema.safeParse(row);
    if (!seal.success) {
      return err(persistenceFailure("Stored triage run seal is invalid"));
    }
    return ok(Object.freeze(seal.data));
  } catch {
    return err(persistenceFailure("Triage run seal read failed"));
  }
}
