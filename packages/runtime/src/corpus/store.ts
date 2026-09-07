import {
  CorpusManifestIdSchema,
  CorpusManifestSealIdSchema,
  CorpusMemberDocumentIdSchema,
  CorpusMemberIdSchema,
  canonicalJsonSha256,
  err,
  ok,
  type Result
} from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  CorpusManifestContentSchema,
  CorpusManifestDraftSchema,
  CorpusManifestSchema,
  CorpusManifestSealDraftSchema,
  CorpusManifestSealSchema,
  CorpusMemberDocumentDraftSchema,
  CorpusMemberDocumentSchema,
  CorpusMemberDraftSchema,
  CorpusMemberSchema,
  MAIN_DEMO_CORPUS_MEMBER_COUNT,
  type CorpusManifest,
  type CorpusManifestContent,
  type CorpusManifestSeal,
  type CorpusMember,
  type CorpusMemberDocument
} from "./schemas.js";

const preparedCorpusManifests = new WeakSet<object>();
const preparedCorpusMembers = new WeakSet<object>();
const preparedCorpusMemberDocuments = new WeakSet<object>();
const preparedCorpusManifestSeals = new WeakSet<object>();

function persistenceFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function validateContext(
  contextInput: unknown
): Result<ImmediateTransactionContext, RuntimeError> {
  if (typeof contextInput !== "object" || contextInput === null) {
    return err(
      persistenceFailure("Corpus manifests require an active command transaction")
    );
  }
  const context = contextInput as Partial<ImmediateTransactionContext>;
  if (
    typeof context.nativeDatabase !== "object" ||
    context.nativeDatabase === null ||
    context.nativeDatabase.inTransaction !== true
  ) {
    return err(
      persistenceFailure("Corpus manifests require an active command transaction")
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

/**
 * Validates contiguous ordinals, document cardinality, uniqueness, and the
 * main-demo size rule before any writer lock is taken. The seal trigger
 * re-checks the same structural rules at commit.
 */
export function validateCorpusManifestContent(
  contentInput: unknown
): Result<CorpusManifestContent, RuntimeError> {
  const content = CorpusManifestContentSchema.safeParse(contentInput);
  if (!content.success) {
    return err(persistenceFailure("Invalid corpus manifest content"));
  }

  const { kind, members } = content.data;
  if (kind === "main" && members.length !== MAIN_DEMO_CORPUS_MEMBER_COUNT) {
    return err(
      persistenceFailure(
        `Main corpus manifests require exactly ${MAIN_DEMO_CORPUS_MEMBER_COUNT} members`
      )
    );
  }

  const candidateIds = new Set<string>();
  const importOrdinals = members.map((member) => member.importOrdinal).sort((a, b) => a - b);
  if (importOrdinals[0] !== 0) {
    return err(persistenceFailure("Corpus member import ordinals must start at 0"));
  }
  for (let index = 0; index < importOrdinals.length; index += 1) {
    if (importOrdinals[index] !== index) {
      return err(
        persistenceFailure("Corpus member import ordinals must be contiguous")
      );
    }
  }

  for (const member of members) {
    if (candidateIds.has(member.candidateId)) {
      return err(persistenceFailure("Corpus members must use unique candidate IDs"));
    }
    candidateIds.add(member.candidateId);

    const documentIds = new Set<string>();
    const documentOrdinals = member.documents
      .map((document) => document.documentOrdinal)
      .sort((a, b) => a - b);
    if (documentOrdinals[0] !== 0) {
      return err(
        persistenceFailure("Corpus member document ordinals must start at 0")
      );
    }
    for (let index = 0; index < documentOrdinals.length; index += 1) {
      if (documentOrdinals[index] !== index) {
        return err(
          persistenceFailure("Corpus member document ordinals must be contiguous")
        );
      }
    }
    for (const document of member.documents) {
      if (documentIds.has(document.candidateDocumentId)) {
        return err(
          persistenceFailure("Corpus member documents must use unique candidate documents")
        );
      }
      documentIds.add(document.candidateDocumentId);
    }
  }

  return ok(content.data);
}

/**
 * Builds the content-addressed hash outside the writer lock. Members are sorted
 * by import ordinal and documents by document ordinal so authoring order cannot
 * change the hash.
 */
export function hashCorpusManifestContent(
  contentInput: unknown
): Result<string, RuntimeError> {
  const content = validateCorpusManifestContent(contentInput);
  if (!content.ok) {
    return content;
  }

  const ordered = {
    kind: content.value.kind,
    members: [...content.value.members]
      .sort((left, right) => left.importOrdinal - right.importOrdinal)
      .map((member) => ({
        candidateId: member.candidateId,
        importOrdinal: member.importOrdinal,
        documents: [...member.documents]
          .sort((left, right) => left.documentOrdinal - right.documentOrdinal)
          .map((document) => ({
            candidateDocumentId: document.candidateDocumentId,
            documentOrdinal: document.documentOrdinal
          }))
      }))
  };

  const hashed = canonicalJsonSha256(ordered);
  if (!hashed.ok) {
    return err(persistenceFailure("Corpus manifest content hashing failed"));
  }
  return ok(hashed.value);
}

/**
 * Hashing and structural validation happen here so the writer lock only covers
 * the insert itself.
 */
export function prepareCorpusManifest(
  draftInput: unknown
): Result<CorpusManifest, RuntimeError> {
  try {
    const draft = CorpusManifestDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid corpus manifest input"));
    }

    const contentHash = hashCorpusManifestContent(draft.data.content);
    if (!contentHash.ok) {
      return contentHash;
    }

    const manifest = CorpusManifestSchema.parse({
      corpusManifestId: draft.data.corpusManifestId,
      kind: draft.data.kind,
      contentHash: contentHash.value,
      sealId: draft.data.sealId,
      createdAt: draft.data.createdAt
    });
    return ok(register(preparedCorpusManifests, manifest));
  } catch {
    return err(persistenceFailure("Corpus manifest preparation failed"));
  }
}

export function prepareCorpusMember(
  draftInput: unknown
): Result<CorpusMember, RuntimeError> {
  try {
    const draft = CorpusMemberDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid corpus member input"));
    }
    return ok(register(preparedCorpusMembers, draft.data));
  } catch {
    return err(persistenceFailure("Corpus member preparation failed"));
  }
}

export function prepareCorpusMemberDocument(
  draftInput: unknown
): Result<CorpusMemberDocument, RuntimeError> {
  try {
    const draft = CorpusMemberDocumentDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid corpus member document input"));
    }
    return ok(register(preparedCorpusMemberDocuments, draft.data));
  } catch {
    return err(persistenceFailure("Corpus member document preparation failed"));
  }
}

export function prepareCorpusManifestSeal(
  draftInput: unknown
): Result<CorpusManifestSeal, RuntimeError> {
  try {
    const draft = CorpusManifestSealDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid corpus manifest seal input"));
    }
    return ok(register(preparedCorpusManifestSeals, draft.data));
  } catch {
    return err(persistenceFailure("Corpus manifest seal preparation failed"));
  }
}

export function insertCorpusManifest(
  contextInput: unknown,
  preparedInput: unknown
): Result<CorpusManifest, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<CorpusManifest>(
      preparedCorpusManifests,
      preparedInput,
      "Invalid prepared corpus manifest"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const manifest = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO corpus_manifest (
          corpus_manifest_id,
          kind,
          content_hash,
          seal_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        manifest.corpusManifestId,
        manifest.kind,
        manifest.contentHash,
        manifest.sealId,
        manifest.createdAt
      );

    return ok(manifest);
  } catch {
    return err(persistenceFailure("Corpus manifest insert failed"));
  }
}

export function insertCorpusMember(
  contextInput: unknown,
  preparedInput: unknown
): Result<CorpusMember, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<CorpusMember>(
      preparedCorpusMembers,
      preparedInput,
      "Invalid prepared corpus member"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const member = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO corpus_member (
          corpus_member_id,
          manifest_id,
          candidate_id,
          import_ordinal,
          created_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        member.corpusMemberId,
        member.manifestId,
        member.candidateId,
        member.importOrdinal,
        member.createdAt
      );

    return ok(member);
  } catch {
    return err(persistenceFailure("Corpus member insert failed"));
  }
}

export function insertCorpusMemberDocument(
  contextInput: unknown,
  preparedInput: unknown
): Result<CorpusMemberDocument, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<CorpusMemberDocument>(
      preparedCorpusMemberDocuments,
      preparedInput,
      "Invalid prepared corpus member document"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const document = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO corpus_member_document (
          corpus_member_document_id,
          corpus_member_id,
          candidate_document_id,
          document_ordinal,
          created_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        document.corpusMemberDocumentId,
        document.corpusMemberId,
        document.candidateDocumentId,
        document.documentOrdinal,
        document.createdAt
      );

    return ok(document);
  } catch {
    return err(persistenceFailure("Corpus member document insert failed"));
  }
}

function readManifestContentFromDatabase(
  context: ImmediateTransactionContext,
  manifestId: string,
  kind: string
): Result<CorpusManifestContent, RuntimeError> {
  const memberRows = context.nativeDatabase
    .prepare(
      `SELECT
        corpus_member_id AS corpusMemberId,
        candidate_id AS candidateId,
        import_ordinal AS importOrdinal
      FROM corpus_member
      WHERE manifest_id = ?
      ORDER BY import_ordinal ASC`
    )
    .all(manifestId) as ReadonlyArray<{
    corpusMemberId: string;
    candidateId: string;
    importOrdinal: number;
  }>;

  const members = [];
  for (const member of memberRows) {
    const documentRows = context.nativeDatabase
      .prepare(
        `SELECT
          candidate_document_id AS candidateDocumentId,
          document_ordinal AS documentOrdinal
        FROM corpus_member_document
        WHERE corpus_member_id = ?
        ORDER BY document_ordinal ASC`
      )
      .all(member.corpusMemberId) as ReadonlyArray<{
      candidateDocumentId: string;
      documentOrdinal: number;
    }>;

    members.push({
      candidateId: member.candidateId,
      importOrdinal: member.importOrdinal,
      documents: documentRows.map((document) => ({
        candidateDocumentId: document.candidateDocumentId,
        documentOrdinal: document.documentOrdinal
      }))
    });
  }

  return validateCorpusManifestContent({ kind, members });
}

/**
 * Seal insert is the commit-time completeness proof: SQL triggers enforce
 * contiguous ordinals and main size, and this function proves the stored
 * relational rows still hash to the manifest's content hash.
 */
export function insertCorpusManifestSeal(
  contextInput: unknown,
  preparedInput: unknown
): Result<CorpusManifestSeal, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<CorpusManifestSeal>(
      preparedCorpusManifestSeals,
      preparedInput,
      "Invalid prepared corpus manifest seal"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const seal = prepared.value;

    const manifestRow = context.value.nativeDatabase
      .prepare(
        `SELECT
          kind,
          content_hash AS contentHash,
          seal_id AS sealId
        FROM corpus_manifest
        WHERE corpus_manifest_id = ?`
      )
      .get(seal.manifestId) as
      | { kind: string; contentHash: string; sealId: string }
      | undefined;
    if (manifestRow === undefined) {
      return err(persistenceFailure("Corpus manifest seal requires a stored manifest"));
    }
    if (manifestRow.sealId !== seal.corpusManifestSealId) {
      return err(
        persistenceFailure("Corpus manifest seal ID does not match the manifest seal_id")
      );
    }

    const content = readManifestContentFromDatabase(
      context.value,
      seal.manifestId,
      manifestRow.kind
    );
    if (!content.ok) {
      return content;
    }
    const contentHash = hashCorpusManifestContent(content.value);
    if (!contentHash.ok) {
      return contentHash;
    }
    if (contentHash.value !== manifestRow.contentHash) {
      return err(
        persistenceFailure(
          "Corpus manifest relational rows do not match the content hash"
        )
      );
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO corpus_manifest_seal (
          corpus_manifest_seal_id,
          manifest_id,
          created_at
        ) VALUES (?, ?, ?)`
      )
      .run(seal.corpusManifestSealId, seal.manifestId, seal.createdAt);

    return ok(seal);
  } catch {
    return err(persistenceFailure("Corpus manifest seal insert failed"));
  }
}

export function readCorpusManifest(
  contextInput: unknown,
  corpusManifestIdInput: unknown
): Result<CorpusManifest | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const corpusManifestId = CorpusManifestIdSchema.safeParse(corpusManifestIdInput);
    if (!corpusManifestId.success) {
      return err(persistenceFailure("Invalid corpus manifest ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          corpus_manifest_id AS corpusManifestId,
          kind,
          content_hash AS contentHash,
          seal_id AS sealId,
          created_at AS createdAt
        FROM corpus_manifest
        WHERE corpus_manifest_id = ?`
      )
      .get(corpusManifestId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const manifest = CorpusManifestSchema.safeParse(row);
    if (!manifest.success) {
      return err(persistenceFailure("Stored corpus manifest is invalid"));
    }
    return ok(Object.freeze(manifest.data));
  } catch {
    return err(persistenceFailure("Corpus manifest read failed"));
  }
}

export function readCorpusMember(
  contextInput: unknown,
  corpusMemberIdInput: unknown
): Result<CorpusMember | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const corpusMemberId = CorpusMemberIdSchema.safeParse(corpusMemberIdInput);
    if (!corpusMemberId.success) {
      return err(persistenceFailure("Invalid corpus member ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          corpus_member_id AS corpusMemberId,
          manifest_id AS manifestId,
          candidate_id AS candidateId,
          import_ordinal AS importOrdinal,
          created_at AS createdAt
        FROM corpus_member
        WHERE corpus_member_id = ?`
      )
      .get(corpusMemberId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const member = CorpusMemberSchema.safeParse(row);
    if (!member.success) {
      return err(persistenceFailure("Stored corpus member is invalid"));
    }
    return ok(Object.freeze(member.data));
  } catch {
    return err(persistenceFailure("Corpus member read failed"));
  }
}

export function readCorpusMemberDocument(
  contextInput: unknown,
  corpusMemberDocumentIdInput: unknown
): Result<CorpusMemberDocument | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const corpusMemberDocumentId = CorpusMemberDocumentIdSchema.safeParse(
      corpusMemberDocumentIdInput
    );
    if (!corpusMemberDocumentId.success) {
      return err(persistenceFailure("Invalid corpus member document ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          corpus_member_document_id AS corpusMemberDocumentId,
          corpus_member_id AS corpusMemberId,
          candidate_document_id AS candidateDocumentId,
          document_ordinal AS documentOrdinal,
          created_at AS createdAt
        FROM corpus_member_document
        WHERE corpus_member_document_id = ?`
      )
      .get(corpusMemberDocumentId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const document = CorpusMemberDocumentSchema.safeParse(row);
    if (!document.success) {
      return err(persistenceFailure("Stored corpus member document is invalid"));
    }
    return ok(Object.freeze(document.data));
  } catch {
    return err(persistenceFailure("Corpus member document read failed"));
  }
}

export function readCorpusManifestSeal(
  contextInput: unknown,
  corpusManifestSealIdInput: unknown
): Result<CorpusManifestSeal | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const corpusManifestSealId = CorpusManifestSealIdSchema.safeParse(
      corpusManifestSealIdInput
    );
    if (!corpusManifestSealId.success) {
      return err(persistenceFailure("Invalid corpus manifest seal ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          corpus_manifest_seal_id AS corpusManifestSealId,
          manifest_id AS manifestId,
          created_at AS createdAt
        FROM corpus_manifest_seal
        WHERE corpus_manifest_seal_id = ?`
      )
      .get(corpusManifestSealId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const seal = CorpusManifestSealSchema.safeParse(row);
    if (!seal.success) {
      return err(persistenceFailure("Stored corpus manifest seal is invalid"));
    }
    return ok(Object.freeze(seal.data));
  } catch {
    return err(persistenceFailure("Corpus manifest seal read failed"));
  }
}
