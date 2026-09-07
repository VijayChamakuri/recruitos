import {
  DimensionAssessmentEvidenceSpanIdSchema,
  DimensionAssessmentIdSchema,
  EvidenceGapIdSchema,
  EvidenceSpanIdSchema,
  ExtractionRunIdSchema,
  canonicalJsonStringify,
  err,
  formatReasonCode,
  ok,
  parseReasonCode,
  sha256Hex,
  validateUtf16Interval,
  validateUtf16Slice,
  type EvidenceSpanId,
  type Result
} from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  DimensionAssessmentDraftSchema,
  DimensionAssessmentEvidenceSpanDraftSchema,
  DimensionAssessmentEvidenceSpanSchema,
  DimensionAssessmentSchema,
  EvidenceGapDraftSchema,
  EvidenceGapSchema,
  EvidenceSpanDraftSchema,
  EvidenceSpanSchema,
  ExtractionRunDraftSchema,
  ExtractionRunSchema,
  type DimensionAssessment,
  type DimensionAssessmentEvidenceSpan,
  type EvidenceGap,
  type EvidenceSpan,
  type ExtractionRun
} from "./schemas.js";

const preparedExtractionRuns = new WeakSet<object>();
const preparedEvidenceSpans = new WeakSet<object>();
const preparedEvidenceGaps = new WeakSet<object>();
const preparedDimensionAssessments = new WeakSet<object>();
const preparedDimensionAssessmentEvidenceSpans = new WeakSet<object>();

const TRANSACTION_REQUIRED =
  "Evidence and extraction rows require an active command transaction";

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
 * than silently different evidence.
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

function documentIsStored(
  context: ImmediateTransactionContext,
  documentId: string
): boolean {
  return (
    context.nativeDatabase
      .prepare("SELECT 1 AS present FROM source_document WHERE source_document_id = ?")
      .get(documentId) !== undefined
  );
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

/**
 * Validates the half-open offset interval before the writer lock. The stored
 * document is only consulted at insert time, where the transaction guarantees
 * the document cannot change underneath the span.
 */
export function prepareEvidenceSpan(
  draftInput: unknown
): Result<EvidenceSpan, RuntimeError> {
  try {
    const draft = EvidenceSpanDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid evidence span input"));
    }
    if (draft.data.end <= draft.data.start) {
      return err(persistenceFailure("Evidence span end must exceed its start"));
    }
    return ok(register(preparedEvidenceSpans, draft.data));
  } catch {
    return err(persistenceFailure("Evidence span preparation failed"));
  }
}

/**
 * Validates the reason code against the closed P5 vocabulary and hashes the
 * searched-document list. The parameterized reason forms cannot be a SQL
 * enum, so membership is enforced here and re-checked on read.
 */
export function prepareEvidenceGap(draftInput: unknown): Result<EvidenceGap, RuntimeError> {
  try {
    const draft = EvidenceGapDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid evidence gap input"));
    }
    const reasonCode = parseReasonCode(draft.data.reasonCode);
    if (!reasonCode.ok) {
      return err(
        persistenceFailure("Evidence gap reason code is not in the closed vocabulary")
      );
    }
    if (draft.data.documentsSearched.length === 0) {
      return err(persistenceFailure("Evidence gap requires at least one searched document"));
    }
    if (new Set(draft.data.documentsSearched).size !== draft.data.documentsSearched.length) {
      return err(persistenceFailure("Evidence gap searched documents must be unique"));
    }

    const canonical = canonicalWithHash(
      draft.data.documentsSearched,
      "Evidence gap searched documents are not canonical JSON"
    );
    if (!canonical.ok) {
      return canonical;
    }

    const gap = EvidenceGapSchema.parse({
      ...draft.data,
      reasonCode: formatReasonCode(reasonCode.value),
      documentsSearchedJson: canonical.value.json,
      documentsSearchedHash: canonical.value.hash
    });
    return ok(register(preparedEvidenceGaps, gap));
  } catch {
    return err(persistenceFailure("Evidence gap preparation failed"));
  }
}

/**
 * A human assessment names the human who made it and an extracted one never
 * borrows an actor, so provenance on the packet is never ambiguous.
 */
export function prepareDimensionAssessment(
  draftInput: unknown
): Result<DimensionAssessment, RuntimeError> {
  try {
    const draft = DimensionAssessmentDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid dimension assessment input"));
    }
    if ((draft.data.source === "human") !== (draft.data.actorId !== null)) {
      return err(
        persistenceFailure(
          "Dimension assessment actor is required for human source and forbidden otherwise"
        )
      );
    }
    return ok(register(preparedDimensionAssessments, draft.data));
  } catch {
    return err(persistenceFailure("Dimension assessment preparation failed"));
  }
}

export function prepareDimensionAssessmentEvidenceSpan(
  draftInput: unknown
): Result<DimensionAssessmentEvidenceSpan, RuntimeError> {
  try {
    const draft = DimensionAssessmentEvidenceSpanDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid dimension assessment evidence span input"));
    }
    return ok(register(preparedDimensionAssessmentEvidenceSpans, draft.data));
  } catch {
    return err(
      persistenceFailure("Dimension assessment evidence span preparation failed")
    );
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

/**
 * Writes a span only when its offsets actually address the stored normalized
 * text. Exact matches must additionally be byte-identical slices, which is the
 * Class 1 offset-resolution invariant checked at the write boundary rather
 * than trusted from the extractor.
 */
export function insertEvidenceSpan(
  contextInput: unknown,
  preparedInput: unknown
): Result<EvidenceSpan, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<EvidenceSpan>(
      preparedEvidenceSpans,
      preparedInput,
      "Invalid prepared evidence span"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const span = prepared.value;

    const documentRow = context.value.nativeDatabase
      .prepare(
        `SELECT normalized_text AS normalizedText
         FROM source_document
         WHERE source_document_id = ?`
      )
      .get(span.documentId) as { normalizedText: string } | undefined;
    if (documentRow === undefined) {
      return err(persistenceFailure("Evidence span requires a stored source document"));
    }

    const interval = validateUtf16Interval(documentRow.normalizedText, {
      start: span.start,
      end: span.end
    });
    if (!interval.ok) {
      return err(
        persistenceFailure("Evidence span offsets do not address the stored document")
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
          persistenceFailure("Exact evidence span quote is not a slice of the document")
        );
      }
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO evidence_span (
          evidence_span_id,
          document_id,
          start,
          end,
          quoted_text,
          dimension_id,
          polarity,
          source,
          match_quality,
          extractor_version,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        span.evidenceSpanId,
        span.documentId,
        span.start,
        span.end,
        span.quotedText,
        span.dimensionId,
        span.polarity,
        span.source,
        span.matchQuality,
        span.extractorVersion,
        span.createdAt
      );

    return ok(span);
  } catch {
    return err(persistenceFailure("Evidence span insert failed"));
  }
}

/**
 * The searched-document list is canonical JSON rather than a child table, so
 * this is where referenced documents are proven to exist.
 */
export function insertEvidenceGap(
  contextInput: unknown,
  preparedInput: unknown
): Result<EvidenceGap, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<EvidenceGap>(
      preparedEvidenceGaps,
      preparedInput,
      "Invalid prepared evidence gap"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const gap = prepared.value;

    for (const documentId of gap.documentsSearched) {
      if (!documentIsStored(context.value, documentId)) {
        return err(
          persistenceFailure("Evidence gap requires stored searched source documents")
        );
      }
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO evidence_gap (
          evidence_gap_id,
          dimension_id,
          reason_code,
          documents_searched_json,
          documents_searched_hash,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        gap.evidenceGapId,
        gap.dimensionId,
        gap.reasonCode,
        gap.documentsSearchedJson,
        gap.documentsSearchedHash,
        gap.createdAt
      );

    return ok(gap);
  } catch {
    return err(persistenceFailure("Evidence gap insert failed"));
  }
}

export function insertDimensionAssessment(
  contextInput: unknown,
  preparedInput: unknown
): Result<DimensionAssessment, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<DimensionAssessment>(
      preparedDimensionAssessments,
      preparedInput,
      "Invalid prepared dimension assessment"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const assessment = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO dimension_assessment (
          dimension_assessment_id,
          dimension_id,
          level,
          source,
          actor_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        assessment.dimensionAssessmentId,
        assessment.dimensionId,
        assessment.level,
        assessment.source,
        assessment.actorId,
        assessment.createdAt
      );

    return ok(assessment);
  } catch {
    return err(persistenceFailure("Dimension assessment insert failed"));
  }
}

/**
 * Cited evidence must be evidence for the dimension being assessed, otherwise
 * a packet could show a span under a dimension it never spoke to.
 */
export function insertDimensionAssessmentEvidenceSpan(
  contextInput: unknown,
  preparedInput: unknown
): Result<DimensionAssessmentEvidenceSpan, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<DimensionAssessmentEvidenceSpan>(
      preparedDimensionAssessmentEvidenceSpans,
      preparedInput,
      "Invalid prepared dimension assessment evidence span"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const association = prepared.value;

    const dimensions = context.value.nativeDatabase
      .prepare(
        `SELECT
          (SELECT dimension_id FROM dimension_assessment WHERE dimension_assessment_id = ?)
            AS assessmentDimensionId,
          (SELECT dimension_id FROM evidence_span WHERE evidence_span_id = ?)
            AS spanDimensionId`
      )
      .get(association.dimensionAssessmentId, association.evidenceSpanId) as {
      assessmentDimensionId: string | null;
      spanDimensionId: string | null;
    };
    if (
      dimensions.assessmentDimensionId === null ||
      dimensions.spanDimensionId === null
    ) {
      return err(
        persistenceFailure(
          "Dimension assessment evidence requires a stored assessment and span"
        )
      );
    }
    if (dimensions.assessmentDimensionId !== dimensions.spanDimensionId) {
      return err(
        persistenceFailure("Dimension assessment evidence must share the assessed dimension")
      );
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO dimension_assessment_evidence_span (
          dimension_assessment_evidence_span_id,
          dimension_assessment_id,
          evidence_span_id,
          span_ordinal,
          created_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        association.dimensionAssessmentEvidenceSpanId,
        association.dimensionAssessmentId,
        association.evidenceSpanId,
        association.spanOrdinal,
        association.createdAt
      );

    return ok(association);
  } catch {
    return err(persistenceFailure("Dimension assessment evidence span insert failed"));
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

export function readEvidenceSpan(
  contextInput: unknown,
  evidenceSpanIdInput: unknown
): Result<EvidenceSpan | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const evidenceSpanId = EvidenceSpanIdSchema.safeParse(evidenceSpanIdInput);
    if (!evidenceSpanId.success) {
      return err(persistenceFailure("Invalid evidence span ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          evidence_span_id AS evidenceSpanId,
          document_id AS documentId,
          start,
          end,
          quoted_text AS quotedText,
          dimension_id AS dimensionId,
          polarity,
          source,
          match_quality AS matchQuality,
          extractor_version AS extractorVersion,
          created_at AS createdAt
        FROM evidence_span
        WHERE evidence_span_id = ?`
      )
      .get(evidenceSpanId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const span = EvidenceSpanSchema.safeParse(row);
    if (!span.success) {
      return err(persistenceFailure("Stored evidence span is invalid"));
    }
    return ok(Object.freeze(span.data));
  } catch {
    return err(persistenceFailure("Evidence span read failed"));
  }
}

export function readEvidenceGap(
  contextInput: unknown,
  evidenceGapIdInput: unknown
): Result<EvidenceGap | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const evidenceGapId = EvidenceGapIdSchema.safeParse(evidenceGapIdInput);
    if (!evidenceGapId.success) {
      return err(persistenceFailure("Invalid evidence gap ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          evidence_gap_id AS evidenceGapId,
          dimension_id AS dimensionId,
          reason_code AS reasonCode,
          documents_searched_json AS documentsSearchedJson,
          documents_searched_hash AS documentsSearchedHash,
          created_at AS createdAt
        FROM evidence_gap
        WHERE evidence_gap_id = ?`
      )
      .get(evidenceGapId.data) as
      | Readonly<{
          reasonCode: string;
          documentsSearchedJson: string;
          documentsSearchedHash: string;
        }>
      | undefined;
    if (row === undefined) {
      return ok(undefined);
    }

    if (!parseReasonCode(row.reasonCode).ok) {
      return err(
        persistenceFailure("Stored evidence gap reason code is outside the closed vocabulary")
      );
    }
    const decoded = decodeCanonicalJson(
      row.documentsSearchedJson,
      row.documentsSearchedHash,
      "Stored evidence gap searched documents are not valid JSON",
      "Stored evidence gap failed integrity validation"
    );
    if (!decoded.ok) {
      return decoded;
    }

    const gap = EvidenceGapSchema.safeParse({
      ...row,
      documentsSearched: decoded.value
    });
    if (!gap.success) {
      return err(persistenceFailure("Stored evidence gap is invalid"));
    }
    return ok(Object.freeze(gap.data));
  } catch {
    return err(persistenceFailure("Evidence gap read failed"));
  }
}

export function readDimensionAssessment(
  contextInput: unknown,
  dimensionAssessmentIdInput: unknown
): Result<DimensionAssessment | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const dimensionAssessmentId = DimensionAssessmentIdSchema.safeParse(
      dimensionAssessmentIdInput
    );
    if (!dimensionAssessmentId.success) {
      return err(persistenceFailure("Invalid dimension assessment ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          dimension_assessment_id AS dimensionAssessmentId,
          dimension_id AS dimensionId,
          level,
          source,
          actor_id AS actorId,
          created_at AS createdAt
        FROM dimension_assessment
        WHERE dimension_assessment_id = ?`
      )
      .get(dimensionAssessmentId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const assessment = DimensionAssessmentSchema.safeParse(row);
    if (!assessment.success) {
      return err(persistenceFailure("Stored dimension assessment is invalid"));
    }
    return ok(Object.freeze(assessment.data));
  } catch {
    return err(persistenceFailure("Dimension assessment read failed"));
  }
}

export function readDimensionAssessmentEvidenceSpan(
  contextInput: unknown,
  dimensionAssessmentEvidenceSpanIdInput: unknown
): Result<DimensionAssessmentEvidenceSpan | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const associationId = DimensionAssessmentEvidenceSpanIdSchema.safeParse(
      dimensionAssessmentEvidenceSpanIdInput
    );
    if (!associationId.success) {
      return err(persistenceFailure("Invalid dimension assessment evidence span ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          dimension_assessment_evidence_span_id AS dimensionAssessmentEvidenceSpanId,
          dimension_assessment_id AS dimensionAssessmentId,
          evidence_span_id AS evidenceSpanId,
          span_ordinal AS spanOrdinal,
          created_at AS createdAt
        FROM dimension_assessment_evidence_span
        WHERE dimension_assessment_evidence_span_id = ?`
      )
      .get(associationId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    const association = DimensionAssessmentEvidenceSpanSchema.safeParse(row);
    if (!association.success) {
      return err(
        persistenceFailure("Stored dimension assessment evidence span is invalid")
      );
    }
    return ok(Object.freeze(association.data));
  } catch {
    return err(persistenceFailure("Dimension assessment evidence span read failed"));
  }
}

/**
 * Reads the ordered span references of one assessment. Contiguity is proven on
 * read so a partially written citation list is an error rather than a packet
 * that quietly cites fewer spans than the level was derived from.
 */
export function readDimensionAssessmentSpanRefs(
  contextInput: unknown,
  dimensionAssessmentIdInput: unknown
): Result<readonly EvidenceSpanId[], RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const dimensionAssessmentId = DimensionAssessmentIdSchema.safeParse(
      dimensionAssessmentIdInput
    );
    if (!dimensionAssessmentId.success) {
      return err(persistenceFailure("Invalid dimension assessment ID"));
    }
    const rows = context.value.nativeDatabase
      .prepare(
        `SELECT
          evidence_span_id AS evidenceSpanId,
          span_ordinal AS spanOrdinal
        FROM dimension_assessment_evidence_span
        WHERE dimension_assessment_id = ?
        ORDER BY span_ordinal ASC`
      )
      .all(dimensionAssessmentId.data) as ReadonlyArray<Record<string, unknown>>;

    const spanIds: EvidenceSpanId[] = [];
    for (const [index, row] of rows.entries()) {
      const spanId = EvidenceSpanIdSchema.safeParse(row["evidenceSpanId"]);
      if (!spanId.success) {
        return err(
          persistenceFailure("Stored dimension assessment evidence span is invalid")
        );
      }
      if (row["spanOrdinal"] !== index) {
        return err(
          persistenceFailure("Dimension assessment span ordinals must be contiguous from 0")
        );
      }
      spanIds.push(spanId.data);
    }
    return ok(Object.freeze(spanIds));
  } catch {
    return err(persistenceFailure("Dimension assessment evidence span read failed"));
  }
}
