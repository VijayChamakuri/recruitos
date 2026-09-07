import {
  ActorIdSchema,
  CandidateDocumentIdSchema,
  CandidateIdSchema,
  SourceDocumentIdSchema,
  err,
  isWellFormedUtf16,
  ok,
  sha256Hex,
  type Result
} from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  ActorDraftSchema,
  ActorSchema,
  CandidateDocumentDraftSchema,
  CandidateDocumentSchema,
  CandidateDraftSchema,
  CandidateSchema,
  MAXIMUM_NORMALIZED_DOCUMENT_BYTES,
  MAXIMUM_NORMALIZED_DOCUMENT_LENGTH,
  MAXIMUM_RAW_DOCUMENT_BYTES,
  SourceDocumentDraftSchema,
  SourceDocumentSchema,
  type Actor,
  type Candidate,
  type CandidateDocument,
  type SourceDocument
} from "./schemas.js";

const preparedActors = new WeakSet<object>();
const preparedCandidates = new WeakSet<object>();
const preparedSourceDocuments = new WeakSet<object>();
const preparedCandidateDocuments = new WeakSet<object>();

const utf8Encoder = new TextEncoder();

function persistenceFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function validateContext(
  contextInput: unknown
): Result<ImmediateTransactionContext, RuntimeError> {
  if (typeof contextInput !== "object" || contextInput === null) {
    return err(
      persistenceFailure("Immutable entities require an active command transaction")
    );
  }
  const context = contextInput as Partial<ImmediateTransactionContext>;
  if (
    typeof context.nativeDatabase !== "object" ||
    context.nativeDatabase === null ||
    context.nativeDatabase.inTransaction !== true
  ) {
    return err(
      persistenceFailure("Immutable entities require an active command transaction")
    );
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

export function prepareActor(draftInput: unknown): Result<Actor, RuntimeError> {
  try {
    const draft = ActorDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid actor input"));
    }
    const actor = ActorSchema.safeParse({
      actorId: draft.data.actorId,
      actorKind: "human",
      displayName: draft.data.displayName,
      createdAt: draft.data.createdAt
    });
    if (!actor.success) {
      return err(persistenceFailure("Invalid actor input"));
    }
    return ok(register(preparedActors, actor.data));
  } catch {
    return err(persistenceFailure("Actor preparation failed"));
  }
}

export function prepareCandidate(draftInput: unknown): Result<Candidate, RuntimeError> {
  try {
    const draft = CandidateDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid candidate input"));
    }
    const candidate = CandidateSchema.safeParse({ ...draft.data, isSynthetic: true });
    if (!candidate.success) {
      return err(persistenceFailure("Invalid candidate input"));
    }
    return ok(register(preparedCandidates, candidate.data));
  } catch {
    return err(persistenceFailure("Candidate preparation failed"));
  }
}

/**
 * Hashing and length accounting happen here so the writer lock only ever covers
 * the insert itself.
 */
export function prepareSourceDocument(
  draftInput: unknown
): Result<SourceDocument, RuntimeError> {
  try {
    const draft = SourceDocumentDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid source document input"));
    }
    if (
      !isWellFormedUtf16(draft.data.rawText) ||
      !isWellFormedUtf16(draft.data.normalizedText)
    ) {
      return err(persistenceFailure("Source document text is not well-formed UTF-16"));
    }

    const rawByteLength = utf8Encoder.encode(draft.data.rawText).length;
    const normalizedByteLength = utf8Encoder.encode(draft.data.normalizedText).length;
    if (rawByteLength > MAXIMUM_RAW_DOCUMENT_BYTES) {
      return err(persistenceFailure("Source document raw text exceeds the byte limit"));
    }
    if (normalizedByteLength > MAXIMUM_NORMALIZED_DOCUMENT_BYTES) {
      return err(
        persistenceFailure("Source document normalized text exceeds the byte limit")
      );
    }
    if (draft.data.normalizedText.length > MAXIMUM_NORMALIZED_DOCUMENT_LENGTH) {
      return err(
        persistenceFailure("Source document normalized text exceeds the length limit")
      );
    }

    const document = SourceDocumentSchema.safeParse({
      sourceDocumentId: draft.data.sourceDocumentId,
      rawText: draft.data.rawText,
      rawHash: sha256Hex(draft.data.rawText),
      rawByteLength,
      normalizedText: draft.data.normalizedText,
      normalizedHash: sha256Hex(draft.data.normalizedText),
      normalizedLength: draft.data.normalizedText.length,
      normalizedByteLength,
      createdAt: draft.data.createdAt
    });
    if (!document.success) {
      return err(persistenceFailure("Invalid source document input"));
    }
    return ok(register(preparedSourceDocuments, document.data));
  } catch {
    return err(persistenceFailure("Source document preparation failed"));
  }
}

export function prepareCandidateDocument(
  draftInput: unknown
): Result<CandidateDocument, RuntimeError> {
  try {
    const draft = CandidateDocumentDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid candidate document input"));
    }
    return ok(register(preparedCandidateDocuments, draft.data));
  } catch {
    return err(persistenceFailure("Candidate document preparation failed"));
  }
}

export function insertActor(
  contextInput: unknown,
  preparedInput: unknown
): Result<Actor, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<Actor>(
      preparedActors,
      preparedInput,
      "Invalid prepared actor"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const actor = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO actor (
          actor_id,
          actor_kind,
          display_name,
          created_at
        ) VALUES (?, ?, ?, ?)`
      )
      .run(actor.actorId, actor.actorKind, actor.displayName, actor.createdAt);

    return ok(actor);
  } catch {
    return err(persistenceFailure("Actor insert failed"));
  }
}

export function insertCandidate(
  contextInput: unknown,
  preparedInput: unknown
): Result<Candidate, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<Candidate>(
      preparedCandidates,
      preparedInput,
      "Invalid prepared candidate"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const candidate = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO candidate (
          candidate_id,
          source_system,
          source_key,
          channel,
          corpus_tag,
          is_synthetic,
          created_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        candidate.candidateId,
        candidate.sourceSystem,
        candidate.sourceKey,
        candidate.channel,
        candidate.corpusTag,
        candidate.createdAt
      );

    return ok(candidate);
  } catch {
    return err(persistenceFailure("Candidate insert failed"));
  }
}

export function insertSourceDocument(
  contextInput: unknown,
  preparedInput: unknown
): Result<SourceDocument, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<SourceDocument>(
      preparedSourceDocuments,
      preparedInput,
      "Invalid prepared source document"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const document = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO source_document (
          source_document_id,
          raw_text,
          raw_hash,
          raw_byte_length,
          normalized_text,
          normalized_hash,
          normalized_length,
          normalized_byte_length,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        document.sourceDocumentId,
        document.rawText,
        document.rawHash,
        document.rawByteLength,
        document.normalizedText,
        document.normalizedHash,
        document.normalizedLength,
        document.normalizedByteLength,
        document.createdAt
      );

    return ok(document);
  } catch {
    return err(persistenceFailure("Source document insert failed"));
  }
}

export function insertCandidateDocument(
  contextInput: unknown,
  preparedInput: unknown
): Result<CandidateDocument, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<CandidateDocument>(
      preparedCandidateDocuments,
      preparedInput,
      "Invalid prepared candidate document"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const document = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO candidate_document (
          candidate_document_id,
          candidate_id,
          source_document_id,
          document_kind,
          label,
          document_ordinal,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        document.candidateDocumentId,
        document.candidateId,
        document.sourceDocumentId,
        document.documentKind,
        document.label,
        document.documentOrdinal,
        document.createdAt
      );

    return ok(document);
  } catch {
    return err(persistenceFailure("Candidate document insert failed"));
  }
}

export function readActor(
  contextInput: unknown,
  actorIdInput: unknown
): Result<Actor | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const actorId = ActorIdSchema.safeParse(actorIdInput);
    if (!actorId.success) {
      return err(persistenceFailure("Invalid actor ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          actor_id AS actorId,
          actor_kind AS actorKind,
          display_name AS displayName,
          created_at AS createdAt
        FROM actor
        WHERE actor_id = ?`
      )
      .get(actorId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const actor = ActorSchema.safeParse(row);
    if (!actor.success) {
      return err(persistenceFailure("Stored actor is invalid"));
    }
    return ok(Object.freeze(actor.data));
  } catch {
    return err(persistenceFailure("Actor read failed"));
  }
}

export function readCandidate(
  contextInput: unknown,
  candidateIdInput: unknown
): Result<Candidate | undefined, RuntimeError> {
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
      .prepare(
        `SELECT
          candidate_id AS candidateId,
          source_system AS sourceSystem,
          source_key AS sourceKey,
          channel,
          corpus_tag AS corpusTag,
          is_synthetic AS isSynthetic,
          created_at AS createdAt
        FROM candidate
        WHERE candidate_id = ?`
      )
      .get(candidateId.data) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    const candidate = CandidateSchema.safeParse({
      ...row,
      isSynthetic: row["isSynthetic"] === 1
    });
    if (!candidate.success) {
      return err(persistenceFailure("Stored candidate is invalid"));
    }
    return ok(Object.freeze(candidate.data));
  } catch {
    return err(persistenceFailure("Candidate read failed"));
  }
}

export function readSourceDocument(
  contextInput: unknown,
  sourceDocumentIdInput: unknown
): Result<SourceDocument | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const sourceDocumentId = SourceDocumentIdSchema.safeParse(sourceDocumentIdInput);
    if (!sourceDocumentId.success) {
      return err(persistenceFailure("Invalid source document ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          source_document_id AS sourceDocumentId,
          raw_text AS rawText,
          raw_hash AS rawHash,
          raw_byte_length AS rawByteLength,
          normalized_text AS normalizedText,
          normalized_hash AS normalizedHash,
          normalized_length AS normalizedLength,
          normalized_byte_length AS normalizedByteLength,
          created_at AS createdAt
        FROM source_document
        WHERE source_document_id = ?`
      )
      .get(sourceDocumentId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const document = SourceDocumentSchema.safeParse(row);
    if (!document.success) {
      return err(persistenceFailure("Stored source document is invalid"));
    }
    if (
      !isWellFormedUtf16(document.data.rawText) ||
      !isWellFormedUtf16(document.data.normalizedText) ||
      sha256Hex(document.data.rawText) !== document.data.rawHash ||
      sha256Hex(document.data.normalizedText) !== document.data.normalizedHash ||
      utf8Encoder.encode(document.data.rawText).length !== document.data.rawByteLength ||
      utf8Encoder.encode(document.data.normalizedText).length !==
        document.data.normalizedByteLength
    ) {
      return err(persistenceFailure("Stored source document failed integrity validation"));
    }
    return ok(Object.freeze(document.data));
  } catch {
    return err(persistenceFailure("Source document read failed"));
  }
}

export function readCandidateDocument(
  contextInput: unknown,
  candidateDocumentIdInput: unknown
): Result<CandidateDocument | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const candidateDocumentId = CandidateDocumentIdSchema.safeParse(
      candidateDocumentIdInput
    );
    if (!candidateDocumentId.success) {
      return err(persistenceFailure("Invalid candidate document ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          candidate_document_id AS candidateDocumentId,
          candidate_id AS candidateId,
          source_document_id AS sourceDocumentId,
          document_kind AS documentKind,
          label,
          document_ordinal AS documentOrdinal,
          created_at AS createdAt
        FROM candidate_document
        WHERE candidate_document_id = ?`
      )
      .get(candidateDocumentId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const document = CandidateDocumentSchema.safeParse(row);
    if (!document.success) {
      return err(persistenceFailure("Stored candidate document is invalid"));
    }
    return ok(Object.freeze(document.data));
  } catch {
    return err(persistenceFailure("Candidate document read failed"));
  }
}
