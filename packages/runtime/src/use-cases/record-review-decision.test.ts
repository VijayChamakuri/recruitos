import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RUBRIC_V1,
  computeAggregateScore,
  computeConfidence,
  formatRational,
  type Result
} from "@recruitos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runImmediateTransaction } from "../commands/index.js";
import { createRuntime, type RuntimeComposition } from "../composition/index.js";
import { SYSTEM_ACTOR_ID } from "../entities/index.js";
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
  insertDimensionAssessment,
  insertEvidenceSpan,
  prepareDimensionAssessment,
  prepareEvidenceSpan
} from "../evidence/index.js";
import { persistDerivedShortlistProposals } from "../proposals/persist-shortlist.js";
import {
  insertProposal,
  prepareProposal,
  readProposal,
  readReviewDecisions
} from "../proposals/index.js";
import {
  insertCandidateResultSeal,
  prepareCandidateResultSeal,
  prepareCandidateTriageResult,
  insertCandidateTriageResult,
  setCandidateHead
} from "../results/index.js";
import {
  RECORD_REVIEW_DECISION_COMMAND_NAME,
  RECORD_REVIEW_DECISION_EVENT_NAME,
  recordReviewDecision,
  type RecordReviewDecisionInput
} from "./record-review-decision.js";

const temporaryDirectories: string[] = [];
const HUMAN_ACTOR_ID = "human:operator";
const CREATED_AT = 1_788_700_000_000;

function unwrap<T>(result: Result<T, RuntimeError> | Result<T, { message: string }>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function nativeClient(runtime: RuntimeComposition): {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
    run: (...a: unknown[]) => { changes: number };
  };
} {
  return (runtime.connection.database as unknown as { $client: ReturnType<typeof nativeClient> })
    .$client;
}

function count(runtime: RuntimeComposition, sql: string, ...params: unknown[]): number {
  const row = nativeClient(runtime).prepare(sql).get(...params) as { n: number };
  return row.n;
}

async function openRuntime(): Promise<RuntimeComposition> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-record-review-decision-"));
  temporaryDirectories.push(directory);
  const created = createRuntime({ database: { filename: join(directory, "runtime.db") } });
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  return created.value;
}

function computedScoreDraft(scoreResultId: string) {
  const computation = unwrap(
    computeAggregateScore(
      RUBRIC_V1.dimensions.map((dimension) => ({
        dimensionId: dimension.dimensionId,
        level: "none" as const
      })),
      RUBRIC_V1
    )
  );
  const confidenceInput = {
    contradictionCount: 0,
    dimensionsWithLocatedSpan: 0,
    requiredFieldsMissing: 0,
    spansLocated: 0,
    spansReturned: 0,
    totalDimensions: 6,
    totalRequiredFields: 4
  };
  const confidence = unwrap(computeConfidence(confidenceInput));
  return {
    scoreResultId,
    aggregate: formatRational(computation.aggregate),
    confidence: formatRational(confidence),
    confidenceInput,
    contributions: computation.contributions.map((contribution) => ({
      dimensionId: contribution.dimensionId,
      level: contribution.level,
      levelValue: formatRational(contribution.levelValue),
      weight: contribution.weight,
      weightedValue: formatRational(contribution.weightedValue)
    }))
  };
}

function seedScoredResult(
  context: Parameters<typeof insertCandidate>[0],
  resultId: string,
  options: {
    kind?: "initial" | "correction";
    supersedesResultId?: string | null;
    insertCandidateRow?: boolean;
  } = {}
): Result<void, RuntimeError> {
  const insertCandidateRow = options.insertCandidateRow ?? true;
  if (insertCandidateRow) {
    const candidate = prepareCandidate({
      candidateId: "candidate-1",
      sourceSystem: "synthetic_corpus",
      sourceKey: "tier-one/0001",
      channel: "inbound",
      corpusTag: "main",
      createdAt: CREATED_AT
    });
    if (!candidate.ok) return candidate;
    const insertedCandidate = insertCandidate(context, candidate.value);
    if (!insertedCandidate.ok) return insertedCandidate;
    const source = prepareSourceDocument({
      sourceDocumentId: "source-document-1",
      rawText: "ABCDEFGHIJ",
      normalizedText: "ABCDEFGHIJ",
      createdAt: CREATED_AT
    });
    if (!source.ok) return source;
    const insertedSource = insertSourceDocument(context, source.value);
    if (!insertedSource.ok) return insertedSource;
    const document = prepareCandidateDocument({
      candidateDocumentId: "candidate-document-1",
      candidateId: "candidate-1",
      sourceDocumentId: "source-document-1",
      documentKind: "resume",
      label: "Resume",
      documentOrdinal: 0,
      createdAt: CREATED_AT
    });
    if (!document.ok) return document;
    const insertedDocument = insertCandidateDocument(context, document.value);
    if (!insertedDocument.ok) return insertedDocument;
    const span = prepareEvidenceSpan({
      evidenceSpanId: "evidence-span-1",
      documentId: "source-document-1",
      start: 2,
      end: 5,
      quotedText: "CDE",
      dimensionId: "applied_ml_llm_systems",
      polarity: "supporting",
      source: "extracted",
      matchQuality: "exact",
      extractorVersion: "extractor-v1",
      createdAt: CREATED_AT
    });
    if (!span.ok) return span;
    const insertedSpan = insertEvidenceSpan(context, span.value);
    if (!insertedSpan.ok) return insertedSpan;
  }
  const dimensionAssessments: Array<{
    candidateResultDimensionAssessmentId: string;
    dimensionAssessmentId: string;
    dimensionId: string;
  }> = [];
  for (const dimension of RUBRIC_V1.dimensions) {
    const assessmentId = `dimension-assessment-${resultId}-${dimension.dimensionId}`;
    const preparedAssessment = prepareDimensionAssessment({
      dimensionAssessmentId: assessmentId,
      dimensionId: dimension.dimensionId,
      level: "none",
      source: "extracted",
      actorId: null,
      createdAt: CREATED_AT
    });
    if (!preparedAssessment.ok) return preparedAssessment;
    const insertedAssessment = insertDimensionAssessment(context, preparedAssessment.value);
    if (!insertedAssessment.ok) return insertedAssessment;
    dimensionAssessments.push({
      candidateResultDimensionAssessmentId: `candidate-result-assessment-${resultId}-${dimension.dimensionId}`,
      dimensionAssessmentId: assessmentId,
      dimensionId: dimension.dimensionId
    });
  }
  const result = prepareCandidateTriageResult({
    candidateTriageResultId: resultId,
    candidateId: "candidate-1",
    kind: options.kind ?? "initial",
    availability: "complete",
    status: "scored",
    supersedesResultId: options.supersedesResultId ?? null,
    evidenceSpans: [
      {
        candidateResultEvidenceSpanId: `candidate-result-span-${resultId}`,
        evidenceSpanId: "evidence-span-1"
      }
    ],
    evidenceGaps: [],
    dimensionAssessments,
    structuredFacts: [],
    factConflicts: [],
    hardRequirementAssessments: [],
    score: computedScoreDraft(`score-result-${resultId}`),
    sealId: `candidate-result-seal-${resultId}`,
    createdAt: CREATED_AT
  });
  if (!result.ok) return result;
  const insertedResult = insertCandidateTriageResult(context, result.value);
  if (!insertedResult.ok) return insertedResult;
  const preparedSeal = prepareCandidateResultSeal({
    candidateResultSealId: `candidate-result-seal-${resultId}`,
    candidateResultId: resultId,
    createdAt: CREATED_AT
  });
  if (!preparedSeal.ok) return preparedSeal;
  const insertedSeal = insertCandidateResultSeal(context, preparedSeal.value);
  if (!insertedSeal.ok) return insertedSeal;
  return { ok: true, value: undefined };
}

function persistShortlist(
  context: Parameters<typeof persistDerivedShortlistProposals>[0]["context"],
  resultId: string,
  proposalId: string
): Result<void, RuntimeError> {
  let counter = 0;
  return persistDerivedShortlistProposals({
    context,
    nextId: () => (counter === 0 ? ((counter += 1), proposalId) : `${proposalId}-span-${(counter += 1)}`),
    createdAt: CREATED_AT,
    resultId,
    proposals: [{ payload: { kind: "shortlist_inclusion" }, evidenceSpanIds: ["evidence-span-1"] }]
  });
}

async function seedCurrentShortlist(
  runtime: RuntimeComposition,
  proposalId = "proposal-shortlist-1",
  resultId = "candidate-result-1"
): Promise<string> {
  unwrap(
    runImmediateTransaction(runtime.connection, (context) => {
      const seeded = seedScoredResult(context, resultId);
      if (!seeded.ok) return seeded;
      const persisted = persistShortlist(context, resultId, proposalId);
      if (!persisted.ok) return persisted;
      return setCandidateHead(
        context,
        { candidateId: "candidate-1", currentResultId: resultId },
        0
      );
    })
  );
  return proposalId;
}

function approveInput(
  proposalId: string,
  overrides: Partial<RecordReviewDecisionInput> = {}
): RecordReviewDecisionInput {
  return {
    actorId: HUMAN_ACTOR_ID,
    proposalId,
    expectedVersion: 0,
    decision: { kind: "approve" },
    ...overrides
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("recordReviewDecision", () => {
  it("rejects invalid composition, input, actor, proposal, version, payload, and command id", () => {
    const runtime = {
      connection: {},
      clock: { now: () => 1 },
      idGenerator: { next: () => "command-1" }
    } as RuntimeComposition;
    expect(recordReviewDecision(null as never, approveInput("proposal-1"))).toMatchObject({
      ok: false,
      error: { message: "Invalid runtime composition" }
    });
    expect(recordReviewDecision({} as RuntimeComposition, approveInput("proposal-1"))).toMatchObject({
      ok: false,
      error: { message: "Invalid runtime composition" }
    });
    expect(
      recordReviewDecision(
        { connection: {}, clock: {}, idGenerator: { next: () => "x" } } as never,
        approveInput("proposal-1")
      )
    ).toMatchObject({ ok: false, error: { message: "Invalid runtime clock" } });
    expect(
      recordReviewDecision(
        { connection: {}, clock: { now: () => 1 }, idGenerator: {} } as never,
        approveInput("proposal-1")
      )
    ).toMatchObject({ ok: false, error: { message: "Invalid runtime id generator" } });
    expect(recordReviewDecision(runtime, null as never)).toMatchObject({
      ok: false,
      error: { message: "Invalid review decision input" }
    });
    expect(recordReviewDecision(runtime, approveInput("proposal-1", { actorId: "" }))).toMatchObject({
      ok: false,
      error: { message: "Review decision requires an actor id" }
    });
    expect(
      recordReviewDecision(runtime, approveInput("proposal-1", { actorId: "has space" }))
    ).toMatchObject({
      ok: false,
      error: { message: "Review decision requires a valid actor id" }
    });
    expect(
      recordReviewDecision(runtime, approveInput("proposal-1", { actorId: SYSTEM_ACTOR_ID }))
    ).toMatchObject({
      ok: false,
      error: { code: "command_conflict", message: "Review decision is a human action" }
    });
    expect(recordReviewDecision(runtime, approveInput(""))).toMatchObject({
      ok: false,
      error: { message: "Review decision requires a proposal id" }
    });
    expect(recordReviewDecision(runtime, approveInput("has space"))).toMatchObject({
      ok: false,
      error: { message: "Review decision requires a valid proposal id" }
    });
    expect(
      recordReviewDecision(runtime, approveInput("proposal-1", { expectedVersion: 1.5 }))
    ).toMatchObject({
      ok: false,
      error: { message: "expectedVersion must be a nonnegative integer" }
    });
    expect(
      recordReviewDecision(runtime, approveInput("proposal-1", { expectedVersion: -1 }))
    ).toMatchObject({
      ok: false,
      error: { message: "expectedVersion must be a nonnegative integer" }
    });
    expect(
      recordReviewDecision(runtime, {
        actorId: HUMAN_ACTOR_ID,
        proposalId: "proposal-1",
        expectedVersion: 0,
        decision: { kind: "reject" } as never
      })
    ).toMatchObject({
      ok: false,
      error: { message: "Review decision requires a valid decision payload" }
    });
    expect(
      recordReviewDecision(runtime, approveInput("proposal-1", { commandId: "has space" }))
    ).toMatchObject({
      ok: false,
      error: { message: "Review decision requires a valid command id" }
    });
  });

  it("approves from version 0, then advances the head once with the next version", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const runtime = await openRuntime();
    const proposalId = await seedCurrentShortlist(runtime);
    const first = unwrap(recordReviewDecision(runtime, approveInput(proposalId)));
    expect(first.metadata.replayed).toBe(false);
    expect(first.metadata.commandId).toBeTruthy();
    expect(first.result).toEqual({
      decisionId: expect.any(String),
      newVersion: 1,
      status: "approved"
    });
    expect(count(runtime, "SELECT count(*) AS n FROM review_decision")).toBe(1);
    expect(count(runtime, "SELECT count(*) AS n FROM proposal_head")).toBe(1);
    expect(count(runtime, "SELECT count(*) AS n FROM proposal")).toBe(1);

    const second = unwrap(
      recordReviewDecision(runtime, {
        actorId: HUMAN_ACTOR_ID,
        proposalId,
        expectedVersion: 1,
        decision: { kind: "reject", rationale: "Score no longer clears the bar." }
      })
    );
    expect(second.result).toEqual({
      decisionId: expect.any(String),
      newVersion: 2,
      status: "rejected"
    });
    expect(count(runtime, "SELECT count(*) AS n FROM review_decision")).toBe(2);
    const head = nativeClient(runtime)
      .prepare("SELECT version AS version, current_decision_id AS currentDecisionId FROM proposal_head WHERE proposal_id = ?")
      .get(proposalId) as { version: number; currentDecisionId: string };
    expect(head.version).toBe(2);
    expect(head.currentDecisionId).toBe(second.result.decisionId);
    expect(fetchImpl).not.toHaveBeenCalled();
    unwrap(runtime.close());
  });

  it("leaves history unchanged on a stale expected version", async () => {
    const runtime = await openRuntime();
    const proposalId = await seedCurrentShortlist(runtime);
    expect(
      recordReviewDecision(runtime, approveInput(proposalId, { expectedVersion: 1 }))
    ).toMatchObject({
      ok: false,
      error: {
        code: "version_conflict",
        details: {
          table: "proposal_head",
          identity: proposalId,
          expectedVersion: 1,
          actualVersion: null
        }
      }
    });
    unwrap(recordReviewDecision(runtime, approveInput(proposalId)));
    const stale = recordReviewDecision(runtime, approveInput(proposalId));
    expect(stale).toMatchObject({
      ok: false,
      error: {
        code: "version_conflict",
        details: {
          table: "proposal_head",
          identity: proposalId,
          expectedVersion: 0,
          actualVersion: 1
        }
      }
    });
    expect(count(runtime, "SELECT count(*) AS n FROM review_decision")).toBe(1);
    expect(count(runtime, "SELECT count(*) AS n FROM audit_event")).toBe(1);
    const head = nativeClient(runtime)
      .prepare("SELECT version AS version FROM proposal_head WHERE proposal_id = ?")
      .get(proposalId) as { version: number };
    expect(head.version).toBe(1);
    unwrap(runtime.close());
  });

  it("rejects a decision on a superseded candidate result", async () => {
    const runtime = await openRuntime();
    unwrap(
      runImmediateTransaction(runtime.connection, (context) => {
        const first = seedScoredResult(context, "candidate-result-old");
        if (!first.ok) return first;
        const persisted = persistShortlist(context, "candidate-result-old", "proposal-old");
        if (!persisted.ok) return persisted;
        const head = setCandidateHead(
          context,
          { candidateId: "candidate-1", currentResultId: "candidate-result-old" },
          0
        );
        if (!head.ok) return head;
        const second = seedScoredResult(context, "candidate-result-new", {
          insertCandidateRow: false,
          kind: "correction",
          supersedesResultId: "candidate-result-old"
        });
        if (!second.ok) return second;
        return setCandidateHead(
          context,
          { candidateId: "candidate-1", currentResultId: "candidate-result-new" },
          1
        );
      })
    );
    const decided = recordReviewDecision(runtime, approveInput("proposal-old"));
    expect(decided).toMatchObject({
      ok: false,
      error: {
        code: "command_conflict",
        message: "Proposal is attached to a superseded candidate result"
      }
    });
    expect(count(runtime, "SELECT count(*) AS n FROM review_decision")).toBe(0);
    expect(count(runtime, "SELECT count(*) AS n FROM proposal_head")).toBe(0);
    unwrap(runtime.close());
  });

  it("rejects a system actor and a missing proposal", async () => {
    const runtime = await openRuntime();
    const proposalId = await seedCurrentShortlist(runtime);
    expect(
      recordReviewDecision(runtime, approveInput(proposalId, { actorId: SYSTEM_ACTOR_ID }))
    ).toMatchObject({
      ok: false,
      error: { code: "command_conflict", message: "Review decision is a human action" }
    });
    expect(recordReviewDecision(runtime, approveInput("proposal-missing"))).toMatchObject({
      ok: false,
      error: { code: "not_found", message: 'Proposal "proposal-missing" not found' }
    });
    expect(count(runtime, "SELECT count(*) AS n FROM review_decision")).toBe(0);
    unwrap(runtime.close());
  });

  it("rejects reject and request_evidence payloads that omit a nonempty rationale", async () => {
    const runtime = {
      connection: {},
      clock: { now: () => 1 },
      idGenerator: { next: () => "command-1" }
    } as RuntimeComposition;
    expect(
      recordReviewDecision(runtime, {
        actorId: HUMAN_ACTOR_ID,
        proposalId: "proposal-1",
        expectedVersion: 0,
        decision: { kind: "reject", rationale: "   " }
      })
    ).toMatchObject({
      ok: false,
      error: { message: "Review decision requires a valid decision payload" }
    });
    expect(
      recordReviewDecision(runtime, {
        actorId: HUMAN_ACTOR_ID,
        proposalId: "proposal-1",
        expectedVersion: 0,
        decision: { kind: "request_evidence", rationale: "" }
      })
    ).toMatchObject({
      ok: false,
      error: { message: "Review decision requires a valid decision payload" }
    });
  });

  it("records request_evidence without rewriting the proposal", async () => {
    const runtime = await openRuntime();
    const proposalId = await seedCurrentShortlist(runtime);
    const original = nativeClient(runtime)
      .prepare("SELECT payload_json AS payloadJson, payload_hash AS payloadHash FROM proposal WHERE proposal_id = ?")
      .get(proposalId) as { payloadJson: string; payloadHash: string };
    const decided = unwrap(
      recordReviewDecision(runtime, {
        actorId: HUMAN_ACTOR_ID,
        proposalId,
        expectedVersion: 0,
        decision: { kind: "request_evidence", rationale: "Need the original offer letter." }
      })
    );
    expect(decided.result.status).toBe("evidence_requested");
    const stored = nativeClient(runtime)
      .prepare("SELECT payload_json AS payloadJson, payload_hash AS payloadHash FROM proposal WHERE proposal_id = ?")
      .get(proposalId) as { payloadJson: string; payloadHash: string };
    expect(stored).toEqual(original);
    unwrap(runtime.close());
  });

  it("edits by retaining the original proposal and storing the edited payload on the decision", async () => {
    const runtime = await openRuntime();
    unwrap(
      runImmediateTransaction(runtime.connection, (context) => {
        const seeded = seedScoredResult(context, "candidate-result-1");
        if (!seeded.ok) return seeded;
        const prepared = prepareProposal({
          proposalId: "proposal-follow-up",
          candidateResultId: "candidate-result-1",
          proposalOrdinal: 0,
          payload: {
            kind: "follow_up_draft",
            body: "Ask for a work-authorization document."
          },
          evidenceSpans: [],
          createdAt: CREATED_AT
        });
        if (!prepared.ok) return prepared;
        const inserted = insertProposal(context, prepared.value);
        if (!inserted.ok) return inserted;
        return setCandidateHead(
          context,
          { candidateId: "candidate-1", currentResultId: "candidate-result-1" },
          0
        );
      })
    );
    const original = unwrap(
      runImmediateTransaction(runtime.connection, (context) => readProposal(context, "proposal-follow-up"))
    );
    expect(original?.payload).toEqual({
      kind: "follow_up_draft",
      body: "Ask for a work-authorization document."
    });
    const decided = unwrap(
      recordReviewDecision(runtime, {
        actorId: HUMAN_ACTOR_ID,
        proposalId: "proposal-follow-up",
        expectedVersion: 0,
        decision: {
          kind: "edit",
          editedPayload: {
            kind: "follow_up_draft",
            body: "Ask for a signed work-authorization letter."
          }
        }
      })
    );
    expect(decided.result.status).toBe("edited");
    const after = unwrap(
      runImmediateTransaction(runtime.connection, (context) => readProposal(context, "proposal-follow-up"))
    );
    expect(after?.payload).toEqual(original?.payload);
    const history = unwrap(
      runImmediateTransaction(runtime.connection, (context) =>
        readReviewDecisions(context, "proposal-follow-up")
      )
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.payload).toEqual({
      kind: "edit",
      editedPayload: {
        kind: "follow_up_draft",
        body: "Ask for a signed work-authorization letter."
      }
    });
    const mismatched = recordReviewDecision(runtime, {
      actorId: HUMAN_ACTOR_ID,
      proposalId: "proposal-follow-up",
      expectedVersion: 1,
      decision: {
        kind: "edit",
        editedPayload: { kind: "shortlist_inclusion" }
      }
    });
    expect(mismatched).toMatchObject({
      ok: false,
      error: {
        code: "command_conflict",
        message: "Edited payload kind must match the stored proposal kind"
      }
    });
    expect(count(runtime, "SELECT count(*) AS n FROM review_decision")).toBe(1);
    unwrap(runtime.close());
  });

  it("replays an identical command and rejects a reused command id with different input", async () => {
    const runtime = await openRuntime();
    const proposalId = await seedCurrentShortlist(runtime);
    const first = unwrap(
      recordReviewDecision(runtime, approveInput(proposalId, { commandId: "decision-command-1" }))
    );
    expect(first.metadata.commandId).toBe("decision-command-1");
    const replay = unwrap(
      recordReviewDecision(runtime, approveInput(proposalId, { commandId: "decision-command-1" }))
    );
    expect(replay.metadata.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
    expect(count(runtime, "SELECT count(*) AS n FROM review_decision")).toBe(1);
    expect(count(runtime, "SELECT count(*) AS n FROM audit_event")).toBe(1);
    const mismatch = recordReviewDecision(
      runtime,
      approveInput(proposalId, {
        commandId: "decision-command-1",
        expectedVersion: 1,
        decision: { kind: "reject", rationale: "Different payload." }
      })
    );
    expect(mismatch).toMatchObject({
      ok: false,
      error: {
        code: "command_conflict",
        details: { reason: "command_identity_mismatch" }
      }
    });
    expect(count(runtime, "SELECT count(*) AS n FROM review_decision")).toBe(1);
    unwrap(runtime.close());
  });

  it("writes exact audit event contents and ordinals", async () => {
    const runtime = await openRuntime();
    const proposalId = await seedCurrentShortlist(runtime);
    const first = unwrap(
      recordReviewDecision(runtime, approveInput(proposalId, { commandId: "audit-command-1" }))
    );
    const firstRow = nativeClient(runtime)
      .prepare(
        `SELECT command_id AS commandId, event_ordinal AS eventOrdinal, actor_id AS actorId,
                event_name AS eventName, payload_json AS payloadJson
         FROM audit_event WHERE command_id = ?`
      )
      .get("audit-command-1") as {
      commandId: string;
      eventOrdinal: number;
      actorId: string;
      eventName: string;
      payloadJson: string;
    };
    expect(firstRow.commandId).toBe("audit-command-1");
    expect(firstRow.eventOrdinal).toBe(0);
    expect(firstRow.actorId).toBe(HUMAN_ACTOR_ID);
    expect(firstRow.eventName).toBe(RECORD_REVIEW_DECISION_EVENT_NAME);
    expect(JSON.parse(firstRow.payloadJson)).toEqual({
      commandId: "audit-command-1",
      eventOrdinal: 0,
      actorId: HUMAN_ACTOR_ID,
      proposalId,
      decisionId: first.result.decisionId,
      decisionKind: "approve",
      previousVersion: 0,
      newVersion: 1
    });
    const second = unwrap(
      recordReviewDecision(runtime, {
        actorId: HUMAN_ACTOR_ID,
        proposalId,
        expectedVersion: 1,
        decision: { kind: "reject", rationale: "Closed after recruiter review." },
        commandId: "audit-command-2"
      })
    );
    const secondRow = nativeClient(runtime)
      .prepare(
        `SELECT event_ordinal AS eventOrdinal, payload_json AS payloadJson
         FROM audit_event WHERE command_id = ?`
      )
      .get("audit-command-2") as { eventOrdinal: number; payloadJson: string };
    expect(secondRow.eventOrdinal).toBe(0);
    expect(JSON.parse(secondRow.payloadJson)).toEqual({
      commandId: "audit-command-2",
      eventOrdinal: 0,
      actorId: HUMAN_ACTOR_ID,
      proposalId,
      decisionId: second.result.decisionId,
      decisionKind: "reject",
      previousVersion: 1,
      newVersion: 2
    });
    const decisions = unwrap(
      runImmediateTransaction(runtime.connection, (context) => readReviewDecisions(context, proposalId))
    );
    expect(decisions.map((decision) => decision.decisionOrdinal)).toEqual([0, 1]);
    expect(RECORD_REVIEW_DECISION_COMMAND_NAME).toBe("proposal.record_review_decision");
    unwrap(runtime.close());
  });

  it("fails closed when the candidate has no head", async () => {
    const runtime = await openRuntime();
    unwrap(
      runImmediateTransaction(runtime.connection, (context) => {
        const seeded = seedScoredResult(context, "candidate-result-1");
        if (!seeded.ok) return seeded;
        return persistShortlist(context, "candidate-result-1", "proposal-shortlist-1");
      })
    );
    expect(
      recordReviewDecision(runtime, approveInput("proposal-shortlist-1"))
    ).toMatchObject({
      ok: false,
      error: { code: "not_found", message: 'Candidate head for "candidate-1" not found' }
    });
    unwrap(runtime.close());
  });
});
