import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RUBRIC_V1, canonicalJsonStringify, sha256Hex, type Result } from "@recruitos/core";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

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
import * as candidateResults from "../results/index.js";
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
  vi.restoreAllMocks();
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

function noneLevelBody(dimensionId: string): string {
  return JSON.stringify({
    dimensionId,
    proposedLevel: "none",
    spans: [],
    rejectedClaims: []
  });
}

/** One span that locates, one that does not: run returned 2, located 1. */
function partiallyLocatedBody(dimensionId: string, locatableQuote: string): string {
  return JSON.stringify({
    dimensionId,
    proposedLevel: "partial",
    spans: [
      { quotedText: locatableQuote, polarity: "supporting" },
      { quotedText: "this phrase does not appear in the stored document", polarity: "supporting" }
    ],
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
  freeText: string | null,
  selectedOptionKey = "authorized"
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
              selectedOptionKey,
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

function dropWorkItemTerminalTriggers(db: BetterSqlite3.Database): void {
  db.exec("DROP TRIGGER IF EXISTS attempt_work_item_reject_terminal_reopen");
  db.exec("DROP TRIGGER IF EXISTS attempt_work_item_reject_terminal_owner");
}

function dropCorpusMemberDeleteTriggers(db: BetterSqlite3.Database): void {
  db.exec("DROP TRIGGER IF EXISTS corpus_member_document_reject_delete");
  db.exec("DROP TRIGGER IF EXISTS corpus_member_reject_delete");
}

function deleteCorpusMembers(db: BetterSqlite3.Database, corpusManifestId: string): void {
  dropCorpusMemberDeleteTriggers(db);
  db.prepare(
    `DELETE FROM corpus_member_document
     WHERE corpus_member_id IN (
       SELECT corpus_member_id FROM corpus_member WHERE manifest_id = ?
     )`
  ).run(corpusManifestId);
  db.prepare("DELETE FROM corpus_member WHERE manifest_id = ?").run(corpusManifestId);
}

function tryBeginImmediate(
  filename: string,
  busyTimeoutMs: number
): { acquired: true; database: BetterSqlite3.Database } | { acquired: false; code: string } {
  const sqlite = new BetterSqlite3(filename);
  sqlite.pragma(`busy_timeout = ${busyTimeoutMs}`);
  try {
    sqlite.exec("BEGIN IMMEDIATE");
    return { acquired: true, database: sqlite };
  } catch (error) {
    sqlite.close();
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "unknown";
    return { acquired: false, code };
  }
}

function onFirstDerive(mutate: () => void): void {
  const original = candidateResults.deriveCandidateDecision;
  let first = true;
  vi.spyOn(candidateResults, "deriveCandidateDecision").mockImplementation((input) => {
    if (first) {
      first = false;
      mutate();
    }
    return original(input);
  });
}

function rewriteStoredArtifacts(
  db: BetterSqlite3.Database,
  mutateAccepted: (accepted: {
    dimensionId: string;
    proposedLevel: string;
    spans: Array<{
      start: number;
      end: number;
      quotedText: string;
      polarity: string;
      matchQuality: string;
    }>;
  }) => void
): void {
  db.exec("DROP TRIGGER IF EXISTS extraction_artifact_reject_update");
  const rows = db
    .prepare(
      `SELECT
        extraction_artifact_id AS id,
        accepted_output_json AS acceptedJson,
        rejected_claims_json AS rejectedJson
       FROM extraction_artifact`
    )
    .all() as Array<{ id: string; acceptedJson: string; rejectedJson: string }>;
  for (const row of rows) {
    const accepted = JSON.parse(row.acceptedJson) as {
      dimensionId: string;
      proposedLevel: string;
      spans: Array<{
        start: number;
        end: number;
        quotedText: string;
        polarity: string;
        matchQuality: string;
      }>;
    };
    const rejected = JSON.parse(row.rejectedJson) as unknown;
    mutateAccepted(accepted);
    const acceptedCanon = canonicalJsonStringify(accepted);
    const rejectedCanon = canonicalJsonStringify(rejected);
    const contentCanon = canonicalJsonStringify({
      acceptedOutput: accepted,
      rejectedClaims: rejected
    });
    if (!acceptedCanon.ok || !rejectedCanon.ok || !contentCanon.ok) {
      throw new Error("canonical JSON rewrite failed");
    }
    db.prepare(
      `UPDATE extraction_artifact
       SET accepted_output_json = ?,
           accepted_output_hash = ?,
           rejected_claims_json = ?,
           rejected_claims_hash = ?,
           content_hash = ?
       WHERE extraction_artifact_id = ?`
    ).run(
      acceptedCanon.value,
      sha256Hex(acceptedCanon.value),
      rejectedCanon.value,
      sha256Hex(rejectedCanon.value),
      sha256Hex(contentCanon.value),
      row.id
    );
  }
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
    expect(
      finalizeTriageRun(runtime, { actorId: "not a valid id", triageAttemptId: "attempt-1" })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "Finalize triage run requires a valid actor id"
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
        triageRunId: `run_${"x".repeat(128)}`
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "triageRunId must be a valid identifier when provided"
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
    const proposalCount = db
      .prepare("SELECT COUNT(*) AS count FROM proposal WHERE candidate_result_id = ?")
      .get(packet.resultId) as { count: number };
    expect(proposalCount.count).toBe(0);
  });

  it("finalizes a run whose work items predate extraction_run persistence", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);

    // Simulate rows written before the scheduler linked an extraction_run.
    const db = nativeDatabase(runtime);
    for (const trigger of [
      "attempt_work_item_reject_terminal_reopen",
      "attempt_work_item_reject_terminal_owner",
      "attempt_work_item_reject_pinned_update",
      "attempt_work_item_reject_illegal_transition"
    ]) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    db.prepare("UPDATE attempt_work_item SET extraction_run_id = NULL").run();

    const result = unwrap(
      finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId })
    );
    expect(result.result.candidateCount).toBe(1);
    const packet = unwrap(readCandidatePacket(runtime.connection.database, "cand-1"));
    expect(packet.resultAvailability).toBe("complete");
    // Fallback: every stored artifact span counts as both returned and located.
    expect(packet.confidenceInput?.spansReturned).toBe(packet.confidenceInput?.spansLocated);
    expect(packet.confidenceInput?.spansLocated).toBeGreaterThan(0);
  });

  it("folds legacy artifact spans into the resolution term on a mixed-coverage attempt", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"], (dimensionId) =>
      partiallyLocatedBody(dimensionId, "document 0 text")
    );

    // One succeeded work item finalized before extraction_run persistence: keep
    // its artifact, drop only its run link. The other five keep linked runs
    // whose returned (2) exceeds located (1).
    const db = nativeDatabase(runtime);
    for (const trigger of [
      "attempt_work_item_reject_terminal_reopen",
      "attempt_work_item_reject_terminal_owner",
      "attempt_work_item_reject_pinned_update",
      "attempt_work_item_reject_illegal_transition"
    ]) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    db.prepare(
      `UPDATE attempt_work_item SET extraction_run_id = NULL
       WHERE attempt_work_item_id = (
         SELECT attempt_work_item_id FROM attempt_work_item
         WHERE triage_attempt_id = ? ORDER BY manifest_ordinal ASC LIMIT 1
       )`
    ).run(triageAttemptId);

    const result = unwrap(
      finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId })
    );
    expect(result.result.candidateCount).toBe(1);

    const packet = unwrap(readCandidatePacket(runtime.connection.database, "cand-1"));
    expect(packet.resultAvailability).toBe("complete");
    // Five linked runs at returned 2 / located 1, plus one legacy item folded
    // from its single stored artifact span at returned 1 / located 1.
    expect(packet.confidenceInput).toEqual({
      dimensionsWithLocatedSpan: 6,
      totalDimensions: 6,
      spansLocated: 6,
      spansReturned: 11,
      contradictionCount: 0,
      requiredFieldsMissing: 4,
      totalRequiredFields: 4
    });
    expect(packet.scoreConfidenceText).toBe("107/220");
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

  it("persists a work-authorization fact from the application answer without resume relocation", async () => {
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
    const db = nativeDatabase(runtime);
    const factCount = db
      .prepare("SELECT COUNT(*) AS count FROM structured_fact WHERE candidate_id = ?")
      .get("cand-1") as { count: number };
    expect(factCount.count).toBe(1);
    const spanLinks = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM structured_fact_evidence_span sfe
         JOIN structured_fact sf ON sf.structured_fact_id = sfe.structured_fact_id
         WHERE sf.candidate_id = ?`
      )
      .get("cand-1") as { count: number };
    expect(spanLinks.count).toBe(0);
    const provenance = db
      .prepare(
        `SELECT sfp.source AS source
         FROM structured_fact_provenance sfp
         JOIN structured_fact sf ON sf.structured_fact_id = sfp.structured_fact_id
         WHERE sf.candidate_id = ?`
      )
      .all("cand-1") as Array<{ source: string }>;
    expect(provenance.map((row) => row.source)).toEqual(["parsed"]);
  });

  it("persists a work-authorization fact when the answer is not duplicated in the resume", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    seedWorkAuthorization(runtime, "cand-1", "authorization text that is not in the resume");
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    unwrap(finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId }));
    const packet = unwrap(readCandidatePacket(runtime.connection.database, "cand-1"));
    expect(packet.resultAvailability).toBe("complete");
    expect(packet.confidenceInput?.requiredFieldsMissing).toBe(3);
    expect(packet.reasons).not.toContain("missing_evidence:work_authorization");
    const factCount = nativeDatabase(runtime)
      .prepare("SELECT COUNT(*) AS count FROM structured_fact WHERE candidate_id = ?")
      .get("cand-1") as { count: number };
    expect(factCount.count).toBe(1);
  });

  it("rejects on a not_authorized application answer that does not appear in the resume", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    seedWorkAuthorization(
      runtime,
      "cand-1",
      "Not authorized to work and this sentence is not in the resume",
      "not_authorized"
    );
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    unwrap(finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId }));
    const packet = unwrap(readCandidatePacket(runtime.connection.database, "cand-1"));
    expect(packet.resultStatus).toBe("rejected_hard_requirement");
    expect(packet.reasons).not.toContain("missing_evidence:work_authorization");
    const polarity = nativeDatabase(runtime)
      .prepare(
        `SELECT hraf.polarity AS polarity
         FROM hard_requirement_assessment_fact hraf
         JOIN hard_requirement_assessment hra
           ON hra.hard_requirement_assessment_id = hraf.hard_requirement_assessment_id
         WHERE hra.candidate_id = ? AND hra.requirement_field_id = 'work_authorization'`
      )
      .all("cand-1") as Array<{ polarity: string }>;
    expect(polarity.map((row) => row.polarity)).toEqual(["contradicting"]);
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

  it("prepares audit envelopes outside the SQLite writer lock", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    const db = nativeDatabase(runtime);
    const guarded = {
      ...runtime,
      clock: {
        now: () => {
          if (db.inTransaction) {
            throw new Error("audit clock must not run inside the writer lock");
          }
          return CREATED_AT;
        }
      }
    };
    const result = unwrap(
      finalizeTriageRun(guarded, { actorId: ACTOR_ID, triageAttemptId })
    );
    expect(result.result.candidateCount).toBe(1);
  });

  it("refuses finalize when the audit clock returns an invalid recorded-at time", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    let calls = 0;
    const guarded = {
      ...runtime,
      clock: {
        now: () => {
          calls += 1;
          return calls === 1 ? CREATED_AT : -1;
        }
      }
    };
    const result = finalizeTriageRun(guarded, { actorId: ACTOR_ID, triageAttemptId });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "Audit clock returned an invalid timestamp"
      })
    });
  });

  it("refuses finalize when the sealed audit envelope cannot be prepared", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    let calls = 0;
    const guarded = {
      ...runtime,
      clock: {
        now: () => {
          calls += 1;
          return calls <= 2 ? CREATED_AT : -1;
        }
      }
    };
    const result = finalizeTriageRun(guarded, { actorId: ACTOR_ID, triageAttemptId });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "Audit clock returned an invalid timestamp"
      })
    });
  });

  it("refuses finalize when a trusted extraction span id is not a valid identifier", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    const db = nativeDatabase(runtime);
    dropWorkItemTerminalTriggers(db);
    db.exec("DROP TRIGGER IF EXISTS extraction_artifact_reject_update");
    db.pragma("foreign_keys = OFF");
    const longArtifactId = `art_${"x".repeat(116)}`;
    const original = db
      .prepare(
        `SELECT extraction_artifact_id AS id
         FROM extraction_artifact
         LIMIT 1`
      )
      .get() as { id: string };
    db.prepare(
      "UPDATE extraction_artifact SET extraction_artifact_id = ? WHERE extraction_artifact_id = ?"
    ).run(longArtifactId, original.id);
    db.prepare(
      `UPDATE attempt_work_item
       SET extraction_artifact_id = ?, version = version + 1
       WHERE extraction_artifact_id = ?`
    ).run(longArtifactId, original.id);
    db.pragma("foreign_keys = ON");
    const result = finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected invalid span id failure");
    }
    expect(result.error.code).toBe("persistence_failed");
    expect(result.error.message).toContain("Invalid evidence span id");
  });

  it("refuses finalize when a trusted extraction span is missing its source document", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    unwrap(
      runImmediateTransaction(runtime.connection, (context) => {
        unwrap(
          insertSourceDocument(
            context,
            unwrap(
              prepareSourceDocument({
                sourceDocumentId: "source-doc-retarget",
                rawText: "Replacement document text that is not the original resume.",
                normalizedText: "Replacement document text that is not the original resume.",
                createdAt: CREATED_AT
              })
            )
          )
        );
        return { ok: true, value: undefined };
      })
    );
    const db = nativeDatabase(runtime);
    db.exec("DROP TRIGGER IF EXISTS candidate_document_reject_update");
    db.prepare("UPDATE candidate_document SET source_document_id = ? WHERE candidate_id = ?").run(
      "source-doc-retarget",
      "cand-1"
    );
    const result = finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "Trusted extraction span is missing its source document"
      })
    });
  });

  it("refuses finalize when trusted extraction span offsets miss the stored document", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    const db = nativeDatabase(runtime);
    db.exec("DROP TRIGGER IF EXISTS source_document_reject_update");
    const tampered = "x";
    db.prepare(
      `UPDATE source_document
       SET normalized_text = ?,
           normalized_hash = ?,
           normalized_length = ?,
           normalized_byte_length = length(CAST(? AS BLOB))
       WHERE source_document_id = ?`
    ).run(
      tampered,
      sha256Hex(tampered),
      tampered.length,
      tampered,
      "source-doc-cand-1-0"
    );
    const result = finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "Evidence span offsets do not address the stored document"
      })
    });
  });

  it("refuses finalize when trusted extraction span preparation fails", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    rewriteStoredArtifacts(nativeDatabase(runtime), (accepted) => {
      for (const span of accepted.spans) {
        span.end = span.start;
      }
    });
    const result = finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: "Evidence span end must exceed its start"
      })
    });
  });

  it("refuses finalize when a candidate has no documents", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    const db = nativeDatabase(runtime);
    db.exec("DROP TRIGGER IF EXISTS candidate_document_reject_delete");
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM candidate_document WHERE candidate_id = ?").run("cand-1");
    db.pragma("foreign_keys = ON");
    const result = finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: 'Candidate "cand-1" has no documents'
      })
    });
  });

  it("refuses finalize when a candidate is missing from the corpus snapshot", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    const db = nativeDatabase(runtime);
    const attempt = db
      .prepare(
        `SELECT corpus_manifest_id AS corpusManifestId
         FROM triage_attempt WHERE triage_attempt_id = ?`
      )
      .get(triageAttemptId) as { corpusManifestId: string };
    db.exec("DROP TRIGGER IF EXISTS corpus_member_document_reject_delete");
    db.exec("DROP TRIGGER IF EXISTS corpus_member_reject_delete");
    db.prepare(
      `DELETE FROM corpus_member_document
       WHERE corpus_member_id IN (
         SELECT corpus_member_id FROM corpus_member WHERE manifest_id = ?
       )`
    ).run(attempt.corpusManifestId);
    db.prepare("DELETE FROM corpus_member WHERE manifest_id = ?").run(attempt.corpusManifestId);
    const result = finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "persistence_failed",
        message: `Candidate "cand-1" is missing from corpus snapshot ${attempt.corpusManifestId}`
      })
    });
  });

  it("refuses finalize when a succeeded work item points at a missing artifact", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    const db = nativeDatabase(runtime);
    dropWorkItemTerminalTriggers(db);
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `UPDATE attempt_work_item
       SET extraction_artifact_id = ?, version = version + 1
       WHERE triage_attempt_id = ? AND state = 'succeeded'`
    ).run("extraction-artifact-missing", triageAttemptId);
    db.pragma("foreign_keys = ON");
    const result = finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "not_found",
        message: 'Extraction artifact "extraction-artifact-missing" not found'
      })
    });
  });

  it("refuses finalize when a failed work item points at a missing failure record", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"], (dimensionId) =>
      unlocatedBody(dimensionId)
    );
    const db = nativeDatabase(runtime);
    dropWorkItemTerminalTriggers(db);
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `UPDATE attempt_work_item
       SET extraction_failure_id = ?, version = version + 1
       WHERE triage_attempt_id = ? AND state = 'reviewable_failure'`
    ).run("extraction-failure-missing", triageAttemptId);
    db.pragma("foreign_keys = ON");
    const result = finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "not_found",
        message: 'Extraction failure "extraction-failure-missing" not found'
      })
    });
  });

  it("persists evidence gaps for complete none-level dimension assessments", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"], (dimensionId) =>
      noneLevelBody(dimensionId)
    );
    unwrap(finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId }));
    const packet = unwrap(readCandidatePacket(runtime.connection.database, "cand-1"));
    expect(packet.resultAvailability).toBe("complete");
    const gapCount = nativeDatabase(runtime)
      .prepare(
        `SELECT COUNT(*) AS count
         FROM candidate_result_evidence_gap
         WHERE candidate_result_id = ?`
      )
      .get(packet.resultId) as { count: number };
    expect(gapCount.count).toBe(RUBRIC_V1.dimensions.length);
  });

  it("does not execute deriveCandidateDecision while a SQLite transaction is open", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    const db = nativeDatabase(runtime);
    const original = candidateResults.deriveCandidateDecision;
    const spy = vi.spyOn(candidateResults, "deriveCandidateDecision").mockImplementation((input) => {
      expect(db.inTransaction).toBe(false);
      return original(input);
    });

    unwrap(finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId }));
    expect(spy).toHaveBeenCalled();
    expect(db.inTransaction).toBe(false);
  });

  it("blocks a concurrent writer only during the short finalize commit", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    const db = nativeDatabase(runtime);
    const original = candidateResults.deriveCandidateDecision;
    vi.spyOn(candidateResults, "deriveCandidateDecision").mockImplementation((input) => {
      expect(db.inTransaction).toBe(false);
      const planningLock = tryBeginImmediate(db.name, 50);
      expect(planningLock.acquired).toBe(true);
      if (planningLock.acquired) {
        planningLock.database.exec(
          "CREATE TABLE finalize_plan_lock_probe (id INTEGER PRIMARY KEY NOT NULL) STRICT"
        );
        planningLock.database.exec("INSERT INTO finalize_plan_lock_probe (id) VALUES (1)");
        planningLock.database.exec("COMMIT");
        planningLock.database.close();
      }
      return original(input);
    });

    let commitBlocked = false;
    const guarded = {
      ...runtime,
      idGenerator: {
        next: () => {
          if (db.inTransaction && !commitBlocked) {
            const commitLock = tryBeginImmediate(db.name, 1);
            expect(commitLock.acquired).toBe(false);
            if (!commitLock.acquired) {
              expect(commitLock.code).toMatch(/^SQLITE_(?:BUSY|LOCKED)/u);
              commitBlocked = true;
            }
          }
          return runtime.idGenerator.next();
        }
      }
    };

    unwrap(finalizeTriageRun(guarded, { actorId: ACTOR_ID, triageAttemptId }));
    expect(commitBlocked).toBe(true);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM finalize_plan_lock_probe").get()
    ).toEqual({ count: 1 });
  });

  it("refuses commit when work item identities change after planning", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    const db = nativeDatabase(runtime);
    onFirstDerive(() => {
      const workItem = db
        .prepare(
          `SELECT attempt_work_item_id AS id
           FROM attempt_work_item
           WHERE triage_attempt_id = ?
           LIMIT 1`
        )
        .get(triageAttemptId) as { id: string };
      db.prepare(
        `UPDATE attempt_work_item
         SET version = version + 1, updated_at = updated_at + 1
         WHERE attempt_work_item_id = ?`
      ).run(workItem.id);
    });

    const result = finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "command_conflict",
        message: "Finalize plan is stale: work item identities changed"
      })
    });
  });

  it("refuses commit when corpus membership changes after planning", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    const db = nativeDatabase(runtime);
    const attempt = db
      .prepare(
        `SELECT corpus_manifest_id AS corpusManifestId
         FROM triage_attempt WHERE triage_attempt_id = ?`
      )
      .get(triageAttemptId) as { corpusManifestId: string };
    onFirstDerive(() => {
      deleteCorpusMembers(db, attempt.corpusManifestId);
    });

    const result = finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "command_conflict",
        message: "Finalize plan is stale: corpus membership changed"
      })
    });
  });

  it("refuses commit when the attempt version changes after planning", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    const db = nativeDatabase(runtime);
    onFirstDerive(() => {
      db.prepare(
        `UPDATE triage_attempt
         SET version = version + 1, updated_at = updated_at + 1
         WHERE triage_attempt_id = ?`
      ).run(triageAttemptId);
    });

    const result = finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "version_conflict",
        message: "Finalize plan is stale: attempt version changed"
      })
    });
  });

  it("refuses commit when another finalize seals the run after planning", async () => {
    const { runtime, adapter } = await createTestRuntime();
    seedCandidates(runtime, ["cand-1"]);
    const { triageAttemptId } = await startAndExtract(runtime, adapter, ["cand-1"]);
    onFirstDerive(() => {
      unwrap(
        finalizeTriageRun(runtime, {
          actorId: ACTOR_ID,
          triageAttemptId,
          triageRunId: "competing-finalize-run"
        })
      );
    });

    const result = finalizeTriageRun(runtime, { actorId: ACTOR_ID, triageAttemptId });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "command_conflict",
        message: expect.stringContaining("A triage run already exists")
      })
    });
  });
});
