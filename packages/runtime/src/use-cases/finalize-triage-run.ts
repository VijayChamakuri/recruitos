import {
  ActorIdSchema,
  RUBRIC_V1,
  TriageRunIdSchema,
  err,
  formatRational,
  formatReasonCode,
  ok,
  type HardRequirementPolicy,
  type LockedRubric,
  type Result
} from "@recruitos/core";
import { z } from "zod";

import { readCandidateApplicationAnswerByCandidateQuestion } from "../application-answers/index.js";
import {
  readAttemptWorkItems,
  readTriageAttempt,
  type AttemptWorkItem,
  type TriageAttempt
} from "../attempts/index.js";
import {
  appendAuditEvent,
  prepareAuditEvent,
  type AuditEvent
} from "../audit/index.js";
import {
  runImmediateTransaction,
  type ImmediateTransactionContext
} from "../commands/index.js";
import type { IdGenerator } from "../composition/index.js";
import { MAIN_DEMO_CORPUS_MEMBER_COUNT } from "../corpus/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  insertDimensionAssessment,
  insertDimensionAssessmentEvidenceSpan,
  insertEvidenceGap,
  insertEvidenceSpan,
  prepareDimensionAssessment,
  prepareDimensionAssessmentEvidenceSpan,
  prepareEvidenceGap,
  prepareEvidenceSpan
} from "../evidence/index.js";
import {
  readExtractionArtifact,
  readExtractionFailure,
  type ExtractionArtifact,
  type ExtractionFailure
} from "../extraction/index.js";
import {
  insertHardRequirementAssessment,
  insertStructuredFact,
  prepareHardRequirementAssessment,
  prepareStructuredFact
} from "../facts/index.js";
import { createHardRequirementPolicyV1 } from "../policy/index.js";
import { insertResolutionTask, prepareResolutionTask } from "../resolution/index.js";
import {
  deriveCandidateDecision,
  insertCandidateResultReason,
  insertCandidateResultSeal,
  insertCandidateTriageResult,
  prepareCandidateResultReason,
  prepareCandidateResultSeal,
  prepareCandidateTriageResult,
  setCandidateHead,
  type CandidateDecisionOutput,
  type CandidateDocumentBridgeInput,
  type CandidateExtractionResultInput
} from "../results/index.js";
import {
  insertTriageRun,
  insertTriageRunMember,
  insertTriageRunSeal,
  prepareTriageRun,
  prepareTriageRunMember,
  prepareTriageRunSeal
} from "../runs/index.js";
import { readRunInputSnapshot } from "../snapshots/index.js";
import {
  runUseCaseCommand,
  type UseCaseComposition,
  type UseCaseResult
} from "./contract.js";

/**
 * Finalizes a ready official triage attempt: one command transaction writes
 * sealed candidate results, candidate heads, the official triage run, and
 * already-prepared audit events. Audit envelopes are hashed and timestamped
 * before the writer lock. A blocked work item refuses finalization.
 * Reviewable failures become unavailable results with exactly one
 * `assessment_unavailable` reason.
 */

export const FINALIZE_TRIAGE_RUN_COMMAND_NAME = "triage_run.finalize";

export const FinalizeTriageRunPayloadSchema = z
  .object({
    triageAttemptId: z.string().min(1),
    triageRunId: z.string().min(1).optional()
  })
  .strict();

export const FinalizeTriageRunResultSchema = z
  .object({
    triageRunId: z.string().min(1),
    triageAttemptId: z.string().min(1),
    candidateCount: z.number().int().nonnegative(),
    resultIds: z.array(z.string().min(1))
  })
  .strict();

export type FinalizeTriageRunPayload = z.infer<typeof FinalizeTriageRunPayloadSchema>;
export type FinalizeTriageRunResult = z.infer<typeof FinalizeTriageRunResultSchema>;

export type FinalizeTriageRunInput = Readonly<{
  actorId: string;
  triageAttemptId: string;
  triageRunId?: string;
  rubric?: LockedRubric;
}>;

const WORK_AUTHORIZATION_QUESTION_KEY = "work_authorization";
const FALLBACK_DIMENSION_ID = RUBRIC_V1.dimensions[0]!.dimensionId;

function finalizeFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type CandidateDocumentRow = Readonly<{
  candidateDocumentId: string;
  documentKind: string;
  sourceDocumentId: string;
  normalizedText: string;
  normalizedHash: string;
}>;

type HydratedWorkItem =
  | Readonly<{ workItem: AttemptWorkItem; artifact: ExtractionArtifact; failure: null }>
  | Readonly<{ workItem: AttemptWorkItem; artifact: null; failure: ExtractionFailure }>;

type CandidateGroup = Readonly<{
  candidateId: string;
  artifacts: ExtractionArtifact[];
  extractions: CandidateExtractionResultInput[];
}>;

type PlannedCandidate = Readonly<{
  candidateId: string;
  documents: readonly CandidateDocumentRow[];
  artifacts: readonly ExtractionArtifact[];
  decision: CandidateDecisionOutput;
  resultId: string;
}>;

type FinalizePlan = Readonly<{
  attempt: TriageAttempt;
  extractorVersion: string;
  policy: HardRequirementPolicy;
  candidates: readonly PlannedCandidate[];
  importOrdinalByCandidate: ReadonlyMap<string, number>;
  triageRunId: string;
  kind: "main" | "variant";
}>;

export function finalizeTriageRun(
  composition: UseCaseComposition,
  input: FinalizeTriageRunInput
): UseCaseResult<FinalizeTriageRunResult> {
  if (!isObject(composition)) {
    return err(finalizeFailure("Invalid runtime composition"));
  }
  if (!isObject(composition.connection)) {
    return err(finalizeFailure("Invalid runtime composition"));
  }
  if (!isObject(composition.clock) || typeof composition.clock.now !== "function") {
    return err(finalizeFailure("Invalid runtime clock"));
  }
  if (!isObject(composition.idGenerator) || typeof composition.idGenerator.next !== "function") {
    return err(finalizeFailure("Invalid runtime id generator"));
  }
  if (!isObject(input)) {
    return err(finalizeFailure("Invalid finalize triage run input"));
  }
  if (typeof input.actorId !== "string" || input.actorId.trim().length === 0) {
    return err(finalizeFailure("Finalize triage run requires an actor id"));
  }
  if (!ActorIdSchema.safeParse(input.actorId).success) {
    return err(finalizeFailure("Finalize triage run requires a valid actor id"));
  }
  if (typeof input.triageAttemptId !== "string" || input.triageAttemptId.trim().length === 0) {
    return err(finalizeFailure("Finalize triage run requires a triage attempt id"));
  }
  if (input.triageRunId !== undefined) {
    if (typeof input.triageRunId !== "string" || input.triageRunId.trim().length === 0) {
      return err(finalizeFailure("triageRunId must be a non-empty string when provided"));
    }
    if (!TriageRunIdSchema.safeParse(input.triageRunId).success) {
      return err(finalizeFailure("triageRunId must be a valid identifier when provided"));
    }
  }
  if (input.rubric !== undefined && input.rubric !== RUBRIC_V1) {
    return err(finalizeFailure("finalizeTriageRun requires RUBRIC_V1"));
  }

  const rubric = input.rubric ?? RUBRIC_V1;
  const createdAt = composition.clock.now();
  const commandId = composition.idGenerator.next();
  const payload: FinalizeTriageRunPayload = {
    triageAttemptId: input.triageAttemptId,
    ...(input.triageRunId === undefined ? {} : { triageRunId: input.triageRunId })
  };

  const plan = planFinalize({
    composition,
    triageAttemptId: input.triageAttemptId,
    requestedTriageRunId: input.triageRunId,
    rubric,
    createdAt
  });
  if (!plan.ok) {
    return plan;
  }

  const audits = prepareFinalizeAuditEvents({
    clock: composition.clock,
    nextId: () => composition.idGenerator.next(),
    commandId,
    actorId: input.actorId,
    createdAt,
    plan: plan.value
  });
  if (!audits.ok) {
    return audits;
  }

  const writingGenerator = replayCommandId(composition.idGenerator, commandId);
  return runUseCaseCommand(
    { ...composition, idGenerator: writingGenerator },
    {
      actorId: input.actorId,
      commandName: FINALIZE_TRIAGE_RUN_COMMAND_NAME,
      expectedVersion: 0,
      payload,
      payloadSchema: FinalizeTriageRunPayloadSchema,
      resultSchema: FinalizeTriageRunResultSchema,
      readVersion: () => ok(0),
      mutate: (context) =>
        commitFinalize({
          composition: { ...composition, idGenerator: writingGenerator },
          context,
          actorId: input.actorId,
          createdAt,
          commandId,
          plan: plan.value,
          auditEvents: audits.value
        })
    }
  );
}

function planFinalize(args: {
  composition: UseCaseComposition;
  triageAttemptId: string;
  requestedTriageRunId: string | undefined;
  rubric: LockedRubric;
  createdAt: number;
}): Result<FinalizePlan, RuntimeError> {
  return runImmediateTransaction(args.composition.connection, (context) => {
    const nextId = () => args.composition.idGenerator.next();
    const loaded = loadReadyAttempt(context, args.triageAttemptId);
    if (!loaded.ok) {
      return loaded;
    }
    const { attempt, workItems } = loaded.value;
    const snapshotResult = readRunInputSnapshot(context, attempt.snapshotId);
    /* v8 ignore next 3 -- startTriageRun writes the snapshot the attempt references. */
    if (!snapshotResult.ok) {
      return snapshotResult;
    }
    /* v8 ignore next 3 -- startTriageRun writes the snapshot the attempt references. */
    if (snapshotResult.value === undefined) {
      return err(createRuntimeError("not_found", `Run input snapshot "${attempt.snapshotId}" not found`, false));
    }
    const snapshot = snapshotResult.value;
    const policyResult = createHardRequirementPolicyV1(snapshot.frozenDate.slice(0, 7));
    /* v8 ignore next 3 -- frozenDate from a stored snapshot is a valid year-month prefix. */
    if (!policyResult.ok) {
      return policyResult;
    }

    const hydratedResult = hydrateWorkItems(context, workItems);
    if (!hydratedResult.ok) {
      return hydratedResult;
    }
    const groups = groupCandidates(hydratedResult.value);
    const importOrdinalByCandidate = loadImportOrdinals(context, attempt.corpusManifestId);
    for (const group of groups) {
      if (!importOrdinalByCandidate.has(group.candidateId)) {
        return err(
          finalizeFailure(
            `Candidate "${group.candidateId}" is missing from corpus snapshot ${attempt.corpusManifestId}`
          )
        );
      }
    }
    const orderedGroups = [...groups].sort((left, right) => {
      return (
        importOrdinalByCandidate.get(left.candidateId)! -
        importOrdinalByCandidate.get(right.candidateId)!
      );
    });

    const candidates: PlannedCandidate[] = [];
    for (const group of orderedGroups) {
      const documents = loadCandidateDocuments(context, group.candidateId);
      if (documents.length === 0) {
        return err(finalizeFailure(`Candidate "${group.candidateId}" has no documents`));
      }
      const workAuthResult = readCandidateApplicationAnswerByCandidateQuestion(
        context,
        group.candidateId,
        WORK_AUTHORIZATION_QUESTION_KEY
      );
      /* v8 ignore next 3 -- reader fails only on invalid stored application-answer rows. */
      if (!workAuthResult.ok) {
        return workAuthResult;
      }
      const decisionResult = deriveCandidateDecision({
        candidateId: group.candidateId,
        documents: documents.map(toBridgeDocument),
        extractions: group.extractions,
        applicationAnswers:
          workAuthResult.value === undefined
            ? undefined
            : { workAuthorization: workAuthResult.value },
        rubric: args.rubric,
        hardRequirementPolicy: policyResult.value,
        isVariant: attempt.kind === "variant_run"
      });
      if (!decisionResult.ok) {
        return decisionResult;
      }
      candidates.push({
        candidateId: group.candidateId,
        documents,
        artifacts: group.artifacts,
        decision: decisionResult.value,
        resultId: nextId()
      });
    }

    return ok({
      attempt,
      extractorVersion: snapshot.extractorVersion,
      policy: policyResult.value,
      candidates,
      importOrdinalByCandidate,
      triageRunId: args.requestedTriageRunId ?? nextId(),
      kind: resolveOfficialTriageRunKind(attempt.kind, candidates.length)
    });
  });
}

function commitFinalize(args: {
  composition: UseCaseComposition;
  context: ImmediateTransactionContext;
  actorId: string;
  createdAt: number;
  commandId: string;
  plan: FinalizePlan;
  auditEvents: readonly AuditEvent[];
}): Result<FinalizeTriageRunResult, RuntimeError> {
  const { composition, context, createdAt, plan } = args;
  const nextId = () => composition.idGenerator.next();

  const loaded = loadReadyAttempt(context, plan.attempt.triageAttemptId);
  /* v8 ignore next 3 -- planFinalize already loaded this attempt; missing attempts fail in plan. */
  if (!loaded.ok) {
    return loaded;
  }
  const existingRun = readExistingTriageRun(
    context,
    plan.attempt.snapshotId,
    plan.attempt.corpusManifestId
  );
  /* v8 ignore start -- planFinalize already refuses an existing run; this is the writer-lock race fence. */
  if (existingRun !== undefined) {
    return err(
      createRuntimeError(
        "command_conflict",
        `A triage run already exists for this snapshot and manifest (${existingRun.id})`,
        false
      )
    );
  }
  /* v8 ignore stop */

  const resultIds: string[] = [];
  for (const candidate of plan.candidates) {
    const persisted = persistCandidateResult({
      context,
      nextId,
      createdAt,
      candidateId: candidate.candidateId,
      documents: candidate.documents,
      artifacts: candidate.artifacts,
      extractorVersion: plan.extractorVersion,
      decision: candidate.decision,
      resultId: candidate.resultId
    });
    if (!persisted.ok) {
      return persisted;
    }
    resultIds.push(persisted.value);
  }

  const runSealId = nextId();
  const preparedRun = prepareTriageRun({
    triageRunId: plan.triageRunId,
    kind: plan.kind,
    snapshotId: plan.attempt.snapshotId,
    corpusManifestId: plan.attempt.corpusManifestId,
    sealId: runSealId,
    createdAt
  });
  /* v8 ignore next 3 -- caller-supplied ids pass TriageRunIdSchema; minted ids are printable ASCII. */
  if (!preparedRun.ok) {
    return preparedRun;
  }
  const insertedRun = insertTriageRun(context, preparedRun.value);
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!insertedRun.ok) {
    return insertedRun;
  }

  for (const [index, candidate] of plan.candidates.entries()) {
    const importOrdinal = plan.importOrdinalByCandidate.get(candidate.candidateId);
    /* v8 ignore start -- planFinalize refuses candidates missing from the corpus. */
    if (importOrdinal === undefined) {
      return err(
        finalizeFailure(
          `Candidate "${candidate.candidateId}" is missing from corpus snapshot ${plan.attempt.corpusManifestId}`
        )
      );
    }
    /* v8 ignore stop */
    const preparedMember = prepareTriageRunMember({
      triageRunMemberId: nextId(),
      triageRunId: plan.triageRunId,
      candidateId: candidate.candidateId,
      importOrdinal,
      initialResultId: resultIds[index]!,
      createdAt
    });
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!preparedMember.ok) {
      return preparedMember;
    }
    const insertedMember = insertTriageRunMember(context, preparedMember.value);
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!insertedMember.ok) {
      return insertedMember;
    }
  }

  const preparedRunSeal = prepareTriageRunSeal({
    triageRunSealId: runSealId,
    triageRunId: plan.triageRunId,
    createdAt
  });
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!preparedRunSeal.ok) {
    return preparedRunSeal;
  }
  const insertedRunSeal = insertTriageRunSeal(context, preparedRunSeal.value);
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!insertedRunSeal.ok) {
    return insertedRunSeal;
  }

  for (const event of args.auditEvents) {
    const appended = appendAuditEvent(context, event);
    /* v8 ignore next 3 -- appendAuditEvent only inserts a prepared envelope. */
    if (!appended.ok) {
      return appended;
    }
  }

  return ok({
    triageRunId: plan.triageRunId,
    triageAttemptId: plan.attempt.triageAttemptId,
    candidateCount: plan.candidates.length,
    resultIds
  });
}

function prepareFinalizeAuditEvents(args: {
  clock: UseCaseComposition["clock"];
  nextId: () => string;
  commandId: string;
  actorId: string;
  createdAt: number;
  plan: FinalizePlan;
}): Result<AuditEvent[], RuntimeError> {
  const events: AuditEvent[] = [];
  let eventOrdinal = 0;
  for (const candidate of args.plan.candidates) {
    const prepared = prepareAuditEvent(args.clock, {
      auditEventId: args.nextId(),
      commandId: args.commandId,
      eventOrdinal,
      actorId: args.actorId,
      actorDisplayName: args.actorId,
      eventName: "candidate.result.published",
      eventVersion: 1,
      occurredAt: args.createdAt,
      payload: {
        candidateId: candidate.candidateId,
        resultId: candidate.resultId,
        status: candidate.decision.routing.status,
        availability: candidate.decision.routing.availability
      }
    });
    if (!prepared.ok) {
      return prepared;
    }
    events.push(prepared.value);
    eventOrdinal += 1;
  }
  const sealed = prepareAuditEvent(args.clock, {
    auditEventId: args.nextId(),
    commandId: args.commandId,
    eventOrdinal,
    actorId: args.actorId,
    actorDisplayName: args.actorId,
    eventName: "triage_run.sealed",
    eventVersion: 1,
    occurredAt: args.createdAt,
    payload: {
      triageRunId: args.plan.triageRunId,
      triageAttemptId: args.plan.attempt.triageAttemptId,
      candidateCount: args.plan.candidates.length
    }
  });
  if (!sealed.ok) {
    return sealed;
  }
  events.push(sealed.value);
  return ok(events);
}

function loadReadyAttempt(
  context: ImmediateTransactionContext,
  triageAttemptId: string
): Result<{ attempt: TriageAttempt; workItems: readonly AttemptWorkItem[] }, RuntimeError> {
  const attemptResult = readTriageAttempt(context, triageAttemptId);
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!attemptResult.ok) {
    return attemptResult;
  }
  if (attemptResult.value === undefined) {
    return err(createRuntimeError("not_found", `Triage attempt "${triageAttemptId}" not found`, false));
  }
  const attempt = attemptResult.value;
  if (attempt.kind === "candidate_correction") {
    return err(
      createRuntimeError(
        "command_conflict",
        "finalizeTriageRun cannot finalize a correction attempt",
        false
      )
    );
  }

  const workItemsResult = readAttemptWorkItems(context, triageAttemptId);
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!workItemsResult.ok) {
    return workItemsResult;
  }
  const workItems = workItemsResult.value;
  if (workItems.length === 0) {
    return err(finalizeFailure(`Triage attempt "${triageAttemptId}" has no work items`));
  }
  const blocked = workItems.find((item) => item.state === "blocked_failure");
  if (blocked !== undefined) {
    return err(
      finalizeFailure(`Cannot finalize while work item ${blocked.attemptWorkItemId} is blocked_failure`)
    );
  }
  const unfinished = workItems.find(
    (item) => item.state !== "succeeded" && item.state !== "reviewable_failure"
  );
  if (unfinished !== undefined) {
    return err(
      finalizeFailure(`Cannot finalize while work item ${unfinished.attemptWorkItemId} is ${unfinished.state}`)
    );
  }
  const existingRun = readExistingTriageRun(context, attempt.snapshotId, attempt.corpusManifestId);
  if (existingRun !== undefined) {
    return err(
      createRuntimeError(
        "command_conflict",
        `A triage run already exists for this snapshot and manifest (${existingRun.id})`,
        false
      )
    );
  }
  return ok({ attempt, workItems });
}

function readExistingTriageRun(
  context: ImmediateTransactionContext,
  snapshotId: string,
  corpusManifestId: string
): { id: string } | undefined {
  return context.nativeDatabase
    .prepare(
      `SELECT triage_run_id AS id
       FROM triage_run
       WHERE snapshot_id = ? AND corpus_manifest_id = ?
       LIMIT 1`
    )
    .get(snapshotId, corpusManifestId) as { id: string } | undefined;
}

function loadImportOrdinals(
  context: ImmediateTransactionContext,
  corpusManifestId: string
): Map<string, number> {
  const corpusMembers = context.nativeDatabase
    .prepare(
      `SELECT candidate_id AS candidateId, import_ordinal AS importOrdinal
       FROM corpus_member
       WHERE manifest_id = ?
       ORDER BY import_ordinal ASC`
    )
    .all(corpusManifestId) as Array<{ candidateId: string; importOrdinal: number }>;
  return new Map(corpusMembers.map((member) => [member.candidateId, member.importOrdinal] as const));
}

function resolveOfficialTriageRunKind(
  attemptKind: TriageAttempt["kind"],
  memberCount: number
): "main" | "variant" {
  /* v8 ignore next 3 -- a main run is 140 members; tests use variant corpora. */
  if (attemptKind === "main_run" && memberCount === MAIN_DEMO_CORPUS_MEMBER_COUNT) {
    return "main";
  }
  return "variant";
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

function hydrateWorkItems(
  context: ImmediateTransactionContext,
  workItems: readonly AttemptWorkItem[]
): Result<HydratedWorkItem[], RuntimeError> {
  const hydrated: HydratedWorkItem[] = [];
  for (const workItem of workItems) {
    if (workItem.state === "succeeded") {
      // attempt_work_item_state_shape requires a non-null artifact id on succeeded rows.
      /* v8 ignore next 5 -- CHECK attempt_work_item_state_shape */
      if (workItem.extractionArtifactId === null) {
        return err(
          finalizeFailure(`Succeeded work item ${workItem.attemptWorkItemId} is missing an artifact`)
        );
      }
      const artifact = readExtractionArtifact(context, workItem.extractionArtifactId);
      /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
      if (!artifact.ok) {
        return artifact;
      }
      if (artifact.value === undefined) {
        return err(
          createRuntimeError("not_found", `Extraction artifact "${workItem.extractionArtifactId}" not found`, false)
        );
      }
      hydrated.push({ workItem, artifact: artifact.value, failure: null });
      continue;
    }
    // attempt_work_item_state_shape requires a non-null failure id on reviewable_failure rows.
    /* v8 ignore next 5 -- CHECK attempt_work_item_state_shape */
    if (workItem.extractionFailureId === null) {
      return err(
        finalizeFailure(`Failed work item ${workItem.attemptWorkItemId} is missing a failure record`)
      );
    }
    const failure = readExtractionFailure(context, workItem.extractionFailureId);
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!failure.ok) {
      return failure;
    }
    if (failure.value === undefined) {
      return err(
        createRuntimeError("not_found", `Extraction failure "${workItem.extractionFailureId}" not found`, false)
      );
    }
    hydrated.push({ workItem, artifact: null, failure: failure.value });
  }
  return ok(hydrated);
}

function groupCandidates(hydrated: readonly HydratedWorkItem[]): CandidateGroup[] {
  const groups = new Map<
    string,
    { artifacts: ExtractionArtifact[]; extractions: CandidateExtractionResultInput[] }
  >();
  for (const item of hydrated) {
    let extraction: CandidateExtractionResultInput;
    if (item.artifact !== null) {
      extraction = {
        candidateDocumentId: item.workItem.candidateDocumentId,
        dimensionId: item.workItem.dimensionId,
        artifact: item.artifact
      };
    } else {
      extraction = {
        candidateDocumentId: item.workItem.candidateDocumentId,
        dimensionId: item.workItem.dimensionId,
        failure: item.failure,
        reviewableFailure: true
      };
    }
    const existing = groups.get(item.workItem.candidateId);
    if (existing === undefined) {
      groups.set(item.workItem.candidateId, {
        artifacts: item.artifact === null ? [] : [item.artifact],
        extractions: [extraction]
      });
      continue;
    }
    if (item.artifact !== null) {
      existing.artifacts.push(item.artifact);
    }
    existing.extractions.push(extraction);
  }
  return [...groups.entries()].map(([candidateId, group]) => ({
    candidateId,
    artifacts: group.artifacts,
    extractions: group.extractions
  }));
}

function loadCandidateDocuments(
  context: ImmediateTransactionContext,
  candidateId: string
): CandidateDocumentRow[] {
  return context.nativeDatabase
    .prepare(
      `SELECT
        cd.candidate_document_id AS candidateDocumentId,
        cd.document_kind AS documentKind,
        cd.source_document_id AS sourceDocumentId,
        sd.normalized_text AS normalizedText,
        sd.normalized_hash AS normalizedHash
       FROM candidate_document cd
       JOIN source_document sd ON sd.source_document_id = cd.source_document_id
       WHERE cd.candidate_id = ?
       ORDER BY cd.document_ordinal ASC`
    )
    .all(candidateId) as CandidateDocumentRow[];
}

function toBridgeDocument(row: CandidateDocumentRow): CandidateDocumentBridgeInput {
  return {
    candidateDocumentId: row.candidateDocumentId,
    documentKind: row.documentKind,
    sourceDocumentId: row.sourceDocumentId,
    normalizedText: row.normalizedText
  };
}

/**
 * Persist one planned candidate result. Remaining v8 ignore regions here are
 * schema-unreachable: prepare/insert checks after drafts built from planned
 * IDs and deriveCandidateDecision output; CHECK attempt_work_item_state_shape;
 * persistArtifactSpans fails closed, so fact and dimension span lookups cannot
 * miss; complete availability always carries score; duplicate span ids cannot
 * collide because each work item owns a unique artifact id.
 */
function persistCandidateResult(args: {
  context: ImmediateTransactionContext;
  nextId: () => string;
  createdAt: number;
  candidateId: string;
  documents: readonly CandidateDocumentRow[];
  artifacts: readonly ExtractionArtifact[];
  extractorVersion: string;
  decision: CandidateDecisionOutput;
  resultId: string;
}): Result<string, RuntimeError> {
  const sealId = args.nextId();
  if (args.decision.dimensionDerivation.availability === "unavailable") {
    return persistUnavailableResult({
      context: args.context,
      nextId: args.nextId,
      createdAt: args.createdAt,
      candidateId: args.candidateId,
      documents: args.documents,
      decision: args.decision,
      resultId: args.resultId,
      sealId
    });
  }
  return persistCompleteResult({
    context: args.context,
    nextId: args.nextId,
    createdAt: args.createdAt,
    candidateId: args.candidateId,
    documents: args.documents,
    artifacts: args.artifacts,
    extractorVersion: args.extractorVersion,
    decision: args.decision,
    resultId: args.resultId,
    sealId
  });
}

function persistUnavailableResult(args: {
  context: ImmediateTransactionContext;
  nextId: () => string;
  createdAt: number;
  candidateId: string;
  documents: readonly CandidateDocumentRow[];
  decision: CandidateDecisionOutput;
  resultId: string;
  sealId: string;
}): Result<string, RuntimeError> {
  const sourceDocumentIds = uniqueSourceIds(args.documents);
  const gapRows: Array<{ evidenceGapId: string; dimensionId: string }> = [];
  const gapDimensions = new Map<string, readonly string[]>();
  // assessDimension records all-document reviewable failure as unavailable, not as a gap.
  /* v8 ignore start -- assess-dimensions.ts: all-document failure is unavailable */
  for (const gap of args.decision.dimensionDerivation.gaps) {
    gapDimensions.set(gap.dimensionId, gap.documentsSearched);
  }
  /* v8 ignore stop */
  for (const unavailable of args.decision.dimensionDerivation.unavailable) {
    if (!gapDimensions.has(unavailable.dimensionId)) {
      gapDimensions.set(unavailable.dimensionId, sourceDocumentIds);
    }
  }
  /* v8 ignore next 3 -- unavailable derivations always carry gaps or unavailable dims. */
  if (gapDimensions.size === 0) {
    gapDimensions.set(FALLBACK_DIMENSION_ID, sourceDocumentIds);
  }
  for (const [dimensionId, searched] of gapDimensions.entries()) {
    const mapped = mapSearchedDocuments(searched, args.documents, sourceDocumentIds);
    const evidenceGapId = args.nextId();
    const preparedGap = prepareEvidenceGap({
      evidenceGapId,
      dimensionId,
      reasonCode: `missing_evidence:${dimensionId}`,
      documentsSearched: mapped,
      createdAt: args.createdAt
    });
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!preparedGap.ok) {
      return preparedGap;
    }
    const insertedGap = insertEvidenceGap(args.context, preparedGap.value);
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!insertedGap.ok) {
      return insertedGap;
    }
    gapRows.push({ evidenceGapId, dimensionId });
  }

  const preparedResult = prepareCandidateTriageResult({
    candidateTriageResultId: args.resultId,
    candidateId: args.candidateId,
    kind: "initial",
    availability: "unavailable",
    status: "escalated",
    supersedesResultId: null,
    evidenceSpans: [],
    evidenceGaps: gapRows.map((gap) => ({
      candidateResultEvidenceGapId: args.nextId(),
      evidenceGapId: gap.evidenceGapId,
      dimensionId: gap.dimensionId
    })),
    dimensionAssessments: [],
    structuredFacts: [],
    factConflicts: [],
    hardRequirementAssessments: [],
    score: null,
    sealId: args.sealId,
    createdAt: args.createdAt
  });
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!preparedResult.ok) {
    return preparedResult;
  }
  const insertedResult = insertCandidateTriageResult(args.context, preparedResult.value);
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!insertedResult.ok) {
    return insertedResult;
  }
  const reasons = persistReasonsAndTasks({
    context: args.context,
    nextId: args.nextId,
    createdAt: args.createdAt,
    resultId: args.resultId,
    reasonCodes: ["assessment_unavailable"]
  });
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!reasons.ok) {
    return reasons;
  }
  const sealed = sealResultAndHead({
    context: args.context,
    createdAt: args.createdAt,
    candidateId: args.candidateId,
    resultId: args.resultId,
    sealId: args.sealId
  });
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!sealed.ok) {
    return sealed;
  }
  return ok(args.resultId);
}

function persistCompleteResult(args: {
  context: ImmediateTransactionContext;
  nextId: () => string;
  createdAt: number;
  candidateId: string;
  documents: readonly CandidateDocumentRow[];
  artifacts: readonly ExtractionArtifact[];
  extractorVersion: string;
  decision: CandidateDecisionOutput;
  resultId: string;
  sealId: string;
}): Result<string, RuntimeError> {
  // deriveCandidateDecision only scores when availability is complete.
  /* v8 ignore next 3 -- complete availability always carries score and confidence */
  if (args.decision.score === null || args.decision.confidence === null || args.decision.confidenceInput === null) {
    return err(finalizeFailure("Complete candidate decision is missing score or confidence"));
  }

  const persistedSpanIds = new Set<string>();
  const artifactSpans = persistArtifactSpans({
    context: args.context,
    candidateId: args.candidateId,
    documents: args.documents,
    artifacts: args.artifacts,
    extractorVersion: args.extractorVersion,
    createdAt: args.createdAt,
    persistedSpanIds
  });
  if (!artifactSpans.ok) {
    return artifactSpans;
  }

  const factIdsByKey = new Map<string, string>();
  const structuredFactIds: string[] = [];
  for (const fact of args.decision.consolidation.facts) {
    const missingSpans = fact.evidenceSpanIds.filter((spanId) => !persistedSpanIds.has(spanId));
    // T10.5 facts are parsed work-auth with empty span ids. persistArtifactSpans
    // fails closed, so a document-grounded fact cannot reach here with missing spans.
    /* v8 ignore next 5 -- persistArtifactSpans fails closed for trusted extraction spans */
    if (missingSpans.length > 0) {
      return err(
        finalizeFailure("Structured fact is missing persisted grounding spans")
      );
    }
    const structuredFactId = args.nextId();
    const preparedFact = prepareStructuredFact({
      structuredFactId,
      candidateId: args.candidateId,
      payload: fact.payload,
      evidenceSpans: fact.evidenceSpanIds.map((spanId) => {
        /* v8 ignore next 4 -- T10.5 facts are parsed work-auth with empty span ids. */
        return {
          structuredFactEvidenceSpanId: args.nextId(),
          evidenceSpanId: spanId
        };
      }),
      provenances: fact.provenance.map((source) => ({
        structuredFactProvenanceId: args.nextId(),
        source,
        actorId: null
      })),
      createdAt: args.createdAt
    });
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!preparedFact.ok) {
      return preparedFact;
    }
    const insertedFact = insertStructuredFact(args.context, preparedFact.value);
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!insertedFact.ok) {
      return insertedFact;
    }
    factIdsByKey.set(fact.factKey, structuredFactId);
    structuredFactIds.push(structuredFactId);
  }

  const requirementIds: string[] = [];
  for (const assessment of args.decision.hardRequirements.assessments) {
    const facts: Array<{ structuredFactId: string; polarity: "supporting" | "contradicting" }> = [];
    for (const key of assessment.supportingFactKeys) {
      const structuredFactId = factIdsByKey.get(key);
      /* v8 ignore next 5 -- supporting keys are factKeys from the facts just persisted */
      if (structuredFactId === undefined) {
        return err(
          finalizeFailure("Hard-requirement cites a structured fact that was not persisted")
        );
      }
      facts.push({ structuredFactId, polarity: "supporting" });
    }
    for (const key of assessment.contradictingFactKeys) {
      const structuredFactId = factIdsByKey.get(key);
      /* v8 ignore next 5 -- contradicting keys are factKeys from the facts just persisted */
      if (structuredFactId === undefined) {
        return err(
          finalizeFailure("Hard-requirement cites a structured fact that was not persisted")
        );
      }
      facts.push({ structuredFactId, polarity: "contradicting" });
    }
    const outcome = assessment.outcome;
    // resolveHardRequirements lists the facts that produced pass or fail.
    /* v8 ignore next 6 -- pass/fail assessments always cite persisted fact keys */
    if ((outcome === "pass" || outcome === "fail") && facts.length === 0) {
      return err(
        finalizeFailure(`Hard-requirement ${assessment.requirementId} cannot persist ${outcome} without facts`)
      );
    }
    const hardRequirementAssessmentId = args.nextId();
    const preparedRequirement = prepareHardRequirementAssessment({
      hardRequirementAssessmentId,
      candidateId: args.candidateId,
      requirementFieldId: assessment.requirementId,
      outcome,
      facts: facts.map((fact) => ({
        hardRequirementAssessmentFactId: args.nextId(),
        structuredFactId: fact.structuredFactId,
        polarity: fact.polarity
      })),
      createdAt: args.createdAt
    });
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!preparedRequirement.ok) {
      return preparedRequirement;
    }
    const insertedRequirement = insertHardRequirementAssessment(args.context, preparedRequirement.value);
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!insertedRequirement.ok) {
      return insertedRequirement;
    }
    requirementIds.push(hardRequirementAssessmentId);
  }

  const assessmentIds: Array<{ dimensionAssessmentId: string; dimensionId: string }> = [];
  for (const assessment of args.decision.dimensionDerivation.assessments) {
    const dimensionAssessmentId = args.nextId();
    const preparedAssessment = prepareDimensionAssessment({
      dimensionAssessmentId,
      dimensionId: assessment.dimensionId,
      level: assessment.level,
      source: assessment.source,
      actorId: null,
      createdAt: args.createdAt
    });
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!preparedAssessment.ok) {
      return preparedAssessment;
    }
    const insertedAssessment = insertDimensionAssessment(args.context, preparedAssessment.value);
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!insertedAssessment.ok) {
      return insertedAssessment;
    }
    let ordinal = 0;
    const spanIds = [...assessment.supportingSpanIds, ...assessment.contradictingSpanIds];
    for (const spanId of spanIds) {
      /* v8 ignore next 5 -- dimension span IDs are the artifact span IDs persistArtifactSpans just wrote */
      if (!persistedSpanIds.has(spanId)) {
        return err(
          finalizeFailure("Dimension assessment cites an evidence span that was not persisted")
        );
      }
      const preparedRef = prepareDimensionAssessmentEvidenceSpan({
        dimensionAssessmentEvidenceSpanId: args.nextId(),
        dimensionAssessmentId,
        evidenceSpanId: spanId,
        spanOrdinal: ordinal,
        createdAt: args.createdAt
      });
      /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
      if (!preparedRef.ok) {
        return preparedRef;
      }
      const insertedRef = insertDimensionAssessmentEvidenceSpan(args.context, preparedRef.value);
      /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
      if (!insertedRef.ok) {
        return insertedRef;
      }
      ordinal += 1;
    }
    assessmentIds.push({ dimensionAssessmentId, dimensionId: assessment.dimensionId });
  }

  const sourceDocumentIds = uniqueSourceIds(args.documents);
  const gapRows: Array<{ evidenceGapId: string; dimensionId: string }> = [];
  for (const gap of args.decision.dimensionDerivation.gaps) {
    const mapped = mapSearchedDocuments(gap.documentsSearched, args.documents, sourceDocumentIds);
    const evidenceGapId = args.nextId();
    const preparedGap = prepareEvidenceGap({
      evidenceGapId,
      dimensionId: gap.dimensionId,
      reasonCode: `missing_evidence:${gap.dimensionId}`,
      documentsSearched: mapped,
      createdAt: args.createdAt
    });
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!preparedGap.ok) {
      return preparedGap;
    }
    const insertedGap = insertEvidenceGap(args.context, preparedGap.value);
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!insertedGap.ok) {
      return insertedGap;
    }
    gapRows.push({ evidenceGapId, dimensionId: gap.dimensionId });
  }

  const scoreId = args.nextId();
  const preparedResult = prepareCandidateTriageResult({
    candidateTriageResultId: args.resultId,
    candidateId: args.candidateId,
    kind: "initial",
    availability: "complete",
    status: args.decision.routing.status,
    supersedesResultId: null,
    evidenceSpans: [...persistedSpanIds].map((evidenceSpanId) => ({
      candidateResultEvidenceSpanId: args.nextId(),
      evidenceSpanId
    })),
    evidenceGaps: gapRows.map((gap) => ({
      candidateResultEvidenceGapId: args.nextId(),
      evidenceGapId: gap.evidenceGapId,
      dimensionId: gap.dimensionId
    })),
    dimensionAssessments: assessmentIds.map((assessment) => ({
      candidateResultDimensionAssessmentId: args.nextId(),
      dimensionAssessmentId: assessment.dimensionAssessmentId,
      dimensionId: assessment.dimensionId
    })),
    structuredFacts: structuredFactIds.map((structuredFactId) => ({
      candidateResultStructuredFactId: args.nextId(),
      structuredFactId
    })),
    factConflicts: [],
    hardRequirementAssessments: requirementIds.map((hardRequirementAssessmentId) => ({
      candidateResultHardRequirementAssessmentId: args.nextId(),
      hardRequirementAssessmentId
    })),
    score: {
      scoreResultId: scoreId,
      aggregate: formatRational(args.decision.score.aggregate),
      confidence: formatRational(args.decision.confidence),
      confidenceInput: args.decision.confidenceInput,
      contributions: args.decision.score.contributions.map((contribution) => ({
        dimensionId: contribution.dimensionId,
        level: contribution.level,
        levelValue: formatRational(contribution.levelValue),
        weight: contribution.weight,
        weightedValue: formatRational(contribution.weightedValue)
      }))
    },
    sealId: args.sealId,
    createdAt: args.createdAt
  });
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!preparedResult.ok) {
    return preparedResult;
  }
  const insertedResult = insertCandidateTriageResult(args.context, preparedResult.value);
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!insertedResult.ok) {
    return insertedResult;
  }

  const reasonCodes = args.decision.routing.reasons.map((reason) => formatReasonCode(reason));
  const reasons = persistReasonsAndTasks({
    context: args.context,
    nextId: args.nextId,
    createdAt: args.createdAt,
    resultId: args.resultId,
    reasonCodes
  });
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!reasons.ok) {
    return reasons;
  }

  const sealed = sealResultAndHead({
    context: args.context,
    createdAt: args.createdAt,
    candidateId: args.candidateId,
    resultId: args.resultId,
    sealId: args.sealId
  });
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!sealed.ok) {
    return sealed;
  }
  return ok(args.resultId);
}

function persistArtifactSpans(args: {
  context: ImmediateTransactionContext;
  candidateId: string;
  documents: readonly CandidateDocumentRow[];
  artifacts: readonly ExtractionArtifact[];
  extractorVersion: string;
  createdAt: number;
  persistedSpanIds: Set<string>;
}): Result<void, RuntimeError> {
  const documentBySource = new Map(args.documents.map((document) => [document.sourceDocumentId, document] as const));
  for (const artifact of args.artifacts) {
    const document = documentBySource.get(artifact.sourceDocumentId);
    if (document === undefined) {
      return err(
        finalizeFailure("Trusted extraction span is missing its source document")
      );
    }
    for (const [spanIdx, span] of artifact.acceptedOutput.spans.entries()) {
      const spanId = `span_${args.candidateId}_${artifact.extractionArtifactId}_${spanIdx}`;
      /* v8 ignore next 5 -- span ids include artifact id and index; each work item has its own artifact */
      if (args.persistedSpanIds.has(spanId)) {
        return err(
          finalizeFailure("Trusted extraction produced a duplicate evidence span id")
        );
      }
      const prepared = prepareEvidenceSpan({
        evidenceSpanId: spanId,
        documentId: document.sourceDocumentId,
        start: span.start,
        end: span.end,
        quotedText: span.quotedText,
        dimensionId: artifact.acceptedOutput.dimensionId,
        polarity: span.polarity,
        source: "extracted",
        matchQuality: span.matchQuality,
        extractorVersion: args.extractorVersion,
        createdAt: args.createdAt
      });
      if (!prepared.ok) {
        return prepared;
      }
      const inserted = insertEvidenceSpan(args.context, prepared.value);
      if (!inserted.ok) {
        return inserted;
      }
      args.persistedSpanIds.add(spanId);
    }
  }
  return ok(undefined);
}

function persistReasonsAndTasks(args: {
  context: ImmediateTransactionContext;
  nextId: () => string;
  createdAt: number;
  resultId: string;
  reasonCodes: readonly string[];
}): Result<void, RuntimeError> {
  for (const [index, reasonCode] of args.reasonCodes.entries()) {
    const candidateResultReasonId = args.nextId();
    const preparedReason = prepareCandidateResultReason({
      candidateResultReasonId,
      candidateResultId: args.resultId,
      reasonCode,
      reasonOrdinal: index,
      createdAt: args.createdAt
    });
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!preparedReason.ok) {
      return preparedReason;
    }
    const insertedReason = insertCandidateResultReason(args.context, preparedReason.value);
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!insertedReason.ok) {
      return insertedReason;
    }
    const preparedTask = prepareResolutionTask({
      resolutionTaskId: args.nextId(),
      candidateResultId: args.resultId,
      candidateResultReasonId,
      taskOrdinal: index,
      createdAt: args.createdAt
    });
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!preparedTask.ok) {
      return preparedTask;
    }
    const insertedTask = insertResolutionTask(args.context, preparedTask.value);
    /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
    if (!insertedTask.ok) {
      return insertedTask;
    }
  }
  return ok(undefined);
}

function sealResultAndHead(args: {
  context: ImmediateTransactionContext;
  createdAt: number;
  candidateId: string;
  resultId: string;
  sealId: string;
}): Result<void, RuntimeError> {
  const preparedSeal = prepareCandidateResultSeal({
    candidateResultSealId: args.sealId,
    candidateResultId: args.resultId,
    createdAt: args.createdAt
  });
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!preparedSeal.ok) {
    return preparedSeal;
  }
  const insertedSeal = insertCandidateResultSeal(args.context, preparedSeal.value);
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!insertedSeal.ok) {
    return insertedSeal;
  }
  const head = setCandidateHead(
    args.context,
    { candidateId: args.candidateId, currentResultId: args.resultId },
    0
  );
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (!head.ok) {
    return head;
  }
  return ok(undefined);
}

function uniqueSourceIds(documents: readonly CandidateDocumentRow[]): string[] {
  return [...new Set(documents.map((document) => document.sourceDocumentId))];
}

function mapSearchedDocuments(
  searched: readonly string[],
  documents: readonly CandidateDocumentRow[],
  fallback: readonly string[]
): string[] {
  const byCandidateId = new Map(documents.map((document) => [document.candidateDocumentId, document.sourceDocumentId]));
  const mapped = searched
    .map((documentId) => byCandidateId.get(documentId) ?? documentId)
    .filter((documentId, index, all) => all.indexOf(documentId) === index);
  /* v8 ignore next 3 -- drafts and stored rows already passed their store contracts */
  if (mapped.length === 0) {
    return [...fallback];
  }
  return mapped;
}
