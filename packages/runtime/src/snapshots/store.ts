import {
  RunInputSnapshotIdSchema,
  Sha256HexSchema,
  canonicalJsonStringify,
  err,
  ok,
  sha256Hex,
  type Result
} from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  RunInputSnapshotContentSchema,
  RunInputSnapshotDraftSchema,
  RunInputSnapshotSchema,
  type RunInputSnapshot,
  type RunInputSnapshotContent,
  type RunInputSnapshotDimension,
  type RunInputScoringPolicy
} from "./schemas.js";

const preparedRunInputSnapshots = new WeakSet<object>();

const TRANSACTION_REQUIRED = "Run input snapshot rows require an active command transaction";

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

function canonicalWithHash(
  value: unknown,
  message: string
): Result<{ json: string; hash: string }, RuntimeError> {
  const json = canonicalJsonStringify(value);
  if (!json.ok) {
    return err(persistenceFailure(message));
  }
  return ok({ json: json.value, hash: sha256Hex(json.value) });
}

function decodeCanonicalJson(
  json: string,
  hash: string,
  invalidJsonMessage: string,
  integrityMessage: string
): Result<unknown, RuntimeError> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    return err(persistenceFailure(invalidJsonMessage));
  }
  const canonical = canonicalJsonStringify(decoded);
  if (!canonical.ok || canonical.value !== json || sha256Hex(json) !== hash) {
    return err(persistenceFailure(integrityMessage));
  }
  return ok(decoded);
}

function orderedDimension(dimension: RunInputSnapshotDimension): RunInputSnapshotDimension {
  return {
    definition: dimension.definition,
    dimensionId: dimension.dimensionId,
    jobRelatedJustification: dimension.jobRelatedJustification,
    ordinal: dimension.ordinal,
    required: dimension.required,
    weight: dimension.weight
  };
}

function orderedScoringPolicy(policy: RunInputScoringPolicy): RunInputScoringPolicy {
  return {
    confidenceWeights: {
      contradiction: policy.confidenceWeights.contradiction,
      coverage: policy.confidenceWeights.coverage,
      missingFields: policy.confidenceWeights.missingFields,
      resolution: policy.confidenceWeights.resolution
    },
    escalateThreshold: policy.escalateThreshold,
    levelValues: {
      none: policy.levelValues.none,
      partial: policy.levelValues.partial,
      strong: policy.levelValues.strong,
      weak: policy.levelValues.weak
    },
    requiredFieldIds: policy.requiredFieldIds,
    shortlistN: policy.shortlistN
  };
}

function orderedSnapshotContent(content: RunInputSnapshotContent): RunInputSnapshotContent {
  return {
    dimensions: [...content.dimensions]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(orderedDimension),
    extractorVersion: content.extractorVersion,
    frozenDate: content.frozenDate,
    limits: {
      maxEvidenceItems: content.limits.maxEvidenceItems,
      maxProviderResponseBytes: content.limits.maxProviderResponseBytes,
      maxQuoteLength: content.limits.maxQuoteLength,
      maxSerializedRequestBytes: content.limits.maxSerializedRequestBytes,
      maxStructuredFacts: content.limits.maxStructuredFacts,
      maxValidationDetails: content.limits.maxValidationDetails
    },
    promptTemplateVersion: content.promptTemplateVersion,
    roleId: content.roleId,
    rubricVersion: content.rubricVersion,
    scoringPolicy: orderedScoringPolicy(content.scoringPolicy)
  };
}

/**
 * Rejects unknown fields, non-v1 scoring or limits, invalid calendar dates,
 * duplicate dimension ids, and non-contiguous ordinals.
 */
export function validateRunInputSnapshotContent(
  contentInput: unknown
): Result<RunInputSnapshotContent, RuntimeError> {
  const content = RunInputSnapshotContentSchema.safeParse(contentInput);
  if (!content.success) {
    return err(persistenceFailure("Invalid run input snapshot content"));
  }

  const dimensionIds = new Set<string>();
  const ordinals = content.data.dimensions
    .map((dimension) => dimension.ordinal)
    .sort((left, right) => left - right);
  if (ordinals[0] !== 0) {
    return err(persistenceFailure("Run input snapshot dimension ordinals must start at 0"));
  }
  for (let index = 0; index < ordinals.length; index += 1) {
    if (ordinals[index] !== index) {
      return err(
        persistenceFailure("Run input snapshot dimension ordinals must be contiguous")
      );
    }
  }
  for (const dimension of content.data.dimensions) {
    if (dimensionIds.has(dimension.dimensionId)) {
      return err(persistenceFailure("Run input snapshot dimension ids must be unique"));
    }
    dimensionIds.add(dimension.dimensionId);
  }

  return ok(content.data);
}

function canonicalizeRunInputSnapshotContent(
  contentInput: unknown
): Result<{ content: RunInputSnapshotContent; json: string; hash: string }, RuntimeError> {
  const hashedInput = canonicalWithHash(
    contentInput,
    "Run input snapshot content is not canonical JSON"
  );
  if (!hashedInput.ok) {
    return hashedInput;
  }
  const content = validateRunInputSnapshotContent(contentInput);
  if (!content.ok) {
    return content;
  }
  const ordered = orderedSnapshotContent(content.value);
  const json = JSON.stringify(ordered);
  return ok({
    content: ordered,
    json,
    hash: sha256Hex(json)
  });
}

/**
 * Builds the content-addressed snapshot hash outside the writer lock. Dimension
 * authoring order cannot change the hash because ordinals are sorted first.
 */
export function hashRunInputSnapshotContent(
  contentInput: unknown
): Result<string, RuntimeError> {
  const canonicalized = canonicalizeRunInputSnapshotContent(contentInput);
  if (!canonicalized.ok) {
    return canonicalized;
  }
  return ok(canonicalized.value.hash);
}

/**
 * Hashing and contract validation happen here so the writer lock only covers
 * the insert itself.
 */
export function prepareRunInputSnapshot(
  draftInput: unknown
): Result<RunInputSnapshot, RuntimeError> {
  try {
    const draft = RunInputSnapshotDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid run input snapshot input"));
    }
    const canonicalized = canonicalizeRunInputSnapshotContent(draft.data.content);
    if (!canonicalized.ok) {
      return canonicalized;
    }
    const snapshot = RunInputSnapshotSchema.parse({
      runInputSnapshotId: draft.data.runInputSnapshotId,
      content: canonicalized.value.content,
      contentJson: canonicalized.value.json,
      contentHash: canonicalized.value.hash,
      frozenDate: canonicalized.value.content.frozenDate,
      rubricVersion: canonicalized.value.content.rubricVersion,
      roleId: canonicalized.value.content.roleId,
      extractorVersion: canonicalized.value.content.extractorVersion,
      promptTemplateVersion: canonicalized.value.content.promptTemplateVersion,
      createdAt: draft.data.createdAt
    });
    return ok(register(preparedRunInputSnapshots, snapshot));
  } catch {
    return err(persistenceFailure("Run input snapshot preparation failed"));
  }
}

export function insertRunInputSnapshot(
  contextInput: unknown,
  preparedInput: unknown
): Result<RunInputSnapshot, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<RunInputSnapshot>(
      preparedRunInputSnapshots,
      preparedInput,
      "Invalid prepared run input snapshot"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const snapshot = prepared.value;

    const roleRow = context.value.nativeDatabase
      .prepare("SELECT 1 AS present FROM role WHERE role_id = ?")
      .get(snapshot.roleId);
    if (roleRow === undefined) {
      return err(persistenceFailure("Run input snapshot requires a stored role"));
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO run_input_snapshot (
          run_input_snapshot_id,
          content_json,
          content_hash,
          frozen_date,
          rubric_version,
          role_id,
          extractor_version,
          prompt_template_version,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.runInputSnapshotId,
        snapshot.contentJson,
        snapshot.contentHash,
        snapshot.frozenDate,
        snapshot.rubricVersion,
        snapshot.roleId,
        snapshot.extractorVersion,
        snapshot.promptTemplateVersion,
        snapshot.createdAt
      );

    return ok(snapshot);
  } catch {
    return err(persistenceFailure("Run input snapshot insert failed"));
  }
}

function hydrateRunInputSnapshot(
  row: Readonly<{
    runInputSnapshotId: string;
    contentJson: string;
    contentHash: string;
    frozenDate: string;
    rubricVersion: string;
    roleId: string;
    extractorVersion: string;
    promptTemplateVersion: string;
    createdAt: number;
  }>
): Result<RunInputSnapshot, RuntimeError> {
  const decoded = decodeCanonicalJson(
    row.contentJson,
    row.contentHash,
    "Stored run input snapshot content is not valid JSON",
    "Stored run input snapshot failed integrity validation"
  );
  if (!decoded.ok) {
    return decoded;
  }
  const snapshot = RunInputSnapshotSchema.safeParse({
    ...row,
    content: decoded.value
  });
  if (!snapshot.success) {
    return err(persistenceFailure("Stored run input snapshot is invalid"));
  }
  if (
    snapshot.data.frozenDate !== snapshot.data.content.frozenDate ||
    snapshot.data.rubricVersion !== snapshot.data.content.rubricVersion ||
    snapshot.data.roleId !== snapshot.data.content.roleId ||
    snapshot.data.extractorVersion !== snapshot.data.content.extractorVersion ||
    snapshot.data.promptTemplateVersion !== snapshot.data.content.promptTemplateVersion
  ) {
    return err(persistenceFailure("Stored run input snapshot failed integrity validation"));
  }
  return ok(Object.freeze(snapshot.data));
}

const SNAPSHOT_SELECT = `SELECT
  run_input_snapshot_id AS runInputSnapshotId,
  content_json AS contentJson,
  content_hash AS contentHash,
  frozen_date AS frozenDate,
  rubric_version AS rubricVersion,
  role_id AS roleId,
  extractor_version AS extractorVersion,
  prompt_template_version AS promptTemplateVersion,
  created_at AS createdAt
FROM run_input_snapshot`;

export function readRunInputSnapshot(
  contextInput: unknown,
  runInputSnapshotIdInput: unknown
): Result<RunInputSnapshot | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const runInputSnapshotId = RunInputSnapshotIdSchema.safeParse(runInputSnapshotIdInput);
    if (!runInputSnapshotId.success) {
      return err(persistenceFailure("Invalid run input snapshot ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${SNAPSHOT_SELECT} WHERE run_input_snapshot_id = ?`)
      .get(runInputSnapshotId.data) as Parameters<typeof hydrateRunInputSnapshot>[0] | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    return hydrateRunInputSnapshot(row);
  } catch {
    return err(persistenceFailure("Run input snapshot read failed"));
  }
}

export function readRunInputSnapshotByContentHash(
  contextInput: unknown,
  contentHashInput: unknown
): Result<RunInputSnapshot | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const contentHash = Sha256HexSchema.safeParse(contentHashInput);
    if (!contentHash.success) {
      return err(persistenceFailure("Invalid run input snapshot content hash"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${SNAPSHOT_SELECT} WHERE content_hash = ?`)
      .get(contentHash.data) as Parameters<typeof hydrateRunInputSnapshot>[0] | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    return hydrateRunInputSnapshot(row);
  } catch {
    return err(persistenceFailure("Run input snapshot read failed"));
  }
}
