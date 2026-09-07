import { describe, expect, it } from "vitest";

import * as runtime from "./index.js";

describe("runtime public API", () => {
  it("exports the audit, connection, command protocol, immutable entity, schema, and error foundation", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "ActorDraftSchema",
      "ActorKindSchema",
      "ActorSchema",
      "AuditEventDraftSchema",
      "AuditEventNameSchema",
      "AuditEventSchema",
      "CandidateChannelSchema",
      "CandidateDocumentDraftSchema",
      "CandidateDocumentSchema",
      "CandidateDraftSchema",
      "CandidateSchema",
      "CommandConflictReasonSchema",
      "CommandEnvelopeSchema",
      "CommandExecutionMetadataSchema",
      "CommandNameSchema",
      "CommandReceiptSchema",
      "CommandStatusSchema",
      "CorpusTagSchema",
      "DocumentKindSchema",
      "MAXIMUM_DOCUMENTS_PER_CANDIDATE",
      "MAXIMUM_NORMALIZED_DOCUMENT_BYTES",
      "MAXIMUM_NORMALIZED_DOCUMENT_LENGTH",
      "MAXIMUM_RAW_DOCUMENT_BYTES",
      "RuntimeDatabaseOptionsSchema",
      "RuntimeErrorSchema",
      "SYSTEM_ACTOR_ID",
      "SourceDocumentDraftSchema",
      "SourceDocumentSchema",
      "SqliteConfigurationSchema",
      "actors",
      "appendAuditEvent",
      "auditEvents",
      "candidateDocuments",
      "candidates",
      "commandReceipts",
      "createRuntimeError",
      "executeCommand",
      "insertActor",
      "insertCandidate",
      "insertCandidateDocument",
      "insertSourceDocument",
      "openRuntimeDatabase",
      "prepareActor",
      "prepareAuditEvent",
      "prepareCandidate",
      "prepareCandidateDocument",
      "prepareSourceDocument",
      "readActor",
      "readAuditEvent",
      "readCandidate",
      "readCandidateDocument",
      "readSourceDocument",
      "runImmediateTransaction",
      "runtimeMigrationSmoke",
      "sourceDocuments"
    ]);
  });

  it("creates errors with optional safe details", () => {
    expect(
      runtime.createRuntimeError("migration_required", "Migration required", false, {
        schemaVersion: 0
      })
    ).toEqual({
      code: "migration_required",
      message: "Migration required",
      retryable: false,
      details: { schemaVersion: 0 }
    });
  });
});
