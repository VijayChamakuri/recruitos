import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RUBRIC_V1, sha256Hex, type Result } from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFixtureExtractionAdapter,
  createSyntheticCandidateSourceAdapter,
  type FixtureExtractionAdapter
} from "../adapters/index.js";
import {
  insertCandidateApplicationAnswer,
  prepareCandidateApplicationAnswer
} from "../application-answers/index.js";
import {
  insertTriageAttempt,
  prepareTriageAttempt
} from "../attempts/index.js";
import {
  runImmediateTransaction,
  type ImmediateTransactionContext
} from "../commands/index.js";
import {
  createIncrementingIdGenerator,
  createRuntime,
  fixedClock,
  type RuntimeComposition
} from "../composition/index.js";
import {
  insertActor,
  insertCandidate,
  insertCandidateDocument,
  insertSourceDocument,
  prepareActor,
  prepareCandidate,
  prepareCandidateDocument,
  prepareSourceDocument
} from "../entities/index.js";
import type { RuntimeError } from "../errors/index.js";
import { readCandidatePacket } from "../read-models/index.js";
import {
  insertResolutionAction,
  prepareResolutionAction
} from "../resolution/index.js";
import { insertRole, prepareRole } from "../roles/index.js";
import { runExtractionAttempt } from "../scheduler/index.js";
import {
  FINALIZE_TRIAGE_RUN_COMMAND_NAME,
  finalizeTriageRun,
  type FinalizeTriageRunInput
} from "./finalize-triage-run.js";
import { startTriageRun } from "./start-triage-run.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const ROLE_ID = "role-applied-ai-engineer";
const ACTOR_ID = "actor-recruiter-1";

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

function nativeDatabase(runtime: RuntimeComposition): BetterSqlite3.Database {
  return (runtime.connection.database as unknown as { $client: BetterSqlite3.Database }).$client;
}

async function createTestRuntime(
  overrides: Partial<Parameters<typeof createRuntime>[0]> = {}
): Promise<{ runtime: RuntimeComposition; adapter: FixtureExtractionAdapter }> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-finalize-run-test-"));
  temporaryDirectories.push(directory);
  const adapter =
    (overrides.extraction as FixtureExtractionAdapter | undefined) ?? createFixtureExtractionAdapter();
  const result = createRuntime({
    database: { filename: join(directory, "runtime.db"), migrationsFolder },
    clock: fixedClock(CREATED_AT),
    idGenerator: createIncrementingIdGenerator("test"),
    candidateSource: createSyntheticCandidateSourceAdapter(),
    ...overrides,
    extraction: adapter
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return { runtime: result.value, adapter };
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

function candidateDocumentText(candidateId: string): string {
  return `Candidate ${candidateId} document 0 text.`;
}

function seedCandidate(context: ImmediateTransactionContext, candidateId: string): void {
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
  const rawText = candidateDocumentText(candidateId);
  unwrap(
    insertSourceDocument(
      context,
      unwrap(
        prepareSourceDocument({
          sourceDocumentId: `source-doc-${candidateId}-0`,
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
          candidateDocumentId: `cand-doc-${candidateId}-0`,
          candidateId,
          sourceDocumentId: `source-doc-${candidateId}-0`,
          documentKind: "resume",
          label: "Resume",
          documentOrdinal: 0,
          createdAt: CREATED_AT
        })
      )
    )
  );
}

function seedCandidates(runtime: RuntimeComposition, candidateIds: readonly string[]): void {
  runImmediateTransaction(runtime.connection, (context) => {
    seedRole(context);
    for (const candidateId of candidateIds) {
      seedCandidate(context, candidateId);
    }
    return { ok: true, value: undefined };
  });
}

function requestHash(row: {
  specContentHash: string;
  documentKind: string;
  normalizedHash: string;
}): string {
  return sha256Hex([row.specContentHash, row.documentKind, row.normalizedHash].join("|"));
}

function locatedBody(dimensionId: string, quotedText: string): string {
  return JSON.stringify({
    dimensionId,
    proposedLevel: "partial",
    spans: [{ quotedText, polarity: "supporting" }],
    rejectedClaims: []
  });
}

function unlocatedBody(dimensionId: string): string {
  return JSON.stringify({
    dimensionId,
    proposedLevel: "partial",
    spans: [{ quotedText: "this quote is not in the stored document", polarity: "supporting" }],
    rejectedClaims: []
  });
}

function registerFixturesForAttempt(
  runtime: RuntimeComposition,
  adapter: FixtureExtractionAdapter,
  triageAttemptId: string,
  bodyFor: (dimensionId: string, candidateId: string) => string
): void {
  const rows = nativeDatabase(runtime)
    .prepare(
      `SELECT
        es.content_hash AS specContentHash,
        cd.document_kind AS documentKind,
        sd.normalized_hash AS normalizedHash,
        awi.dimension_id AS dimensionId,
        awi.candidate_id AS candidateId
       FROM attempt_work_item awi
       JOIN extraction_spec es ON es.extraction_spec_id = awi.extraction_spec_id
       JOIN candidate_document cd ON cd.candidate_document_id = awi.candidate_document_id
       JOIN source_document sd ON sd.source_document_id = cd.source_document_id
       WHERE awi.triage_attempt_id = ?`
    )
    .all(triageAttemptId) as Array<{
    specContentHash: string;
    documentKind: string;
    normalizedHash: string;
    dimensionId: string;
    candidateId: string;
  }>;
  for (const row of rows) {
    adapter.registerFixture(requestHash(row), bodyFor(row.dimensionId, row.candidateId));
  }
}

async function startAndExtract(
  runtime: RuntimeComposition,
  adapter: FixtureExtractionAdapter,
  candidateIds: readonly string[],
  bodyFor: (dimensionId: string, candidateId: string) => string = (dimensionId, candidateId) =>
    locatedBody(dimensionId, candidateDocumentText(candidateId))
): Promise<{ triageAttemptId: string; triageRunId: string }> {
  const started = unwrap(
    startTriageRun(runtime, {
      actorId: ACTOR_ID,
      roleId: ROLE_ID,
      candidateIds
    })
  );
  registerFixturesForAttempt(runtime, adapter, started.result.triageAttemptId, bodyFor);
  unwrap(await runExtractionAttempt(runtime, { triageAttemptId: started.result.triageAttemptId }));
  return {
    triageAttemptId: started.result.triageAttemptId,
    triageRunId: started.result.triageRunId
  };
}

function seedWorkAuthorization(
  runtime: RuntimeComposition,
  candidateId: string,
  freeText: string | null
): void {
  unwrap(
    runImmediateTransaction(runtime.connection, (context) => {
      unwrap(
        insertCandidateApplicationAnswer(
          context,
          unwrap(
            prepareCandidateApplicationAnswer({
              candidateApplicationAnswerId: `ans-${candidateId}`,
              candidateId,
              questionKey: "work_authorization",
              selectedOptionKey: "authorized",
              freeText,
              collectedBy: "ats",
              formId: "app-form-1",
              questionId: "q-auth",
              collectedAt: CREATED_AT,
              createdAt: CREATED_AT
            })
          )
        )
      );
      return { ok: true, value: undefined };
    })
  );
}

describe("finalizeTriageRun", () => {
  it("exports the command name", () => {
    expect(FINALIZE_TRIAGE_RUN_COMMAND_NAME).toBe("triage_run.finalize");
  });

  it("rejects invalid composition and input", async () => {
    const { runtime } = await createTestRuntime();
    const valid: FinalizeTriageRunInput = {
      actorId: ACTOR_ID,
      triageAttemptId: "attempt-1"
    };

    expect(finalizeTriageRun(null as unknown as RuntimeComposition, valid)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "persistence_failed", message: "Invalid runtime composition" })
    });
    expect(
      finalizeTriageRun({ ...runtime, connection: null as unknown as RuntimeComposition["connection"] }, valid)
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "persistence_failed", message: "Invalid runtime composition" })
    });
    expect(
      finalizeTriageRun({ ...runtime, clock: null as unknown as RuntimeComposition["clock"] }, valid)
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "persistence_failed", message: "Invalid runtime clock" })
    });
    expect(
      finalizeTriageRun(
        { ...runtime, idGenerator: null as unknown as RuntimeComposition["idGenerator"] },
        valid
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "persistence_failed", message: "Invalid runtime id generator" })
    });
    expect(finalizeTriageRun(runtime, null as unknown as FinalizeTriageRunInput)).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "Invalid finalize triage run input"
      })
    });
    expect(finalizeTriageRun(runtime, { actorId: "", triageAttemptId: "attempt-1" })).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "Finalize triage run requires an actor id"
      })
    });
    expect(finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId: "" })).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "Finalize triage run requires a triage attempt id"
      })
    });
    expect(
      finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId: "attempt-1", triageRunId: "" })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "triageRunId must be a non-empty string when provided"
      })
    });
    expect(
      finalizeTriageRun(runtime, {
        actorId: ACTOR_ID,
        triageAttemptId: "attempt-1",
        rubric: { ...RUBRIC_V1 }
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "finalizeTriageRun requires RUBRIC_V1"
      })
    });
  });

  it("returns not_found for a missing attempt", async () => {
    const { runtime } = await createTestRuntime();
    const result = finalizeTriageRun(runtime, {
      actorId: ACTOR_ID,
      triageAttemptId: "missing-attempt"
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "not_found",
        message: 'Triage attempt "missing-attempt" not found'
      })
    });
  });

  it("refuses finalize while work items are still pending", async () => {
    const { runtime } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const started = unwrap(
      startTriageRun(runtime, { actorId: ACTOR_ID, roleId: ROLE_ID, candidateIds: ["cand-1"] })
    );
    const result = finalizeTriageRun(runtime, {
      actorId: ACTOR_ID,
      triageAttemptId: started.result.triageAttemptId
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected pending refusal");
    }
    expect(result.error.code).toBe("persistence_failed");
    expect(result.error.message).toContain("pending");
  });

  it("refuses finalize when a work item is blocked_failure", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const started = unwrap(
      startTriageRun(runtime, { actorId: ACTOR_ID, roleId: ROLE_ID, candidateIds: ["cand-1"] })
    );
    unwrap(await runExtractionAttempt(runtime, { triageAttemptId: started.result.triageAttemptId }));
    const result = finalizeTriageRun(runtime, {
      actorId: ACTOR_ID,
      triageAttemptId: started.result.triageAttemptId
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected blocked refusal");
    }
    expect(result.error.message).toContain("blocked_failure");
    expect(adapter.hasFixture("missing")).toBe(false);
  });

  it("refuses finalize when the attempt has no work items", async () => {
    const { runtime } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const started = unwrap(
      startTriageRun(runtime, { actorId: ACTOR_ID, roleId: ROLE_ID, candidateIds: ["cand-1"] })
    );
    const db = nativeDatabase(runtime);
    db.exec("DROP TRIGGER IF EXISTS attempt_work_item_reject_delete");
    db.prepare("DELETE FROM attempt_work_item WHERE triage_attempt_id = ?").run(
      started.result.triageAttemptId
    );
    const result = finalizeTriageRun(runtime, {
      actorId: ACTOR_ID,
      triageAttemptId: started.result.triageAttemptId
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: `Triage attempt "${started.result.triageAttemptId}" has no work items`
      })
    });
  });

  it("finalizes a variant attempt to complete escalated results and a readable packet", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId, triageRunId: mintedRunId } = await startAndExtract(runtime, adapter, [
      "cand-1"
    ]);

    const result = unwrap(
      finalizeTriageRun(runtime, {
        actorId: ACTOR_ID,
        triageAttemptId,
        triageRunId: mintedRunId,
        rubric: RUBRIC_V1
      })
    );
    expect(result.metadata.status).toBe("succeeded");
    expect(result.result.triageAttemptId).toBe(triageAttemptId);
    expect(result.result.triageRunId).toBe(mintedRunId);
    expect(result.result.candidateCount).toBe(1);
    expect(result.result.resultIds).toHaveLength(1);

    const db = nativeDatabase(runtime);
    const runRow = db
      .prepare("SELECT kind FROM triage_run WHERE triage_run_id = ?")
      .get(result.result.triageRunId) as { kind: string };
    expect(runRow.kind).toBe("variant");
    const sealCount = db
      .prepare("SELECT COUNT(*) AS count FROM triage_run_seal WHERE triage_run_id = ?")
      .get(result.result.triageRunId) as { count: number };
    expect(sealCount.count).toBe(1);

    const events = db
      .prepare(
        "SELECT event_name AS eventName FROM audit_event WHERE command_id = ? ORDER BY event_ordinal ASC"
      )
      .all(result.metadata.commandId) as Array<{ eventName: string }>;
    expect(events.map((event) => event.eventName)).toEqual([
      "candidate.result.published",
      "triage_run.sealed"
    ]);

    const packet = unwrap(readCandidatePacket(runtime.connection.database, "cand-1"));
    expect(packet.resultAvailability).toBe("complete");
    expect(packet.resultStatus).toBe("escalated");
    expect(packet.isSealed).toBe(true);
    expect(packet.scoreAggregateText).toMatch(/^\d+\/\d+$/);
    expect(packet.scoreConfidenceText).toMatch(/^\d+\/\d+$/);
    expect(packet.scoreAggregateBasisPoints).toBeGreaterThanOrEqual(0);
    expect(packet.scoreConfidenceBasisPoints).toBeGreaterThanOrEqual(0);
    expect(packet.confidenceInput).toEqual(
      expect.objectContaining({
        totalDimensions: 6,
        totalRequiredFields: 4,
        requiredFieldsMissing: 4
      })
    );
    expect(packet.reasons).toEqual(
      expect.arrayContaining([
        "missing_evidence:years_experience",
        "missing_evidence:work_authorization",
        "missing_evidence:current_title",
        "missing_evidence:employer_history"
      ])
    );
    expect(packet.reasons).not.toContain("assessment_unavailable");
    const taskCount = db
      .prepare("SELECT COUNT(*) AS count FROM resolution_task WHERE candidate_result_id = ?")
      .get(packet.resultId) as { count: number };
    expect(taskCount.count).toBe(packet.reasons.length);
  });

  it("writes an unavailable packet for reviewable extraction failure", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"], (dimensionId) =>
      unlocatedBody(dimensionId)
    );
    const result = unwrap(
      finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId })
    );
    expect(result.result.candidateCount).toBe(1);
    const packet = unwrap(readCandidatePacket(runtime.connection.database, "cand-1"));
    expect(packet.resultAvailability).toBe("unavailable");
    expect(packet.resultStatus).toBe("escalated");
    expect(packet.scoreAggregateText).toBeNull();
    expect(packet.confidenceInput).toBeNull();
    expect(packet.reasons).toEqual(["assessment_unavailable"]);
    const scoreCount = nativeDatabase(runtime)
      .prepare("SELECT COUNT(*) AS count FROM score_result WHERE candidate_result_id = ?")
      .get(packet.resultId) as { count: number };
    expect(scoreCount.count).toBe(0);
  });

  it("persists a relocatable work-authorization fact when the answer quotes the document", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    seedWorkAuthorization(runtime, "cand-1", candidateDocumentText("cand-1"));
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    unwrap(finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId }));
    const packet = unwrap(readCandidatePacket(runtime.connection.database, "cand-1"));
    expect(packet.resultAvailability).toBe("complete");
    expect(packet.confidenceInput?.requiredFieldsMissing).toBe(3);
    expect(packet.reasons).not.toContain("missing_evidence:work_authorization");
    expect(packet.reasons).toEqual(
      expect.arrayContaining([
        "missing_evidence:years_experience",
        "missing_evidence:current_title",
        "missing_evidence:employer_history"
      ])
    );
    const factCount = nativeDatabase(runtime)
      .prepare("SELECT COUNT(*) AS count FROM structured_fact WHERE candidate_id = ?")
      .get("cand-1") as { count: number };
    expect(factCount.count).toBe(1);
  });

  it("does not persist a work-authorization fact when the answer quote is not in the document", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    seedWorkAuthorization(runtime, "cand-1", "authorization text that is not in the resume");
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    unwrap(finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId }));
    const packet = unwrap(readCandidatePacket(runtime.connection.database, "cand-1"));
    expect(packet.reasons).toContain("missing_evidence:work_authorization");
    const factCount = nativeDatabase(runtime)
      .prepare("SELECT COUNT(*) AS count FROM structured_fact WHERE candidate_id = ?")
      .get("cand-1") as { count: number };
    expect(factCount.count).toBe(0);
  });

  it("finalizes candidates in corpus import order", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-b", "cand-a"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-b", "cand-a"]);
    const result = unwrap(finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId }));
    expect(result.result.candidateCount).toBe(2);
    const members = nativeDatabase(runtime)
      .prepare(
        `SELECT candidate_id AS candidateId, import_ordinal AS importOrdinal
         FROM triage_run_member
         WHERE triage_run_id = ?
         ORDER BY import_ordinal ASC`
      )
      .all(result.result.triageRunId) as Array<{ candidateId: string; importOrdinal: number }>;
    expect(members.map((member) => member.candidateId)).toEqual(["cand-b", "cand-a"]);
    expect(members.map((member) => member.importOrdinal)).toEqual([0, 1]);
  });

  it("returns command_conflict when the snapshot and manifest already have a run", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    unwrap(finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId }));
    const second = finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId });
    expect(second).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "command_conflict",
        message: expect.stringContaining("A triage run already exists")
      })
    });
  });

  it("refuses to finalize a candidate_correction attempt", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    const finalized = unwrap(finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId }));
    const db = nativeDatabase(runtime);
    const attempt = db
      .prepare(
        `SELECT snapshot_id AS snapshotId, corpus_manifest_id AS corpusManifestId
         FROM triage_attempt WHERE triage_attempt_id = ?`
      )
      .get(triageAttemptId) as { snapshotId: string; corpusManifestId: string };
    const task = db
      .prepare(
        `SELECT resolution_task_id AS resolutionTaskId
         FROM resolution_task WHERE candidate_result_id = ? LIMIT 1`
      )
      .get(finalized.result.resultIds[0]!) as { resolutionTaskId: string };

    unwrap(
      runImmediateTransaction(runtime.connection, (context) => {
        unwrap(
          insertActor(
            context,
            unwrap(prepareActor({ actorId: ACTOR_ID, displayName: "Dana Recruiter", createdAt: CREATED_AT }))
          )
        );
        unwrap(
          insertResolutionAction(
            context,
            unwrap(
              prepareResolutionAction({
                resolutionActionId: "resolution-action-correction",
                resolutionTaskId: task.resolutionTaskId,
                actorId: ACTOR_ID,
                actionOrdinal: 0,
                payload: { kind: "request_re_extraction" },
                createdAt: CREATED_AT
              })
            ),
            0
          )
        );
        unwrap(
          insertTriageAttempt(
            context,
            unwrap(
              prepareTriageAttempt({
                triageAttemptId: "triage-attempt-correction",
                kind: "candidate_correction",
                snapshotId: attempt.snapshotId,
                corpusManifestId: attempt.corpusManifestId,
                originRunId: finalized.result.triageRunId,
                baseResultId: finalized.result.resultIds[0]!,
                requestActionId: "resolution-action-correction",
                scopeCandidateId: "cand-1",
                status: "in_progress",
                version: 1,
                createdAt: CREATED_AT,
                updatedAt: CREATED_AT
              })
            )
          )
        );
        return { ok: true, value: undefined };
      })
    );

    const result = finalizeTriageRun(runtime, {
      actorId: ACTOR_ID,
      triageAttemptId: "triage-attempt-correction"
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "command_conflict",
        message: "finalizeTriageRun cannot finalize a correction attempt"
      })
    });
  });
});
