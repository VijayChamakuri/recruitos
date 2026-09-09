import {
  ActorIdSchema,
  CommandIdSchema,
  ProposalIdSchema,
  ReviewDecisionPayloadSchema,
  deriveProposalStatus,
  err,
  ok,
  type Result,
  type ReviewDecisionPayload
} from "@recruitos/core";
import { z } from "zod";

import { appendAuditEvent, prepareAuditEvent } from "../audit/index.js";
import type { ImmediateTransactionContext } from "../commands/index.js";
import type { IdGenerator } from "../composition/index.js";
import { insertActor, prepareActor, readActor, SYSTEM_ACTOR_ID } from "../entities/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  insertReviewDecision,
  prepareReviewDecision,
  readProposal,
  readProposalHead
} from "../proposals/index.js";
import { readCandidateHead, readCandidateTriageResult } from "../results/index.js";
import {
  runUseCaseCommand,
  type UseCaseComposition,
  type UseCaseResult
} from "./contract.js";

/**
 * Human review decision on a persisted proposal. One command transaction
 * inserts an immutable `review_decision`, compare-and-sets `proposal_head`
 * from version 0, and appends an audit event. The original proposal row is
 * never rewritten. No outbound ATS, message, email, or provider call.
 */

export const RECORD_REVIEW_DECISION_COMMAND_NAME = "proposal.record_review_decision";
export const RECORD_REVIEW_DECISION_EVENT_NAME = "proposal.review_decision_recorded";

export const RecordReviewDecisionPayloadSchema = z
  .object({
    proposalId: ProposalIdSchema,
    expectedVersion: z.number().int().nonnegative(),
    decision: ReviewDecisionPayloadSchema
  })
  .strict();

export const RecordReviewDecisionResultSchema = z
  .object({
    decisionId: z.string().min(1),
    newVersion: z.number().int().positive(),
    status: z.enum(["pending", "evidence_requested", "approved", "rejected", "edited"])
  })
  .strict();

export type RecordReviewDecisionPayload = z.infer<typeof RecordReviewDecisionPayloadSchema>;
export type RecordReviewDecisionResult = z.infer<typeof RecordReviewDecisionResultSchema>;

export type RecordReviewDecisionInput = Readonly<{
  actorId: string;
  proposalId: string;
  expectedVersion: number;
  decision: ReviewDecisionPayload;
  commandId?: string;
}>;

function decisionFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
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

export function recordReviewDecision(
  composition: UseCaseComposition,
  input: RecordReviewDecisionInput
): UseCaseResult<RecordReviewDecisionResult> {
  if (!isObject(composition)) {
    return err(decisionFailure("Invalid runtime composition"));
  }
  if (!isObject(composition.connection)) {
    return err(decisionFailure("Invalid runtime composition"));
  }
  if (!isObject(composition.clock) || typeof composition.clock.now !== "function") {
    return err(decisionFailure("Invalid runtime clock"));
  }
  if (!isObject(composition.idGenerator) || typeof composition.idGenerator.next !== "function") {
    return err(decisionFailure("Invalid runtime id generator"));
  }
  if (!isObject(input)) {
    return err(decisionFailure("Invalid review decision input"));
  }
  if (typeof input.actorId !== "string" || input.actorId.trim().length === 0) {
    return err(decisionFailure("Review decision requires an actor id"));
  }
  if (!ActorIdSchema.safeParse(input.actorId).success) {
    return err(decisionFailure("Review decision requires a valid actor id"));
  }
  if (input.actorId === SYSTEM_ACTOR_ID) {
    return err(createRuntimeError("command_conflict", "Review decision is a human action", false));
  }
  if (typeof input.proposalId !== "string" || input.proposalId.trim().length === 0) {
    return err(decisionFailure("Review decision requires a proposal id"));
  }
  const parsedProposalId = ProposalIdSchema.safeParse(input.proposalId);
  if (!parsedProposalId.success) {
    return err(decisionFailure("Review decision requires a valid proposal id"));
  }
  if (
    typeof input.expectedVersion !== "number" ||
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  ) {
    return err(decisionFailure("expectedVersion must be a nonnegative integer"));
  }
  const parsedDecision = ReviewDecisionPayloadSchema.safeParse(input.decision);
  if (!parsedDecision.success) {
    return err(decisionFailure("Review decision requires a valid decision payload"));
  }
  if (input.commandId !== undefined) {
    if (typeof input.commandId !== "string" || !CommandIdSchema.safeParse(input.commandId).success) {
      return err(decisionFailure("Review decision requires a valid command id"));
    }
  }

  const createdAt = composition.clock.now();
  const commandId =
    input.commandId !== undefined ? input.commandId : composition.idGenerator.next();
  const payload: RecordReviewDecisionPayload = {
    proposalId: parsedProposalId.data,
    expectedVersion: input.expectedVersion,
    decision: parsedDecision.data
  };

  const writingGenerator = replayCommandId(composition.idGenerator, commandId);
  return runUseCaseCommand(
    { ...composition, idGenerator: writingGenerator },
    {
      actorId: input.actorId,
      commandName: RECORD_REVIEW_DECISION_COMMAND_NAME,
      expectedVersion: 0,
      payload,
      payloadSchema: RecordReviewDecisionPayloadSchema,
      resultSchema: RecordReviewDecisionResultSchema,
      readVersion: () => ok(0),
      mutate: (context) =>
        commitDecision({
          composition: { ...composition, idGenerator: writingGenerator },
          context,
          actorId: input.actorId,
          createdAt,
          commandId,
          payload
        })
    }
  );
}

function commitDecision(args: {
  composition: UseCaseComposition;
  context: ImmediateTransactionContext;
  actorId: string;
  createdAt: number;
  commandId: string;
  payload: RecordReviewDecisionPayload;
}): Result<RecordReviewDecisionResult, RuntimeError> {
  const { context, payload } = args;
  const nextId = () => args.composition.idGenerator.next();

  const proposal = readProposal(context, payload.proposalId);
  /* v8 ignore next 3 -- store readers fail only on invalid stored rows */
  if (!proposal.ok) {
    return proposal;
  }
  if (proposal.value === undefined) {
    return err(createRuntimeError("not_found", `Proposal "${payload.proposalId}" not found`, false));
  }

  const storedResult = readCandidateTriageResult(context, proposal.value.candidateResultId);
  /* v8 ignore next 3 -- store readers fail only on invalid stored rows */
  if (!storedResult.ok) {
    return storedResult;
  }
  if (storedResult.value === undefined) {
    return err(
      createRuntimeError(
        "not_found",
        `Candidate result "${proposal.value.candidateResultId}" not found`,
        false
      )
    );
  }
  const candidateId = storedResult.value.candidateId;

  const candidateHead = readCandidateHead(context, candidateId);
  /* v8 ignore next 3 -- store readers fail only on invalid stored rows */
  if (!candidateHead.ok) {
    return candidateHead;
  }
  if (candidateHead.value === undefined) {
    return err(
      createRuntimeError("not_found", `Candidate head for "${candidateId}" not found`, false)
    );
  }
  if (candidateHead.value.currentResultId !== proposal.value.candidateResultId) {
    return err(
      createRuntimeError(
        "command_conflict",
        "Proposal is attached to a superseded candidate result",
        false
      )
    );
  }

  const currentHead = readProposalHead(context, payload.proposalId);
  /* v8 ignore next 3 -- store readers fail only on invalid stored rows */
  if (!currentHead.ok) {
    return currentHead;
  }
  const actualVersion = currentHead.value === undefined ? 0 : currentHead.value.version;
  if (actualVersion !== payload.expectedVersion) {
    return err(
      createRuntimeError("version_conflict", "Mutable head version conflict", false, {
        table: "proposal_head",
        identity: payload.proposalId,
        expectedVersion: payload.expectedVersion,
        actualVersion: actualVersion === 0 ? null : actualVersion
      })
    );
  }

  if (
    payload.decision.kind === "edit" &&
    payload.decision.editedPayload.kind !== proposal.value.proposalKind
  ) {
    return err(
      createRuntimeError(
        "command_conflict",
        "Edited payload kind must match the stored proposal kind",
        false
      )
    );
  }

  const actorEnsured = ensureHumanActor(context, args.actorId, args.createdAt);
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!actorEnsured.ok) {
    return actorEnsured;
  }

  const reviewDecisionId = nextId();
  const prepared = prepareReviewDecision({
    reviewDecisionId,
    proposalId: payload.proposalId,
    actorId: args.actorId,
    decisionOrdinal: payload.expectedVersion,
    payload: payload.decision,
    createdAt: args.createdAt
  });
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!prepared.ok) {
    return prepared;
  }
  const inserted = insertReviewDecision(context, prepared.value, payload.expectedVersion);
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!inserted.ok) {
    return inserted;
  }

  const newVersion = payload.expectedVersion + 1;
  const status = deriveProposalStatus(payload.decision.kind);
  const audit = prepareAuditEvent(args.composition.clock, {
    auditEventId: nextId(),
    commandId: args.commandId,
    eventOrdinal: 0,
    actorId: args.actorId,
    actorDisplayName: args.actorId,
    eventName: RECORD_REVIEW_DECISION_EVENT_NAME,
    eventVersion: 1,
    occurredAt: args.createdAt,
    payload: {
      commandId: args.commandId,
      eventOrdinal: 0,
      actorId: args.actorId,
      proposalId: payload.proposalId,
      decisionId: reviewDecisionId,
      decisionKind: payload.decision.kind,
      previousVersion: payload.expectedVersion,
      newVersion
    }
  });
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!audit.ok) {
    return audit;
  }
  const appended = appendAuditEvent(context, audit.value);
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!appended.ok) {
    return appended;
  }

  return ok({
    decisionId: reviewDecisionId,
    newVersion,
    status
  });
}

function ensureHumanActor(
  context: ImmediateTransactionContext,
  actorId: string,
  createdAt: number
): Result<void, RuntimeError> {
  const existing = readActor(context, actorId);
  /* v8 ignore next 3 -- store readers fail only on invalid stored rows */
  if (!existing.ok) {
    return existing;
  }
  if (existing.value !== undefined) {
    return ok(undefined);
  }
  const prepared = prepareActor({
    actorId,
    displayName: actorId,
    createdAt
  });
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!prepared.ok) {
    return prepared;
  }
  const inserted = insertActor(context, prepared.value);
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!inserted.ok) {
    return inserted;
  }
  return ok(undefined);
}
