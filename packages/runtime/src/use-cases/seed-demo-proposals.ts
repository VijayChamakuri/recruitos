import {
  ActorIdSchema,
  CommandIdSchema,
  SYNTHETIC_DEMO_SESSION_ID,
  err,
  ok,
  type ProposalPayload,
  type Result
} from "@recruitos/core";
import { z } from "zod";

import { appendAuditEvent, prepareAuditEvent } from "../audit/index.js";
import type { ImmediateTransactionContext } from "../commands/index.js";
import type { IdGenerator } from "../composition/index.js";
import { DEMO_CORPUS_SEED_HASH } from "../corpus/index.js";
import { SYSTEM_ACTOR_ID } from "../entities/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import { insertProposal, prepareProposal } from "../proposals/index.js";
import {
  runUseCaseCommand,
  type UseCaseComposition,
  type UseCaseResult
} from "./contract.js";

export const SEED_DEMO_PROPOSALS_COMMAND_NAME = "demo.seed_proposals";
export const SEED_DEMO_PROPOSALS_EVENT_NAME = "demo.proposals_seeded";

const DemoProposalKindSchema = z.enum([
  "shortlist_inclusion",
  "ats_stage_change",
  "follow_up_draft"
]);

export const SeedDemoProposalsResultSchema = z
  .object({
    proposals: z.array(
      z
        .object({
          proposalId: z.string().min(1),
          candidateId: z.string().min(1),
          sourceKey: z.string().min(1),
          kind: DemoProposalKindSchema
        })
        .strict()
    ),
    triageRunCount: z.literal(1),
    triageRunMemberCount: z.literal(7)
  })
  .strict();

const SeedDemoProposalsPayloadSchema = z
  .object({ seedHash: z.string().length(64) })
  .strict();

export type SeedDemoProposalsResult = z.infer<typeof SeedDemoProposalsResultSchema>;

export type SeedDemoProposalsInput = Readonly<{
  actorId?: string;
  commandId?: string;
}>;

type TargetRow = Readonly<{
  candidateId: string;
  sourceKey: string;
  resultId: string;
  evidenceSpanId: string;
}>;

const FIXTURES: readonly Readonly<{
  sourceKey: string;
  payload: ProposalPayload;
}>[] = [
  {
    sourceKey: "demo/route-1-scored",
    payload: { kind: "shortlist_inclusion" }
  },
  {
    sourceKey: "demo/route-7-quote-grounding",
    payload: { kind: "ats_stage_change", targetStage: "Recruiter screen" }
  },
  {
    sourceKey: "demo/route-5-missing-evidence",
    payload: {
      kind: "follow_up_draft",
      body: "Please provide a concrete example of an applied ML or LLM system you built and operated."
    }
  }
];

function failure(message: string, code: "persistence_failed" | "command_conflict" = "persistence_failed"): RuntimeError {
  return createRuntimeError(code, message, false);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function replayCommandId(idGenerator: IdGenerator, commandId: string): IdGenerator {
  let replayed = false;
  return {
    next: () => {
      if (!replayed) {
        replayed = true;
        return commandId;
      }
      return idGenerator.next();
    }
  };
}

function readFixtureVersion(context: ImmediateTransactionContext): Result<number, RuntimeError> {
  const row = context.nativeDatabase
    .prepare(
      `SELECT COUNT(*) AS count
       FROM proposal proposal
       JOIN candidate_triage_result result
         ON result.candidate_triage_result_id = proposal.candidate_result_id
       JOIN candidate candidate ON candidate.candidate_id = result.candidate_id
       WHERE candidate.source_key IN (?, ?, ?)`
    )
    .get(...FIXTURES.map((fixture) => fixture.sourceKey)) as { count: number };
  return ok(row.count);
}

function validateDemoDatabase(
  context: ImmediateTransactionContext
): Result<{ triageRunCount: 1; triageRunMemberCount: 7 }, RuntimeError> {
  const marker = context.nativeDatabase
    .prepare(
      `SELECT seed_hash AS seedHash
       FROM demo_session
       WHERE demo_session_id = ? AND purpose = 'synthetic_demo'`
    )
    .get(SYNTHETIC_DEMO_SESSION_ID) as { seedHash: string } | undefined;
  if (marker?.seedHash !== DEMO_CORPUS_SEED_HASH) {
    return err(failure("Demo proposals require the prepared synthetic demo database", "command_conflict"));
  }
  const run = context.nativeDatabase
    .prepare(
      `SELECT COUNT(*) AS runCount,
              COALESCE(SUM((SELECT COUNT(*) FROM triage_run_member member
                            WHERE member.triage_run_id = triage_run.triage_run_id)), 0) AS memberCount,
              MIN(kind) AS runKind,
              MAX(kind) AS maxRunKind
       FROM triage_run`
    )
    .get() as { runCount: number; memberCount: number; runKind: string | null; maxRunKind: string | null };
  if (
    run.runCount !== 1 ||
    run.memberCount !== 7 ||
    run.runKind !== "variant" ||
    run.maxRunKind !== "variant"
  ) {
    return err(failure("Demo proposals require one seven-member variant run", "command_conflict"));
  }
  return ok({ triageRunCount: 1, triageRunMemberCount: 7 });
}

function loadTarget(
  context: ImmediateTransactionContext,
  sourceKey: string
): Result<TargetRow, RuntimeError> {
  const row = context.nativeDatabase
    .prepare(
      `SELECT candidate.candidate_id AS candidateId,
              candidate.source_key AS sourceKey,
              head.current_result_id AS resultId,
              span.evidence_span_id AS evidenceSpanId
       FROM candidate candidate
       JOIN candidate_head head ON head.candidate_id = candidate.candidate_id
       JOIN candidate_result_seal seal ON seal.candidate_result_id = head.current_result_id
       JOIN candidate_result_evidence_span result_span
         ON result_span.candidate_result_id = head.current_result_id
       JOIN evidence_span span ON span.evidence_span_id = result_span.evidence_span_id
       WHERE candidate.source_key = ?
       ORDER BY result_span.span_ordinal ASC
       LIMIT 1`
    )
    .get(sourceKey) as TargetRow | undefined;
  return row === undefined
    ? err(failure(`Demo proposal target "${sourceKey}" is not a sealed evidenced result`, "command_conflict"))
    : ok(row);
}

function commitFixtures(args: {
  composition: UseCaseComposition;
  context: ImmediateTransactionContext;
  commandId: string;
  actorId: string;
  createdAt: number;
}): Result<SeedDemoProposalsResult, RuntimeError> {
  const invariant = validateDemoDatabase(args.context);
  if (!invariant.ok) return invariant;

  const proposals: SeedDemoProposalsResult["proposals"] = [];
  for (const fixture of FIXTURES) {
    const target = loadTarget(args.context, fixture.sourceKey);
    if (!target.ok) return target;
    const proposalId = args.composition.idGenerator.next();
    const prepared = prepareProposal({
      proposalId,
      candidateResultId: target.value.resultId,
      proposalOrdinal: 0,
      payload: fixture.payload,
      evidenceSpans: [
        {
          proposalEvidenceSpanId: args.composition.idGenerator.next(),
          evidenceSpanId: target.value.evidenceSpanId
        }
      ],
      createdAt: args.createdAt
    });
    /* v8 ignore next 1 -- fixture constants and stored rows satisfy the proposal schema. */
    if (!prepared.ok) return prepared;
    const inserted = insertProposal(args.context, prepared.value);
    /* v8 ignore next 1 -- target ownership is checked by loadTarget in this transaction. */
    if (!inserted.ok) return inserted;
    proposals.push({
      proposalId,
      candidateId: target.value.candidateId,
      sourceKey: target.value.sourceKey,
      kind: DemoProposalKindSchema.parse(fixture.payload.kind)
    });
  }

  const audit = prepareAuditEvent(args.composition.clock, {
    auditEventId: args.composition.idGenerator.next(),
    commandId: args.commandId,
    eventOrdinal: 0,
    actorId: args.actorId,
    actorDisplayName: args.actorId,
    eventName: SEED_DEMO_PROPOSALS_EVENT_NAME,
    eventVersion: 1,
    occurredAt: args.createdAt,
    payload: {
      commandId: args.commandId,
      eventOrdinal: 0,
      proposalIds: proposals.map((proposal) => proposal.proposalId),
      sourceKeys: proposals.map((proposal) => proposal.sourceKey)
    }
  });
  /* v8 ignore next 1 -- the event is built from validated command and fixture data. */
  if (!audit.ok) return audit;
  const appended = appendAuditEvent(args.context, audit.value);
  /* v8 ignore next 1 -- append receives a prepared event in the active command transaction. */
  if (!appended.ok) return appended;

  return ok({ proposals, ...invariant.value });
}

export function seedDemoProposals(
  composition: UseCaseComposition,
  inputValue: SeedDemoProposalsInput = {}
): UseCaseResult<SeedDemoProposalsResult> {
  if (
    !isObject(composition) ||
    !isObject(composition.connection) ||
    !isObject(composition.clock) ||
    typeof composition.clock.now !== "function" ||
    !isObject(composition.idGenerator) ||
    typeof composition.idGenerator.next !== "function"
  ) {
    return err(failure("Invalid runtime composition"));
  }
  if (!isObject(inputValue)) {
    return err(failure("Invalid demo proposal input"));
  }
  const input = inputValue as SeedDemoProposalsInput;
  const actorId = input.actorId ?? SYSTEM_ACTOR_ID;
  if (!ActorIdSchema.safeParse(actorId).success || actorId !== SYSTEM_ACTOR_ID) {
    return err(failure("Demo proposal seeding is a system-only action", "command_conflict"));
  }
  if (input.commandId !== undefined && !CommandIdSchema.safeParse(input.commandId).success) {
    return err(failure("Demo proposal seeding requires a valid command id"));
  }
  const commandId = input.commandId ?? composition.idGenerator.next();
  const idGenerator = replayCommandId(composition.idGenerator, commandId);
  const createdAt = composition.clock.now();
  return runUseCaseCommand(
    { ...composition, idGenerator },
    {
      actorId,
      commandName: SEED_DEMO_PROPOSALS_COMMAND_NAME,
      expectedVersion: 0,
      payload: { seedHash: DEMO_CORPUS_SEED_HASH },
      payloadSchema: SeedDemoProposalsPayloadSchema,
      resultSchema: SeedDemoProposalsResultSchema,
      readVersion: readFixtureVersion,
      mutate: (context) =>
        commitFixtures({
          composition: { ...composition, idGenerator },
          context,
          commandId,
          actorId,
          createdAt
        })
    }
  );
}
