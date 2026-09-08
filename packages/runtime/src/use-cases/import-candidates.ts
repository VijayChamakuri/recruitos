import {
  err,
  normalizeSourceText,
  ok,
  sha256Hex,
  type Result
} from "@recruitos/core";
import { z } from "zod";

import type {
  CandidateSourceDocument,
  CandidateSourceRecord,
  StructuredApplicationAnswer
} from "../adapters/index.js";
import {
  insertCandidateApplicationAnswer,
  prepareCandidateApplicationAnswer
} from "../application-answers/index.js";
import type { ImmediateTransactionContext } from "../commands/index.js";
import type { RuntimeComposition } from "../composition/index.js";
import {
  CandidateChannelSchema,
  CorpusTagSchema,
  DocumentKindSchema,
  insertCandidate,
  insertCandidateDocument,
  insertSourceDocument,
  prepareCandidate,
  prepareCandidateDocument,
  prepareSourceDocument,
  type CorpusTag
} from "../entities/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import { runUseCaseCommand, type UseCaseResult } from "./contract.js";

/**
 * Import candidates from the configured candidate source into persistence.
 *
 * The source hands over each candidate's documents and, separately, the
 * structured application answers the form collected. This use case normalizes
 * every document with the frozen text policy, then in one command transaction
 * inserts the candidate, its source documents, the candidate-document links,
 * and any structured application answer. It never writes a `candidate_head`:
 * that row requires a `current_result_id` and is born at finalize.
 *
 * Import is additive and idempotent per record. A candidate whose
 * `(source_system, source_key)` pair already exists is skipped, not
 * reinserted. Identical raw document bytes are stored once and reused across
 * candidates through the `source_document.raw_hash` unique index.
 *
 * Adapter I/O happens before the writer lock is taken. The transaction only
 * covers the inserts.
 */

export const IMPORT_CANDIDATES_COMMAND_NAME = "candidate.import";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAXIMUM_CANDIDATES = 1000;
const WORK_AUTHORIZATION_QUESTION_KEY = "work_authorization";

export type ImportCandidatesInput = Readonly<{
  /** Actor the import command is recorded against. */
  actorId: string;
  /** Corpus the imported candidates belong to. Defaults to `main`. */
  corpusTag?: CorpusTag;
  /** Candidates requested per source page. Defaults to 100. */
  pageSize?: number;
  /** Hard cap on candidates read in one import. Defaults to 1000. */
  maximumCandidates?: number;
}>;

export type ImportCandidatesResult = Readonly<{
  imported: number;
  skipped: number;
  candidateIds: readonly string[];
}>;

const ImportCandidatesPayloadSchema = z
  .object({
    sourceSystem: z.string().min(1),
    corpusTag: CorpusTagSchema,
    sourceKeys: z.array(z.string().min(1))
  })
  .strict();

const ImportCandidatesResultSchema = z
  .object({
    imported: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    candidateIds: z.array(z.string().min(1))
  })
  .strict();

type ResolvedDocument = Readonly<{
  rawText: string;
  rawHash: string;
  normalizedText: string;
  documentKind: string;
  label: string;
  documentOrdinal: number;
}>;

type ResolvedRecord = Readonly<{
  sourceKey: string;
  channel: string;
  documents: readonly ResolvedDocument[];
  workAuthorization: StructuredApplicationAnswer | undefined;
}>;

function importFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveDocument(
  document: CandidateSourceDocument
): Result<ResolvedDocument, RuntimeError> {
  const normalized = normalizeSourceText(document.rawText);
  if (!normalized.ok) {
    return err(importFailure(`Candidate document text is invalid: ${normalized.error.message}`));
  }
  return ok({
    rawText: document.rawText,
    rawHash: sha256Hex(document.rawText),
    normalizedText: normalized.value.normalizedText,
    documentKind: document.documentKind,
    label: document.label,
    documentOrdinal: document.documentOrdinal
  });
}

function resolveRecord(
  record: CandidateSourceRecord
): Result<ResolvedRecord, RuntimeError> {
  if (record.documents.length === 0) {
    return err(importFailure("Candidate record carries no documents"));
  }
  const documents: ResolvedDocument[] = [];
  for (const document of record.documents) {
    const resolved = resolveDocument(document);
    if (!resolved.ok) {
      return resolved;
    }
    documents.push(resolved.value);
  }
  return ok({
    sourceKey: record.sourceKey,
    channel: record.channel,
    documents,
    workAuthorization: record.applicationAnswers.workAuthorization
  });
}

async function collectRecords(
  composition: RuntimeComposition,
  pageSize: number,
  maximumCandidates: number
): Promise<Result<{ sourceSystem: string; records: readonly ResolvedRecord[] }, RuntimeError>> {
  const records: ResolvedRecord[] = [];

  const firstPage = await composition.candidateSource.listCandidates({
    cursor: undefined,
    limit: pageSize
  });
  if (!firstPage.ok) {
    return firstPage;
  }
  const sourceSystem = firstPage.value.descriptor.sourceSystem;
  let page = firstPage.value;

  for (;;) {
    for (const record of page.records) {
      const resolved = resolveRecord(record);
      if (!resolved.ok) {
        return resolved;
      }
      records.push(resolved.value);
      if (records.length > maximumCandidates) {
        return err(importFailure("Candidate source exceeded the import limit"));
      }
    }
    if (page.nextCursor === undefined) {
      return ok({ sourceSystem, records });
    }
    const nextPage = await composition.candidateSource.listCandidates({
      cursor: page.nextCursor,
      limit: pageSize
    });
    if (!nextPage.ok) {
      return nextPage;
    }
    page = nextPage.value;
  }
}

function candidateExists(
  context: ImmediateTransactionContext,
  sourceSystem: string,
  sourceKey: string
): boolean {
  const row = context.nativeDatabase
    .prepare(
      `SELECT 1 AS present
       FROM candidate
       WHERE source_system = ? AND source_key = ?
       LIMIT 1`
    )
    .get(sourceSystem, sourceKey);
  return row !== undefined;
}

function existingSourceDocumentId(
  context: ImmediateTransactionContext,
  rawHash: string
): string | undefined {
  const row = context.nativeDatabase
    .prepare(
      `SELECT source_document_id AS id
       FROM source_document
       WHERE raw_hash = ?
       LIMIT 1`
    )
    .get(rawHash) as { id: string } | undefined;
  return row?.id;
}

function insertOneDocument(
  context: ImmediateTransactionContext,
  composition: RuntimeComposition,
  candidateId: string,
  document: ResolvedDocument,
  createdAt: number
): Result<void, RuntimeError> {
  let sourceDocumentId = existingSourceDocumentId(context, document.rawHash);
  if (sourceDocumentId === undefined) {
    const prepared = prepareSourceDocument({
      sourceDocumentId: composition.idGenerator.next(),
      rawText: document.rawText,
      normalizedText: document.normalizedText,
      createdAt
    });
    if (!prepared.ok) {
      return prepared;
    }
    const inserted = insertSourceDocument(context, prepared.value);
    if (!inserted.ok) {
      return inserted;
    }
    sourceDocumentId = inserted.value.sourceDocumentId;
  }

  const kind = DocumentKindSchema.safeParse(document.documentKind);
  if (!kind.success) {
    return err(importFailure(`Unknown candidate document kind: ${document.documentKind}`));
  }
  const preparedLink = prepareCandidateDocument({
    candidateDocumentId: composition.idGenerator.next(),
    candidateId,
    sourceDocumentId,
    documentKind: kind.data,
    label: document.label,
    documentOrdinal: document.documentOrdinal,
    createdAt
  });
  if (!preparedLink.ok) {
    return preparedLink;
  }
  const linked = insertCandidateDocument(context, preparedLink.value);
  if (!linked.ok) {
    return linked;
  }
  return ok(undefined);
}

function insertWorkAuthorization(
  context: ImmediateTransactionContext,
  composition: RuntimeComposition,
  candidateId: string,
  answer: StructuredApplicationAnswer,
  createdAt: number
): Result<void, RuntimeError> {
  const prepared = prepareCandidateApplicationAnswer({
    candidateApplicationAnswerId: composition.idGenerator.next(),
    candidateId,
    questionKey: WORK_AUTHORIZATION_QUESTION_KEY,
    selectedOptionKey: answer.selectedOptionKey,
    freeText: answer.freeText ?? null,
    collectedBy: answer.provenance.collectedBy,
    formId: answer.provenance.formId,
    questionId: answer.provenance.questionId,
    collectedAt: answer.provenance.collectedAt,
    createdAt
  });
  if (!prepared.ok) {
    return prepared;
  }
  const inserted = insertCandidateApplicationAnswer(context, prepared.value);
  if (!inserted.ok) {
    return inserted;
  }
  return ok(undefined);
}

function importOne(
  context: ImmediateTransactionContext,
  composition: RuntimeComposition,
  sourceSystem: string,
  corpusTag: CorpusTag,
  record: ResolvedRecord,
  createdAt: number
): Result<string | undefined, RuntimeError> {
  if (candidateExists(context, sourceSystem, record.sourceKey)) {
    return ok(undefined);
  }

  const channel = CandidateChannelSchema.safeParse(record.channel);
  if (!channel.success) {
    return err(importFailure(`Unknown candidate channel: ${record.channel}`));
  }

  const candidateId = composition.idGenerator.next();
  const preparedCandidate = prepareCandidate({
    candidateId,
    sourceSystem,
    sourceKey: record.sourceKey,
    channel: channel.data,
    corpusTag,
    createdAt
  });
  if (!preparedCandidate.ok) {
    return preparedCandidate;
  }
  const insertedCandidate = insertCandidate(context, preparedCandidate.value);
  if (!insertedCandidate.ok) {
    return insertedCandidate;
  }

  for (const document of record.documents) {
    const wrote = insertOneDocument(context, composition, candidateId, document, createdAt);
    if (!wrote.ok) {
      return wrote;
    }
  }

  if (record.workAuthorization !== undefined) {
    const wrote = insertWorkAuthorization(
      context,
      composition,
      candidateId,
      record.workAuthorization,
      createdAt
    );
    if (!wrote.ok) {
      return wrote;
    }
  }

  return ok(candidateId);
}

export async function importCandidates(
  composition: RuntimeComposition,
  input: ImportCandidatesInput
): Promise<UseCaseResult<ImportCandidatesResult>> {
  if (!isObject(composition) || !isObject(composition.candidateSource)) {
    return err(importFailure("Invalid runtime composition"));
  }
  if (!isObject(input) || typeof input.actorId !== "string" || input.actorId.length === 0) {
    return err(importFailure("Import requires an actor id"));
  }

  const corpusTag = input.corpusTag ?? "main";
  if (!CorpusTagSchema.safeParse(corpusTag).success) {
    return err(importFailure("Invalid corpus tag"));
  }
  const pageSize =
    input.pageSize === undefined ? DEFAULT_PAGE_SIZE : input.pageSize;
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    return err(importFailure("Page size must be a positive integer"));
  }
  const maximumCandidates =
    input.maximumCandidates === undefined
      ? DEFAULT_MAXIMUM_CANDIDATES
      : input.maximumCandidates;
  if (!Number.isInteger(maximumCandidates) || maximumCandidates <= 0) {
    return err(importFailure("Maximum candidates must be a positive integer"));
  }

  const collected = await collectRecords(composition, pageSize, maximumCandidates);
  if (!collected.ok) {
    return collected;
  }
  const { sourceSystem, records } = collected.value;
  const createdAt = composition.clock.now();

  return runUseCaseCommand(composition, {
    actorId: input.actorId,
    commandName: IMPORT_CANDIDATES_COMMAND_NAME,
    expectedVersion: 0,
    payload: {
      sourceSystem,
      corpusTag,
      sourceKeys: records.map((record) => record.sourceKey)
    },
    payloadSchema: ImportCandidatesPayloadSchema,
    resultSchema: ImportCandidatesResultSchema,
    readVersion: () => ok(0),
    mutate: (context) => {
      const candidateIds: string[] = [];
      let skipped = 0;
      for (const record of records) {
        const outcome = importOne(
          context,
          composition,
          sourceSystem,
          corpusTag,
          record,
          createdAt
        );
        if (!outcome.ok) {
          return outcome;
        }
        if (outcome.value === undefined) {
          skipped += 1;
          continue;
        }
        candidateIds.push(outcome.value);
      }
      return ok({ imported: candidateIds.length, skipped, candidateIds });
    }
  });
}
