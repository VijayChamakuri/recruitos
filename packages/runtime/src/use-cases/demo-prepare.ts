import {
  SYNTHETIC_DEMO_SESSION_ID,
  err,
  ok,
  sha256Hex,
  type Result
} from "@recruitos/core";

import { FixtureExtractionAdapter } from "../adapters/index.js";
import { runImmediateTransaction } from "../commands/index.js";
import type { RuntimeComposition } from "../composition/index.js";
import {
  DEMO_CORPUS_SEED_HASH,
  DEMO_FROZEN_DATE,
  DEMO_ROLE_ID,
  DEMO_ROLE_TITLE,
  demoExtractionResponseBody
} from "../corpus/demo/demo-corpus.js";
import { insertDemoSession, prepareDemoSession } from "../demo-session/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import { insertRole, prepareRole } from "../roles/index.js";
import { runExtractionAttempt } from "../scheduler/index.js";
import { finalizeTriageRun } from "./finalize-triage-run.js";
import { importCandidates } from "./import-candidates.js";
import { startTriageRun } from "./start-triage-run.js";

/**
 * One call that stands up the local demo spine end to end against a fresh
 * database: seed the role and the `synthetic_demo` marker, import the
 * one-candidate proving corpus, start a triage attempt, register the
 * hand-authored fixture extraction responses keyed exactly the way the
 * scheduler hashes its requests, run fixture extraction, and finalize.
 *
 * The composition must carry a `FixtureExtractionAdapter` and a candidate
 * source seeded with the demo corpus; `demoCompositionOptions` provides both.
 * The call is a thin orchestration over existing command use cases, so replay
 * safety and version checks come from each of those.
 */

const REQUEST_HASH_SEPARATOR = "|";
const DEMO_ACTOR_ID = "actor-demo-runner";

export type DemoPrepareInput = Readonly<{
  /** Actor the seeded commands are recorded against. Defaults to the demo runner. */
  actorId?: string;
}>;

export type DemoPrepareResult = Readonly<{
  candidateIds: readonly string[];
  triageAttemptId: string;
  triageRunId: string;
  resultIds: readonly string[];
}>;

type WorkItemFixtureRow = Readonly<{
  specContentHash: string;
  documentKind: string;
  normalizedHash: string;
  dimensionId: string;
  sourceKey: string;
}>;

function demoFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function seedRole(
  composition: RuntimeComposition,
  createdAt: number
): Result<void, RuntimeError> {
  return runImmediateTransaction(composition.connection, (context) => {
    const existing = context.nativeDatabase
      .prepare("SELECT 1 AS present FROM role WHERE role_id = ? LIMIT 1")
      .get(DEMO_ROLE_ID);
    if (existing !== undefined) {
      return ok(undefined);
    }
    const prepared = prepareRole({
      roleId: DEMO_ROLE_ID,
      title: DEMO_ROLE_TITLE,
      createdAt
    });
    /* v8 ignore next 3 -- draft built from module constants; only fails on an injected fault. */
    if (!prepared.ok) {
      return prepared;
    }
    const inserted = insertRole(context, prepared.value);
    /* v8 ignore next 3 -- insert of a fresh row into a migrated table; only fails on an injected fault. */
    if (!inserted.ok) {
      return inserted;
    }
    return ok(undefined);
  });
}

function seedDemoSessionMarker(
  composition: RuntimeComposition,
  createdAt: number
): Result<void, RuntimeError> {
  return runImmediateTransaction(composition.connection, (context) => {
    const existing = context.nativeDatabase
      .prepare("SELECT 1 AS present FROM demo_session WHERE demo_session_id = ? LIMIT 1")
      .get(SYNTHETIC_DEMO_SESSION_ID);
    if (existing !== undefined) {
      return ok(undefined);
    }
    const prepared = prepareDemoSession({
      demoSessionId: SYNTHETIC_DEMO_SESSION_ID,
      purpose: "synthetic_demo",
      generation: 1,
      webOwner: null,
      heartbeatAt: null,
      expiresAt: null,
      seedHash: DEMO_CORPUS_SEED_HASH,
      version: 1,
      createdAt,
      updatedAt: createdAt
    });
    /* v8 ignore next 3 -- draft built from module constants; only fails on an injected fault. */
    if (!prepared.ok) {
      return prepared;
    }
    const inserted = insertDemoSession(context, prepared.value);
    /* v8 ignore next 3 -- insert of a fresh row into a migrated table; only fails on an injected fault. */
    if (!inserted.ok) {
      return inserted;
    }
    return ok(undefined);
  });
}

const WORK_ITEM_FIXTURE_SELECT = `SELECT
  s.content_hash AS specContentHash,
  cd.document_kind AS documentKind,
  sd.normalized_hash AS normalizedHash,
  awi.dimension_id AS dimensionId,
  c.source_key AS sourceKey
FROM attempt_work_item awi
JOIN extraction_spec s ON s.extraction_spec_id = awi.extraction_spec_id
JOIN candidate_document cd ON cd.candidate_document_id = awi.candidate_document_id
JOIN source_document sd ON sd.source_document_id = cd.source_document_id
JOIN candidate c ON c.candidate_id = awi.candidate_id
WHERE awi.triage_attempt_id = ?`;

function registerDemoFixtures(
  composition: RuntimeComposition,
  triageAttemptId: string
): Result<void, RuntimeError> {
  const adapter = composition.extraction;
  if (!(adapter instanceof FixtureExtractionAdapter)) {
    return err(demoFailure("demoPrepare requires a FixtureExtractionAdapter"));
  }
  const rows = runImmediateTransaction(composition.connection, (context) =>
    ok(
      context.nativeDatabase
        .prepare(WORK_ITEM_FIXTURE_SELECT)
        .all(triageAttemptId) as readonly WorkItemFixtureRow[]
    )
  );
  /* v8 ignore next 3 -- the inline read transaction returns ok unconditionally. */
  if (!rows.ok) {
    return rows;
  }
  /* v8 ignore next 3 -- a successful startTriageRun always produces work items. */
  if (rows.value.length === 0) {
    return err(demoFailure("Triage attempt produced no work items"));
  }
  for (const row of rows.value) {
    const requestHash = sha256Hex(
      [row.specContentHash, row.documentKind, row.normalizedHash].join(REQUEST_HASH_SEPARATOR)
    );
    adapter.registerFixture(
      requestHash,
      demoExtractionResponseBody(row.dimensionId, row.sourceKey)
    );
  }
  return ok(undefined);
}

export async function demoPrepare(
  composition: RuntimeComposition,
  input: DemoPrepareInput = {}
): Promise<Result<DemoPrepareResult, RuntimeError>> {
  if (!isObject(composition) || !isObject(composition.candidateSource) || !isObject(composition.extraction)) {
    return err(demoFailure("Invalid runtime composition"));
  }
  const actorId = input.actorId ?? DEMO_ACTOR_ID;
  const createdAt = composition.clock.now();

  const roleSeeded = seedRole(composition, createdAt);
  /* v8 ignore next 3 -- seedRole only fails on an injected fault. */
  if (!roleSeeded.ok) {
    return roleSeeded;
  }
  const markerSeeded = seedDemoSessionMarker(composition, createdAt);
  /* v8 ignore next 3 -- seedDemoSessionMarker only fails on an injected fault. */
  if (!markerSeeded.ok) {
    return markerSeeded;
  }

  const imported = await importCandidates(composition, { actorId, corpusTag: "main" });
  /* v8 ignore next 3 -- importCandidates over the seeded demo source only fails on an injected fault. */
  if (!imported.ok) {
    return imported;
  }
  const candidateIds = imported.value.result.candidateIds;
  if (candidateIds.length === 0) {
    return err(demoFailure("Demo corpus imported no candidates"));
  }

  const started = startTriageRun(composition, {
    actorId,
    roleId: DEMO_ROLE_ID,
    candidateIds,
    frozenDate: DEMO_FROZEN_DATE
  });
  /* v8 ignore next 3 -- startTriageRun over the imported demo candidate only fails on an injected fault. */
  if (!started.ok) {
    return started;
  }
  const { triageAttemptId, triageRunId } = started.value.result;

  const fixturesRegistered = registerDemoFixtures(composition, triageAttemptId);
  if (!fixturesRegistered.ok) {
    return fixturesRegistered;
  }

  const extracted = await runExtractionAttempt(composition, { triageAttemptId });
  /* v8 ignore next 3 -- runExtractionAttempt only errors on an invalid attempt id. */
  if (!extracted.ok) {
    return extracted;
  }
  if (extracted.value.blockedFailures > 0) {
    return err(
      demoFailure(
        `Demo extraction produced ${extracted.value.blockedFailures} blocked failures`
      )
    );
  }

  const finalized = finalizeTriageRun(composition, {
    actorId,
    triageAttemptId,
    triageRunId
  });
  /* v8 ignore next 3 -- finalizeTriageRun over the extracted demo attempt only fails on an injected fault. */
  if (!finalized.ok) {
    return finalized;
  }

  return ok({
    candidateIds,
    triageAttemptId,
    triageRunId,
    resultIds: finalized.value.result.resultIds
  });
}
