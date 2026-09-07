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

export const extractionSpecs = sqliteTable(
  "extraction_spec",
  {
    extractionSpecId: text("extraction_spec_id").primaryKey(),
    contentJson: text("content_json").notNull(),
    contentHash: text("content_hash").notNull(),
    modelId: text("model_id").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    promptHash: text("prompt_hash").notNull(),
    schemaHash: text("schema_hash").notNull(),
    dimensionId: text("dimension_id").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("extraction_spec_content_hash_unique").on(table.contentHash),
    index("extraction_spec_dimension").on(table.dimensionId),
    // Canonical contract bytes are stored so a later reader can prove the
    // denormalized identity columns still match the hashed content.
    check(
      "extraction_spec_content_json",
      sql`json_valid(${table.contentJson}) AND json_type(${table.contentJson}) = 'object'`
    ),
    check(
      "extraction_spec_content_hash",
      sql`length(${table.contentHash}) = 64 AND ${table.contentHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check("extraction_spec_model_id", sql`length(${table.modelId}) BETWEEN 1 AND 200`),
    check(
      "extraction_spec_extractor_version",
      sql`length(${table.extractorVersion}) BETWEEN 1 AND 64`
    ),
    check(
      "extraction_spec_prompt_hash",
      sql`length(${table.promptHash}) = 64 AND ${table.promptHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      "extraction_spec_schema_hash",
      sql`length(${table.schemaHash}) = 64 AND ${table.schemaHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      "extraction_spec_dimension_id",
      sql`length(${table.dimensionId}) BETWEEN 1 AND 128`
    ),
    check("extraction_spec_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const extractionArtifacts = sqliteTable(
  "extraction_artifact",
  {
    extractionArtifactId: text("extraction_artifact_id").primaryKey(),
    specId: text("spec_id")
      .notNull()
      .references(() => extractionSpecs.extractionSpecId, { onDelete: "restrict" }),
    sourceDocumentId: text("source_document_id")
      .notNull()
      .references(() => sourceDocuments.sourceDocumentId, { onDelete: "restrict" }),
    acceptedOutputJson: text("accepted_output_json").notNull(),
    acceptedOutputHash: text("accepted_output_hash").notNull(),
    rejectedClaimsJson: text("rejected_claims_json").notNull(),
    rejectedClaimsHash: text("rejected_claims_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("extraction_artifact_content_hash_unique").on(table.contentHash),
    index("extraction_artifact_spec").on(table.specId),
    index("extraction_artifact_document").on(table.sourceDocumentId),
    check(
      "extraction_artifact_accepted_output_json",
      sql`json_valid(${table.acceptedOutputJson})
        AND json_type(${table.acceptedOutputJson}) = 'object'
        AND json_type(json_extract(${table.acceptedOutputJson}, '$.spans')) = 'array'
        AND json_array_length(json_extract(${table.acceptedOutputJson}, '$.spans')) BETWEEN 0 AND 12`
    ),
    check(
      "extraction_artifact_accepted_output_hash",
      sql`length(${table.acceptedOutputHash}) = 64 AND ${table.acceptedOutputHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      "extraction_artifact_rejected_claims_json",
      sql`json_valid(${table.rejectedClaimsJson})
        AND json_type(${table.rejectedClaimsJson}) = 'array'
        AND json_array_length(${table.rejectedClaimsJson}) BETWEEN 0 AND 8`
    ),
    check(
      "extraction_artifact_rejected_claims_hash",
      sql`length(${table.rejectedClaimsHash}) = 64 AND ${table.rejectedClaimsHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      "extraction_artifact_content_hash",
      sql`length(${table.contentHash}) = 64 AND ${table.contentHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check("extraction_artifact_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const extractionFailures = sqliteTable(
  "extraction_failure",
  {
    extractionFailureId: text("extraction_failure_id").primaryKey(),
    specId: text("spec_id")
      .notNull()
      .references(() => extractionSpecs.extractionSpecId, { onDelete: "restrict" }),
    sourceDocumentId: text("source_document_id")
      .notNull()
      .references(() => sourceDocuments.sourceDocumentId, { onDelete: "restrict" }),
    errorClass: text("error_class", {
      enum: [
        "structurally_invalid",
        "oversized_response",
        "identity_mismatch",
        "cardinality_exceeded"
      ]
    }).notNull(),
    responseHash: text("response_hash").notNull(),
    responseByteLength: integer("response_byte_length").notNull(),
    diagnosticJson: text("diagnostic_json").notNull(),
    diagnosticHash: text("diagnostic_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("extraction_failure_content_hash_unique").on(table.contentHash),
    index("extraction_failure_spec").on(table.specId),
    index("extraction_failure_document").on(table.sourceDocumentId),
    index("extraction_failure_error_class").on(table.errorClass),
    check(
      "extraction_failure_error_class",
      sql`${table.errorClass} IN ('structurally_invalid', 'oversized_response', 'identity_mismatch', 'cardinality_exceeded')`
    ),
    check(
      "extraction_failure_response_hash",
      sql`length(${table.responseHash}) = 64 AND ${table.responseHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      "extraction_failure_response_byte_length",
      sql`${table.responseByteLength} >= 0`
    ),
    // Oversized responses are the only class allowed to exceed the provider
    // byte cap; every other failure still hashed a body that fit the bound.
    check(
      "extraction_failure_oversized_response",
      sql`(${table.errorClass} = 'oversized_response') = (${table.responseByteLength} > 65536)`
    ),
    check(
      "extraction_failure_diagnostic_json",
      sql`json_valid(${table.diagnosticJson})
        AND json_type(${table.diagnosticJson}) = 'object'
        AND json_type(json_extract(${table.diagnosticJson}, '$.details')) = 'array'
        AND json_array_length(json_extract(${table.diagnosticJson}, '$.details')) BETWEEN 0 AND 8`
    ),
    check(
      "extraction_failure_diagnostic_hash",
      sql`length(${table.diagnosticHash}) = 64 AND ${table.diagnosticHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      "extraction_failure_content_hash",
      sql`length(${table.contentHash}) = 64 AND ${table.contentHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check("extraction_failure_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const runInputSnapshots = sqliteTable(
  "run_input_snapshot",
  {
    runInputSnapshotId: text("run_input_snapshot_id").primaryKey(),
    contentJson: text("content_json").notNull(),
    contentHash: text("content_hash").notNull(),
    frozenDate: text("frozen_date").notNull(),
    rubricVersion: text("rubric_version").notNull(),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.roleId, { onDelete: "restrict" }),
    extractorVersion: text("extractor_version").notNull(),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("run_input_snapshot_content_hash_unique").on(table.contentHash),
    index("run_input_snapshot_role").on(table.roleId),
    index("run_input_snapshot_frozen_date").on(table.frozenDate),
    check(
      "run_input_snapshot_content_json",
      sql`json_valid(${table.contentJson}) AND json_type(${table.contentJson}) = 'object'`
    ),
    check(
      "run_input_snapshot_content_hash",
      sql`length(${table.contentHash}) = 64 AND ${table.contentHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      "run_input_snapshot_frozen_date",
      sql`length(${table.frozenDate}) = 10
        AND ${table.frozenDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`
    ),
    check(
      "run_input_snapshot_rubric_version",
      sql`length(${table.rubricVersion}) BETWEEN 1 AND 64`
    ),
    check(
      "run_input_snapshot_extractor_version",
      sql`length(${table.extractorVersion}) BETWEEN 1 AND 64`
    ),
    check(
      "run_input_snapshot_prompt_template_version",
      sql`length(${table.promptTemplateVersion}) BETWEEN 1 AND 64`
    ),
    check("run_input_snapshot_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const structuredFacts = sqliteTable(
  "structured_fact",
  {
    structuredFactId: text("structured_fact_id").primaryKey(),
    candidateId: text("candidate_id")
      .notNull()
      .references(() => candidates.candidateId, { onDelete: "restrict" }),
    kind: text("kind", {
      enum: [
        "employment_interval",
        "work_authorization_statement",
        "current_title",
        "employer_history_entry",
        "claimed_experience"
      ]
    }).notNull(),
    semanticKey: text("semantic_key").notNull(),
    payloadJson: text("payload_json").notNull(),
    contentJson: text("content_json").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("structured_fact_content_hash_unique").on(table.contentHash),
    uniqueIndex("structured_fact_semantic_key_unique").on(
      table.candidateId,
      table.kind,
      table.semanticKey
    ),
    index("structured_fact_candidate").on(table.candidateId),
    index("structured_fact_kind").on(table.kind),
    check(
      "structured_fact_kind",
      sql`${table.kind} IN ('employment_interval', 'work_authorization_statement', 'current_title', 'employer_history_entry', 'claimed_experience')`
    ),
    check(
      "structured_fact_semantic_key",
      sql`length(${table.semanticKey}) BETWEEN 1 AND 256`
    ),
    check(
      "structured_fact_payload_json",
      sql`json_valid(${table.payloadJson}) AND json_type(${table.payloadJson}) = 'object'`
    ),
    check(
      "structured_fact_content_json",
      sql`json_valid(${table.contentJson}) AND json_type(${table.contentJson}) = 'object'`
    ),
    check(
      "structured_fact_content_hash",
      sql`length(${table.contentHash}) = 64 AND ${table.contentHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check("structured_fact_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const structuredFactEvidenceSpans = sqliteTable(
  "structured_fact_evidence_span",
  {
    structuredFactEvidenceSpanId: text("structured_fact_evidence_span_id").primaryKey(),
    structuredFactId: text("structured_fact_id")
      .notNull()
      .references(() => structuredFacts.structuredFactId, { onDelete: "restrict" }),
    evidenceSpanId: text("evidence_span_id")
      .notNull()
      .references(() => evidenceSpans.evidenceSpanId, { onDelete: "restrict" }),
    spanOrdinal: integer("span_ordinal").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("structured_fact_evidence_span_ordinal_unique").on(
      table.structuredFactId,
      table.spanOrdinal
    ),
    uniqueIndex("structured_fact_evidence_span_unique").on(
      table.structuredFactId,
      table.evidenceSpanId
    ),
    check("structured_fact_evidence_span_ordinal", sql`${table.spanOrdinal} >= 0`),
    check("structured_fact_evidence_span_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const structuredFactProvenances = sqliteTable(
  "structured_fact_provenance",
  {
    structuredFactProvenanceId: text("structured_fact_provenance_id").primaryKey(),
    structuredFactId: text("structured_fact_id")
      .notNull()
      .references(() => structuredFacts.structuredFactId, { onDelete: "restrict" }),
    source: text("source", { enum: ["parsed", "extracted", "human"] }).notNull(),
    actorId: text("actor_id").references(() => actors.actorId, { onDelete: "restrict" }),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    index("structured_fact_provenance_fact").on(table.structuredFactId),
    check(
      "structured_fact_provenance_source",
      sql`${table.source} IN ('parsed', 'extracted', 'human')`
    ),
    check(
      "structured_fact_provenance_actor_presence",
      sql`(${table.source} = 'human') = (${table.actorId} IS NOT NULL)`
    ),
    check("structured_fact_provenance_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const factConflicts = sqliteTable(
  "fact_conflict",
  {
    factConflictId: text("fact_conflict_id").primaryKey(),
    contentJson: text("content_json").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("fact_conflict_content_hash_unique").on(table.contentHash),
    check(
      "fact_conflict_content_json",
      sql`json_valid(${table.contentJson})
        AND json_type(${table.contentJson}) = 'object'
        AND json_type(json_extract(${table.contentJson}, '$.memberIds')) = 'array'
        AND json_array_length(json_extract(${table.contentJson}, '$.memberIds')) >= 2`
    ),
    check(
      "fact_conflict_content_hash",
      sql`length(${table.contentHash}) = 64 AND ${table.contentHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check("fact_conflict_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const factConflictMembers = sqliteTable(
  "fact_conflict_member",
  {
    factConflictMemberId: text("fact_conflict_member_id").primaryKey(),
    factConflictId: text("fact_conflict_id")
      .notNull()
      .references(() => factConflicts.factConflictId, { onDelete: "restrict" }),
    structuredFactId: text("structured_fact_id")
      .notNull()
      .references(() => structuredFacts.structuredFactId, { onDelete: "restrict" }),
    memberOrdinal: integer("member_ordinal").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("fact_conflict_member_ordinal_unique").on(
      table.factConflictId,
      table.memberOrdinal
    ),
    uniqueIndex("fact_conflict_member_fact_unique").on(
      table.factConflictId,
      table.structuredFactId
    ),
    check("fact_conflict_member_ordinal", sql`${table.memberOrdinal} >= 0`),
    check("fact_conflict_member_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const hardRequirementAssessments = sqliteTable(
  "hard_requirement_assessment",
  {
    hardRequirementAssessmentId: text("hard_requirement_assessment_id").primaryKey(),
    candidateId: text("candidate_id")
      .notNull()
      .references(() => candidates.candidateId, { onDelete: "restrict" }),
    requirementFieldId: text("requirement_field_id", {
      enum: ["years_experience", "work_authorization", "current_title", "employer_history"]
    }).notNull(),
    outcome: text("outcome", { enum: ["pass", "fail", "unknown"] }).notNull(),
    contentJson: text("content_json").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("hard_requirement_assessment_content_hash_unique").on(table.contentHash),
    index("hard_requirement_assessment_candidate").on(table.candidateId),
    index("hard_requirement_assessment_field").on(table.requirementFieldId),
    check(
      "hard_requirement_assessment_requirement_field_id",
      sql`${table.requirementFieldId} IN ('years_experience', 'work_authorization', 'current_title', 'employer_history')`
    ),
    check(
      "hard_requirement_assessment_outcome",
      sql`${table.outcome} IN ('pass', 'fail', 'unknown')`
    ),
    check(
      "hard_requirement_assessment_content_json",
      sql`json_valid(${table.contentJson})
        AND json_type(${table.contentJson}) = 'object'
        AND json_type(json_extract(${table.contentJson}, '$.facts')) = 'array'
        AND (
          ${table.outcome} = 'unknown'
          OR json_array_length(json_extract(${table.contentJson}, '$.facts')) >= 1
        )`
    ),
    check(
      "hard_requirement_assessment_content_hash",
      sql`length(${table.contentHash}) = 64 AND ${table.contentHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check("hard_requirement_assessment_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const hardRequirementAssessmentFacts = sqliteTable(
  "hard_requirement_assessment_fact",
  {
    hardRequirementAssessmentFactId: text(
      "hard_requirement_assessment_fact_id"
    ).primaryKey(),
    hardRequirementAssessmentId: text("hard_requirement_assessment_id")
      .notNull()
      .references(() => hardRequirementAssessments.hardRequirementAssessmentId, {
        onDelete: "restrict"
      }),
    structuredFactId: text("structured_fact_id")
      .notNull()
      .references(() => structuredFacts.structuredFactId, { onDelete: "restrict" }),
    polarity: text("polarity", { enum: ["supporting", "contradicting"] }).notNull(),
    factOrdinal: integer("fact_ordinal").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("hard_requirement_assessment_fact_ordinal_unique").on(
      table.hardRequirementAssessmentId,
      table.factOrdinal
    ),
    uniqueIndex("hard_requirement_assessment_fact_unique").on(
      table.hardRequirementAssessmentId,
      table.structuredFactId
    ),
    check(
      "hard_requirement_assessment_fact_polarity",
      sql`${table.polarity} IN ('supporting', 'contradicting')`
    ),
    check("hard_requirement_assessment_fact_ordinal", sql`${table.factOrdinal} >= 0`),
    check("hard_requirement_assessment_fact_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const candidateTriageResults = sqliteTable(
  "candidate_triage_result",
  {
    candidateTriageResultId: text("candidate_triage_result_id").primaryKey(),
    candidateId: text("candidate_id")
      .notNull()
      .references(() => candidates.candidateId, { onDelete: "restrict" }),
    kind: text("kind", { enum: ["initial", "correction"] }).notNull(),
    availability: text("availability", { enum: ["complete", "unavailable"] }).notNull(),
    status: text("status", {
      enum: ["scored", "rejected_hard_requirement", "escalated"]
    }).notNull(),
    supersedesResultId: text("supersedes_result_id").references(
      (): AnySQLiteColumn => candidateTriageResults.candidateTriageResultId,
      { onDelete: "restrict" }
    ),
    contentJson: text("content_json").notNull(),
    contentHash: text("content_hash").notNull(),
    // Cyclic pair with candidate_result_seal: the seal row is inserted after
    // this result's associations, reasons, tasks, and proposals, so this
    // reference must be deferred to commit time. Omitting onDelete keeps
    // drizzle-kit's SQLite generator on its deferred-by-default codegen path.
    sealId: text("seal_id")
      .notNull()
      .references((): AnySQLiteColumn => candidateResultSeals.candidateResultSealId),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("candidate_triage_result_content_hash_unique").on(table.contentHash),
    uniqueIndex("candidate_triage_result_seal_id_unique").on(table.sealId),
    index("candidate_triage_result_candidate_created").on(
      table.candidateId,
      table.createdAt,
      table.candidateTriageResultId
    ),
    check("candidate_triage_result_kind", sql`${table.kind} IN ('initial', 'correction')`),
    check(
      "candidate_triage_result_availability",
      sql`${table.availability} IN ('complete', 'unavailable')`
    ),
    check(
      "candidate_triage_result_status",
      sql`${table.status} IN ('scored', 'rejected_hard_requirement', 'escalated')`
    ),
    check(
      "candidate_triage_result_lineage",
      sql`(
        ${table.kind} = 'initial' AND ${table.supersedesResultId} IS NULL
      ) OR (
        ${table.kind} = 'correction' AND ${table.supersedesResultId} IS NOT NULL
      )`
    ),
    check(
      "candidate_triage_result_availability_status",
      sql`(
        ${table.availability} = 'unavailable' AND ${table.status} = 'escalated'
      ) OR (
        ${table.availability} = 'complete'
        AND ${table.status} IN ('scored', 'escalated', 'rejected_hard_requirement')
      )`
    ),
    check(
      "candidate_triage_result_content_json",
      sql`json_valid(${table.contentJson}) AND json_type(${table.contentJson}) = 'object'`
    ),
    check(
      "candidate_triage_result_content_hash",
      sql`length(${table.contentHash}) = 64 AND ${table.contentHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check("candidate_triage_result_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const candidateResultSeals = sqliteTable(
  "candidate_result_seal",
  {
    candidateResultSealId: text("candidate_result_seal_id").primaryKey(),
    candidateResultId: text("candidate_result_id")
      .notNull()
      .references(() => candidateTriageResults.candidateTriageResultId, {
        onDelete: "restrict"
      }),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("candidate_result_seal_result_unique").on(table.candidateResultId),
    check("candidate_result_seal_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const scoreResults = sqliteTable(
  "score_result",
  {
    scoreResultId: text("score_result_id").primaryKey(),
    candidateResultId: text("candidate_result_id")
      .notNull()
      .references(() => candidateTriageResults.candidateTriageResultId, {
        onDelete: "restrict"
      }),
    aggregateText: text("aggregate_text").notNull(),
    confidenceText: text("confidence_text").notNull(),
    aggregateBasisPoints: integer("aggregate_basis_points").notNull(),
    confidenceBasisPoints: integer("confidence_basis_points").notNull(),
    contentJson: text("content_json").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("score_result_candidate_result_unique").on(table.candidateResultId),
    uniqueIndex("score_result_content_hash_unique").on(table.contentHash),
    check(
      "score_result_aggregate_text",
      sql`length(${table.aggregateText}) BETWEEN 3 AND 64
        AND ${table.aggregateText} NOT GLOB '*[^0-9/]*'`
    ),
    check(
      "score_result_confidence_text",
      sql`length(${table.confidenceText}) BETWEEN 3 AND 64
        AND ${table.confidenceText} NOT GLOB '*[^0-9/]*'`
    ),
    check(
      "score_result_aggregate_basis_points",
      sql`${table.aggregateBasisPoints} BETWEEN 0 AND 10000`
    ),
    check(
      "score_result_confidence_basis_points",
      sql`${table.confidenceBasisPoints} BETWEEN 0 AND 10000`
    ),
    check(
      "score_result_content_json",
      sql`json_valid(${table.contentJson})
        AND json_type(${table.contentJson}) = 'object'
        AND json_type(json_extract(${table.contentJson}, '$.contributions')) = 'array'
        AND json_array_length(json_extract(${table.contentJson}, '$.contributions')) = 6`
    ),
    check(
      "score_result_content_hash",
      sql`length(${table.contentHash}) = 64 AND ${table.contentHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check("score_result_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const candidateResultEvidenceSpans = sqliteTable(
  "candidate_result_evidence_span",
  {
    candidateResultEvidenceSpanId: text("candidate_result_evidence_span_id").primaryKey(),
    candidateResultId: text("candidate_result_id")
      .notNull()
      .references(() => candidateTriageResults.candidateTriageResultId, {
        onDelete: "restrict"
      }),
    evidenceSpanId: text("evidence_span_id")
      .notNull()
      .references(() => evidenceSpans.evidenceSpanId, { onDelete: "restrict" }),
    spanOrdinal: integer("span_ordinal").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("candidate_result_evidence_span_ordinal_unique").on(
      table.candidateResultId,
      table.spanOrdinal
    ),
    uniqueIndex("candidate_result_evidence_span_unique").on(
      table.candidateResultId,
      table.evidenceSpanId
    ),
    check("candidate_result_evidence_span_ordinal", sql`${table.spanOrdinal} >= 0`),
    check("candidate_result_evidence_span_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const candidateResultEvidenceGaps = sqliteTable(
  "candidate_result_evidence_gap",
  {
    candidateResultEvidenceGapId: text("candidate_result_evidence_gap_id").primaryKey(),
    candidateResultId: text("candidate_result_id")
      .notNull()
      .references(() => candidateTriageResults.candidateTriageResultId, {
        onDelete: "restrict"
      }),
    evidenceGapId: text("evidence_gap_id")
      .notNull()
      .references(() => evidenceGaps.evidenceGapId, { onDelete: "restrict" }),
    dimensionId: text("dimension_id").notNull(),
    gapOrdinal: integer("gap_ordinal").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("candidate_result_evidence_gap_ordinal_unique").on(
      table.candidateResultId,
      table.gapOrdinal
    ),
    uniqueIndex("candidate_result_evidence_gap_unique").on(
      table.candidateResultId,
      table.evidenceGapId
    ),
    uniqueIndex("candidate_result_evidence_gap_dimension_unique").on(
      table.candidateResultId,
      table.dimensionId
    ),
    check(
      "candidate_result_evidence_gap_dimension_id",
      sql`length(${table.dimensionId}) BETWEEN 1 AND 128`
    ),
    check("candidate_result_evidence_gap_ordinal", sql`${table.gapOrdinal} >= 0`),
    check("candidate_result_evidence_gap_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const candidateResultDimensionAssessments = sqliteTable(
  "candidate_result_dimension_assessment",
  {
    candidateResultDimensionAssessmentId: text(
      "candidate_result_dimension_assessment_id"
    ).primaryKey(),
    candidateResultId: text("candidate_result_id")
      .notNull()
      .references(() => candidateTriageResults.candidateTriageResultId, {
        onDelete: "restrict"
      }),
    dimensionAssessmentId: text("dimension_assessment_id")
      .notNull()
      .references(() => dimensionAssessments.dimensionAssessmentId, {
        onDelete: "restrict"
      }),
    dimensionId: text("dimension_id").notNull(),
    assessmentOrdinal: integer("assessment_ordinal").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("candidate_result_dimension_assessment_ordinal_unique").on(
      table.candidateResultId,
      table.assessmentOrdinal
    ),
    uniqueIndex("candidate_result_dimension_assessment_unique").on(
      table.candidateResultId,
      table.dimensionAssessmentId
    ),
    uniqueIndex("candidate_result_dimension_assessment_dimension_unique").on(
      table.candidateResultId,
      table.dimensionId
    ),
    check(
      "candidate_result_dimension_assessment_dimension_id",
      sql`length(${table.dimensionId}) BETWEEN 1 AND 128`
    ),
    check(
      "candidate_result_dimension_assessment_ordinal",
      sql`${table.assessmentOrdinal} >= 0`
    ),
    check(
      "candidate_result_dimension_assessment_created_at",
      sql`${table.createdAt} >= 0`
    )
  ]
);

export const candidateResultStructuredFacts = sqliteTable(
  "candidate_result_structured_fact",
  {
    candidateResultStructuredFactId: text("candidate_result_structured_fact_id").primaryKey(),
    candidateResultId: text("candidate_result_id")
      .notNull()
      .references(() => candidateTriageResults.candidateTriageResultId, {
        onDelete: "restrict"
      }),
    structuredFactId: text("structured_fact_id")
      .notNull()
      .references(() => structuredFacts.structuredFactId, { onDelete: "restrict" }),
    factOrdinal: integer("fact_ordinal").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("candidate_result_structured_fact_ordinal_unique").on(
      table.candidateResultId,
      table.factOrdinal
    ),
    uniqueIndex("candidate_result_structured_fact_unique").on(
      table.candidateResultId,
      table.structuredFactId
    ),
    check("candidate_result_structured_fact_ordinal", sql`${table.factOrdinal} >= 0`),
    check("candidate_result_structured_fact_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const candidateResultFactConflicts = sqliteTable(
  "candidate_result_fact_conflict",
  {
    candidateResultFactConflictId: text("candidate_result_fact_conflict_id").primaryKey(),
    candidateResultId: text("candidate_result_id")
      .notNull()
      .references(() => candidateTriageResults.candidateTriageResultId, {
        onDelete: "restrict"
      }),
    factConflictId: text("fact_conflict_id")
      .notNull()
      .references(() => factConflicts.factConflictId, { onDelete: "restrict" }),
    conflictOrdinal: integer("conflict_ordinal").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("candidate_result_fact_conflict_ordinal_unique").on(
      table.candidateResultId,
      table.conflictOrdinal
    ),
    uniqueIndex("candidate_result_fact_conflict_unique").on(
      table.candidateResultId,
      table.factConflictId
    ),
    check("candidate_result_fact_conflict_ordinal", sql`${table.conflictOrdinal} >= 0`),
    check("candidate_result_fact_conflict_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const candidateResultHardRequirementAssessments = sqliteTable(
  "candidate_result_hard_requirement_assessment",
  {
    candidateResultHardRequirementAssessmentId: text(
      "candidate_result_hard_requirement_assessment_id"
    ).primaryKey(),
    candidateResultId: text("candidate_result_id")
      .notNull()
      .references(() => candidateTriageResults.candidateTriageResultId, {
        onDelete: "restrict"
      }),
    hardRequirementAssessmentId: text("hard_requirement_assessment_id")
      .notNull()
      .references(() => hardRequirementAssessments.hardRequirementAssessmentId, {
        onDelete: "restrict"
      }),
    requirementOrdinal: integer("requirement_ordinal").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("candidate_result_hard_requirement_assessment_ordinal_unique").on(
      table.candidateResultId,
      table.requirementOrdinal
    ),
    uniqueIndex("candidate_result_hard_requirement_assessment_unique").on(
      table.candidateResultId,
      table.hardRequirementAssessmentId
    ),
    check(
      "candidate_result_hard_requirement_assessment_ordinal",
      sql`${table.requirementOrdinal} >= 0`
    ),
    check(
      "candidate_result_hard_requirement_assessment_created_at",
      sql`${table.createdAt} >= 0`
    )
  ]
);

export const candidateResultReasons = sqliteTable(
  "candidate_result_reason",
  {
    candidateResultReasonId: text("candidate_result_reason_id").primaryKey(),
    candidateResultId: text("candidate_result_id")
      .notNull()
      .references(() => candidateTriageResults.candidateTriageResultId, {
        onDelete: "restrict"
      }),
    reasonKind: text("reason_kind").notNull(),
    subjectId: text("subject_id"),
    reasonCode: text("reason_code").notNull(),
    reasonOrdinal: integer("reason_ordinal").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("candidate_result_reason_ordinal_unique").on(
      table.candidateResultId,
      table.reasonOrdinal
    ),
    uniqueIndex("candidate_result_reason_kind_unique")
      .on(table.candidateResultId, table.reasonKind)
      .where(sql`${table.subjectId} is null`),
    uniqueIndex("candidate_result_reason_kind_subject_unique")
      .on(table.candidateResultId, table.reasonKind, table.subjectId)
      .where(sql`${table.subjectId} is not null`),
    index("candidate_result_reason_result_created").on(
      table.candidateResultId,
      table.createdAt,
      table.candidateResultReasonId
    ),
    check(
      "candidate_result_reason_kind",
      sql`${table.reasonKind} IN (
        'missing_evidence',
        'contradiction',
        'ambiguous',
        'assessment_unavailable',
        'parse_failure',
        'possible_duplicate',
        'prompt_injection_flagged',
        'low_confidence'
      )`
    ),
    // Parameterized kinds require a printable subject; unparameterized kinds
    // forbid one. reason_code is the canonical formatReasonCode string.
    check(
      "candidate_result_reason_subject",
      sql`(
        ${table.reasonKind} IN ('missing_evidence', 'contradiction', 'ambiguous')
        AND ${table.subjectId} IS NOT NULL
        AND length(${table.subjectId}) BETWEEN 1 AND 128
        AND ${table.subjectId} NOT GLOB '*[^!-~]*'
        AND ${table.reasonCode} = ${table.reasonKind} || ':' || ${table.subjectId}
      ) OR (
        ${table.reasonKind} IN (
          'assessment_unavailable',
          'parse_failure',
          'possible_duplicate',
          'prompt_injection_flagged',
          'low_confidence'
        )
        AND ${table.subjectId} IS NULL
        AND ${table.reasonCode} = ${table.reasonKind}
      )`
    ),
    check(
      "candidate_result_reason_reason_code",
      sql`length(${table.reasonCode}) BETWEEN 1 AND 256
        AND ${table.reasonCode} NOT GLOB '*[^!-~]*'`
    ),
    check("candidate_result_reason_ordinal", sql`${table.reasonOrdinal} >= 0`),
    check("candidate_result_reason_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const resolutionTasks = sqliteTable(
  "resolution_task",
  {
    resolutionTaskId: text("resolution_task_id").primaryKey(),
    candidateResultId: text("candidate_result_id")
      .notNull()
      .references(() => candidateTriageResults.candidateTriageResultId, {
        onDelete: "restrict"
      }),
    candidateResultReasonId: text("candidate_result_reason_id")
      .notNull()
      .references(() => candidateResultReasons.candidateResultReasonId, {
        onDelete: "restrict"
      }),
    taskOrdinal: integer("task_ordinal").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("resolution_task_reason_unique").on(table.candidateResultReasonId),
    uniqueIndex("resolution_task_ordinal_unique").on(table.candidateResultId, table.taskOrdinal),
    index("resolution_task_result_created").on(
      table.candidateResultId,
      table.createdAt,
      table.resolutionTaskId
    ),
    check("resolution_task_ordinal", sql`${table.taskOrdinal} >= 0`),
    check("resolution_task_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const resolutionActions = sqliteTable(
  "resolution_action",
  {
    resolutionActionId: text("resolution_action_id").primaryKey(),
    resolutionTaskId: text("resolution_task_id")
      .notNull()
      .references(() => resolutionTasks.resolutionTaskId, { onDelete: "restrict" }),
    actorId: text("actor_id")
      .notNull()
      .references(() => actors.actorId, { onDelete: "restrict" }),
    actionKind: text("action_kind").notNull(),
    actionOrdinal: integer("action_ordinal").notNull(),
    payloadJson: text("payload_json").notNull(),
    payloadHash: text("payload_hash").notNull(),
    evidenceSpanId: text("evidence_span_id").references(() => evidenceSpans.evidenceSpanId, {
      onDelete: "restrict"
    }),
    dimensionAssessmentId: text("dimension_assessment_id").references(
      () => dimensionAssessments.dimensionAssessmentId,
      { onDelete: "restrict" }
    ),
    resultingResultId: text("resulting_result_id").references(
      () => candidateTriageResults.candidateTriageResultId,
      { onDelete: "restrict" }
    ),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("resolution_action_ordinal_unique").on(table.resolutionTaskId, table.actionOrdinal),
    index("resolution_action_task_created").on(
      table.resolutionTaskId,
      table.createdAt,
      table.resolutionActionId
    ),
    check(
      "resolution_action_kind",
      sql`${table.actionKind} IN (
        'supply_evidence_and_set_level',
        'correct_parse',
        'confirm_judgment',
        'block',
        'dismiss',
        'request_re_extraction',
        'reextraction_completed'
      )`
    ),
    check(
      "resolution_action_shape",
      sql`(
        ${table.actionKind} = 'supply_evidence_and_set_level'
        AND ${table.evidenceSpanId} IS NOT NULL
        AND ${table.dimensionAssessmentId} IS NOT NULL
        AND ${table.resultingResultId} IS NULL
        AND ${table.actorId} != 'system:runtime'
      ) OR (
        ${table.actionKind} = 'confirm_judgment'
        AND ${table.evidenceSpanId} IS NULL
        AND ${table.dimensionAssessmentId} IS NOT NULL
        AND ${table.resultingResultId} IS NULL
        AND ${table.actorId} != 'system:runtime'
      ) OR (
        ${table.actionKind} IN ('correct_parse', 'block', 'dismiss', 'request_re_extraction')
        AND ${table.evidenceSpanId} IS NULL
        AND ${table.dimensionAssessmentId} IS NULL
        AND ${table.resultingResultId} IS NULL
        AND ${table.actorId} != 'system:runtime'
      ) OR (
        ${table.actionKind} = 'reextraction_completed'
        AND ${table.evidenceSpanId} IS NULL
        AND ${table.dimensionAssessmentId} IS NULL
        AND ${table.resultingResultId} IS NOT NULL
        AND ${table.actorId} = 'system:runtime'
      )`
    ),
    check(
      "resolution_action_payload_json",
      sql`json_valid(${table.payloadJson}) AND json_type(${table.payloadJson}) = 'object'`
    ),
    check(
      "resolution_action_payload_hash",
      sql`length(${table.payloadHash}) = 64 AND ${table.payloadHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check("resolution_action_ordinal", sql`${table.actionOrdinal} >= 0`),
    check("resolution_action_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const resolutionTaskHeads = sqliteTable(
  "resolution_task_head",
  {
    resolutionTaskId: text("resolution_task_id")
      .primaryKey()
      .references(() => resolutionTasks.resolutionTaskId, { onDelete: "restrict" }),
    currentActionId: text("current_action_id")
      .notNull()
      .references(() => resolutionActions.resolutionActionId, { onDelete: "restrict" }),
    version: integer("version").notNull()
  },
  (table) => [
    check("resolution_task_head_version", sql`${table.version} >= 1`)
  ]
);

export const proposals = sqliteTable(
  "proposal",
  {
    proposalId: text("proposal_id").primaryKey(),
    candidateResultId: text("candidate_result_id")
      .notNull()
      .references(() => candidateTriageResults.candidateTriageResultId, {
        onDelete: "restrict"
      }),
    proposalKind: text("proposal_kind").notNull(),
    proposalOrdinal: integer("proposal_ordinal").notNull(),
    payloadJson: text("payload_json").notNull(),
    payloadHash: text("payload_hash").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("proposal_ordinal_unique").on(table.candidateResultId, table.proposalOrdinal),
    uniqueIndex("proposal_shortlist_result_unique")
      .on(table.candidateResultId)
      .where(sql`${table.proposalKind} = 'shortlist_inclusion'`),
    index("proposal_result_created").on(
      table.candidateResultId,
      table.createdAt,
      table.proposalId
    ),
    check(
      "proposal_kind",
      sql`${table.proposalKind} IN (
        'follow_up_draft',
        'ats_stage_change',
        'shortlist_inclusion',
        'rejection'
      )`
    ),
    check(
      "proposal_payload_json",
      sql`json_valid(${table.payloadJson}) AND json_type(${table.payloadJson}) = 'object'`
    ),
    check(
      "proposal_payload_hash",
      sql`length(${table.payloadHash}) = 64 AND ${table.payloadHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check("proposal_ordinal", sql`${table.proposalOrdinal} >= 0`),
    check("proposal_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const proposalEvidenceSpans = sqliteTable(
  "proposal_evidence_span",
  {
    proposalEvidenceSpanId: text("proposal_evidence_span_id").primaryKey(),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => proposals.proposalId, { onDelete: "restrict" }),
    evidenceSpanId: text("evidence_span_id")
      .notNull()
      .references(() => evidenceSpans.evidenceSpanId, { onDelete: "restrict" }),
    spanOrdinal: integer("span_ordinal").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("proposal_evidence_span_ordinal_unique").on(table.proposalId, table.spanOrdinal),
    uniqueIndex("proposal_evidence_span_unique").on(table.proposalId, table.evidenceSpanId),
    check("proposal_evidence_span_ordinal", sql`${table.spanOrdinal} >= 0`),
    check("proposal_evidence_span_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const reviewDecisions = sqliteTable(
  "review_decision",
  {
    reviewDecisionId: text("review_decision_id").primaryKey(),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => proposals.proposalId, { onDelete: "restrict" }),
    actorId: text("actor_id")
      .notNull()
      .references(() => actors.actorId, { onDelete: "restrict" }),
    decisionKind: text("decision_kind").notNull(),
    decisionOrdinal: integer("decision_ordinal").notNull(),
    payloadJson: text("payload_json").notNull(),
    payloadHash: text("payload_hash").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("review_decision_ordinal_unique").on(table.proposalId, table.decisionOrdinal),
    index("review_decision_proposal_created").on(
      table.proposalId,
      table.createdAt,
      table.reviewDecisionId
    ),
    check(
      "review_decision_kind",
      sql`${table.decisionKind} IN (
        'approve',
        'edit',
        'reject',
        'request_evidence'
      )`
    ),
    check("review_decision_actor", sql`${table.actorId} != 'system:runtime'`),
    check(
      "review_decision_payload_json",
      sql`json_valid(${table.payloadJson}) AND json_type(${table.payloadJson}) = 'object'`
    ),
    check(
      "review_decision_payload_hash",
      sql`length(${table.payloadHash}) = 64 AND ${table.payloadHash} NOT GLOB '*[^0-9a-f]*'`
    ),
    check("review_decision_ordinal", sql`${table.decisionOrdinal} >= 0`),
    check("review_decision_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const proposalHeads = sqliteTable(
  "proposal_head",
  {
    proposalId: text("proposal_id")
      .primaryKey()
      .references(() => proposals.proposalId, { onDelete: "restrict" }),
    currentDecisionId: text("current_decision_id")
      .notNull()
      .references(() => reviewDecisions.reviewDecisionId, { onDelete: "restrict" }),
    version: integer("version").notNull()
  },
  (table) => [check("proposal_head_version", sql`${table.version} >= 1`)]
);

export const candidateHeads = sqliteTable(
  "candidate_head",
  {
    candidateId: text("candidate_id")
      .primaryKey()
      .references(() => candidates.candidateId, { onDelete: "restrict" }),
    currentResultId: text("current_result_id")
      .notNull()
      .references(() => candidateTriageResults.candidateTriageResultId, {
        onDelete: "restrict"
      }),
    version: integer("version").notNull()
  },
  (table) => [check("candidate_head_version", sql`${table.version} >= 1`)]
);

export const triageRuns = sqliteTable(
  "triage_run",
  {
    triageRunId: text("triage_run_id").primaryKey(),
    kind: text("kind", { enum: ["main", "variant"] }).notNull(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => runInputSnapshots.runInputSnapshotId, { onDelete: "restrict" }),
    corpusManifestId: text("corpus_manifest_id")
      .notNull()
      .references(() => corpusManifests.corpusManifestId, { onDelete: "restrict" }),
    // Cyclic pair with triage_run_seal: the seal row is inserted after this
    // run's members, so this reference must be deferred to commit time.
    // Omitting onDelete keeps drizzle-kit's SQLite generator on its
    // deferred-by-default codegen path for this column.
    sealId: text("seal_id")
      .notNull()
      .references((): AnySQLiteColumn => triageRunSeals.triageRunSealId),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("triage_run_seal_id_unique").on(table.sealId),
    uniqueIndex("triage_run_snapshot_manifest_unique").on(
      table.snapshotId,
      table.corpusManifestId
    ),
    check("triage_run_kind", sql`${table.kind} IN ('main', 'variant')`),
    check("triage_run_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const triageRunMembers = sqliteTable(
  "triage_run_member",
  {
    triageRunMemberId: text("triage_run_member_id").primaryKey(),
    triageRunId: text("triage_run_id")
      .notNull()
      .references(() => triageRuns.triageRunId, { onDelete: "restrict" }),
    candidateId: text("candidate_id")
      .notNull()
      .references(() => candidates.candidateId, { onDelete: "restrict" }),
    importOrdinal: integer("import_ordinal").notNull(),
    initialResultId: text("initial_result_id")
      .notNull()
      .references(() => candidateTriageResults.candidateTriageResultId, {
        onDelete: "restrict"
      }),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("triage_run_member_run_candidate_unique").on(
      table.triageRunId,
      table.candidateId
    ),
    uniqueIndex("triage_run_member_run_ordinal_unique").on(
      table.triageRunId,
      table.importOrdinal
    ),
    uniqueIndex("triage_run_member_result_unique").on(table.initialResultId),
    index("triage_run_member_run_access").on(
      table.triageRunId,
      table.candidateId,
      table.importOrdinal,
      table.initialResultId
    ),
    check("triage_run_member_import_ordinal", sql`${table.importOrdinal} >= 0`),
    check("triage_run_member_created_at", sql`${table.createdAt} >= 0`)
  ]
);

export const triageRunSeals = sqliteTable(
  "triage_run_seal",
  {
    triageRunSealId: text("triage_run_seal_id").primaryKey(),
    triageRunId: text("triage_run_id")
      .notNull()
      .references(() => triageRuns.triageRunId, { onDelete: "restrict" }),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("triage_run_seal_run_unique").on(table.triageRunId),
    check("triage_run_seal_created_at", sql`${table.createdAt} >= 0`)
  ]
);
