import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core";

export const runtimeMigrationSmoke = sqliteTable("runtime_migration_smoke", {
  singleton: integer("singleton").primaryKey(),
  applied: integer("applied").notNull().default(1)
});

export const commandReceipts = sqliteTable(
  "command_receipt",
  {
    commandId: text("command_id").primaryKey(),
    commandName: text("command_name").notNull(),
    actorId: text("actor_id").notNull(),
    expectedVersion: integer("expected_version").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status", { enum: ["in_progress", "succeeded", "failed"] }).notNull(),
    resultJson: text("result_json"),
    resultHash: text("result_hash"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at")
  },
  (table) => [
    check("command_receipt_expected_version", sql`${table.expectedVersion} >= 0`),
    check("command_receipt_created_at", sql`${table.createdAt} >= 0`),
    check(
      "command_receipt_completed_at",
      sql`${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt}`
    ),
    check(
      "command_receipt_status",
      sql`${table.status} IN ('in_progress', 'succeeded', 'failed')`
    ),
    check(
      "command_receipt_terminal_shape",
      sql`(
        ${table.status} = 'in_progress'
        AND ${table.resultJson} IS NULL
        AND ${table.resultHash} IS NULL
        AND ${table.errorCode} IS NULL
        AND ${table.errorMessage} IS NULL
        AND ${table.completedAt} IS NULL
      ) OR (
        ${table.status} = 'succeeded'
        AND ${table.resultJson} IS NOT NULL
        AND ${table.resultHash} IS NOT NULL
        AND ${table.errorCode} IS NULL
        AND ${table.errorMessage} IS NULL
        AND ${table.completedAt} IS NOT NULL
      ) OR (
        ${table.status} = 'failed'
        AND ${table.resultJson} IS NULL
        AND ${table.resultHash} IS NULL
        AND ${table.errorCode} IS NOT NULL
        AND ${table.errorMessage} IS NOT NULL
        AND ${table.completedAt} IS NOT NULL
      )`
    )
  ]
);

export const auditEvents = sqliteTable(
  "audit_event",
  {
    auditEventId: text("audit_event_id").primaryKey(),
    commandId: text("command_id").references(() => commandReceipts.commandId),
    eventOrdinal: integer("event_ordinal"),
    actorId: text("actor_id").notNull(),
    actorDisplayName: text("actor_display_name").notNull(),
    eventName: text("event_name").notNull(),
    eventVersion: integer("event_version").notNull(),
    payloadJson: text("payload_json").notNull(),
    payloadHash: text("payload_hash").notNull(),
    occurredAt: integer("occurred_at").notNull(),
    recordedAt: integer("recorded_at").notNull()
  },
  (table) => [
    uniqueIndex("audit_event_command_ordinal_unique").on(
      table.commandId,
      table.eventOrdinal
    ),
    check(
      "audit_event_command_ordinal_pair",
      sql`(${table.commandId} IS NULL AND ${table.eventOrdinal} IS NULL) OR (${table.commandId} IS NOT NULL AND ${table.eventOrdinal} IS NOT NULL)`
    ),
    check(
      "audit_event_event_ordinal",
      sql`${table.eventOrdinal} IS NULL OR ${table.eventOrdinal} >= 0`
    ),
    check(
      "audit_event_actor_display_name",
      sql`length(${table.actorDisplayName}) BETWEEN 1 AND 200`
    ),
    check(
      "audit_event_name",
      sql`length(${table.eventName}) BETWEEN 1 AND 128`
    ),
    check("audit_event_version", sql`${table.eventVersion} > 0`),
    check(
      "audit_event_payload_hash",
      sql`length(${table.payloadHash}) = 64 AND ${table.payloadHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check("audit_event_occurred_at", sql`${table.occurredAt} >= 0`),
    check(
      "audit_event_recorded_at",
      sql`${table.recordedAt} >= ${table.occurredAt}`
    )
  ]
);

export const actors = sqliteTable(
  "actor",
  {
    actorId: text("actor_id").primaryKey(),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    displayName: text("display_name").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    check("actor_kind", sql`${table.actorKind} IN ('human', 'system')`),
    check(
      "actor_system_identity",
      sql`(${table.actorKind} = 'system') = (${table.actorId} = 'system:runtime')`
    ),
    check(
      "actor_display_name",
      sql`length(${table.displayName}) BETWEEN 1 AND 200`
    ),
    check("actor_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const candidates = sqliteTable(
  "candidate",
  {
    candidateId: text("candidate_id").primaryKey(),
    sourceSystem: text("source_system").notNull(),
    sourceKey: text("source_key").notNull(),
    channel: text("channel", { enum: ["inbound", "sourced"] }).notNull(),
    corpusTag: text("corpus_tag", { enum: ["main", "variant"] }).notNull(),
    isSynthetic: integer("is_synthetic").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("candidate_source_unique").on(table.sourceSystem, table.sourceKey),
    check(
      "candidate_source_system",
      sql`length(${table.sourceSystem}) BETWEEN 1 AND 64`
    ),
    check("candidate_source_key", sql`length(${table.sourceKey}) BETWEEN 1 AND 128`),
    check("candidate_channel", sql`${table.channel} IN ('inbound', 'sourced')`),
    check("candidate_corpus_tag", sql`${table.corpusTag} IN ('main', 'variant')`),
    check("candidate_is_synthetic", sql`${table.isSynthetic} = 1`),
    check("candidate_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const sourceDocuments = sqliteTable(
  "source_document",
  {
    sourceDocumentId: text("source_document_id").primaryKey(),
    rawText: text("raw_text").notNull(),
    rawHash: text("raw_hash").notNull(),
    rawByteLength: integer("raw_byte_length").notNull(),
    normalizedText: text("normalized_text").notNull(),
    normalizedHash: text("normalized_hash").notNull(),
    normalizedLength: integer("normalized_length").notNull(),
    normalizedByteLength: integer("normalized_byte_length").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("source_document_raw_hash_unique").on(table.rawHash),
    index("source_document_normalized_hash").on(table.normalizedHash),
    check(
      "source_document_raw_hash",
      sql`length(${table.rawHash}) = 64 AND ${table.rawHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      "source_document_normalized_hash",
      sql`length(${table.normalizedHash}) = 64 AND ${table.normalizedHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      "source_document_raw_byte_length",
      sql`${table.rawByteLength} BETWEEN 1 AND 262144
        AND ${table.rawByteLength} = length(CAST(${table.rawText} AS BLOB))`
    ),
    check(
      "source_document_normalized_byte_length",
      sql`${table.normalizedByteLength} BETWEEN 1 AND 131072
        AND ${table.normalizedByteLength} = length(CAST(${table.normalizedText} AS BLOB))`
    ),
    check(
      "source_document_normalized_length",
      sql`${table.normalizedLength} BETWEEN 1 AND 50000
        AND ${table.normalizedLength} >= length(${table.normalizedText})
        AND ${table.normalizedLength} <= 2 * length(${table.normalizedText})`
    ),
    check("source_document_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const candidateDocuments = sqliteTable(
  "candidate_document",
  {
    candidateDocumentId: text("candidate_document_id").primaryKey(),
    candidateId: text("candidate_id")
      .notNull()
      .references(() => candidates.candidateId, { onDelete: "restrict" }),
    sourceDocumentId: text("source_document_id")
      .notNull()
      .references(() => sourceDocuments.sourceDocumentId, { onDelete: "restrict" }),
    documentKind: text("document_kind", {
      enum: ["resume", "cover_letter", "profile", "recruiter_note"]
    }).notNull(),
    label: text("label").notNull(),
    documentOrdinal: integer("document_ordinal").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("candidate_document_ordinal_unique").on(
      table.candidateId,
      table.documentOrdinal
    ),
    uniqueIndex("candidate_document_source_unique").on(
      table.candidateId,
      table.sourceDocumentId
    ),
    check(
      "candidate_document_kind",
      sql`${table.documentKind} IN ('resume', 'cover_letter', 'profile', 'recruiter_note')`
    ),
    check("candidate_document_label", sql`length(${table.label}) BETWEEN 1 AND 200`),
    check(
      "candidate_document_ordinal",
      sql`${table.documentOrdinal} BETWEEN 0 AND 3`
    ),
    check("candidate_document_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const corpusManifests = sqliteTable(
  "corpus_manifest",
  {
    corpusManifestId: text("corpus_manifest_id").primaryKey(),
    kind: text("kind", { enum: ["main", "variant"] }).notNull(),
    contentHash: text("content_hash").notNull(),
    // Cyclic pair with corpus_manifest_seal: the seal row is inserted after
    // this manifest's members and documents, so this reference must be
    // deferred to commit time. Omitting onDelete keeps drizzle-kit's SQLite
    // generator on its deferred-by-default codegen path for this column.
    sealId: text("seal_id")
      .notNull()
      .references((): AnySQLiteColumn => corpusManifestSeals.corpusManifestSealId),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("corpus_manifest_content_hash_unique").on(table.contentHash),
    uniqueIndex("corpus_manifest_seal_id_unique").on(table.sealId),
    check("corpus_manifest_kind", sql`${table.kind} IN ('main', 'variant')`),
    check(
      "corpus_manifest_content_hash",
      sql`length(${table.contentHash}) = 64 AND ${table.contentHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check("corpus_manifest_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const corpusMembers = sqliteTable(
  "corpus_member",
  {
    corpusMemberId: text("corpus_member_id").primaryKey(),
    manifestId: text("manifest_id")
      .notNull()
      .references(() => corpusManifests.corpusManifestId, { onDelete: "restrict" }),
    candidateId: text("candidate_id")
      .notNull()
      .references(() => candidates.candidateId, { onDelete: "restrict" }),
    importOrdinal: integer("import_ordinal").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("corpus_member_manifest_candidate_unique").on(
      table.manifestId,
      table.candidateId
    ),
    uniqueIndex("corpus_member_manifest_ordinal_unique").on(
      table.manifestId,
      table.importOrdinal
    ),
    check("corpus_member_import_ordinal", sql`${table.importOrdinal} >= 0`),
    check("corpus_member_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const corpusMemberDocuments = sqliteTable(
  "corpus_member_document",
  {
    corpusMemberDocumentId: text("corpus_member_document_id").primaryKey(),
    corpusMemberId: text("corpus_member_id")
      .notNull()
      .references(() => corpusMembers.corpusMemberId, { onDelete: "restrict" }),
    candidateDocumentId: text("candidate_document_id")
      .notNull()
      .references(() => candidateDocuments.candidateDocumentId, { onDelete: "restrict" }),
    documentOrdinal: integer("document_ordinal").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("corpus_member_document_ordinal_unique").on(
      table.corpusMemberId,
      table.documentOrdinal
    ),
    uniqueIndex("corpus_member_document_candidate_document_unique").on(
      table.corpusMemberId,
      table.candidateDocumentId
    ),
    check(
      "corpus_member_document_ordinal",
      sql`${table.documentOrdinal} BETWEEN 0 AND 3`
    ),
    check("corpus_member_document_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const corpusManifestSeals = sqliteTable(
  "corpus_manifest_seal",
  {
    corpusManifestSealId: text("corpus_manifest_seal_id").primaryKey(),
    manifestId: text("manifest_id")
      .notNull()
      .references(() => corpusManifests.corpusManifestId, { onDelete: "restrict" }),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("corpus_manifest_seal_manifest_unique").on(table.manifestId),
    check("corpus_manifest_seal_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const roles = sqliteTable(
  "role",
  {
    roleId: text("role_id").primaryKey(),
    title: text("title").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    check("role_title", sql`length(${table.title}) BETWEEN 1 AND 200`),
    check("role_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const requirements = sqliteTable(
  "requirement",
  {
    requirementId: text("requirement_id").primaryKey(),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.roleId, { onDelete: "restrict" }),
    kind: text("kind", { enum: ["hard", "scored"] }).notNull(),
    description: text("description").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    check("requirement_kind", sql`${table.kind} IN ('hard', 'scored')`),
    check(
      "requirement_description",
      sql`length(${table.description}) BETWEEN 1 AND 2000`
    ),
    check("requirement_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const rubrics = sqliteTable(
  "rubric",
  {
    rubricId: text("rubric_id").primaryKey(),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.roleId, { onDelete: "restrict" }),
    version: text("version").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("rubric_role_version_unique").on(table.roleId, table.version),
    check("rubric_version", sql`length(${table.version}) BETWEEN 1 AND 64`),
    check("rubric_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const rubricDimensions = sqliteTable(
  "rubric_dimension",
  {
    rubricDimensionId: text("rubric_dimension_id").primaryKey(),
    rubricId: text("rubric_id")
      .notNull()
      .references(() => rubrics.rubricId, { onDelete: "restrict" }),
    dimensionId: text("dimension_id").notNull(),
    weight: integer("weight").notNull(),
    required: integer("required").notNull(),
    definition: text("definition").notNull(),
    jobRelatedJustification: text("job_related_justification").notNull(),
    ordinal: integer("ordinal").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("rubric_dimension_rubric_ordinal_unique").on(
      table.rubricId,
      table.ordinal
    ),
    uniqueIndex("rubric_dimension_rubric_dimension_id_unique").on(
      table.rubricId,
      table.dimensionId
    ),
    check("rubric_dimension_weight", sql`${table.weight} > 0`),
    check("rubric_dimension_required", sql`${table.required} IN (0, 1)`),
    check(
      "rubric_dimension_definition",
      sql`length(${table.definition}) BETWEEN 1 AND 2000`
    ),
    check(
      "rubric_dimension_job_related_justification",
      sql`length(${table.jobRelatedJustification}) BETWEEN 1 AND 2000`
    ),
    check("rubric_dimension_ordinal", sql`${table.ordinal} >= 0`),
    check("rubric_dimension_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const extractionRuns = sqliteTable(
  "extraction_run",
  {
    extractionRunId: text("extraction_run_id").primaryKey(),
    spansReturned: integer("spans_returned").notNull(),
    spansLocated: integer("spans_located").notNull(),
    droppedQuotesJson: text("dropped_quotes_json").notNull(),
    droppedQuotesHash: text("dropped_quotes_hash").notNull(),
    modelId: text("model_id").notNull(),
    fixtureKey: text("fixture_key"),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    check("extraction_run_spans_returned", sql`${table.spansReturned} >= 0`),
    check(
      "extraction_run_spans_located",
      sql`${table.spansLocated} >= 0 AND ${table.spansLocated} <= ${table.spansReturned}`
    ),
    // An unlocated span is exactly a dropped quote, so the recorded quotes
    // account for every span the extractor returned but could not locate.
    // That keeps the confidence resolution term auditable from stored rows.
    check(
      "extraction_run_dropped_quotes_json",
      sql`json_valid(${table.droppedQuotesJson})
        AND json_type(${table.droppedQuotesJson}) = 'array'
        AND json_array_length(${table.droppedQuotesJson}) = ${table.spansReturned} - ${table.spansLocated}`
    ),
    check(
      "extraction_run_dropped_quotes_hash",
      sql`length(${table.droppedQuotesHash}) = 64 AND ${table.droppedQuotesHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check("extraction_run_model_id", sql`length(${table.modelId}) BETWEEN 1 AND 200`),
    check(
      "extraction_run_fixture_key",
      sql`${table.fixtureKey} IS NULL OR (length(${table.fixtureKey}) = 64 AND ${table.fixtureKey} NOT GLOB '*[^0-9a-f]*')`
    ),
    check("extraction_run_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const evidenceSpans = sqliteTable(
  "evidence_span",
  {
    evidenceSpanId: text("evidence_span_id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => sourceDocuments.sourceDocumentId, { onDelete: "restrict" }),
    start: integer("start").notNull(),
    end: integer("end").notNull(),
    quotedText: text("quoted_text").notNull(),
    dimensionId: text("dimension_id").notNull(),
    polarity: text("polarity", { enum: ["supporting", "contradicting"] }).notNull(),
    source: text("source", { enum: ["extracted", "human"] }).notNull(),
    matchQuality: text("match_quality", {
      enum: ["exact", "normalized", "fuzzy"]
    }).notNull(),
    extractorVersion: text("extractor_version").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    index("evidence_span_document").on(table.documentId),
    index("evidence_span_dimension").on(table.dimensionId),
    // Offsets are non-null half-open intervals into normalized_text, so a
    // stored span always addresses at least one code unit. There is no
    // unresolved match quality: unlocated quotes live on extraction_run.
    check("evidence_span_start", sql`${table.start} >= 0`),
    check("evidence_span_end", sql`${table.end} > ${table.start}`),
    check("evidence_span_quoted_text", sql`length(${table.quotedText}) BETWEEN 1 AND 240`),
    check(
      "evidence_span_dimension_id",
      sql`length(${table.dimensionId}) BETWEEN 1 AND 128`
    ),
    check(
      "evidence_span_polarity",
      sql`${table.polarity} IN ('supporting', 'contradicting')`
    ),
    check("evidence_span_source", sql`${table.source} IN ('extracted', 'human')`),
    check(
      "evidence_span_match_quality",
      sql`${table.matchQuality} IN ('exact', 'normalized', 'fuzzy')`
    ),
    check(
      "evidence_span_extractor_version",
      sql`length(${table.extractorVersion}) BETWEEN 1 AND 64`
    ),
    check("evidence_span_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const evidenceGaps = sqliteTable(
  "evidence_gap",
  {
    evidenceGapId: text("evidence_gap_id").primaryKey(),
    dimensionId: text("dimension_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    documentsSearchedJson: text("documents_searched_json").notNull(),
    documentsSearchedHash: text("documents_searched_hash").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    index("evidence_gap_dimension").on(table.dimensionId),
    check("evidence_gap_dimension_id", sql`length(${table.dimensionId}) BETWEEN 1 AND 128`),
    // The parameterized reason-code forms cannot be a SQL enum, so SQL bounds
    // the shape and the store validates membership in the closed P5 set.
    check(
      "evidence_gap_reason_code",
      sql`length(${table.reasonCode}) BETWEEN 1 AND 256
        AND ${table.reasonCode} NOT GLOB '*[^!-~]*'`
    ),
    // A gap is only reviewable when it names what was searched, so the stored
    // document list can never be empty.
    check(
      "evidence_gap_documents_searched_json",
      sql`json_valid(${table.documentsSearchedJson})
        AND json_type(${table.documentsSearchedJson}) = 'array'
        AND json_array_length(${table.documentsSearchedJson}) >= 1`
    ),
    check(
      "evidence_gap_documents_searched_hash",
      sql`length(${table.documentsSearchedHash}) = 64 AND ${table.documentsSearchedHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check("evidence_gap_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const dimensionAssessments = sqliteTable(
  "dimension_assessment",
  {
    dimensionAssessmentId: text("dimension_assessment_id").primaryKey(),
    dimensionId: text("dimension_id").notNull(),
    level: text("level", { enum: ["none", "weak", "partial", "strong"] }).notNull(),
    source: text("source", { enum: ["extracted", "human"] }).notNull(),
    actorId: text("actor_id").references(() => actors.actorId, { onDelete: "restrict" }),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    index("dimension_assessment_dimension").on(table.dimensionId),
    check(
      "dimension_assessment_dimension_id",
      sql`length(${table.dimensionId}) BETWEEN 1 AND 128`
    ),
    check(
      "dimension_assessment_level",
      sql`${table.level} IN ('none', 'weak', 'partial', 'strong')`
    ),
    check("dimension_assessment_source", sql`${table.source} IN ('extracted', 'human')`),
    // A human assessment names the human who made it; an extracted one never
    // borrows an actor, so provenance stays unambiguous on the packet.
    check(
      "dimension_assessment_actor_presence",
      sql`(${table.source} = 'human') = (${table.actorId} IS NOT NULL)`
    ),
    check("dimension_assessment_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const dimensionAssessmentEvidenceSpans = sqliteTable(
  "dimension_assessment_evidence_span",
  {
    dimensionAssessmentEvidenceSpanId: text(
      "dimension_assessment_evidence_span_id"
    ).primaryKey(),
    dimensionAssessmentId: text("dimension_assessment_id")
      .notNull()
      .references(() => dimensionAssessments.dimensionAssessmentId, {
        onDelete: "restrict"
      }),
    evidenceSpanId: text("evidence_span_id")
      .notNull()
      .references(() => evidenceSpans.evidenceSpanId, { onDelete: "restrict" }),
    spanOrdinal: integer("span_ordinal").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("dimension_assessment_evidence_span_ordinal_unique").on(
      table.dimensionAssessmentId,
      table.spanOrdinal
    ),
    uniqueIndex("dimension_assessment_evidence_span_unique").on(
      table.dimensionAssessmentId,
      table.evidenceSpanId
    ),
    check(
      "dimension_assessment_evidence_span_ordinal",
      sql`${table.spanOrdinal} >= 0`
    ),
    check(
      "dimension_assessment_evidence_span_created_at",
      sql`${table.createdAt} >= 0`
    )
  ]
);
