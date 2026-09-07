import { afterEach, describe, expect, it } from "vitest";

import {
  EXTRACTION_LIMITS,
  ok,
  sha256Hex,
  type Result
} from "../../packages/core/src/index.js";
import {
  createFixtureExtractionAdapter,
  createSyntheticCandidateSourceAdapter
} from "../../packages/runtime/src/adapters/index.js";
import {
  runImmediateTransaction,
  type ImmediateTransactionContext
} from "../../packages/runtime/src/commands/index.js";
import type { RuntimeDatabaseConnection } from "../../packages/runtime/src/db/index.js";
import {
  insertCandidate,
  insertCandidateDocument,
  insertSourceDocument,
  prepareCandidate,
  prepareCandidateDocument,
  prepareSourceDocument,
  readCandidate,
  readCandidateDocument,
  readSourceDocument
} from "../../packages/runtime/src/entities/index.js";
import { type RuntimeError } from "../../packages/runtime/src/errors/index.js";
import {
  insertExtractionArtifact,
  insertExtractionFailure,
  insertExtractionSpec,
  prepareExtractionArtifact,
  prepareExtractionFailure,
  prepareExtractionSpec,
  readExtractionArtifact,
  readExtractionArtifactByContentHash,
  readExtractionFailure,
  readExtractionFailureByContentHash,
  readExtractionSpec,
  readExtractionSpecByContentHash
} from "../../packages/runtime/src/extraction/index.js";
import {
  countRow,
  nativeDatabase,
  openMigratedDatabase,
  removeTemporaryDatabases
} from "./harness/database.js";
import { unwrap } from "./harness/results.js";

const TEST_TIMESTAMP = 1_788_700_000_000;
const PROMPT_HASH = sha256Hex("extraction-prompt-template-v1");
const SCHEMA_HASH = sha256Hex("extraction-schema-v1");

function inTransaction<TValue>(
  connection: RuntimeDatabaseConnection,
  work: (context: ImmediateTransactionContext) => TValue
): TValue {
  return unwrap(runImmediateTransaction(connection, (context) => ok(work(context))));
}

afterEach(removeTemporaryDatabases);

describe("synthetic candidate source adapter ingestion", () => {
  it("paginates and ingests candidate records with full relational persistence", async () => {
    const connection = await openMigratedDatabase("adapter-candidate-ingest");

    const sourceAdapter = createSyntheticCandidateSourceAdapter({
      records: [
        {
          sourceKey: "tier-one/0001",
          channel: "inbound",
          documents: [
            {
              documentKind: "resume",
              label: "Resume",
              documentOrdinal: 0,
              rawText: "Lead Engineer with 10 years experience building distributed data engines."
            }
          ],
          applicationAnswers: {
            workAuthorization: {
              questionKey: "work_auth",
              selectedOptionKey: "authorized_no_sponsorship",
              freeText: undefined,
              provenance: {
                collectedBy: "recruiting_portal",
                formId: "form-001",
                questionId: "q-auth",
                collectedAt: TEST_TIMESTAMP
              }
            }
          }
        },
        {
          sourceKey: "tier-one/0002",
          channel: "sourced",
          documents: [
            {
              documentKind: "resume",
              label: "Resume",
              documentOrdinal: 0,
              rawText: "Staff Engineer experienced in high throughput streaming pipelines."
            },
            {
              documentKind: "cover_letter",
              label: "Cover Letter",
              documentOrdinal: 1,
              rawText: "I am writing to express my interest in the Applied AI Engineer position."
            }
          ],
          applicationAnswers: {
            workAuthorization: undefined
          }
        },
        {
          sourceKey: "tier-one/0003",
          channel: "inbound",
          documents: [
            {
              documentKind: "resume",
              label: "Resume",
              documentOrdinal: 0,
              rawText: "Senior Systems Engineer specializing in SQLite internals and schema engines."
            }
          ],
          applicationAnswers: {
            workAuthorization: {
              questionKey: "work_auth",
              selectedOptionKey: "sponsorship_required",
              freeText: "Needs H-1B transfer",
              provenance: {
                collectedBy: "recruiting_portal",
                formId: "form-001",
                questionId: "q-auth",
                collectedAt: TEST_TIMESTAMP
              }
            }
          }
        }
      ]
    });

    // Page 1: fetch first 2 records
    const page1Result = await sourceAdapter.listCandidates({
      cursor: undefined,
      limit: 2
    });
    expect(page1Result.ok).toBe(true);
    if (!page1Result.ok) return;

    expect(page1Result.value.records.length).toBe(2);
    expect(page1Result.value.nextCursor).toBeDefined();

    // Page 2: fetch remaining 1 record
    const page2Result = await sourceAdapter.listCandidates({
      cursor: page1Result.value.nextCursor,
      limit: 2
    });
    expect(page2Result.ok).toBe(true);
    if (!page2Result.ok) return;

    expect(page2Result.value.records.length).toBe(1);
    expect(page2Result.value.nextCursor).toBeUndefined();

    const allRecords = [
      ...page1Result.value.records,
      ...page2Result.value.records
    ];
    expect(allRecords.length).toBe(3);

    // Persist all candidates and documents in SQLite
    let candidateIndex = 0;
    inTransaction(connection, (context) => {
      for (const record of allRecords) {
        candidateIndex += 1;
        const candidateId = `candidate-${candidateIndex}`;

        unwrap(
          insertCandidate(
            context,
            unwrap(
              prepareCandidate({
                candidateId,
                sourceSystem: sourceAdapter.descriptor.sourceSystem,
                sourceKey: record.sourceKey,
                channel: record.channel,
                corpusTag: "main",
                createdAt: TEST_TIMESTAMP + candidateIndex
              })
            )
          )
        );

        let docIndex = 0;
        for (const doc of record.documents) {
          docIndex += 1;
          const sourceDocumentId = `source-doc-${candidateIndex}-${docIndex}`;
          const candidateDocumentId = `candidate-doc-${candidateIndex}-${docIndex}`;

          unwrap(
            insertSourceDocument(
              context,
              unwrap(
                prepareSourceDocument({
                  sourceDocumentId,
                  rawText: doc.rawText,
                  normalizedText: doc.rawText.trim(),
                  createdAt: TEST_TIMESTAMP + candidateIndex
                })
              )
            )
          );

          unwrap(
            insertCandidateDocument(
              context,
              unwrap(
                prepareCandidateDocument({
                  candidateDocumentId,
                  candidateId,
                  sourceDocumentId,
                  documentKind: doc.documentKind,
                  label: doc.label,
                  documentOrdinal: doc.documentOrdinal,
                  createdAt: TEST_TIMESTAMP + candidateIndex
                })
              )
            )
          );
        }
      }
    });

    // Read back and verify persisted state
    inTransaction(connection, (context) => {
      // Candidate 1
      const c1 = unwrap(readCandidate(context, "candidate-1"));
      expect(c1).toBeDefined();
      expect(c1?.candidateId).toBe("candidate-1");
      expect(c1?.sourceSystem).toBe("ats_synthetic");
      expect(c1?.sourceKey).toBe("tier-one/0001");
      expect(c1?.channel).toBe("inbound");
      expect(c1?.corpusTag).toBe("main");
      expect(c1?.isSynthetic).toBe(true);

      const d1 = unwrap(readSourceDocument(context, "source-doc-1-1"));
      expect(d1).toBeDefined();
      expect(d1?.rawText).toContain("Lead Engineer");
      expect(d1?.normalizedText).toContain("Lead Engineer");

      const cd1 = unwrap(readCandidateDocument(context, "candidate-doc-1-1"));
      expect(cd1).toBeDefined();
      expect(cd1?.candidateId).toBe("candidate-1");
      expect(cd1?.sourceDocumentId).toBe("source-doc-1-1");
      expect(cd1?.documentKind).toBe("resume");
      expect(cd1?.documentOrdinal).toBe(0);

      // Candidate 2 has two documents
      const cd2_1 = unwrap(readCandidateDocument(context, "candidate-doc-2-1"));
      const cd2_2 = unwrap(readCandidateDocument(context, "candidate-doc-2-2"));
      expect(cd2_1?.documentKind).toBe("resume");
      expect(cd2_2?.documentKind).toBe("cover_letter");
      expect(cd2_2?.documentOrdinal).toBe(1);

      // Candidate 3
      const c3 = unwrap(readCandidate(context, "candidate-3"));
      expect(c3?.sourceKey).toBe("tier-one/0003");
      expect(c3?.channel).toBe("inbound");
    });

    // Verify structured work authorization contract isolation
    // Work auth is on applicationAnswers and not in document text
    const firstRecord = allRecords[0];
    const secondRecord = allRecords[1];
    const thirdRecord = allRecords[2];
    expect(firstRecord?.applicationAnswers.workAuthorization?.selectedOptionKey).toBe(
      "authorized_no_sponsorship"
    );
    expect(secondRecord?.applicationAnswers.workAuthorization).toBeUndefined();
    expect(thirdRecord?.applicationAnswers.workAuthorization?.freeText).toBe(
      "Needs H-1B transfer"
    );

    expect(connection.close().ok).toBe(true);
  });
});

describe("fixture extraction adapter and artifact persistence", () => {
  it("executes fixture extraction, persists spec and artifact, and reads back with exact fidelity", async () => {
    const connection = await openMigratedDatabase("adapter-extraction-flow");

    // 1. Prepare and insert an extraction spec
    const specDraftInput = {
      extractionSpecId: "extraction-spec-1",
      content: {
        modelId: "mock-evaluator-v1",
        extractorVersion: "evaluator-v1",
        promptTemplateVersion: "prompt-v1",
        promptHash: PROMPT_HASH,
        schemaHash: SCHEMA_HASH,
        dimensionId: "system_architecture",
        dimensionDefinition: "Demonstrated experience designing reliable distributed systems.",
        jobRelatedJustification: "Role requires building high availability data pipelines.",
        limits: { ...EXTRACTION_LIMITS }
      },
      createdAt: TEST_TIMESTAMP
    };

    const preparedSpec = unwrap(prepareExtractionSpec(specDraftInput));

    inTransaction(connection, (context) => {
      unwrap(insertExtractionSpec(context, preparedSpec));
    });

    // Read back spec
    inTransaction(connection, (context) => {
      const readSpec = unwrap(readExtractionSpec(context, "extraction-spec-1"));
      expect(readSpec).toBeDefined();
      expect(readSpec?.contentHash).toBe(preparedSpec.contentHash);
      expect(readSpec?.dimensionId).toBe("system_architecture");

      const readSpecByHash = unwrap(
        readExtractionSpecByContentHash(context, preparedSpec.contentHash)
      );
      expect(readSpecByHash?.extractionSpecId).toBe("extraction-spec-1");
    });

    // 2. Configure fixture extraction adapter matching spec content hash
    const fixtureResponseBody = JSON.stringify({
      dimensionId: "system_architecture",
      proposedLevel: "strong",
      quotes: [
        {
          quote: "built distributed data engines",
          polarity: "supporting"
        }
      ]
    });

    const extractionAdapter = createFixtureExtractionAdapter({
      fixtures: {
        [preparedSpec.contentHash]: fixtureResponseBody
      }
    });

    expect(extractionAdapter.hasFixture(preparedSpec.contentHash)).toBe(true);

    const docText = "Lead Engineer who built distributed data engines with 99.99% uptime.";

    // Run extraction through adapter
    const extractionResult = await extractionAdapter.extract({
      extractionSpecHash: preparedSpec.contentHash,
      documents: [
        {
          documentId: "source-doc-extract-1",
          documentKind: "resume",
          normalizedText: docText,
          normalizedHash: sha256Hex(docText)
        }
      ],
      instructions: "Extract evidence of system architecture skills."
    });

    expect(extractionResult.ok).toBe(true);
    if (!extractionResult.ok) return;

    expect(extractionResult.value.extractionSpecHash).toBe(preparedSpec.contentHash);
    expect(extractionResult.value.body).toBe(fixtureResponseBody);
    expect(extractionResult.value.bodyHash).toBe(sha256Hex(fixtureResponseBody));

    // 3. Persist source document and extraction artifact
    inTransaction(connection, (context) => {
      unwrap(
        insertSourceDocument(
          context,
          unwrap(
            prepareSourceDocument({
              sourceDocumentId: "source-doc-extract-1",
              rawText: docText,
              normalizedText: docText,
              createdAt: TEST_TIMESTAMP
            })
          )
        )
      );

      const quoteStart = docText.indexOf("built distributed data engines");
      const quoteEnd = quoteStart + "built distributed data engines".length;

      const artifactDraft = {
        extractionArtifactId: "extraction-artifact-1",
        specId: "extraction-spec-1",
        sourceDocumentId: "source-doc-extract-1",
        acceptedOutput: {
          dimensionId: "system_architecture",
          proposedLevel: "strong" as const,
          spans: [
            {
              start: quoteStart,
              end: quoteEnd,
              quotedText: "built distributed data engines",
              polarity: "supporting" as const,
              matchQuality: "exact" as const
            }
          ]
        },
        rejectedClaims: [
          {
            kind: "unlocated_quote" as const,
            quotedText: "microservices on k8s",
            reason: "Quote not present in candidate resume."
          }
        ],
        createdAt: TEST_TIMESTAMP + 1
      };

      const preparedArtifact = unwrap(prepareExtractionArtifact(artifactDraft));
      unwrap(insertExtractionArtifact(context, preparedArtifact));
    });

    // 4. Read back artifact
    inTransaction(connection, (context) => {
      const artifact = unwrap(readExtractionArtifact(context, "extraction-artifact-1"));
      expect(artifact).toBeDefined();
      expect(artifact?.specId).toBe("extraction-spec-1");
      expect(artifact?.sourceDocumentId).toBe("source-doc-extract-1");
      expect(artifact?.acceptedOutput.proposedLevel).toBe("strong");
      expect(artifact?.acceptedOutput.spans.length).toBe(1);
      expect(artifact?.acceptedOutput.spans[0]?.quotedText).toBe(
        "built distributed data engines"
      );
      expect(artifact?.rejectedClaims.length).toBe(1);
      expect(artifact?.rejectedClaims[0]?.kind).toBe("unlocated_quote");

      const artifactByHash = unwrap(
        readExtractionArtifactByContentHash(context, artifact!.contentHash)
      );
      expect(artifactByHash?.extractionArtifactId).toBe("extraction-artifact-1");
    });

    expect(connection.close().ok).toBe(true);
  });
});

describe("extraction failure handling and persistence", () => {
  it("returns error on missing fixture and persists extraction failure record", async () => {
    const connection = await openMigratedDatabase("adapter-extraction-failure");

    const extractionAdapter = createFixtureExtractionAdapter();
    const missingHash = sha256Hex("missing-spec-content");

    const failedResult = await extractionAdapter.extract({
      extractionSpecHash: missingHash,
      documents: [
        {
          documentId: "source-doc-failure-1",
          documentKind: "resume",
          normalizedText: "Candidate resume",
          normalizedHash: sha256Hex("Candidate resume")
        }
      ],
      instructions: "Extract skills."
    });

    expect(failedResult.ok).toBe(false);
    if (failedResult.ok) return;
    expect(failedResult.error.code).toBe("persistence_failed");
    expect(failedResult.error.message).toContain("Fixture not found");

    // Persist extraction spec, source document, and failure record
    const specDraftInput = {
      extractionSpecId: "extraction-spec-failed",
      content: {
        modelId: "mock-evaluator-v1",
        extractorVersion: "evaluator-v1",
        promptTemplateVersion: "prompt-v1",
        promptHash: PROMPT_HASH,
        schemaHash: SCHEMA_HASH,
        dimensionId: "system_architecture",
        dimensionDefinition: "Demonstrated experience designing reliable distributed systems.",
        jobRelatedJustification: "Role requires building high availability data pipelines.",
        limits: { ...EXTRACTION_LIMITS }
      },
      createdAt: TEST_TIMESTAMP
    };

    inTransaction(connection, (context) => {
      unwrap(insertExtractionSpec(context, unwrap(prepareExtractionSpec(specDraftInput))));
      unwrap(
        insertSourceDocument(
          context,
          unwrap(
            prepareSourceDocument({
              sourceDocumentId: "source-doc-failure-1",
              rawText: "Candidate resume text",
              normalizedText: "Candidate resume text",
              createdAt: TEST_TIMESTAMP
            })
          )
        )
      );

      const failureDraft = {
        extractionFailureId: "extraction-failure-1",
        specId: "extraction-spec-failed",
        sourceDocumentId: "source-doc-failure-1",
        errorClass: "structurally_invalid" as const,
        responseHash: sha256Hex("invalid-response-payload"),
        responseByteLength: 24,
        diagnostic: {
          summary: "Model output failed schema validation",
          details: ["Field proposedLevel was missing from response payload."]
        },
        createdAt: TEST_TIMESTAMP + 2
      };

      unwrap(
        insertExtractionFailure(
          context,
          unwrap(prepareExtractionFailure(failureDraft))
        )
      );
    });

    // Read back failure record
    inTransaction(connection, (context) => {
      const failure = unwrap(
        readExtractionFailure(context, "extraction-failure-1")
      );
      expect(failure).toBeDefined();
      expect(failure?.specId).toBe("extraction-spec-failed");
      expect(failure?.sourceDocumentId).toBe("source-doc-failure-1");
      expect(failure?.errorClass).toBe("structurally_invalid");
      expect(failure?.diagnostic.summary).toBe("Model output failed schema validation");
      expect(failure?.diagnostic.details.length).toBe(1);

      const failureByHash = unwrap(
        readExtractionFailureByContentHash(context, failure!.contentHash)
      );
      expect(failureByHash?.extractionFailureId).toBe("extraction-failure-1");
    });

    expect(connection.close().ok).toBe(true);
  });
});

describe("extraction table immutability triggers", () => {
  it("rejects update, delete, and replacement on extraction_spec, extraction_artifact, and extraction_failure", async () => {
    const connection = await openMigratedDatabase("adapter-immutability-triggers");

    // Setup base rows
    inTransaction(connection, (context) => {
      unwrap(
        insertExtractionSpec(
          context,
          unwrap(
            prepareExtractionSpec({
              extractionSpecId: "spec-immutable-1",
              content: {
                modelId: "mock-model",
                extractorVersion: "v1",
                promptTemplateVersion: "p1",
                promptHash: PROMPT_HASH,
                schemaHash: SCHEMA_HASH,
                dimensionId: "system_architecture",
                dimensionDefinition: "Arch definition.",
                jobRelatedJustification: "Arch justification.",
                limits: { ...EXTRACTION_LIMITS }
              },
              createdAt: TEST_TIMESTAMP
            })
          )
        )
      );

      unwrap(
        insertSourceDocument(
          context,
          unwrap(
            prepareSourceDocument({
              sourceDocumentId: "source-doc-immutable-1",
              rawText: "Sample text for immutability tests.",
              normalizedText: "Sample text for immutability tests.",
              createdAt: TEST_TIMESTAMP
            })
          )
        )
      );

      unwrap(
        insertExtractionArtifact(
          context,
          unwrap(
            prepareExtractionArtifact({
              extractionArtifactId: "artifact-immutable-1",
              specId: "spec-immutable-1",
              sourceDocumentId: "source-doc-immutable-1",
              acceptedOutput: {
                dimensionId: "system_architecture",
                proposedLevel: "weak",
                spans: [
                  {
                    start: 0,
                    end: 11,
                    quotedText: "Sample text",
                    polarity: "supporting",
                    matchQuality: "exact"
                  }
                ]
              },
              rejectedClaims: [],
              createdAt: TEST_TIMESTAMP
            })
          )
        )
      );

      unwrap(
        insertExtractionFailure(
          context,
          unwrap(
            prepareExtractionFailure({
              extractionFailureId: "failure-immutable-1",
              specId: "spec-immutable-1",
              sourceDocumentId: "source-doc-immutable-1",
              errorClass: "oversized_response",
              responseHash: sha256Hex("overflow"),
              responseByteLength: 99999,
              diagnostic: {
                summary: "Response exceeds maximum byte limit",
                details: []
              },
              createdAt: TEST_TIMESTAMP
            })
          )
        )
      );
    });

    const database = nativeDatabase(connection);

    // 1. extraction_spec immutability triggers
    expect(() =>
      database
        .prepare("UPDATE extraction_spec SET model_id = 'tampered' WHERE extraction_spec_id = ?")
        .run("spec-immutable-1")
    ).toThrow(/extraction_spec is immutable/u);

    expect(() =>
      database
        .prepare("DELETE FROM extraction_spec WHERE extraction_spec_id = ?")
        .run("spec-immutable-1")
    ).toThrow(/extraction_spec is immutable/u);

    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO extraction_spec (
            extraction_spec_id, content_json, content_hash, model_id, extractor_version,
            prompt_hash, schema_hash, dimension_id, created_at
          ) VALUES (?, '{}', ?, 'm', 'v', ?, ?, 'd', ?)`
        )
        .run(
          "spec-immutable-1",
          sha256Hex("{}"),
          PROMPT_HASH,
          SCHEMA_HASH,
          TEST_TIMESTAMP
        )
    ).toThrow(/extraction_spec is immutable/u);

    // 2. extraction_artifact immutability triggers
    expect(() =>
      database
        .prepare(
          "UPDATE extraction_artifact SET created_at = 999 WHERE extraction_artifact_id = ?"
        )
        .run("artifact-immutable-1")
    ).toThrow(/extraction_artifact is immutable/u);

    expect(() =>
      database
        .prepare(
          "DELETE FROM extraction_artifact WHERE extraction_artifact_id = ?"
        )
        .run("artifact-immutable-1")
    ).toThrow(/extraction_artifact is immutable/u);

    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO extraction_artifact (
            extraction_artifact_id, spec_id, source_document_id,
            accepted_output_json, accepted_output_hash,
            rejected_claims_json, rejected_claims_hash,
            content_hash, created_at
          ) VALUES (?, 'spec-immutable-1', 'source-doc-immutable-1', '{"spans":[]}', ?, '[]', ?, ?, ?)`
        )
        .run(
          "artifact-immutable-1",
          sha256Hex('{"spans":[]}'),
          sha256Hex("[]"),
          sha256Hex("content"),
          TEST_TIMESTAMP
        )
    ).toThrow(/extraction_artifact is immutable/u);

    // 3. extraction_failure immutability triggers
    expect(() =>
      database
        .prepare(
          "UPDATE extraction_failure SET error_class = 'cardinality_exceeded' WHERE extraction_failure_id = ?"
        )
        .run("failure-immutable-1")
    ).toThrow(/extraction_failure is immutable/u);

    expect(() =>
      database
        .prepare(
          "DELETE FROM extraction_failure WHERE extraction_failure_id = ?"
        )
        .run("failure-immutable-1")
    ).toThrow(/extraction_failure is immutable/u);

    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO extraction_failure (
            extraction_failure_id, spec_id, source_document_id, error_class,
            response_hash, response_byte_length, diagnostic_json, diagnostic_hash,
            content_hash, created_at
          ) VALUES (?, 'spec-immutable-1', 'source-doc-immutable-1', 'cardinality_exceeded', ?, 10, '{}', ?, ?, ?)`
        )
        .run(
          "failure-immutable-1",
          sha256Hex("resp"),
          sha256Hex("{}"),
          sha256Hex("fail-content"),
          TEST_TIMESTAMP
        )
    ).toThrow(/extraction_failure is immutable/u);

    // Verify row counts remain unchanged
    expect(countRow(database, "SELECT COUNT(*) AS total FROM extraction_spec")).toBe(1);
    expect(countRow(database, "SELECT COUNT(*) AS total FROM extraction_artifact")).toBe(1);
    expect(countRow(database, "SELECT COUNT(*) AS total FROM extraction_failure")).toBe(1);

    expect(connection.close().ok).toBe(true);
  });
});
