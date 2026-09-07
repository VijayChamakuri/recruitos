import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import {
  actors,
  auditEvents,
  candidateDocuments,
  candidates,
  commandReceipts,
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
});
