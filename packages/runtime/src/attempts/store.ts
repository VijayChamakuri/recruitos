import {
  AttemptWorkItemIdSchema,
  TriageAttemptIdSchema,
  err,
  ok,
  type Result
} from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  AttemptWorkItemDraftSchema,
  AttemptWorkItemSchema,
  ClaimAttemptWorkItemInputSchema,
  CompleteAttemptWorkItemInputSchema,
  FailAttemptWorkItemInputSchema,
  TriageAttemptDraftSchema,
  TriageAttemptSchema,
  isTriageAttemptKindShape,
  type AttemptWorkItem,
  type TriageAttempt
} from "./schemas.js";

const preparedTriageAttempts = new WeakSet<object>();
const preparedAttemptWorkItems = new WeakSet<object>();

const TRANSACTION_REQUIRED = "Triage attempt rows require an active command transaction";

function persistenceFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function versionConflict(
  table: string,
  identity: string,
  expectedVersion: number,
  actualVersion: number | null
): RuntimeError {
  return createRuntimeError("version_conflict", "Attempt work item version conflict", false, {
    table,
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

const ATTEMPT_SELECT = `SELECT
  triage_attempt_id AS triageAttemptId,
  kind,
  snapshot_id AS snapshotId,
  corpus_manifest_id AS corpusManifestId,
  origin_run_id AS originRunId,
  base_result_id AS baseResultId,
  request_action_id AS requestActionId,
  scope_candidate_id AS scopeCandidateId,
  status,
  version,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM triage_attempt`;

const WORK_ITEM_SELECT = `SELECT
  attempt_work_item_id AS attemptWorkItemId,
  triage_attempt_id AS triageAttemptId,
  work_item_key AS workItemKey,
  manifest_ordinal AS manifestOrdinal,
  candidate_id AS candidateId,
  candidate_document_id AS candidateDocumentId,
  dimension_id AS dimensionId,
  extraction_spec_id AS extractionSpecId,
  state,
  claim_id AS claimId,
  claimed_at AS claimedAt,
  claim_expires_at AS claimExpiresAt,
  attempt_count AS attemptCount,
  extraction_artifact_id AS extractionArtifactId,
  extraction_failure_id AS extractionFailureId,
  version,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM attempt_work_item`;

function parseStoredAttempt(row: unknown): Result<TriageAttempt, RuntimeError> {
  const attempt = TriageAttemptSchema.safeParse(row);
  if (!attempt.success || !isTriageAttemptKindShape(attempt.data)) {
    return err(persistenceFailure("Stored triage attempt is invalid"));
  }
  return ok(Object.freeze(attempt.data));
}

function parseStoredWorkItem(row: unknown): Result<AttemptWorkItem, RuntimeError> {
  const item = AttemptWorkItemSchema.safeParse(row);
  if (!item.success) {
    return err(persistenceFailure("Stored attempt work item is invalid"));
  }
  return ok(Object.freeze(item.data));
}

function refreshAttemptStatus(
  context: ImmediateTransactionContext,
  triageAttemptId: string,
  updatedAt: number
): Result<void, RuntimeError> {
  const current = context.nativeDatabase
    .prepare(
      `SELECT status, version FROM triage_attempt WHERE triage_attempt_id = ?`
    )
    .get(triageAttemptId) as { status: string; version: number } | undefined;
  if (current === undefined) {
    return err(persistenceFailure("Triage attempt is missing for status refresh"));
  }

  const stats = context.nativeDatabase
    .prepare(
      `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN state = 'blocked_failure' THEN 1 ELSE 0 END), 0) AS blocked,
        COALESCE(SUM(CASE WHEN state IN ('succeeded', 'reviewable_failure') THEN 1 ELSE 0 END), 0) AS ready
      FROM attempt_work_item
      WHERE triage_attempt_id = ?`
    )
    .get(triageAttemptId) as { total: number; blocked: number; ready: number };

  let nextStatus = "in_progress";
  if (stats.blocked > 0) {
    nextStatus = "blocked";
  } else if (stats.total > 0 && stats.ready === stats.total) {
    nextStatus = "ready";
  }

  if (nextStatus === current.status) {
    return ok(undefined);
  }

  context.nativeDatabase
    .prepare(
      `UPDATE triage_attempt
       SET status = ?, version = ?, updated_at = ?
       WHERE triage_attempt_id = ?`
    )
    .run(nextStatus, current.version + 1, updatedAt, triageAttemptId);
  return ok(undefined);
}

export function prepareTriageAttempt(draftInput: unknown): Result<TriageAttempt, RuntimeError> {
  try {
    const draft = TriageAttemptDraftSchema.safeParse(draftInput);
    if (!draft.success || !isTriageAttemptKindShape(draft.data)) {
      return err(persistenceFailure("Invalid triage attempt input"));
    }
    return ok(register(preparedTriageAttempts, draft.data));
  } catch {
    return err(persistenceFailure("Triage attempt preparation failed"));
  }
}

export function prepareAttemptWorkItem(
  draftInput: unknown
): Result<AttemptWorkItem, RuntimeError> {
  try {
    const draft = AttemptWorkItemDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid attempt work item input"));
    }
    return ok(
      register(
        preparedAttemptWorkItems,
        AttemptWorkItemSchema.parse({
          ...draft.data,
          state: "pending",
          claimId: null,
          claimedAt: null,
          claimExpiresAt: null,
          attemptCount: 0,
          extractionArtifactId: null,
          extractionFailureId: null,
          version: 1,
          updatedAt: draft.data.createdAt
        })
      )
    );
  } catch {
    return err(persistenceFailure("Attempt work item preparation failed"));
  }
}

export function insertTriageAttempt(
  contextInput: unknown,
  preparedInput: unknown
): Result<TriageAttempt, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<TriageAttempt>(
      preparedTriageAttempts,
      preparedInput,
      "Invalid prepared triage attempt"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const attempt = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO triage_attempt (
          triage_attempt_id,
          kind,
          snapshot_id,
          corpus_manifest_id,
          origin_run_id,
          base_result_id,
          request_action_id,
          scope_candidate_id,
          status,
          version,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        attempt.triageAttemptId,
        attempt.kind,
        attempt.snapshotId,
        attempt.corpusManifestId,
        attempt.originRunId,
        attempt.baseResultId,
        attempt.requestActionId,
        attempt.scopeCandidateId,
        attempt.status,
        attempt.version,
        attempt.createdAt,
        attempt.updatedAt
      );

    return ok(attempt);
  } catch {
    return err(persistenceFailure("Triage attempt insert failed"));
  }
}

export function insertAttemptWorkItem(
  contextInput: unknown,
  preparedInput: unknown
): Result<AttemptWorkItem, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<AttemptWorkItem>(
      preparedAttemptWorkItems,
      preparedInput,
      "Invalid prepared attempt work item"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const item = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO attempt_work_item (
          attempt_work_item_id,
          triage_attempt_id,
          work_item_key,
          manifest_ordinal,
          candidate_id,
          candidate_document_id,
          dimension_id,
          extraction_spec_id,
          state,
          claim_id,
          claimed_at,
          claim_expires_at,
          attempt_count,
          extraction_artifact_id,
          extraction_failure_id,
          version,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.attemptWorkItemId,
        item.triageAttemptId,
        item.workItemKey,
        item.manifestOrdinal,
        item.candidateId,
        item.candidateDocumentId,
        item.dimensionId,
        item.extractionSpecId,
        item.state,
        item.claimId,
        item.claimedAt,
        item.claimExpiresAt,
        item.attemptCount,
        item.extractionArtifactId,
        item.extractionFailureId,
        item.version,
        item.createdAt,
        item.updatedAt
      );

    const refreshed = refreshAttemptStatus(
      context.value,
      item.triageAttemptId,
      item.updatedAt
    );
    if (!refreshed.ok) {
      return refreshed;
    }

    return ok(item);
  } catch {
    return err(persistenceFailure("Attempt work item insert failed"));
  }
}

export function readTriageAttempt(
  contextInput: unknown,
  triageAttemptIdInput: unknown
): Result<TriageAttempt | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const triageAttemptId = TriageAttemptIdSchema.safeParse(triageAttemptIdInput);
    if (!triageAttemptId.success) {
      return err(persistenceFailure("Invalid triage attempt ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${ATTEMPT_SELECT} WHERE triage_attempt_id = ?`)
      .get(triageAttemptId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    return parseStoredAttempt(row);
  } catch {
    return err(persistenceFailure("Triage attempt read failed"));
  }
}

export function readAttemptWorkItem(
  contextInput: unknown,
  attemptWorkItemIdInput: unknown
): Result<AttemptWorkItem | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const attemptWorkItemId = AttemptWorkItemIdSchema.safeParse(attemptWorkItemIdInput);
    if (!attemptWorkItemId.success) {
      return err(persistenceFailure("Invalid attempt work item ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${WORK_ITEM_SELECT} WHERE attempt_work_item_id = ?`)
      .get(attemptWorkItemId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    return parseStoredWorkItem(row);
  } catch {
    return err(persistenceFailure("Attempt work item read failed"));
  }
}

export function readAttemptWorkItems(
  contextInput: unknown,
  triageAttemptIdInput: unknown
): Result<readonly AttemptWorkItem[], RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const triageAttemptId = TriageAttemptIdSchema.safeParse(triageAttemptIdInput);
    if (!triageAttemptId.success) {
      return err(persistenceFailure("Invalid triage attempt ID"));
    }
    const rows = context.value.nativeDatabase
      .prepare(
        `${WORK_ITEM_SELECT}
        WHERE triage_attempt_id = ?
        ORDER BY manifest_ordinal ASC, work_item_key ASC`
      )
      .all(triageAttemptId.data);
    const items = [];
    for (const row of rows) {
      const item = parseStoredWorkItem(row);
      if (!item.ok) {
        return item;
      }
      items.push(item.value);
    }
    return ok(Object.freeze(items));
  } catch {
    return err(persistenceFailure("Attempt work item read failed"));
  }
}

function readWorkItemForUpdate(
  context: ImmediateTransactionContext,
  attemptWorkItemId: string
): Result<AttemptWorkItem, RuntimeError> {
  const row = context.nativeDatabase
    .prepare(`${WORK_ITEM_SELECT} WHERE attempt_work_item_id = ?`)
    .get(attemptWorkItemId);
  if (row === undefined) {
    return err(persistenceFailure("Attempt work item is missing"));
  }
  return parseStoredWorkItem(row);
}

export function claimAttemptWorkItem(
  contextInput: unknown,
  input: unknown
): Result<AttemptWorkItem, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const parsed = ClaimAttemptWorkItemInputSchema.safeParse(input);
    if (!parsed.success || parsed.data.claimExpiresAt < parsed.data.claimedAt) {
      return err(persistenceFailure("Invalid attempt work item claim input"));
    }
    const claim = parsed.data;
    const current = readWorkItemForUpdate(context.value, claim.attemptWorkItemId);
    if (!current.ok) {
      return current;
    }
    const item = current.value;
    if (item.version !== claim.expectedVersion) {
      return err(
        versionConflict(
          "attempt_work_item",
          item.attemptWorkItemId,
          claim.expectedVersion,
          item.version
        )
      );
    }

    const expiredClaim =
      item.state === "claimed" &&
      item.claimExpiresAt !== null &&
      item.claimExpiresAt <= claim.claimedAt;
    const claimable =
      item.state === "pending" || item.state === "retryable_failure" || expiredClaim;
    if (!claimable) {
      return err(persistenceFailure("Attempt work item is not claimable"));
    }

    context.value.nativeDatabase
      .prepare(
        `UPDATE attempt_work_item
         SET state = 'claimed',
             claim_id = ?,
             claimed_at = ?,
             claim_expires_at = ?,
             attempt_count = ?,
             extraction_artifact_id = NULL,
             extraction_failure_id = NULL,
             version = ?,
             updated_at = ?
         WHERE attempt_work_item_id = ?`
      )
      .run(
        claim.claimId,
        claim.claimedAt,
        claim.claimExpiresAt,
        item.attemptCount + 1,
        item.version + 1,
        claim.claimedAt,
        item.attemptWorkItemId
      );

    const refreshed = refreshAttemptStatus(
      context.value,
      item.triageAttemptId,
      claim.claimedAt
    );
    if (!refreshed.ok) {
      return refreshed;
    }

    return readWorkItemForUpdate(context.value, item.attemptWorkItemId);
  } catch {
    return err(persistenceFailure("Attempt work item claim failed"));
  }
}

export function completeAttemptWorkItem(
  contextInput: unknown,
  input: unknown
): Result<AttemptWorkItem, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const parsed = CompleteAttemptWorkItemInputSchema.safeParse(input);
    if (!parsed.success) {
      return err(persistenceFailure("Invalid attempt work item completion input"));
    }
    const completion = parsed.data;
    const current = readWorkItemForUpdate(context.value, completion.attemptWorkItemId);
    if (!current.ok) {
      return current;
    }
    const item = current.value;
    if (item.version !== completion.expectedVersion) {
      return err(
        versionConflict(
          "attempt_work_item",
          item.attemptWorkItemId,
          completion.expectedVersion,
          item.version
        )
      );
    }
    if (item.state !== "claimed") {
      return err(persistenceFailure("Attempt work item is not claimed"));
    }

    context.value.nativeDatabase
      .prepare(
        `UPDATE attempt_work_item
         SET state = 'succeeded',
             extraction_artifact_id = ?,
             extraction_failure_id = NULL,
             version = ?,
             updated_at = ?
         WHERE attempt_work_item_id = ?`
      )
      .run(
        completion.extractionArtifactId,
        item.version + 1,
        completion.completedAt,
        item.attemptWorkItemId
      );

    const refreshed = refreshAttemptStatus(
      context.value,
      item.triageAttemptId,
      completion.completedAt
    );
    if (!refreshed.ok) {
      return refreshed;
    }

    return readWorkItemForUpdate(context.value, item.attemptWorkItemId);
  } catch {
    return err(persistenceFailure("Attempt work item completion failed"));
  }
}

export function failAttemptWorkItem(
  contextInput: unknown,
  input: unknown
): Result<AttemptWorkItem, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const parsed = FailAttemptWorkItemInputSchema.safeParse(input);
    if (!parsed.success) {
      return err(persistenceFailure("Invalid attempt work item failure input"));
    }
    const failure = parsed.data;
    const current = readWorkItemForUpdate(context.value, failure.attemptWorkItemId);
    if (!current.ok) {
      return current;
    }
    const item = current.value;
    if (item.version !== failure.expectedVersion) {
      return err(
        versionConflict(
          "attempt_work_item",
          item.attemptWorkItemId,
          failure.expectedVersion,
          item.version
        )
      );
    }
    if (item.state !== "claimed") {
      return err(persistenceFailure("Attempt work item is not claimed"));
    }

    context.value.nativeDatabase
      .prepare(
        `UPDATE attempt_work_item
         SET state = ?,
             extraction_artifact_id = NULL,
             extraction_failure_id = ?,
             version = ?,
             updated_at = ?
         WHERE attempt_work_item_id = ?`
      )
      .run(
        failure.state,
        failure.extractionFailureId,
        item.version + 1,
        failure.failedAt,
        item.attemptWorkItemId
      );

    const refreshed = refreshAttemptStatus(
      context.value,
      item.triageAttemptId,
      failure.failedAt
    );
    if (!refreshed.ok) {
      return refreshed;
    }

    return readWorkItemForUpdate(context.value, item.attemptWorkItemId);
  } catch {
    return err(persistenceFailure("Attempt work item failure failed"));
  }
}
