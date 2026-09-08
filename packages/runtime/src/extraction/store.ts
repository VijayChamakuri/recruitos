import {
  ExtractionArtifactIdSchema,
  ExtractionFailureIdSchema,
  ExtractionRunIdSchema,
  ExtractionSpecIdSchema,
  Sha256HexSchema,
  canonicalJsonStringify,
  err,
  ok,
  sha256Hex,
  validateUtf16Interval,
  validateUtf16Slice,
  type Result
} from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  ExtractionRunDraftSchema,
  ExtractionRunSchema,
  type ExtractionRun
} from "../evidence/schemas.js";
import {
  EXTRACTION_LIMITS,
  ExtractionArtifactDraftSchema,
  ExtractionArtifactSchema,
  ExtractionFailureDraftSchema,
  ExtractionFailureSchema,
  ExtractionSpecContentSchema,
  ExtractionSpecDraftSchema,
  ExtractionSpecSchema,
  type ExtractionAcceptedOutput,
  type ExtractionArtifact,
  type ExtractionFailure,
  type ExtractionFailureDiagnostic,
  type ExtractionRejectedClaim,
  type ExtractionSpec,
  type ExtractionSpecContent
} from "./schemas.js";

const preparedExtractionSpecs = new WeakSet<object>();
const preparedExtractionArtifacts = new WeakSet<object>();
const preparedExtractionFailures = new WeakSet<object>();
const preparedExtractionRuns = new WeakSet<object>();

const TRANSACTION_REQUIRED = "Extraction spec rows require an active command transaction";

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

/**
 * Proves a stored canonical JSON column still round-trips and still matches its
 * digest, so a hand-edited or partially written row is a read error rather
 * than a silently different extraction contract.
 */
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

function orderedSpecContent(content: ExtractionSpecContent): ExtractionSpecContent {
  return {
    dimensionDefinition: content.dimensionDefinition,
    dimensionId: content.dimensionId,
    extractorVersion: content.extractorVersion,
    jobRelatedJustification: content.jobRelatedJustification,
    limits: {
      maxEvidenceItems: content.limits.maxEvidenceItems,
      maxProviderResponseBytes: content.limits.maxProviderResponseBytes,
      maxQuoteLength: content.limits.maxQuoteLength,
      maxSerializedRequestBytes: content.limits.maxSerializedRequestBytes,
      maxStructuredFacts: content.limits.maxStructuredFacts,
      maxValidationDetails: content.limits.maxValidationDetails
    },
    modelId: content.modelId,
    promptHash: content.promptHash,
    promptTemplateVersion: content.promptTemplateVersion,
    schemaHash: content.schemaHash
  };
}

function orderedAcceptedOutput(output: ExtractionAcceptedOutput): ExtractionAcceptedOutput {
  return {
    dimensionId: output.dimensionId,
    proposedLevel: output.proposedLevel,
    spans: output.spans.map((span) => ({
      end: span.end,
      matchQuality: span.matchQuality,
      polarity: span.polarity,
      quotedText: span.quotedText,
      start: span.start
    }))
  };
}

function orderedRejectedClaims(
  claims: readonly ExtractionRejectedClaim[]
): ExtractionRejectedClaim[] {
  return claims.map((claim) => ({
    kind: claim.kind,
    quotedText: claim.quotedText,
    reason: claim.reason
  }));
}

function orderedDiagnostic(
  diagnostic: ExtractionFailureDiagnostic
): ExtractionFailureDiagnostic {
  return {
    details: [...diagnostic.details],
    summary: diagnostic.summary
  };
}

function artifactContent(input: {
  acceptedOutput: ExtractionAcceptedOutput;
  rejectedClaims: readonly ExtractionRejectedClaim[];
}): unknown {
  return {
    acceptedOutput: orderedAcceptedOutput(input.acceptedOutput),
    rejectedClaims: orderedRejectedClaims(input.rejectedClaims)
  };
}

function failureContent(input: {
  diagnostic: ExtractionFailureDiagnostic;
  errorClass: ExtractionFailure["errorClass"];
  responseByteLength: number;
  responseHash: string;
}): unknown {
  return {
    diagnostic: orderedDiagnostic(input.diagnostic),
    errorClass: input.errorClass,
    responseByteLength: input.responseByteLength,
    responseHash: input.responseHash
  };
}

function rowExists(
  context: ImmediateTransactionContext,
  sql: string,
  id: string
): boolean {
  return context.nativeDatabase.prepare(sql).get(id) !== undefined;
}

/**
 * Rejects unknown fields, missing definitions, and any limit vector that is
 * not the locked v1 capacity contract. Weights never appear on this object.
 */
export function validateExtractionSpecContent(
  contentInput: unknown
): Result<ExtractionSpecContent, RuntimeError> {
  if (
    typeof contentInput === "object" &&
    contentInput !== null &&
    Object.prototype.hasOwnProperty.call(contentInput, "weight")
  ) {
    return err(persistenceFailure("Extraction spec content must not include weights"));
  }
  const content = ExtractionSpecContentSchema.safeParse(contentInput);
  if (!content.success) {
    return err(persistenceFailure("Invalid extraction spec content"));
  }
  return ok(content.data);
}

function canonicalizeExtractionSpecContent(
  contentInput: unknown
): Result<
  { content: ExtractionSpecContent; json: string; hash: string },
  RuntimeError
> {
  if (
    typeof contentInput === "object" &&
    contentInput !== null &&
    Object.prototype.hasOwnProperty.call(contentInput, "weight")
  ) {
    return err(persistenceFailure("Extraction spec content must not include weights"));
  }
  const hashedInput = canonicalWithHash(
    contentInput,
    "Extraction spec content is not canonical JSON"
  );
  if (!hashedInput.ok) {
    return hashedInput;
  }
  const content = validateExtractionSpecContent(contentInput);
  if (!content.ok) {
    return content;
  }
  // Parsed spec content is a closed plain object with ordered keys, so the
  // stored identity is the SHA-256 of that JSON. A second canonicalization
  // Result cannot fail here.
  const json = JSON.stringify(orderedSpecContent(content.value));
  return ok({
    content: content.value,
    json,
    hash: sha256Hex(json)
  });
}

/**
 * Builds the content-addressed spec hash outside the writer lock. Field order
 * cannot change the hash because canonical JSON sorts keys.
 */
export function hashExtractionSpecContent(
  contentInput: unknown
): Result<string, RuntimeError> {
  const canonicalized = canonicalizeExtractionSpecContent(contentInput);
  if (!canonicalized.ok) {
    return canonicalized;
  }
  return ok(canonicalized.value.hash);
}

/**
 * Hashing and contract validation happen here so the writer lock only covers
 * the insert itself.
 */
export function prepareExtractionSpec(
  draftInput: unknown
): Result<ExtractionSpec, RuntimeError> {
  try {
    const draft = ExtractionSpecDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid extraction spec input"));
    }
    const canonicalized = canonicalizeExtractionSpecContent(draft.data.content);
    if (!canonicalized.ok) {
      return canonicalized;
    }
    const spec = ExtractionSpecSchema.parse({
      extractionSpecId: draft.data.extractionSpecId,
      content: canonicalized.value.content,
      contentJson: canonicalized.value.json,
      contentHash: canonicalized.value.hash,
      modelId: canonicalized.value.content.modelId,
      extractorVersion: canonicalized.value.content.extractorVersion,
      promptHash: canonicalized.value.content.promptHash,
      schemaHash: canonicalized.value.content.schemaHash,
      dimensionId: canonicalized.value.content.dimensionId,
      createdAt: draft.data.createdAt
    });
    return ok(register(preparedExtractionSpecs, spec));
  } catch {
    return err(persistenceFailure("Extraction spec preparation failed"));
  }
}

/**
 * Validates bounded accepted output and rejected claims, then hashes both
 * together so identical validated proposals converge on one content hash.
 */
export function prepareExtractionArtifact(
  draftInput: unknown
): Result<ExtractionArtifact, RuntimeError> {
  try {
    const draft = ExtractionArtifactDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid extraction artifact input"));
    }

    for (const span of draft.data.acceptedOutput.spans) {
      if (span.end <= span.start) {
        return err(persistenceFailure("Extraction artifact span end must exceed its start"));
      }
    }

    const accepted = canonicalWithHash(
      orderedAcceptedOutput(draft.data.acceptedOutput),
      "Extraction artifact accepted output is not canonical JSON"
    );
    if (!accepted.ok) {
      return accepted;
    }
    const rejected = canonicalWithHash(
      orderedRejectedClaims(draft.data.rejectedClaims),
      "Extraction artifact rejected claims are not canonical JSON"
    );
    if (!rejected.ok) {
      return rejected;
    }
    const combined = canonicalWithHash(
      artifactContent({
        acceptedOutput: draft.data.acceptedOutput,
        rejectedClaims: draft.data.rejectedClaims
      }),
      "Extraction artifact content is not canonical JSON"
    );
    if (!combined.ok) {
      return combined;
    }

    if (draft.data.acceptedOutput.spans.length > EXTRACTION_LIMITS.maxEvidenceItems) {
      return err(
        persistenceFailure("Extraction artifact spans exceed the work-item evidence limit")
      );
    }
    if (draft.data.rejectedClaims.length > EXTRACTION_LIMITS.maxValidationDetails) {
      return err(
        persistenceFailure("Extraction artifact rejected claims exceed the validation-detail limit")
      );
    }
    if (
      draft.data.acceptedOutput.proposedLevel !== "none" &&
      !draft.data.acceptedOutput.spans.some((span) => span.polarity === "supporting")
    ) {
      return err(
        persistenceFailure("Non-none extraction artifacts require a located supporting span")
      );
    }

    const artifact = ExtractionArtifactSchema.parse({
      ...draft.data,
      acceptedOutputJson: accepted.value.json,
      acceptedOutputHash: accepted.value.hash,
      rejectedClaimsJson: rejected.value.json,
      rejectedClaimsHash: rejected.value.hash,
      contentHash: combined.value.hash
    });
    return ok(register(preparedExtractionArtifacts, artifact));
  } catch {
    return err(persistenceFailure("Extraction artifact preparation failed"));
  }
}

/**
 * Stores only a bounded diagnostic and the hash of the provider body. The
 * raw body never becomes a persistence input.
 */
export function prepareExtractionFailure(
  draftInput: unknown
): Result<ExtractionFailure, RuntimeError> {
  try {
    const draft = ExtractionFailureDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid extraction failure input"));
    }

    const oversized = draft.data.responseByteLength > EXTRACTION_LIMITS.maxProviderResponseBytes;
    if ((draft.data.errorClass === "oversized_response") !== oversized) {
      return err(
        persistenceFailure(
          "Oversized extraction failures must record a response larger than the provider byte cap"
        )
      );
    }

    const diagnostic = canonicalWithHash(
      orderedDiagnostic(draft.data.diagnostic),
      "Extraction failure diagnostic is not canonical JSON"
    );
    if (!diagnostic.ok) {
      return diagnostic;
    }
    const combined = canonicalWithHash(
      failureContent({
        diagnostic: draft.data.diagnostic,
        errorClass: draft.data.errorClass,
        responseByteLength: draft.data.responseByteLength,
        responseHash: draft.data.responseHash
      }),
      "Extraction failure content is not canonical JSON"
    );
    if (!combined.ok) {
      return combined;
    }
    if (draft.data.diagnostic.details.length > EXTRACTION_LIMITS.maxValidationDetails) {
      return err(
        persistenceFailure("Extraction failure diagnostic details exceed the validation-detail limit")
      );
    }

    const failure = ExtractionFailureSchema.parse({
      ...draft.data,
      diagnosticJson: diagnostic.value.json,
      diagnosticHash: diagnostic.value.hash,
      contentHash: combined.value.hash
    });
    return ok(register(preparedExtractionFailures, failure));
  } catch {
    return err(persistenceFailure("Extraction failure preparation failed"));
  }
}

export function insertExtractionSpec(
  contextInput: unknown,
  preparedInput: unknown
): Result<ExtractionSpec, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<ExtractionSpec>(
      preparedExtractionSpecs,
      preparedInput,
      "Invalid prepared extraction spec"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const spec = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO extraction_spec (
          extraction_spec_id,
          content_json,
          content_hash,
          model_id,
          extractor_version,
          prompt_hash,
          schema_hash,
          dimension_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        spec.extractionSpecId,
        spec.contentJson,
        spec.contentHash,
        spec.modelId,
        spec.extractorVersion,
        spec.promptHash,
        spec.schemaHash,
        spec.dimensionId,
        spec.createdAt
      );

    return ok(spec);
  } catch {
    return err(persistenceFailure("Extraction spec insert failed"));
  }
}

/**
 * Relocated exact spans must still be a UTF-16 slice of the stored document,
 * and the artifact's dimension must be the spec's dimension. That keeps a
 * later packet from citing a proposal that was validated for a different
 * contract.
 */
export function insertExtractionArtifact(
  contextInput: unknown,
  preparedInput: unknown
): Result<ExtractionArtifact, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<ExtractionArtifact>(
      preparedExtractionArtifacts,
      preparedInput,
      "Invalid prepared extraction artifact"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const artifact = prepared.value;

    const specRow = context.value.nativeDatabase
      .prepare(
        `SELECT dimension_id AS dimensionId
         FROM extraction_spec
         WHERE extraction_spec_id = ?`
      )
      .get(artifact.specId) as { dimensionId: string } | undefined;
    if (specRow === undefined) {
      return err(persistenceFailure("Extraction artifact requires a stored extraction spec"));
    }
    if (specRow.dimensionId !== artifact.acceptedOutput.dimensionId) {
      return err(
        persistenceFailure("Extraction artifact dimension must match the spec dimension")
      );
    }

    const documentRow = context.value.nativeDatabase
      .prepare(
        `SELECT normalized_text AS normalizedText
         FROM source_document
         WHERE source_document_id = ?`
      )
      .get(artifact.sourceDocumentId) as { normalizedText: string } | undefined;
    if (documentRow === undefined) {
      return err(persistenceFailure("Extraction artifact requires a stored source document"));
    }

    for (const span of artifact.acceptedOutput.spans) {
      const interval = validateUtf16Interval(documentRow.normalizedText, {
        start: span.start,
        end: span.end
      });
      if (!interval.ok) {
        return err(
          persistenceFailure("Extraction artifact span offsets do not address the stored document")
        );
      }
      if (span.matchQuality === "exact") {
        const slice = validateUtf16Slice(documentRow.normalizedText, {
          start: span.start,
          end: span.end,
          matchedText: span.quotedText
        });
        if (!slice.ok) {
          return err(
            persistenceFailure("Exact extraction artifact quote is not a slice of the document")
          );
        }
      }
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO extraction_artifact (
          extraction_artifact_id,
          spec_id,
          source_document_id,
          accepted_output_json,
          accepted_output_hash,
          rejected_claims_json,
          rejected_claims_hash,
          content_hash,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        artifact.extractionArtifactId,
        artifact.specId,
        artifact.sourceDocumentId,
        artifact.acceptedOutputJson,
        artifact.acceptedOutputHash,
        artifact.rejectedClaimsJson,
        artifact.rejectedClaimsHash,
        artifact.contentHash,
        artifact.createdAt
      );

    return ok(artifact);
  } catch {
    return err(persistenceFailure("Extraction artifact insert failed"));
  }
}

export function insertExtractionFailure(
  contextInput: unknown,
  preparedInput: unknown
): Result<ExtractionFailure, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<ExtractionFailure>(
      preparedExtractionFailures,
      preparedInput,
      "Invalid prepared extraction failure"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const failure = prepared.value;

    if (
      !rowExists(
        context.value,
        "SELECT 1 AS present FROM extraction_spec WHERE extraction_spec_id = ?",
        failure.specId
      )
    ) {
      return err(persistenceFailure("Extraction failure requires a stored extraction spec"));
    }
    if (
      !rowExists(
        context.value,
        "SELECT 1 AS present FROM source_document WHERE source_document_id = ?",
        failure.sourceDocumentId
      )
    ) {
      return err(persistenceFailure("Extraction failure requires a stored source document"));
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO extraction_failure (
          extraction_failure_id,
          spec_id,
          source_document_id,
          error_class,
          response_hash,
          response_byte_length,
          diagnostic_json,
          diagnostic_hash,
          content_hash,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        failure.extractionFailureId,
        failure.specId,
        failure.sourceDocumentId,
        failure.errorClass,
        failure.responseHash,
        failure.responseByteLength,
        failure.diagnosticJson,
        failure.diagnosticHash,
        failure.contentHash,
        failure.createdAt
      );

    return ok(failure);
  } catch {
    return err(persistenceFailure("Extraction failure insert failed"));
  }
}

function hydrateExtractionSpec(
  row: Readonly<{
    extractionSpecId: string;
    contentJson: string;
    contentHash: string;
    modelId: string;
    extractorVersion: string;
    promptHash: string;
    schemaHash: string;
    dimensionId: string;
    createdAt: number;
  }>
): Result<ExtractionSpec, RuntimeError> {
  const decoded = decodeCanonicalJson(
    row.contentJson,
    row.contentHash,
    "Stored extraction spec content is not valid JSON",
    "Stored extraction spec failed integrity validation"
  );
  if (!decoded.ok) {
    return decoded;
  }
  const spec = ExtractionSpecSchema.safeParse({
    ...row,
    content: decoded.value
  });
  if (!spec.success) {
    return err(persistenceFailure("Stored extraction spec is invalid"));
  }
  if (
    spec.data.modelId !== spec.data.content.modelId ||
    spec.data.extractorVersion !== spec.data.content.extractorVersion ||
    spec.data.promptHash !== spec.data.content.promptHash ||
    spec.data.schemaHash !== spec.data.content.schemaHash ||
    spec.data.dimensionId !== spec.data.content.dimensionId
  ) {
    return err(persistenceFailure("Stored extraction spec failed integrity validation"));
  }
  return ok(Object.freeze(spec.data));
}

function hydrateExtractionArtifact(
  row: Readonly<{
    extractionArtifactId: string;
    specId: string;
    sourceDocumentId: string;
    acceptedOutputJson: string;
    acceptedOutputHash: string;
    rejectedClaimsJson: string;
    rejectedClaimsHash: string;
    contentHash: string;
    createdAt: number;
  }>
): Result<ExtractionArtifact, RuntimeError> {
  const accepted = decodeCanonicalJson(
    row.acceptedOutputJson,
    row.acceptedOutputHash,
    "Stored extraction artifact accepted output is not valid JSON",
    "Stored extraction artifact failed integrity validation"
  );
  if (!accepted.ok) {
    return accepted;
  }
  const rejected = decodeCanonicalJson(
    row.rejectedClaimsJson,
    row.rejectedClaimsHash,
    "Stored extraction artifact rejected claims are not valid JSON",
    "Stored extraction artifact failed integrity validation"
  );
  if (!rejected.ok) {
    return rejected;
  }
  const combined = canonicalWithHash(
    artifactContent({
      acceptedOutput: accepted.value as ExtractionAcceptedOutput,
      rejectedClaims: rejected.value as ExtractionRejectedClaim[]
    }),
    "Stored extraction artifact failed integrity validation"
  );
  if (!combined.ok) {
    return combined;
  }
  if (combined.value.hash !== row.contentHash) {
    return err(persistenceFailure("Stored extraction artifact failed integrity validation"));
  }
  const artifact = ExtractionArtifactSchema.safeParse({
    ...row,
    acceptedOutput: accepted.value,
    rejectedClaims: rejected.value
  });
  if (!artifact.success) {
    return err(persistenceFailure("Stored extraction artifact is invalid"));
  }
  return ok(Object.freeze(artifact.data));
}

function hydrateExtractionFailure(
  row: Readonly<{
    extractionFailureId: string;
    specId: string;
    sourceDocumentId: string;
    errorClass: string;
    responseHash: string;
    responseByteLength: number;
    diagnosticJson: string;
    diagnosticHash: string;
    contentHash: string;
    createdAt: number;
  }>
): Result<ExtractionFailure, RuntimeError> {
  const diagnostic = decodeCanonicalJson(
    row.diagnosticJson,
    row.diagnosticHash,
    "Stored extraction failure diagnostic is not valid JSON",
    "Stored extraction failure failed integrity validation"
  );
  if (!diagnostic.ok) {
    return diagnostic;
  }
  const combined = canonicalWithHash(
    failureContent({
      diagnostic: diagnostic.value as ExtractionFailureDiagnostic,
      errorClass: row.errorClass as ExtractionFailure["errorClass"],
      responseByteLength: row.responseByteLength,
      responseHash: row.responseHash
    }),
    "Stored extraction failure failed integrity validation"
  );
  if (!combined.ok) {
    return combined;
  }
  if (combined.value.hash !== row.contentHash) {
    return err(persistenceFailure("Stored extraction failure failed integrity validation"));
  }
  const failure = ExtractionFailureSchema.safeParse({
    ...row,
    diagnostic: diagnostic.value
  });
  if (!failure.success) {
    return err(persistenceFailure("Stored extraction failure is invalid"));
  }
  return ok(Object.freeze(failure.data));
}

const SPEC_SELECT = `SELECT
  extraction_spec_id AS extractionSpecId,
  content_json AS contentJson,
  content_hash AS contentHash,
  model_id AS modelId,
  extractor_version AS extractorVersion,
  prompt_hash AS promptHash,
  schema_hash AS schemaHash,
  dimension_id AS dimensionId,
  created_at AS createdAt
FROM extraction_spec`;

const ARTIFACT_SELECT = `SELECT
  extraction_artifact_id AS extractionArtifactId,
  spec_id AS specId,
  source_document_id AS sourceDocumentId,
  accepted_output_json AS acceptedOutputJson,
  accepted_output_hash AS acceptedOutputHash,
  rejected_claims_json AS rejectedClaimsJson,
  rejected_claims_hash AS rejectedClaimsHash,
  content_hash AS contentHash,
  created_at AS createdAt
FROM extraction_artifact`;

const FAILURE_SELECT = `SELECT
  extraction_failure_id AS extractionFailureId,
  spec_id AS specId,
  source_document_id AS sourceDocumentId,
  error_class AS errorClass,
  response_hash AS responseHash,
  response_byte_length AS responseByteLength,
  diagnostic_json AS diagnosticJson,
  diagnostic_hash AS diagnosticHash,
  content_hash AS contentHash,
  created_at AS createdAt
FROM extraction_failure`;

export function readExtractionSpec(
  contextInput: unknown,
  extractionSpecIdInput: unknown
): Result<ExtractionSpec | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const extractionSpecId = ExtractionSpecIdSchema.safeParse(extractionSpecIdInput);
    if (!extractionSpecId.success) {
      return err(persistenceFailure("Invalid extraction spec ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${SPEC_SELECT} WHERE extraction_spec_id = ?`)
      .get(extractionSpecId.data) as Parameters<typeof hydrateExtractionSpec>[0] | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    return hydrateExtractionSpec(row);
  } catch {
    return err(persistenceFailure("Extraction spec read failed"));
  }
}

export function readExtractionSpecByContentHash(
  contextInput: unknown,
  contentHashInput: unknown
): Result<ExtractionSpec | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const contentHash = Sha256HexSchema.safeParse(contentHashInput);
    if (!contentHash.success) {
      return err(persistenceFailure("Invalid extraction spec content hash"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${SPEC_SELECT} WHERE content_hash = ?`)
      .get(contentHash.data) as Parameters<typeof hydrateExtractionSpec>[0] | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    return hydrateExtractionSpec(row);
  } catch {
    return err(persistenceFailure("Extraction spec read failed"));
  }
}

export function readExtractionArtifact(
  contextInput: unknown,
  extractionArtifactIdInput: unknown
): Result<ExtractionArtifact | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const extractionArtifactId = ExtractionArtifactIdSchema.safeParse(
      extractionArtifactIdInput
    );
    if (!extractionArtifactId.success) {
      return err(persistenceFailure("Invalid extraction artifact ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${ARTIFACT_SELECT} WHERE extraction_artifact_id = ?`)
      .get(extractionArtifactId.data) as
      | Parameters<typeof hydrateExtractionArtifact>[0]
      | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    return hydrateExtractionArtifact(row);
  } catch {
    return err(persistenceFailure("Extraction artifact read failed"));
  }
}

export function readExtractionArtifactByContentHash(
  contextInput: unknown,
  contentHashInput: unknown
): Result<ExtractionArtifact | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const contentHash = Sha256HexSchema.safeParse(contentHashInput);
    if (!contentHash.success) {
      return err(persistenceFailure("Invalid extraction artifact content hash"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${ARTIFACT_SELECT} WHERE content_hash = ?`)
      .get(contentHash.data) as Parameters<typeof hydrateExtractionArtifact>[0] | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    return hydrateExtractionArtifact(row);
  } catch {
    return err(persistenceFailure("Extraction artifact read failed"));
  }
}

export function readExtractionFailure(
  contextInput: unknown,
  extractionFailureIdInput: unknown
): Result<ExtractionFailure | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const extractionFailureId = ExtractionFailureIdSchema.safeParse(
      extractionFailureIdInput
    );
    if (!extractionFailureId.success) {
      return err(persistenceFailure("Invalid extraction failure ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${FAILURE_SELECT} WHERE extraction_failure_id = ?`)
      .get(extractionFailureId.data) as
      | Parameters<typeof hydrateExtractionFailure>[0]
      | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    return hydrateExtractionFailure(row);
  } catch {
    return err(persistenceFailure("Extraction failure read failed"));
  }
}

export function readExtractionFailureByContentHash(
  contextInput: unknown,
  contentHashInput: unknown
): Result<ExtractionFailure | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const contentHash = Sha256HexSchema.safeParse(contentHashInput);
    if (!contentHash.success) {
      return err(persistenceFailure("Invalid extraction failure content hash"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${FAILURE_SELECT} WHERE content_hash = ?`)
      .get(contentHash.data) as Parameters<typeof hydrateExtractionFailure>[0] | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    return hydrateExtractionFailure(row);
  } catch {
    return err(persistenceFailure("Extraction failure read failed"));
  }
}

/**
 * Validates the extraction counters, hashes the dropped quotes, and freezes the
 * record before any writer lock is taken. Dropped quotes account for exactly
 * the spans the extractor returned but could not locate, which is the property
 * that makes the confidence resolution term reproducible from stored rows.
 */
export function prepareExtractionRun(
  draftInput: unknown
): Result<ExtractionRun, RuntimeError> {
  try {
    const draft = ExtractionRunDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid extraction run input"));
    }
    if (draft.data.spansLocated > draft.data.spansReturned) {
      return err(
        persistenceFailure("Extraction run located spans cannot exceed returned spans")
      );
    }
    if (
      draft.data.droppedQuotes.length !==
      draft.data.spansReturned - draft.data.spansLocated
    ) {
      return err(
        persistenceFailure(
          "Extraction run dropped quotes must account for every unlocated span"
        )
      );
    }

    const canonical = canonicalWithHash(
      draft.data.droppedQuotes,
      "Extraction run dropped quotes are not canonical JSON"
    );
    if (!canonical.ok) {
      return canonical;
    }

    const run = ExtractionRunSchema.parse({
      ...draft.data,
      droppedQuotesJson: canonical.value.json,
      droppedQuotesHash: canonical.value.hash
    });
    return ok(register(preparedExtractionRuns, run));
  } catch {
    return err(persistenceFailure("Extraction run preparation failed"));
  }
}

export function insertExtractionRun(
  contextInput: unknown,
  preparedInput: unknown
): Result<ExtractionRun, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<ExtractionRun>(
      preparedExtractionRuns,
      preparedInput,
      "Invalid prepared extraction run"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const run = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO extraction_run (
          extraction_run_id,
          spans_returned,
          spans_located,
          dropped_quotes_json,
          dropped_quotes_hash,
          model_id,
          fixture_key,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.extractionRunId,
        run.spansReturned,
        run.spansLocated,
        run.droppedQuotesJson,
        run.droppedQuotesHash,
        run.modelId,
        run.fixtureKey,
        run.createdAt
      );

    return ok(run);
  } catch {
    return err(persistenceFailure("Extraction run insert failed"));
  }
}

export function readExtractionRun(
  contextInput: unknown,
  extractionRunIdInput: unknown
): Result<ExtractionRun | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const extractionRunId = ExtractionRunIdSchema.safeParse(extractionRunIdInput);
    if (!extractionRunId.success) {
      return err(persistenceFailure("Invalid extraction run ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          extraction_run_id AS extractionRunId,
          spans_returned AS spansReturned,
          spans_located AS spansLocated,
          dropped_quotes_json AS droppedQuotesJson,
          dropped_quotes_hash AS droppedQuotesHash,
          model_id AS modelId,
          fixture_key AS fixtureKey,
          created_at AS createdAt
        FROM extraction_run
        WHERE extraction_run_id = ?`
      )
      .get(extractionRunId.data) as
      | Readonly<{ droppedQuotesJson: string; droppedQuotesHash: string }>
      | undefined;
    if (row === undefined) {
      return ok(undefined);
    }

    const decoded = decodeCanonicalJson(
      row.droppedQuotesJson,
      row.droppedQuotesHash,
      "Stored extraction run dropped quotes are not valid JSON",
      "Stored extraction run failed integrity validation"
    );
    if (!decoded.ok) {
      return decoded;
    }

    const run = ExtractionRunSchema.safeParse({
      ...row,
      droppedQuotes: decoded.value
    });
    if (!run.success) {
      return err(persistenceFailure("Stored extraction run is invalid"));
    }
    return ok(Object.freeze(run.data));
  } catch {
    return err(persistenceFailure("Extraction run read failed"));
  }
}
