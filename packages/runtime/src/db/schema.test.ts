import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import {
  actors,
  auditEvents,
  candidateDocuments,
  candidates,
  commandReceipts,
  corpusManifestSeals,
  corpusManifests,
  corpusMemberDocuments,
  corpusMembers,
  dimensionAssessmentEvidenceSpans,
  dimensionAssessments,
  evidenceGaps,
  evidenceSpans,
  extractionArtifacts,
  extractionFailures,
  extractionRuns,
  extractionSpecs,
  requirements,
  roles,
  rubricDimensions,
  rubrics,
  runInputSnapshots,
  sourceDocuments
} from "./schema.js";

describe("runtime Drizzle schema", () => {
  it("exposes every command receipt integrity constraint", () => {
    expect(
      getTableConfig(commandReceipts)
        .checks.map((constraint) => constraint.name)
        .sort()
    ).toEqual([
      "command_receipt_completed_at",
      "command_receipt_created_at",
      "command_receipt_expected_version",
      "command_receipt_status",
      "command_receipt_terminal_shape"
    ]);
  });

  it("exposes the neutral audit constraints and command ordering index", () => {
    const config = getTableConfig(auditEvents);
    expect(config.checks.map((constraint) => constraint.name).sort()).toEqual([
      "audit_event_actor_display_name",
      "audit_event_command_ordinal_pair",
      "audit_event_event_ordinal",
      "audit_event_name",
      "audit_event_occurred_at",
      "audit_event_payload_hash",
      "audit_event_recorded_at",
      "audit_event_version"
    ]);
    expect(config.indexes.map((index) => index.config.name)).toEqual([
      "audit_event_command_ordinal_unique"
    ]);
    expect(config.foreignKeys).toHaveLength(1);
  });

  it("exposes the immutable actor and candidate identity constraints", () => {
    expect(
      getTableConfig(actors)
        .checks.map((constraint) => constraint.name)
        .sort()
    ).toEqual([
      "actor_created_at",
      "actor_display_name",
      "actor_kind",
      "actor_system_identity"
    ]);

    const candidateConfig = getTableConfig(candidates);
    expect(candidateConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "candidate_channel",
      "candidate_corpus_tag",
      "candidate_created_at",
      "candidate_is_synthetic",
      "candidate_source_key",
      "candidate_source_system"
    ]);
    expect(candidateConfig.indexes.map((index) => index.config.name)).toEqual([
      "candidate_source_unique"
    ]);
  });

  it("exposes the content-addressed document constraints and access paths", () => {
    const documentConfig = getTableConfig(sourceDocuments);
    expect(documentConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "source_document_created_at",
      "source_document_normalized_byte_length",
      "source_document_normalized_hash",
      "source_document_normalized_length",
      "source_document_raw_byte_length",
      "source_document_raw_hash"
    ]);
    expect(documentConfig.indexes.map((index) => index.config.name).sort()).toEqual([
      "source_document_normalized_hash",
      "source_document_raw_hash_unique"
    ]);

    const ownershipConfig = getTableConfig(candidateDocuments);
    expect(ownershipConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "candidate_document_created_at",
      "candidate_document_kind",
      "candidate_document_label",
      "candidate_document_ordinal"
    ]);
    expect(ownershipConfig.indexes.map((index) => index.config.name).sort()).toEqual([
      "candidate_document_ordinal_unique",
      "candidate_document_source_unique"
    ]);
    expect(ownershipConfig.foreignKeys).toHaveLength(2);
  });

  it("exposes the corpus manifest seal constraints and deferred cyclic pair", () => {
    const manifestConfig = getTableConfig(corpusManifests);
    expect(manifestConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "corpus_manifest_content_hash",
      "corpus_manifest_created_at",
      "corpus_manifest_kind"
    ]);
    expect(manifestConfig.indexes.map((index) => index.config.name).sort()).toEqual([
      "corpus_manifest_content_hash_unique",
      "corpus_manifest_seal_id_unique"
    ]);
    expect(manifestConfig.foreignKeys).toHaveLength(1);
    expect(manifestConfig.foreignKeys[0]!.onDelete).toBeUndefined();

    const memberConfig = getTableConfig(corpusMembers);
    expect(memberConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "corpus_member_created_at",
      "corpus_member_import_ordinal"
    ]);
    expect(memberConfig.indexes.map((index) => index.config.name).sort()).toEqual([
      "corpus_member_manifest_candidate_unique",
      "corpus_member_manifest_ordinal_unique"
    ]);
    expect(memberConfig.foreignKeys).toHaveLength(2);

    const memberDocumentConfig = getTableConfig(corpusMemberDocuments);
    expect(memberDocumentConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "corpus_member_document_created_at",
      "corpus_member_document_ordinal"
    ]);
    expect(memberDocumentConfig.indexes.map((index) => index.config.name).sort()).toEqual([
      "corpus_member_document_candidate_document_unique",
      "corpus_member_document_ordinal_unique"
    ]);

    const sealConfig = getTableConfig(corpusManifestSeals);
    expect(sealConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "corpus_manifest_seal_created_at"
    ]);
    expect(sealConfig.indexes.map((index) => index.config.name)).toEqual([
      "corpus_manifest_seal_manifest_unique"
    ]);
    expect(sealConfig.foreignKeys).toHaveLength(1);
  });

  it("exposes the immutable role and rubric constraints", () => {
    const roleConfig = getTableConfig(roles);
    expect(roleConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "role_created_at",
      "role_title"
    ]);
    expect(roleConfig.indexes).toEqual([]);
    expect(roleConfig.foreignKeys).toHaveLength(0);

    const requirementConfig = getTableConfig(requirements);
    expect(requirementConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "requirement_created_at",
      "requirement_description",
      "requirement_kind"
    ]);
    expect(requirementConfig.foreignKeys).toHaveLength(1);

    const rubricConfig = getTableConfig(rubrics);
    expect(rubricConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "rubric_created_at",
      "rubric_version"
    ]);
    expect(rubricConfig.indexes.map((index) => index.config.name)).toEqual([
      "rubric_role_version_unique"
    ]);
    expect(rubricConfig.foreignKeys).toHaveLength(1);

    const dimensionConfig = getTableConfig(rubricDimensions);
    expect(dimensionConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "rubric_dimension_created_at",
      "rubric_dimension_definition",
      "rubric_dimension_job_related_justification",
      "rubric_dimension_ordinal",
      "rubric_dimension_required",
      "rubric_dimension_weight"
    ]);
    expect(dimensionConfig.indexes.map((index) => index.config.name).sort()).toEqual([
      "rubric_dimension_rubric_dimension_id_unique",
      "rubric_dimension_rubric_ordinal_unique"
    ]);
    expect(dimensionConfig.foreignKeys).toHaveLength(1);
  });

  it("exposes the immutable evidence and extraction constraints", () => {
    const runConfig = getTableConfig(extractionRuns);
    expect(runConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "extraction_run_created_at",
      "extraction_run_dropped_quotes_hash",
      "extraction_run_dropped_quotes_json",
      "extraction_run_fixture_key",
      "extraction_run_model_id",
      "extraction_run_spans_located",
      "extraction_run_spans_returned"
    ]);
    expect(runConfig.indexes).toEqual([]);
    expect(runConfig.foreignKeys).toHaveLength(0);

    const spanConfig = getTableConfig(evidenceSpans);
    expect(spanConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "evidence_span_created_at",
      "evidence_span_dimension_id",
      "evidence_span_end",
      "evidence_span_extractor_version",
      "evidence_span_match_quality",
      "evidence_span_polarity",
      "evidence_span_quoted_text",
      "evidence_span_source",
      "evidence_span_start"
    ]);
    expect(spanConfig.indexes.map((index) => index.config.name).sort()).toEqual([
      "evidence_span_dimension",
      "evidence_span_document"
    ]);
    expect(spanConfig.foreignKeys).toHaveLength(1);
    expect(spanConfig.foreignKeys[0]!.onDelete).toBe("restrict");

    const gapConfig = getTableConfig(evidenceGaps);
    expect(gapConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "evidence_gap_created_at",
      "evidence_gap_dimension_id",
      "evidence_gap_documents_searched_hash",
      "evidence_gap_documents_searched_json",
      "evidence_gap_reason_code"
    ]);
    expect(gapConfig.indexes.map((index) => index.config.name)).toEqual([
      "evidence_gap_dimension"
    ]);

    const assessmentConfig = getTableConfig(dimensionAssessments);
    expect(assessmentConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "dimension_assessment_actor_presence",
      "dimension_assessment_created_at",
      "dimension_assessment_dimension_id",
      "dimension_assessment_level",
      "dimension_assessment_source"
    ]);
    expect(assessmentConfig.foreignKeys).toHaveLength(1);
    expect(assessmentConfig.foreignKeys[0]!.onDelete).toBe("restrict");

    const associationConfig = getTableConfig(dimensionAssessmentEvidenceSpans);
    expect(associationConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "dimension_assessment_evidence_span_created_at",
      "dimension_assessment_evidence_span_ordinal"
    ]);
    expect(associationConfig.indexes.map((index) => index.config.name).sort()).toEqual([
      "dimension_assessment_evidence_span_ordinal_unique",
      "dimension_assessment_evidence_span_unique"
    ]);
    expect(associationConfig.foreignKeys).toHaveLength(2);
    expect(
      associationConfig.foreignKeys.every((foreignKey) => foreignKey.onDelete === "restrict")
    ).toBe(true);
  });

  it("exposes the content-addressed extraction spec constraints and access paths", () => {
    const specConfig = getTableConfig(extractionSpecs);
    expect(specConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "extraction_spec_content_hash",
      "extraction_spec_content_json",
      "extraction_spec_created_at",
      "extraction_spec_dimension_id",
      "extraction_spec_extractor_version",
      "extraction_spec_model_id",
      "extraction_spec_prompt_hash",
      "extraction_spec_schema_hash"
    ]);
    expect(specConfig.indexes.map((index) => index.config.name).sort()).toEqual([
      "extraction_spec_content_hash_unique",
      "extraction_spec_dimension"
    ]);
    expect(specConfig.foreignKeys).toHaveLength(0);

    const artifactConfig = getTableConfig(extractionArtifacts);
    expect(artifactConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "extraction_artifact_accepted_output_hash",
      "extraction_artifact_accepted_output_json",
      "extraction_artifact_content_hash",
      "extraction_artifact_created_at",
      "extraction_artifact_rejected_claims_hash",
      "extraction_artifact_rejected_claims_json"
    ]);
    expect(artifactConfig.indexes.map((index) => index.config.name).sort()).toEqual([
      "extraction_artifact_content_hash_unique",
      "extraction_artifact_document",
      "extraction_artifact_spec"
    ]);
    expect(artifactConfig.foreignKeys).toHaveLength(2);
    expect(
      artifactConfig.foreignKeys.every((foreignKey) => foreignKey.onDelete === "restrict")
    ).toBe(true);

    const failureConfig = getTableConfig(extractionFailures);
    expect(failureConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "extraction_failure_content_hash",
      "extraction_failure_created_at",
      "extraction_failure_diagnostic_hash",
      "extraction_failure_diagnostic_json",
      "extraction_failure_error_class",
      "extraction_failure_oversized_response",
      "extraction_failure_response_byte_length",
      "extraction_failure_response_hash"
    ]);
    expect(failureConfig.indexes.map((index) => index.config.name).sort()).toEqual([
      "extraction_failure_content_hash_unique",
      "extraction_failure_document",
      "extraction_failure_error_class",
      "extraction_failure_spec"
    ]);
    expect(failureConfig.foreignKeys).toHaveLength(2);
    expect(
      failureConfig.foreignKeys.every((foreignKey) => foreignKey.onDelete === "restrict")
    ).toBe(true);
  });

  it("exposes the content-addressed run input snapshot constraints and access paths", () => {
    const snapshotConfig = getTableConfig(runInputSnapshots);
    expect(snapshotConfig.checks.map((constraint) => constraint.name).sort()).toEqual([
      "run_input_snapshot_content_hash",
      "run_input_snapshot_content_json",
      "run_input_snapshot_created_at",
      "run_input_snapshot_extractor_version",
      "run_input_snapshot_frozen_date",
      "run_input_snapshot_prompt_template_version",
      "run_input_snapshot_rubric_version"
    ]);
    expect(snapshotConfig.indexes.map((index) => index.config.name).sort()).toEqual([
      "run_input_snapshot_content_hash_unique",
      "run_input_snapshot_frozen_date",
      "run_input_snapshot_role"
    ]);
    expect(snapshotConfig.foreignKeys).toHaveLength(1);
    expect(snapshotConfig.foreignKeys[0]!.onDelete).toBe("restrict");
  });
});
