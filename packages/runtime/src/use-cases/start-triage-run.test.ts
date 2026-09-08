import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXTRACTION_LIMITS,
  LockedRubricSchema,
  RUBRIC_V1,
  SCORING_POLICY_V1,
  sha256Hex,
  type LockedRubric,
  type Result
} from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFixtureExtractionAdapter,
  createSyntheticCandidateSourceAdapter
} from "../adapters/index.js";
import {
  runImmediateTransaction,
  type ImmediateTransactionContext
} from "../commands/index.js";
import {
  createIncrementingIdGenerator,
  createRuntime,
  fixedClock,
  type IdGenerator,
  type RuntimeComposition
} from "../composition/index.js";
import {
  insertCorpusManifest,
  insertCorpusManifestSeal,
  insertCorpusMember,
  insertCorpusMemberDocument,
  prepareCorpusManifest,
  prepareCorpusManifestSeal,
  prepareCorpusMember,
  prepareCorpusMemberDocument
} from "../corpus/index.js";
import { openRuntimeDatabase, type RuntimeDatabaseConnection } from "../db/index.js";
import {
  insertCandidate,
  insertCandidateDocument,
  insertSourceDocument,
  prepareCandidate,
  prepareCandidateDocument,
  prepareSourceDocument
} from "../entities/index.js";
import type { RuntimeError } from "../errors/index.js";
import {
  insertExtractionSpec,
  prepareExtractionSpec
} from "../extraction/index.js";
import { insertRole, prepareRole } from "../roles/index.js";
import { runExtractionAttempt } from "../scheduler/index.js";
import {
  insertRunInputSnapshot,
  prepareRunInputSnapshot
} from "../snapshots/index.js";
import {
  START_TRIAGE_RUN_COMMAND_NAME,
  startTriageRun,
  type StartTriageRunInput
} from "./start-triage-run.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const ROLE_ID = "role-applied-ai-engineer";

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function unwrap<T>(result: Result<T, RuntimeError>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function nativeDatabase(connection: RuntimeDatabaseConnection): BetterSqlite3.Database {
  return (connection.database as unknown as { $client: BetterSqlite3.Database }).$client;
}

function scriptedIdGenerator(ids: readonly (string | undefined)[]): IdGenerator {
  let index = 0;
  return Object.freeze({
    next: (): string => {
      const id = ids[index] ?? `test-overflow-${index}`;
      index += 1;
      return id;
    }
  });
}

async function createTestRuntime(
  overrides: Partial<Parameters<typeof createRuntime>[0]> = {}
): Promise<RuntimeComposition> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-start-run-test-"));
  temporaryDirectories.push(directory);
  const result = createRuntime({
    database: { filename: join(directory, "runtime.db"), migrationsFolder },
    clock: fixedClock(CREATED_AT),
    idGenerator: createIncrementingIdGenerator("test"),
    extraction: createFixtureExtractionAdapter(),
    candidateSource: createSyntheticCandidateSourceAdapter(),
    ...overrides
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function seedRole(context: ImmediateTransactionContext, roleId = ROLE_ID): void {
  unwrap(
    insertRole(
      context,
      unwrap(
        prepareRole({
          roleId,
          title: "Applied AI Engineer",
          createdAt: CREATED_AT
        })
      )
    )
  );
}

function seedCandidate(
  context: ImmediateTransactionContext,
  candidateId: string,
  documentCount = 1
): void {
  unwrap(
    insertCandidate(
      context,
      unwrap(
        prepareCandidate({
          candidateId,
          sourceSystem: "synthetic_corpus",
          sourceKey: `tier-one/${candidateId}`,
          channel: "inbound",
          corpusTag: "variant",
          createdAt: CREATED_AT
        })
      )
    )
  );

  for (let docIndex = 0; docIndex < documentCount; docIndex += 1) {
    const rawText = `Candidate ${candidateId} document ${docIndex} text.`;
    const sourceDocumentId = `source-doc-${candidateId}-${docIndex}`;
    unwrap(
      insertSourceDocument(
        context,
        unwrap(
          prepareSourceDocument({
            sourceDocumentId,
            rawText,
            normalizedText: rawText,
            createdAt: CREATED_AT
          })
        )
      )
    );
    unwrap(
      insertCandidateDocument(
        context,
        unwrap(
          prepareCandidateDocument({
            candidateDocumentId: `cand-doc-${candidateId}-${docIndex}`,
            candidateId,
            sourceDocumentId,
            documentKind: docIndex === 0 ? "resume" : "cover_letter",
            label: docIndex === 0 ? "Resume" : "Cover Letter",
            documentOrdinal: docIndex,
            createdAt: CREATED_AT
          })
        )
      )
    );
  }
}

function singleDimensionRubric(): LockedRubric {
  return Object.freeze(
    LockedRubricSchema.parse({
      rubricId: "rubric_single_dim_v1",
      version: 1,
      provenance: {
        authorship: "product-authored",
        restsOn: ["WA-05"]
      },
      dimensions: [
        {
          dimensionId: "applied_ml_llm_systems",
          weight: 3,
          required: true,
          definition: "Evidence of machine learning in product behavior.",
          jobRelatedJustification: "The role builds tooling where model output drives product behavior.",
          levelAnchors: {
            none: "No located span of any polarity.",
            weak: "Machine learning work is named but unanchored.",
            partial: "At least one named system with a real user.",
            strong: "A system in production with users."
          }
        }
      ]
    })
  );
}

describe("startTriageRun", () => {
  it("starts a triage attempt with candidate IDs and auto-creates a sealed variant corpus manifest", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");
      seedCandidate(context, "cand-2");
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-recruiter-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1", "cand-2"]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const execution = result.value;
    expect(execution.metadata.status).toBe("succeeded");
    expect(typeof execution.metadata.commandId).toBe("string");

    const payload = execution.result;
    expect(typeof payload.triageRunId).toBe("string");
    expect(typeof payload.triageAttemptId).toBe("string");
    // 2 candidates * 1 document * 6 dimensions = 12 work items
    expect(payload.workItemCount).toBe(12);

    // Verify database state
    const db = nativeDatabase(runtime.connection);
    const attemptRow = db
      .prepare("SELECT * FROM triage_attempt WHERE triage_attempt_id = ?")
      .get(payload.triageAttemptId) as {
      triage_attempt_id: string;
      kind: string;
      status: string;
      version: number;
    };
    expect(attemptRow).toBeDefined();
    expect(attemptRow.kind).toBe("variant_run");
    expect(attemptRow.status).toBe("in_progress");
    expect(attemptRow.version).toBe(1);

    const workItemRows = db
      .prepare(
        "SELECT * FROM attempt_work_item WHERE triage_attempt_id = ? ORDER BY manifest_ordinal ASC"
      )
      .all(payload.triageAttemptId) as Array<{
      manifest_ordinal: number;
      candidate_id: string;
      state: string;
      work_item_key: string;
    }>;
    expect(workItemRows.length).toBe(12);
    expect(workItemRows[0]?.manifest_ordinal).toBe(0);
    expect(workItemRows[11]?.manifest_ordinal).toBe(11);
    expect(workItemRows.every((item) => item.state === "pending")).toBe(true);
    expect(workItemRows[0]?.candidate_id).toBe("cand-1");
    expect(workItemRows[6]?.candidate_id).toBe("cand-2");
  });

  it("starts a main run with exactly 140 candidates and creates a sealed main corpus manifest", async () => {
    const runtime = await createTestRuntime();
    const candidateIds = Array.from({ length: 140 }, (_, i) => `main-cand-${String(i + 1).padStart(4, "0")}`);

    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      for (const id of candidateIds) {
        seedCandidate(context, id);
      }
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-recruiter-1",
      roleId: ROLE_ID,
      candidateIds,
      kind: "main_run",
      rubric: singleDimensionRubric()
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.result.workItemCount).toBe(140);

    const db = nativeDatabase(runtime.connection);
    const attemptRow = db
      .prepare("SELECT kind, status FROM triage_attempt WHERE triage_attempt_id = ?")
      .get(result.value.result.triageAttemptId) as { kind: string; status: string };
    expect(attemptRow.kind).toBe("main_run");
    expect(attemptRow.status).toBe("in_progress");
  });

  it("starts with an existing sealed corpusManifestId", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");
      seedCandidate(context, "cand-2");

      const manifestContent = {
        kind: "variant" as const,
        members: [
          {
            candidateId: "cand-1",
            importOrdinal: 0,
            documents: [{ candidateDocumentId: "cand-doc-cand-1-0", documentOrdinal: 0 }]
          },
          {
            candidateId: "cand-2",
            importOrdinal: 1,
            documents: [{ candidateDocumentId: "cand-doc-cand-2-0", documentOrdinal: 0 }]
          }
        ]
      };
      unwrap(
        insertCorpusManifest(
          context,
          unwrap(
            prepareCorpusManifest({
              corpusManifestId: "manifest-pre-seeded",
              kind: "variant",
              sealId: "seal-pre-seeded",
              createdAt: CREATED_AT,
              content: manifestContent
            })
          )
        )
      );
      unwrap(
        insertCorpusMember(
          context,
          unwrap(
            prepareCorpusMember({
              corpusMemberId: "member-1",
              manifestId: "manifest-pre-seeded",
              candidateId: "cand-1",
              importOrdinal: 0,
              createdAt: CREATED_AT
            })
          )
        )
      );
      unwrap(
        insertCorpusMemberDocument(
          context,
          unwrap(
            prepareCorpusMemberDocument({
              corpusMemberDocumentId: "member-doc-1",
              corpusMemberId: "member-1",
              candidateDocumentId: "cand-doc-cand-1-0",
              documentOrdinal: 0,
              createdAt: CREATED_AT
            })
          )
        )
      );
      unwrap(
        insertCorpusMember(
          context,
          unwrap(
            prepareCorpusMember({
              corpusMemberId: "member-2",
              manifestId: "manifest-pre-seeded",
              candidateId: "cand-2",
              importOrdinal: 1,
              createdAt: CREATED_AT
            })
          )
        )
      );
      unwrap(
        insertCorpusMemberDocument(
          context,
          unwrap(
            prepareCorpusMemberDocument({
              corpusMemberDocumentId: "member-doc-2",
              corpusMemberId: "member-2",
              candidateDocumentId: "cand-doc-cand-2-0",
              documentOrdinal: 0,
              createdAt: CREATED_AT
            })
          )
        )
      );
      unwrap(
        insertCorpusManifestSeal(
          context,
          unwrap(
            prepareCorpusManifestSeal({
              corpusManifestSealId: "seal-pre-seeded",
              manifestId: "manifest-pre-seeded",
              createdAt: CREATED_AT
            })
          )
        )
      );
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      corpusManifestId: "manifest-pre-seeded"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.result.workItemCount).toBe(12);
  });

  it("starts with an existing sealed corpusManifestId and matching candidateIds", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");

      const manifestContent = {
        kind: "variant" as const,
        members: [
          {
            candidateId: "cand-1",
            importOrdinal: 0,
            documents: [{ candidateDocumentId: "cand-doc-cand-1-0", documentOrdinal: 0 }]
          }
        ]
      };
      unwrap(
        insertCorpusManifest(
          context,
          unwrap(
            prepareCorpusManifest({
              corpusManifestId: "manifest-single",
              kind: "variant",
              sealId: "seal-single",
              createdAt: CREATED_AT,
              content: manifestContent
            })
          )
        )
      );
      unwrap(
        insertCorpusMember(
          context,
          unwrap(
            prepareCorpusMember({
              corpusMemberId: "member-single",
              manifestId: "manifest-single",
              candidateId: "cand-1",
              importOrdinal: 0,
              createdAt: CREATED_AT
            })
          )
        )
      );
      unwrap(
        insertCorpusMemberDocument(
          context,
          unwrap(
            prepareCorpusMemberDocument({
              corpusMemberDocumentId: "member-doc-single",
              corpusMemberId: "member-single",
              candidateDocumentId: "cand-doc-cand-1-0",
              documentOrdinal: 0,
              createdAt: CREATED_AT
            })
          )
        )
      );
      unwrap(
        insertCorpusManifestSeal(
          context,
          unwrap(
            prepareCorpusManifestSeal({
              corpusManifestSealId: "seal-single",
              manifestId: "manifest-single",
              createdAt: CREATED_AT
            })
          )
        )
      );
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      corpusManifestId: "manifest-single",
      candidateIds: ["cand-1"]
    });

    expect(result.ok).toBe(true);
  });

  it("reuses existing run_input_snapshot and extraction_specs by content hash", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");

      // Pre-insert snapshot
      unwrap(
        insertRunInputSnapshot(
          context,
          unwrap(
            prepareRunInputSnapshot({
              runInputSnapshotId: "pre-existing-snapshot",
              content: {
                frozenDate: "2026-09-07",
                roleId: ROLE_ID,
                rubricVersion: "1",
                dimensions: RUBRIC_V1.dimensions.map((dim, ordinal) => ({
                  dimensionId: dim.dimensionId,
                  weight: dim.weight,
                  required: dim.required,
                  definition: dim.definition,
                  jobRelatedJustification: dim.jobRelatedJustification,
                  ordinal
                })),
                scoringPolicy: { ...SCORING_POLICY_V1 },
                extractorVersion: "extractor-v1",
                promptTemplateVersion: "prompt-v1",
                limits: { ...EXTRACTION_LIMITS }
              },
              createdAt: CREATED_AT
            })
          )
        )
      );

      // Pre-insert extraction spec for first dimension
      const firstDim = RUBRIC_V1.dimensions[0]!;
      unwrap(
        insertExtractionSpec(
          context,
          unwrap(
            prepareExtractionSpec({
              extractionSpecId: "pre-existing-spec-0",
              content: {
                modelId: "test-extractor",
                extractorVersion: "extractor-v1",
                promptTemplateVersion: "prompt-v1",
                promptHash: sha256Hex("prompt-v1"),
                schemaHash: sha256Hex("extraction-output-schema-v1"),
                dimensionId: firstDim.dimensionId,
                dimensionDefinition: firstDim.definition,
                jobRelatedJustification: firstDim.jobRelatedJustification,
                limits: { ...EXTRACTION_LIMITS }
              },
              createdAt: CREATED_AT
            })
          )
        )
      );
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const db = nativeDatabase(runtime.connection);
    const attemptRow = db
      .prepare("SELECT snapshot_id FROM triage_attempt WHERE triage_attempt_id = ?")
      .get(result.value.result.triageAttemptId) as { snapshot_id: string };
    expect(attemptRow.snapshot_id).toBe("pre-existing-snapshot");

    const workItemRows = db
      .prepare(
        "SELECT extraction_spec_id FROM attempt_work_item WHERE triage_attempt_id = ? AND dimension_id = ?"
      )
      .all(result.value.result.triageAttemptId, RUBRIC_V1.dimensions[0]!.dimensionId) as Array<{
      extraction_spec_id: string;
    }>;
    expect(workItemRows[0]?.extraction_spec_id).toBe("pre-existing-spec-0");
  });

  it("reuses existing corpus_manifest by content hash across different attempts", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context, "role-1");
      seedRole(context, "role-2");
      seedCandidate(context, "cand-1");
      return { ok: true, value: undefined };
    });

    const firstRun = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: "role-1",
      candidateIds: ["cand-1"]
    });
    expect(firstRun.ok).toBe(true);
    if (!firstRun.ok) {
      throw new Error(firstRun.error.message);
    }

    const db = nativeDatabase(runtime.connection);
    const firstAttempt = db
      .prepare("SELECT corpus_manifest_id FROM triage_attempt WHERE triage_attempt_id = ?")
      .get(firstRun.value.result.triageAttemptId) as { corpus_manifest_id: string };

    const secondRun = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: "role-2",
      candidateIds: ["cand-1"]
    });
    expect(secondRun.ok).toBe(true);
    if (!secondRun.ok) {
      throw new Error(secondRun.error.message);
    }

    const secondAttempt = db
      .prepare("SELECT corpus_manifest_id FROM triage_attempt WHERE triage_attempt_id = ?")
      .get(secondRun.value.result.triageAttemptId) as { corpus_manifest_id: string };

    expect(secondAttempt.corpus_manifest_id).toBe(firstAttempt.corpus_manifest_id);
  });

  it("creates attempt work items for all documents of a candidate across all dimensions", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "multi-doc-cand", 2); // 2 documents
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["multi-doc-cand"]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    // 1 candidate * 2 documents * 6 dimensions = 12 work items
    expect(result.value.result.workItemCount).toBe(12);

    const db = nativeDatabase(runtime.connection);
    const items = db
      .prepare(
        "SELECT candidate_document_id, dimension_id, manifest_ordinal FROM attempt_work_item WHERE triage_attempt_id = ? ORDER BY manifest_ordinal ASC"
      )
      .all(result.value.result.triageAttemptId) as Array<{
      candidate_document_id: string;
      dimension_id: string;
      manifest_ordinal: number;
    }>;
    expect(items.length).toBe(12);
    expect(items.map((i) => i.manifest_ordinal)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(items[0]?.candidate_document_id).toBe("cand-doc-multi-doc-cand-0");
    expect(items[6]?.candidate_document_id).toBe("cand-doc-multi-doc-cand-1");
  });

  it("integrates seamlessly with the extraction scheduler (runExtractionAttempt)", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");
      return { ok: true, value: undefined };
    });

    const startResult = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"],
      rubric: singleDimensionRubric()
    });
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) {
      throw new Error(startResult.error.message);
    }

    const { triageAttemptId } = startResult.value.result;

    // Run scheduler directly on the created attempt
    const scheduleSummary = await runExtractionAttempt(runtime, { triageAttemptId });
    expect(scheduleSummary.ok).toBe(true);
    if (!scheduleSummary.ok) {
      throw new Error(scheduleSummary.error.message);
    }

    expect(scheduleSummary.value.totalWorkItems).toBe(1);
    expect(scheduleSummary.value.processed).toBe(1);
  });

  it("rejects invalid composition inputs", () => {
    const validRuntime = {
      connection: {} as RuntimeDatabaseConnection,
      clock: fixedClock(CREATED_AT),
      idGenerator: createIncrementingIdGenerator("test")
    };
    const validProps: StartTriageRunInput = {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"]
    };

    expect(startTriageRun(null as unknown as RuntimeComposition, validProps)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "persistence_failed", message: "Invalid runtime composition" })
    });
    expect(
      startTriageRun({ ...validRuntime, connection: null as unknown as RuntimeDatabaseConnection }, validProps)
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "persistence_failed", message: "Invalid runtime composition" })
    });
    expect(
      startTriageRun(
        { ...validRuntime, clock: null as unknown as RuntimeComposition["clock"] },
        validProps
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "persistence_failed", message: "Invalid runtime clock" })
    });
    expect(
      startTriageRun(
        { ...validRuntime, idGenerator: null as unknown as RuntimeComposition["idGenerator"] },
        validProps
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "persistence_failed", message: "Invalid runtime id generator" })
    });
  });

  it("rejects invalid input payloads", async () => {
    const runtime = await createTestRuntime();

    expect(startTriageRun(runtime, null as unknown as StartTriageRunInput)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "persistence_failed", message: "Invalid start triage run input" })
    });

    expect(startTriageRun(runtime, { actorId: "", roleId: ROLE_ID, candidateIds: ["cand-1"] })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "persistence_failed", message: "Start triage run requires an actor id" })
    });

    expect(startTriageRun(runtime, { actorId: "actor-1", roleId: "", candidateIds: ["cand-1"] })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "persistence_failed", message: "Start triage run requires a role id" })
    });

    expect(startTriageRun(runtime, { actorId: "actor-1", roleId: ROLE_ID })).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "Start triage run requires candidate IDs or a corpus manifest ID"
      })
    });

    expect(startTriageRun(runtime, { actorId: "actor-1", roleId: ROLE_ID, candidateIds: [] })).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "Start triage run requires candidate IDs or a corpus manifest ID"
      })
    });

    expect(
      startTriageRun(runtime, { actorId: "actor-1", roleId: ROLE_ID, candidateIds: [""] })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "Candidate IDs must be non-empty strings"
      })
    });

    expect(
      startTriageRun(runtime, {
        actorId: "actor-1",
        roleId: ROLE_ID,
        candidateIds: ["cand-1", "cand-1"]
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "Input contains duplicate candidate IDs"
      })
    });

    const tooMany = Array.from({ length: 201 }, (_, i) => `cand-${i}`);
    expect(
      startTriageRun(runtime, { actorId: "actor-1", roleId: ROLE_ID, candidateIds: tooMany })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "Attempt candidate count cannot exceed 200 (received 201)"
      })
    });
  });

  it("fails if role is not found in database", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedCandidate(context, "cand-1");
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: "non-existent-role",
      candidateIds: ["cand-1"]
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "not_found",
        message: 'Role "non-existent-role" not found'
      })
    });
  });

  it("fails if candidate is not found in database", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["missing-candidate"]
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "not_found",
        message: 'Candidate "missing-candidate" not found'
      })
    });
  });

  it("fails if candidate has no documents", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      unwrap(
        insertCandidate(
          context,
          unwrap(
            prepareCandidate({
              candidateId: "bare-cand",
              sourceSystem: "synthetic_corpus",
              sourceKey: "bare-key",
              channel: "inbound",
              corpusTag: "variant",
              createdAt: CREATED_AT
            })
          )
        )
      );
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["bare-cand"]
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: 'Candidate "bare-cand" has no documents'
      })
    });
  });

  it("fails if main_run does not have exactly 140 candidates", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"],
      kind: "main_run"
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "Main run requires exactly 140 candidates (received 1)"
      })
    });
  });

  it("fails if corpus manifest is not found", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      corpusManifestId: "missing-manifest"
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "not_found",
        message: 'Corpus manifest "missing-manifest" not found'
      })
    });
  });

  it("fails if corpus manifest is not sealed", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");
      return { ok: true, value: undefined };
    });

    const db = nativeDatabase(runtime.connection);
    db.exec("PRAGMA foreign_keys = OFF;");
    db.prepare(
      `INSERT INTO corpus_manifest (corpus_manifest_id, kind, content_hash, seal_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      "unsealed-manifest",
      "variant",
      sha256Hex("unsealed"),
      "unsealed-seal",
      CREATED_AT
    );
    db.exec("PRAGMA foreign_keys = ON;");

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      corpusManifestId: "unsealed-manifest"
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: 'Corpus manifest "unsealed-manifest" is not sealed'
      })
    });
  });

  it("fails if candidateIds do not match corpus manifest members", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");
      seedCandidate(context, "cand-2");

      const manifestContent = {
        kind: "variant" as const,
        members: [
          {
            candidateId: "cand-1",
            importOrdinal: 0,
            documents: [{ candidateDocumentId: "cand-doc-cand-1-0", documentOrdinal: 0 }]
          }
        ]
      };
      unwrap(
        insertCorpusManifest(
          context,
          unwrap(
            prepareCorpusManifest({
              corpusManifestId: "mismatch-manifest",
              kind: "variant",
              sealId: "mismatch-seal",
              createdAt: CREATED_AT,
              content: manifestContent
            })
          )
        )
      );
      unwrap(
        insertCorpusMember(
          context,
          unwrap(
            prepareCorpusMember({
              corpusMemberId: "m-1",
              manifestId: "mismatch-manifest",
              candidateId: "cand-1",
              importOrdinal: 0,
              createdAt: CREATED_AT
            })
          )
        )
      );
      unwrap(
        insertCorpusMemberDocument(
          context,
          unwrap(
            prepareCorpusMemberDocument({
              corpusMemberDocumentId: "md-1",
              corpusMemberId: "m-1",
              candidateDocumentId: "cand-doc-cand-1-0",
              documentOrdinal: 0,
              createdAt: CREATED_AT
            })
          )
        )
      );
      unwrap(
        insertCorpusManifestSeal(
          context,
          unwrap(
            prepareCorpusManifestSeal({
              corpusManifestSealId: "mismatch-seal",
              manifestId: "mismatch-manifest",
              createdAt: CREATED_AT
            })
          )
        )
      );
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      corpusManifestId: "mismatch-manifest",
      candidateIds: ["cand-2"] // Doesn't match cand-1 in manifest
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "Supplied candidate IDs do not match the corpus manifest"
      })
    });
  });

  it("fails if requested kind does not match manifest kind", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");

      const manifestContent = {
        kind: "variant" as const,
        members: [
          {
            candidateId: "cand-1",
            importOrdinal: 0,
            documents: [{ candidateDocumentId: "cand-doc-cand-1-0", documentOrdinal: 0 }]
          }
        ]
      };
      unwrap(
        insertCorpusManifest(
          context,
          unwrap(
            prepareCorpusManifest({
              corpusManifestId: "variant-manifest",
              kind: "variant",
              sealId: "variant-seal",
              createdAt: CREATED_AT,
              content: manifestContent
            })
          )
        )
      );
      unwrap(
        insertCorpusMember(
          context,
          unwrap(
            prepareCorpusMember({
              corpusMemberId: "vm-1",
              manifestId: "variant-manifest",
              candidateId: "cand-1",
              importOrdinal: 0,
              createdAt: CREATED_AT
            })
          )
        )
      );
      unwrap(
        insertCorpusMemberDocument(
          context,
          unwrap(
            prepareCorpusMemberDocument({
              corpusMemberDocumentId: "vmd-1",
              corpusMemberId: "vm-1",
              candidateDocumentId: "cand-doc-cand-1-0",
              documentOrdinal: 0,
              createdAt: CREATED_AT
            })
          )
        )
      );
      unwrap(
        insertCorpusManifestSeal(
          context,
          unwrap(
            prepareCorpusManifestSeal({
              corpusManifestSealId: "variant-seal",
              manifestId: "variant-manifest",
              createdAt: CREATED_AT
            })
          )
        )
      );
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      corpusManifestId: "variant-manifest",
      kind: "main_run"
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: 'Requested kind "main_run" does not match manifest kind "variant"'
      })
    });
  });

  it("returns command_conflict if official attempt already exists for snapshot and manifest", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");
      return { ok: true, value: undefined };
    });

    const firstResult = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"]
    });
    expect(firstResult.ok).toBe(true);

    // Call again with exact same parameters
    const secondResult = startTriageRun(runtime, {
      actorId: "actor-2",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"]
    });

    expect(secondResult).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "command_conflict",
        message: expect.stringContaining("A triage attempt for this snapshot and manifest already exists")
      })
    });
  });

  it("rejects empty candidateIds array even if corpusManifestId is provided", async () => {
    const runtime = await createTestRuntime();
    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      corpusManifestId: "manifest-1",
      candidateIds: []
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Start triage run requires candidate IDs or a corpus manifest ID" }
    });
  });

  it("starts a triage attempt with an existing sealed main corpus manifest", async () => {
    const runtime = await createTestRuntime();
    const candidateIds = Array.from({ length: 140 }, (_, i) => `main-cand-${String(i + 1).padStart(4, "0")}`);
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      for (const id of candidateIds) {
        seedCandidate(context, id);
      }
      const manifestContent = {
        kind: "main" as const,
        members: candidateIds.map((candidateId, importOrdinal) => ({
          candidateId,
          importOrdinal,
          documents: [{ candidateDocumentId: `cand-doc-${candidateId}-0`, documentOrdinal: 0 }]
        }))
      };
      unwrap(
        insertCorpusManifest(
          context,
          unwrap(
            prepareCorpusManifest({
              corpusManifestId: "main-manifest-sealed",
              kind: "main",
              sealId: "main-seal-sealed",
              createdAt: CREATED_AT,
              content: manifestContent
            })
          )
        )
      );
      for (let i = 0; i < candidateIds.length; i += 1) {
        const candidateId = candidateIds[i]!;
        unwrap(
          insertCorpusMember(
            context,
            unwrap(
              prepareCorpusMember({
                corpusMemberId: `main-mem-${i}`,
                manifestId: "main-manifest-sealed",
                candidateId,
                importOrdinal: i,
                createdAt: CREATED_AT
              })
            )
          )
        );
        unwrap(
          insertCorpusMemberDocument(
            context,
            unwrap(
              prepareCorpusMemberDocument({
                corpusMemberDocumentId: `main-mem-doc-${i}`,
                corpusMemberId: `main-mem-${i}`,
                candidateDocumentId: `cand-doc-${candidateId}-0`,
                documentOrdinal: 0,
                createdAt: CREATED_AT
              })
            )
          )
        );
      }
      unwrap(
        insertCorpusManifestSeal(
          context,
          unwrap(
            prepareCorpusManifestSeal({
              corpusManifestSealId: "main-seal-sealed",
              manifestId: "main-manifest-sealed",
              createdAt: CREATED_AT
            })
          )
        )
      );
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      corpusManifestId: "main-manifest-sealed"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const db = nativeDatabase(runtime.connection);
    const row = db
      .prepare("SELECT kind FROM triage_attempt WHERE triage_attempt_id = ?")
      .get(result.value.result.triageAttemptId) as { kind: string };
    expect(row.kind).toBe("main_run");
  });

  it("starts a triage attempt with explicitly supplied kind variant_run", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"],
      kind: "variant_run"
    });
    expect(result.ok).toBe(true);
  });

  it("auto-detects main run when 140 candidates are supplied without explicit kind", async () => {
    const runtime = await createTestRuntime();
    const candidateIds = Array.from({ length: 140 }, (_, i) => `cand-140-${String(i + 1).padStart(4, "0")}`);
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      for (const id of candidateIds) {
        seedCandidate(context, id);
      }
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds,
      rubric: singleDimensionRubric()
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const db = nativeDatabase(runtime.connection);
    const row = db
      .prepare("SELECT kind FROM triage_attempt WHERE triage_attempt_id = ?")
      .get(result.value.result.triageAttemptId) as { kind: string };
    expect(row.kind).toBe("main_run");
  });

  it("fails if candidate documents have non-zero starting ordinal", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      unwrap(
        insertCandidate(
          context,
          unwrap(
            prepareCandidate({
              candidateId: "cand-bad-doc",
              sourceSystem: "synthetic_corpus",
              sourceKey: "bad-doc",
              channel: "inbound",
              corpusTag: "variant",
              createdAt: CREATED_AT
            })
          )
        )
      );
      unwrap(
        insertSourceDocument(
          context,
          unwrap(
            prepareSourceDocument({
              sourceDocumentId: "src-bad-doc",
              rawText: "bad doc text",
              normalizedText: "bad doc text",
              createdAt: CREATED_AT
            })
          )
        )
      );
      unwrap(
        insertCandidateDocument(
          context,
          unwrap(
            prepareCandidateDocument({
              candidateDocumentId: "cand-doc-bad",
              candidateId: "cand-bad-doc",
              sourceDocumentId: "src-bad-doc",
              documentKind: "resume",
              label: "Resume",
              documentOrdinal: 1,
              createdAt: CREATED_AT
            })
          )
        )
      );
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-bad-doc"]
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Corpus member document ordinals must start at 0" }
    });
  });

  it("fails if frozenDate is an invalid calendar date", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"],
      frozenDate: "2026-02-31"
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: { message: "Invalid run input snapshot content" }
    });
  });

  it("fails if modelId is empty string", async () => {
    const runtime = await createTestRuntime();
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"],
      modelId: ""
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: { message: "Invalid extraction spec content" }
    });
  });

  it("fails if workItemKey exceeds 200 characters", async () => {
    const runtime = await createTestRuntime();
    const longCandidateId = "cand-" + "a".repeat(100);
    const longDocId = "doc-" + "b".repeat(100);

    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      unwrap(
        insertCandidate(
          context,
          unwrap(
            prepareCandidate({
              candidateId: longCandidateId,
              sourceSystem: "synthetic_corpus",
              sourceKey: "long-key",
              channel: "inbound",
              corpusTag: "variant",
              createdAt: CREATED_AT
            })
          )
        )
      );
      unwrap(
        insertSourceDocument(
          context,
          unwrap(
            prepareSourceDocument({
              sourceDocumentId: "src-long",
              rawText: "text",
              normalizedText: "text",
              createdAt: CREATED_AT
            })
          )
        )
      );
      unwrap(
        insertCandidateDocument(
          context,
          unwrap(
            prepareCandidateDocument({
              candidateDocumentId: longDocId,
              candidateId: longCandidateId,
              sourceDocumentId: "src-long",
              documentKind: "resume",
              label: "Resume",
              documentOrdinal: 0,
              createdAt: CREATED_AT
            })
          )
        )
      );
      return { ok: true, value: undefined };
    });

    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: [longCandidateId]
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Work item key exceeds maximum length") }
    });
  });

  it("fails if corpusManifestId is invalid", async () => {
    const runtime = await createTestRuntime({
      idGenerator: scriptedIdGenerator(["cmd", "bad manifest id spaces"])
    });
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");
      return { ok: true, value: undefined };
    });
    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"],
      rubric: singleDimensionRubric()
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Invalid corpus manifest input" }
    });
  });

  it("fails if corpusManifestId collides", async () => {
    const runtime = await createTestRuntime({
      idGenerator: scriptedIdGenerator(["cmd", "colliding-manifest"])
    });
    unwrap(
      runImmediateTransaction(runtime.connection, (context) => {
        seedRole(context);
        seedCandidate(context, "cand-1");
        seedCandidate(context, "cand-2");
        const manifestContent = {
          kind: "variant" as const,
          members: [
            {
              candidateId: "cand-1",
              importOrdinal: 0,
              documents: [{ candidateDocumentId: "cand-doc-cand-1-0", documentOrdinal: 0 }]
            }
          ]
        };
        unwrap(
          insertCorpusManifest(
            context,
            unwrap(
              prepareCorpusManifest({
                corpusManifestId: "colliding-manifest",
                kind: "variant",
                sealId: "seal-pre-1",
                createdAt: CREATED_AT,
                content: manifestContent
              })
            )
          )
        );
        unwrap(
          insertCorpusMember(
            context,
            unwrap(
              prepareCorpusMember({
                corpusMemberId: "mem-pre-1",
                manifestId: "colliding-manifest",
                candidateId: "cand-1",
                importOrdinal: 0,
                createdAt: CREATED_AT
              })
            )
          )
        );
        unwrap(
          insertCorpusMemberDocument(
            context,
            unwrap(
              prepareCorpusMemberDocument({
                corpusMemberDocumentId: "mem-doc-pre-1",
                corpusMemberId: "mem-pre-1",
                candidateDocumentId: "cand-doc-cand-1-0",
                documentOrdinal: 0,
                createdAt: CREATED_AT
              })
            )
          )
        );
        unwrap(
          insertCorpusManifestSeal(
            context,
            unwrap(
              prepareCorpusManifestSeal({
                corpusManifestSealId: "seal-pre-1",
                manifestId: "colliding-manifest",
                createdAt: CREATED_AT
              })
            )
          )
        );
        return { ok: true, value: undefined };
      })
    );
    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-2"],
      rubric: singleDimensionRubric()
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Corpus manifest insert failed" }
    });
  });

  it("fails if corpusMemberId is invalid", async () => {
    const runtime = await createTestRuntime({
      idGenerator: scriptedIdGenerator(["cmd", "m-1", "s-1", "bad member id spaces"])
    });
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");
      return { ok: true, value: undefined };
    });
    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"],
      rubric: singleDimensionRubric()
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Invalid corpus member input" }
    });
  });

  it("fails if corpusMemberId collides", async () => {
    const runtime = await createTestRuntime({
      idGenerator: scriptedIdGenerator(["cmd", "m-new", "s-new", "colliding-member"])
    });
    unwrap(
      runImmediateTransaction(runtime.connection, (context) => {
        seedRole(context);
        seedCandidate(context, "cand-1");
        seedCandidate(context, "cand-2");
        const manifestContent = {
          kind: "variant" as const,
          members: [
            {
              candidateId: "cand-1",
              importOrdinal: 0,
              documents: [{ candidateDocumentId: "cand-doc-cand-1-0", documentOrdinal: 0 }]
            }
          ]
        };
        unwrap(
          insertCorpusManifest(
            context,
            unwrap(
              prepareCorpusManifest({
                corpusManifestId: "seed-manifest-mem",
                kind: "variant",
                sealId: "seed-seal-mem",
                createdAt: CREATED_AT,
                content: manifestContent
              })
            )
          )
        );
        unwrap(
          insertCorpusMember(
            context,
            unwrap(
              prepareCorpusMember({
                corpusMemberId: "colliding-member",
                manifestId: "seed-manifest-mem",
                candidateId: "cand-1",
                importOrdinal: 0,
                createdAt: CREATED_AT
              })
            )
          )
        );
        unwrap(
          insertCorpusMemberDocument(
            context,
            unwrap(
              prepareCorpusMemberDocument({
                corpusMemberDocumentId: "mem-doc-seed-mem",
                corpusMemberId: "colliding-member",
                candidateDocumentId: "cand-doc-cand-1-0",
                documentOrdinal: 0,
                createdAt: CREATED_AT
              })
            )
          )
        );
        unwrap(
          insertCorpusManifestSeal(
            context,
            unwrap(
              prepareCorpusManifestSeal({
                corpusManifestSealId: "seed-seal-mem",
                manifestId: "seed-manifest-mem",
                createdAt: CREATED_AT
              })
            )
          )
        );
        return { ok: true, value: undefined };
      })
    );
    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-2"],
      rubric: singleDimensionRubric()
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Corpus member insert failed" }
    });
  });

  it("fails if corpusMemberDocumentId is invalid", async () => {
    const runtime = await createTestRuntime({
      idGenerator: scriptedIdGenerator(["cmd", "m-1", "s-1", "mem-1", "bad doc id spaces"])
    });
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");
      return { ok: true, value: undefined };
    });
    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"],
      rubric: singleDimensionRubric()
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Invalid corpus member document input" }
    });
  });

  it("fails if corpusMemberDocumentId collides", async () => {
    const runtime = await createTestRuntime({
      idGenerator: scriptedIdGenerator(["cmd", "m-new", "s-new", "mem-new", "colliding-doc"])
    });
    unwrap(
      runImmediateTransaction(runtime.connection, (context) => {
        seedRole(context);
        seedCandidate(context, "cand-1");
        seedCandidate(context, "cand-2");
        const manifestContent = {
          kind: "variant" as const,
          members: [
            {
              candidateId: "cand-1",
              importOrdinal: 0,
              documents: [{ candidateDocumentId: "cand-doc-cand-1-0", documentOrdinal: 0 }]
            }
          ]
        };
        unwrap(
          insertCorpusManifest(
            context,
            unwrap(
              prepareCorpusManifest({
                corpusManifestId: "seed-manifest-doc",
                kind: "variant",
                sealId: "seed-seal-doc",
                createdAt: CREATED_AT,
                content: manifestContent
              })
            )
          )
        );
        unwrap(
          insertCorpusMember(
            context,
            unwrap(
              prepareCorpusMember({
                corpusMemberId: "mem-seed-doc",
                manifestId: "seed-manifest-doc",
                candidateId: "cand-1",
                importOrdinal: 0,
                createdAt: CREATED_AT
              })
            )
          )
        );
        unwrap(
          insertCorpusMemberDocument(
            context,
            unwrap(
              prepareCorpusMemberDocument({
                corpusMemberDocumentId: "colliding-doc",
                corpusMemberId: "mem-seed-doc",
                candidateDocumentId: "cand-doc-cand-1-0",
                documentOrdinal: 0,
                createdAt: CREATED_AT
              })
            )
          )
        );
        unwrap(
          insertCorpusManifestSeal(
            context,
            unwrap(
              prepareCorpusManifestSeal({
                corpusManifestSealId: "seed-seal-doc",
                manifestId: "seed-manifest-doc",
                createdAt: CREATED_AT
              })
            )
          )
        );
        return { ok: true, value: undefined };
      })
    );
    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-2"],
      rubric: singleDimensionRubric()
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Corpus member document insert failed" }
    });
  });

  it("fails if snapshotId is invalid", async () => {
    const runtime = await createTestRuntime({
      idGenerator: scriptedIdGenerator(["cmd", "m-1", "s-1", "mem-1", "doc-1", "bad snapshot id spaces"])
    });
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");
      return { ok: true, value: undefined };
    });
    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"],
      rubric: singleDimensionRubric()
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Invalid run input snapshot input" }
    });
  });

  it("fails if snapshotId collides", async () => {
    const runtime = await createTestRuntime({
      idGenerator: scriptedIdGenerator(["cmd", "m-1", "s-1", "mem-1", "doc-1", "colliding-snapshot"])
    });
    unwrap(
      runImmediateTransaction(runtime.connection, (context) => {
        seedRole(context);
        seedCandidate(context, "cand-1");
        unwrap(
          insertRunInputSnapshot(
            context,
            unwrap(
              prepareRunInputSnapshot({
                runInputSnapshotId: "colliding-snapshot",
                content: {
                  frozenDate: "2025-01-01",
                  roleId: ROLE_ID,
                  rubricVersion: "1",
                  dimensions: [
                    {
                      dimensionId: "applied_ml_llm_systems",
                      weight: 3,
                      required: true,
                      definition: "Evidence of machine learning in product behavior.",
                      jobRelatedJustification: "The role builds tooling where model output drives product behavior.",
                      ordinal: 0
                    }
                  ],
                  scoringPolicy: {
                    levelValues: { ...SCORING_POLICY_V1.levelValues },
                    confidenceWeights: { ...SCORING_POLICY_V1.confidenceWeights },
                    escalateThreshold: SCORING_POLICY_V1.escalateThreshold,
                    shortlistN: SCORING_POLICY_V1.shortlistN,
                    requiredFieldIds: [...SCORING_POLICY_V1.requiredFieldIds]
                  },
                  extractorVersion: "extractor-v1",
                  promptTemplateVersion: "prompt-v1",
                  limits: { ...EXTRACTION_LIMITS }
                },
                createdAt: CREATED_AT
              })
            )
          )
        );
        return { ok: true, value: undefined };
      })
    );
    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"],
      rubric: singleDimensionRubric()
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Run input snapshot insert failed" }
    });
  });

  it("fails if extractionSpecId is invalid", async () => {
    const runtime = await createTestRuntime({
      idGenerator: scriptedIdGenerator(["cmd", "m-1", "s-1", "mem-1", "doc-1", "snap-1", "bad spec id spaces"])
    });
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");
      return { ok: true, value: undefined };
    });
    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"],
      rubric: singleDimensionRubric()
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Invalid extraction spec input" }
    });
  });

  it("fails if extractionSpecId collides", async () => {
    const runtime = await createTestRuntime({
      idGenerator: scriptedIdGenerator(["cmd", "m-1", "s-1", "mem-1", "doc-1", "snap-1", "colliding-spec"])
    });
    unwrap(
      runImmediateTransaction(runtime.connection, (context) => {
        seedRole(context);
        seedCandidate(context, "cand-1");
        unwrap(
          insertExtractionSpec(
            context,
            unwrap(
              prepareExtractionSpec({
                extractionSpecId: "colliding-spec",
                content: {
                  modelId: "different-model",
                  extractorVersion: "extractor-v1",
                  promptTemplateVersion: "prompt-v1",
                  promptHash: sha256Hex("prompt-v1"),
                  schemaHash: sha256Hex("extraction-output-schema-v1"),
                  dimensionId: "applied_ml_llm_systems",
                  dimensionDefinition: "Evidence of machine learning in product behavior.",
                  jobRelatedJustification: "The role builds tooling where model output drives product behavior.",
                  limits: { ...EXTRACTION_LIMITS }
                },
                createdAt: CREATED_AT
              })
            )
          )
        );
        return { ok: true, value: undefined };
      })
    );
    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"],
      rubric: singleDimensionRubric()
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Extraction spec insert failed" }
    });
  });

  it("fails if triageAttemptId is invalid", async () => {
    const runtime = await createTestRuntime({
      idGenerator: scriptedIdGenerator([
        "cmd",
        "m-1",
        "s-1",
        "mem-1",
        "doc-1",
        "snap-1",
        "spec-1",
        "bad attempt id spaces"
      ])
    });
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");
      return { ok: true, value: undefined };
    });
    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"],
      rubric: singleDimensionRubric()
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Invalid triage attempt input" }
    });
  });

  it("fails if triageAttemptId collides", async () => {
    const runtime = await createTestRuntime();
    unwrap(
      runImmediateTransaction(runtime.connection, (context) => {
        seedRole(context);
        seedCandidate(context, "cand-1");
        seedCandidate(context, "cand-2");
        return { ok: true, value: undefined };
      })
    );
    const firstResult = unwrap(
      startTriageRun(runtime, {
        actorId: "actor-1",
        roleId: ROLE_ID,
        candidateIds: ["cand-1"],
        rubric: singleDimensionRubric()
      })
    );
    const existingAttemptId = firstResult.result.triageAttemptId;

    const runtimeWithScripted: RuntimeComposition = {
      ...runtime,
      idGenerator: scriptedIdGenerator([
        "cmd-2",
        "m-2",
        "s-2",
        "mem-2",
        "doc-2",
        existingAttemptId
      ])
    };
    const result = startTriageRun(runtimeWithScripted, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-2"],
      rubric: singleDimensionRubric()
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Triage attempt insert failed" }
    });
  });

  it("fails if attemptWorkItemId is invalid", async () => {
    const runtime = await createTestRuntime({
      idGenerator: scriptedIdGenerator([
        "cmd",
        "m-1",
        "s-1",
        "mem-1",
        "doc-1",
        "snap-1",
        "spec-1",
        "att-1",
        "bad work item spaces"
      ])
    });
    runImmediateTransaction(runtime.connection, (context) => {
      seedRole(context);
      seedCandidate(context, "cand-1");
      return { ok: true, value: undefined };
    });
    const result = startTriageRun(runtime, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-1"],
      rubric: singleDimensionRubric()
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Invalid attempt work item input" }
    });
  });

  it("fails if attemptWorkItemId collides", async () => {
    const runtime = await createTestRuntime();
    unwrap(
      runImmediateTransaction(runtime.connection, (context) => {
        seedRole(context);
        seedCandidate(context, "cand-1");
        seedCandidate(context, "cand-2");
        return { ok: true, value: undefined };
      })
    );
    unwrap(
      startTriageRun(runtime, {
        actorId: "actor-1",
        roleId: ROLE_ID,
        candidateIds: ["cand-1"],
        rubric: singleDimensionRubric()
      })
    );
    const db = nativeDatabase(runtime.connection);
    const existingWorkItem = db
      .prepare("SELECT attempt_work_item_id AS id FROM attempt_work_item LIMIT 1")
      .get() as { id: string };

    const runtimeWithScripted: RuntimeComposition = {
      ...runtime,
      idGenerator: scriptedIdGenerator([
        "cmd-2",
        "m-2",
        "s-2",
        "mem-2",
        "doc-2",
        "att-2",
        existingWorkItem.id
      ])
    };
    const result = startTriageRun(runtimeWithScripted, {
      actorId: "actor-1",
      roleId: ROLE_ID,
      candidateIds: ["cand-2"],
      rubric: singleDimensionRubric()
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Attempt work item insert failed" }
    });
  });
});
