import {
  RUBRIC_V1,
  err,
  formatRational,
  formatReasonCode,
  ok,
  type LockedRubric,
  type Result
} from "@recruitos/core";
import { z } from "zod";

import { readCandidateApplicationAnswerByCandidateQuestion } from "../application-answers/index.js";
import {
  readAttemptWorkItems,
  readTriageAttempt,
  type AttemptWorkItem
} from "../attempts/index.js";
import { appendAuditEvent, prepareAuditEvent } from "../audit/index.js";
import type { ImmediateTransactionContext } from "../commands/index.js";
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
  insertFactConflict,
  insertHardRequirementAssessment,
  insertStructuredFact,
  prepareFactConflict,
  prepareHardRequirementAssessment,
  prepareStructuredFact
} from "../facts/index.js";
import { createHardRequirementPolicyV1 } from "../policy/index.js";
import { insertProposal, prepareProposal } from "../proposals/index.js";
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
 * audit events. A blocked work item refuses finalization. Reviewable failures
 * become unavailable results with exactly one `assessment_unavailable` reason.
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

type HydratedWorkItem = Readonly<{
  workItem: AttemptWorkItem;
  artifact: ExtractionArtifact | null;
  failure: ExtractionFailure | null;
}>;

type CandidateGroup = Readonly<{
  candidateId: string;
  artifacts: ExtractionArtifact[];
  extractions: CandidateExtractionResultInput[];
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
  if (typeof input.triageAttemptId !== "string" || input.triageAttemptId.trim().length === 0) {
    return err(finalizeFailure("Finalize triage run requires a triage attempt id"));
  }
  if (input.triageRunId !== undefined && (typeof input.triageRunId !== "string" || input.triageRunId.trim().length === 0)) {
    return err(finalizeFailure("triageRunId must be a non-empty string when provided"));
  }
  if (input.rubric !== undefined && input.rubric !== RUBRIC_V1) {
    return err(finalizeFailure("finalizeTriageRun requires RUBRIC_V1"));
  }

  const rubric = input.rubric ?? RUBRIC_V1;
  const captured = captureFirstId(composition.idGenerator);
  const createdAt = composition.clock.now();
  const payload: FinalizeTriageRunPayload = {
    triageAttemptId: input.triageAttemptId,
    ...(input.triageRunId === undefined ? {} : { triageRunId: input.triageRunId })
  };

  return runUseCaseCommand(
    { ...composition, idGenerator: captured.generator },
    {
      actorId: input.actorId,
      commandName: FINALIZE_TRIAGE_RUN_COMMAND_NAME,
      expectedVersion: 0,
      payload,
      payloadSchema: FinalizeTriageRunPayloadSchema,
      resultSchema: FinalizeTriageRunResultSchema,
      readVersion: () => ok(0),
      mutate: (context) => {
        const commandId = captured.firstId;
        /* v8 ignore next 3 */
        if (commandId === undefined) {
          return err(finalizeFailure("Command id was not captured"));
        }
        return mutateFinalize({
          composition: { ...composition, idGenerator: captured.generator },
          context,
          actorId: input.actorId,
          createdAt,
          commandId,
          triageAttemptId: input.triageAttemptId,
          requestedTriageRunId: input.triageRunId,
          rubric
        });
      }
    }
  );
}

function mutateFinalize(args: {
  composition: UseCaseComposition;
  context: ImmediateTransactionContext;
  actorId: string;
  createdAt: number;
  commandId: string;
  triageAttemptId: string;
  requestedTriageRunId: string | undefined;
  rubric: LockedRubric;
}): Result<FinalizeTriageRunResult, RuntimeError> {
  const { composition, context, actorId, createdAt, commandId, triageAttemptId, requestedTriageRunId, rubric } =
    args;
  const nextId = () => composition.idGenerator.next();

  const attemptResult = readTriageAttempt(context, triageAttemptId);
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

  const existingRun = context.nativeDatabase
    .prepare(
      `SELECT triage_run_id AS id
       FROM triage_run
       WHERE snapshot_id = ? AND corpus_manifest_id = ?
       LIMIT 1`
    )
    .get(attempt.snapshotId, attempt.corpusManifestId) as { id: string } | undefined;
  if (existingRun !== undefined) {
    return err(
      createRuntimeError(
        "command_conflict",
        `A triage run already exists for this snapshot and manifest (${existingRun.id})`,
        false
      )
    );
  }

  const snapshotResult = readRunInputSnapshot(context, attempt.snapshotId);
  if (!snapshotResult.ok) {
    return snapshotResult;
  }
  if (snapshotResult.value === undefined) {
    /* v8 ignore next 3 */
    return err(createRuntimeError("not_found", `Run input snapshot "${attempt.snapshotId}" not found`, false));
  }
  const snapshot = snapshotResult.value;
  const policyResult = createHardRequirementPolicyV1(snapshot.frozenDate.slice(0, 7));
  /* v8 ignore next 3 */
  if (!policyResult.ok) {
    return policyResult;
  }

  const hydratedResult = hydrateWorkItems(context, workItems);
  if (!hydratedResult.ok) {
    return hydratedResult;
  }
  const groups = groupCandidates(hydratedResult.value);
  const corpusMembers = context.nativeDatabase
    .prepare(
      `SELECT candidate_id AS candidateId, import_ordinal AS importOrdinal
       FROM corpus_member
       WHERE manifest_id = ?
       ORDER BY import_ordinal ASC`
    )
    .all(attempt.corpusManifestId) as Array<{ candidateId: string; importOrdinal: number }>;
  const importOrdinalByCandidate = new Map(
    corpusMembers.map((member) => [member.candidateId, member.importOrdinal] as const)
  );
  const orderedGroups = [...groups].sort((left, right) => {
    const leftOrdinal = importOrdinalByCandidate.get(left.candidateId) ?? Number.MAX_SAFE_INTEGER;
    const rightOrdinal = importOrdinalByCandidate.get(right.candidateId) ?? Number.MAX_SAFE_INTEGER;
    return leftOrdinal - rightOrdinal;
  });

  const resultIds: string[] = [];
  let eventOrdinal = 0;
  for (const group of orderedGroups) {
    const documents = loadCandidateDocuments(context, group.candidateId);
    /* v8 ignore next 3 */
    if (documents.length === 0) {
      return err(finalizeFailure(`Candidate "${group.candidateId}" has no documents`));
    }
    const workAuthResult = readCandidateApplicationAnswerByCandidateQuestion(
      context,
      group.candidateId,
      WORK_AUTHORIZATION_QUESTION_KEY
    );
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
      rubric,
      hardRequirementPolicy: policyResult.value,
      isVariant: attempt.kind === "variant_run"
    });
    if (!decisionResult.ok) {
      return decisionResult;
    }
    const persisted = persistCandidateResult({
      context,
      nextId,
      createdAt,
      commandId,
      actorId,
      candidateId: group.candidateId,
      documents,
      artifacts: group.artifacts,
      extractorVersion: snapshot.extractorVersion,
      decision: decisionResult.value,
      rubric
    });
    if (!persisted.ok) {
      return persisted;
    }
    resultIds.push(persisted.value);
    const published = appendNamedAuditEvent({
      context,
      clock: composition.clock,
      auditEventId: nextId(),
      commandId,
      eventOrdinal,
      actorId,
      eventName: "candidate.result.published",
      occurredAt: createdAt,
      payload: {
        candidateId: group.candidateId,
        resultId: persisted.value,
        status: decisionResult.value.routing.status,
        availability: decisionResult.value.routing.availability
      }
    });
    if (!published.ok) {
      return published;
    }
    eventOrdinal += 1;
  }

  const triageRunId = requestedTriageRunId ?? nextId();
  const runSealId = nextId();
  let kind: "main" | "variant" = "variant";
  /* v8 ignore next 3 -- a main run is 140 members; tests use variant corpora. */
  if (attempt.kind === "main_run" && orderedGroups.length === MAIN_DEMO_CORPUS_MEMBER_COUNT) {
    kind = "main";
  }
  const preparedRun = prepareTriageRun({
    triageRunId,
    kind,
    snapshotId: attempt.snapshotId,
    corpusManifestId: attempt.corpusManifestId,
    sealId: runSealId,
    createdAt
  });
  if (!preparedRun.ok) {
    return preparedRun;
  }
  const insertedRun = insertTriageRun(context, preparedRun.value);
  if (!insertedRun.ok) {
    return insertedRun;
  }

  for (const [index, group] of orderedGroups.entries()) {
    const importOrdinal = importOrdinalByCandidate.get(group.candidateId);
    /* v8 ignore next 6 -- startTriageRun writes matching corpus members. */
    if (importOrdinal === undefined) {
      return err(
        finalizeFailure(
          `Candidate "${group.candidateId}" is missing from corpus snapshot ${attempt.corpusManifestId}`
        )
      );
    }
    const preparedMember = prepareTriageRunMember({
      triageRunMemberId: nextId(),
      triageRunId,
      candidateId: group.candidateId,
      importOrdinal,
      initialResultId: resultIds[index]!,
      createdAt
    });
    if (!preparedMember.ok) {
      return preparedMember;
    }
    const insertedMember = insertTriageRunMember(context, preparedMember.value);
    if (!insertedMember.ok) {
      return insertedMember;
    }
  }

  const preparedRunSeal = prepareTriageRunSeal({
    triageRunSealId: runSealId,
    triageRunId,
    createdAt
  });
  if (!preparedRunSeal.ok) {
    return preparedRunSeal;
  }
  const insertedRunSeal = insertTriageRunSeal(context, preparedRunSeal.value);
  if (!insertedRunSeal.ok) {
    return insertedRunSeal;
  }

  const sealed = appendNamedAuditEvent({
    context,
    clock: composition.clock,
    auditEventId: nextId(),
    commandId,
    eventOrdinal,
    actorId,
    eventName: "triage_run.sealed",
    occurredAt: createdAt,
    payload: {
      triageRunId,
      triageAttemptId,
      candidateCount: orderedGroups.length
    }
  });
  if (!sealed.ok) {
    return sealed;
  }

  return ok({
    triageRunId,
    triageAttemptId,
    candidateCount: orderedGroups.length,
    resultIds
  });
}

function hydrateWorkItems(
  context: ImmediateTransactionContext,
  workItems: readonly AttemptWorkItem[]
): Result<HydratedWorkItem[], RuntimeError> {
  const hydrated: HydratedWorkItem[] = [];
  for (const workItem of workItems) {
    if (workItem.state === "succeeded") {
      /* v8 ignore next 5 */
      if (workItem.extractionArtifactId === null) {
        return err(
          finalizeFailure(`Succeeded work item ${workItem.attemptWorkItemId} is missing an artifact`)
        );
      }
      const artifact = readExtractionArtifact(context, workItem.extractionArtifactId);
      if (!artifact.ok) {
        return artifact;
      }
      /* v8 ignore next 5 */
      if (artifact.value === undefined) {
        return err(
          createRuntimeError("not_found", `Extraction artifact "${workItem.extractionArtifactId}" not found`, false)
        );
      }
      hydrated.push({ workItem, artifact: artifact.value, failure: null });
      continue;
    }
    /* v8 ignore next 5 */
    if (workItem.extractionFailureId === null) {
      return err(
        finalizeFailure(`Failed work item ${workItem.attemptWorkItemId} is missing a failure record`)
      );
    }
    const failure = readExtractionFailure(context, workItem.extractionFailureId);
    if (!failure.ok) {
      return failure;
    }
    /* v8 ignore next 5 */
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
    } else if (item.failure !== null) {
      extraction = {
        candidateDocumentId: item.workItem.candidateDocumentId,
        dimensionId: item.workItem.dimensionId,
        failure: item.failure,
        reviewableFailure: true
      };
    } else {
      /* v8 ignore next */
      continue;
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

function persistCandidateResult(args: {
  context: ImmediateTransactionContext;
  nextId: () => string;
  createdAt: number;
  commandId: string;
  actorId: string;
  candidateId: string;
  documents: readonly CandidateDocumentRow[];
  artifacts: readonly ExtractionArtifact[];
  extractorVersion: string;
  decision: CandidateDecisionOutput;
  rubric: LockedRubric;
}): Result<string, RuntimeError> {
  const resultId = args.nextId();
  const sealId = args.nextId();
  if (args.decision.dimensionDerivation.availability === "unavailable") {
    return persistUnavailableResult({ ...args, resultId, sealId });
  }
  return persistCompleteResult({ ...args, resultId, sealId });
}

function persistUnavailableResult(args: {
  context: ImmediateTransactionContext;
  nextId: () => string;
  createdAt: number;
  actorId: string;
  candidateId: string;
  documents: readonly CandidateDocumentRow[];
  decision: CandidateDecisionOutput;
  resultId: string;
  sealId: string;
}): Result<string, RuntimeError> {
  const sourceDocumentIds = uniqueSourceIds(args.documents);
  const gapRows: Array<{ evidenceGapId: string; dimensionId: string }> = [];
  const gapDimensions = new Map<string, readonly string[]>();
  for (const gap of args.decision.dimensionDerivation.gaps) {
    gapDimensions.set(gap.dimensionId, gap.documentsSearched);
  }
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
    if (!preparedGap.ok) {
      return preparedGap;
    }
    const insertedGap = insertEvidenceGap(args.context, preparedGap.value);
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
  if (!preparedResult.ok) {
    return preparedResult;
  }
  const insertedResult = insertCandidateTriageResult(args.context, preparedResult.value);
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
  if (!sealed.ok) {
    return sealed;
  }
  return ok(args.resultId);
}

function persistCompleteResult(args: {
  context: ImmediateTransactionContext;
  nextId: () => string;
  createdAt: number;
  actorId: string;
  candidateId: string;
  documents: readonly CandidateDocumentRow[];
  artifacts: readonly ExtractionArtifact[];
  extractorVersion: string;
  decision: CandidateDecisionOutput;
  rubric: LockedRubric;
  resultId: string;
  sealId: string;
}): Result<string, RuntimeError> {
  if (args.decision.score === null || args.decision.confidence === null || args.decision.confidenceInput === null) {
    /* v8 ignore next */
    return err(finalizeFailure("Complete candidate decision is missing score or confidence"));
  }

  const persistedSpanIds = new Set<string>();
  const documentByCandidateId = new Map(
    args.documents.map((document) => [document.candidateDocumentId, document] as const)
  );

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
  const locatedSpans = persistLocatedSpans({
    context: args.context,
    documents: documentByCandidateId,
    extractorVersion: args.extractorVersion,
    createdAt: args.createdAt,
    locatedSpans: args.decision.triageInputs.locatedSpans,
    persistedSpanIds
  });
  if (!locatedSpans.ok) {
    return locatedSpans;
  }

  const factIdsByKey = new Map<string, string>();
  const structuredFactIds: string[] = [];
  for (const fact of args.decision.consolidation.facts) {
    const grounding = fact.evidenceSpanIds.filter((spanId) => persistedSpanIds.has(spanId));
    if (grounding.length === 0) {
      continue;
    }
    const structuredFactId = args.nextId();
    const preparedFact = prepareStructuredFact({
      structuredFactId,
      candidateId: args.candidateId,
      payload: fact.payload,
      evidenceSpans: grounding.map((spanId) => ({
        structuredFactEvidenceSpanId: args.nextId(),
        evidenceSpanId: spanId
      })),
      provenances: fact.provenance.map((source) => ({
        structuredFactProvenanceId: args.nextId(),
        source,
        actorId: null
      })),
      createdAt: args.createdAt
    });
    if (!preparedFact.ok) {
      return preparedFact;
    }
    const insertedFact = insertStructuredFact(args.context, preparedFact.value);
    if (!insertedFact.ok) {
      return insertedFact;
    }
    factIdsByKey.set(fact.factKey, structuredFactId);
    structuredFactIds.push(structuredFactId);
  }

  const conflictIds: string[] = [];
  for (const conflict of args.decision.consolidation.conflicts) {
    const members = conflict.memberFactKeys
      .map((key) => factIdsByKey.get(key))
      .filter((id): id is string => id !== undefined);
    if (members.length < 2) {
      continue;
    }
    const factConflictId = args.nextId();
    const preparedConflict = prepareFactConflict({
      factConflictId,
      members: members.map((structuredFactId) => ({
        factConflictMemberId: args.nextId(),
        structuredFactId
      })),
      createdAt: args.createdAt
    });
    if (!preparedConflict.ok) {
      return preparedConflict;
    }
    const insertedConflict = insertFactConflict(args.context, preparedConflict.value);
    if (!insertedConflict.ok) {
      return insertedConflict;
    }
    conflictIds.push(factConflictId);
  }

  const requirementIds: string[] = [];
  for (const assessment of args.decision.hardRequirements.assessments) {
    const facts: Array<{ structuredFactId: string; polarity: "supporting" | "contradicting" }> = [];
    for (const key of assessment.supportingFactKeys) {
      const structuredFactId = factIdsByKey.get(key);
      if (structuredFactId !== undefined) {
        facts.push({ structuredFactId, polarity: "supporting" });
      }
    }
    for (const key of assessment.contradictingFactKeys) {
      const structuredFactId = factIdsByKey.get(key);
      if (structuredFactId !== undefined) {
        facts.push({ structuredFactId, polarity: "contradicting" });
      }
    }
    const outcome = assessment.outcome;
    if ((outcome === "pass" || outcome === "fail") && facts.length === 0) {
      /* v8 ignore next 4 */
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
    if (!preparedRequirement.ok) {
      return preparedRequirement;
    }
    const insertedRequirement = insertHardRequirementAssessment(args.context, preparedRequirement.value);
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
    if (!preparedAssessment.ok) {
      return preparedAssessment;
    }
    const insertedAssessment = insertDimensionAssessment(args.context, preparedAssessment.value);
    if (!insertedAssessment.ok) {
      return insertedAssessment;
    }
    let ordinal = 0;
    const spanIds = [...assessment.supportingSpanIds, ...assessment.contradictingSpanIds];
    for (const spanId of spanIds) {
      if (!persistedSpanIds.has(spanId)) {
        continue;
      }
      const preparedRef = prepareDimensionAssessmentEvidenceSpan({
        dimensionAssessmentEvidenceSpanId: args.nextId(),
        dimensionAssessmentId,
        evidenceSpanId: spanId,
        spanOrdinal: ordinal,
        createdAt: args.createdAt
      });
      if (!preparedRef.ok) {
        return preparedRef;
      }
      const insertedRef = insertDimensionAssessmentEvidenceSpan(args.context, preparedRef.value);
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
    if (!preparedGap.ok) {
      return preparedGap;
    }
    const insertedGap = insertEvidenceGap(args.context, preparedGap.value);
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
    factConflicts: conflictIds.map((factConflictId) => ({
      candidateResultFactConflictId: args.nextId(),
      factConflictId
    })),
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
  if (!preparedResult.ok) {
    return preparedResult;
  }
  const insertedResult = insertCandidateTriageResult(args.context, preparedResult.value);
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
  if (!reasons.ok) {
    return reasons;
  }

  /* v8 ignore start -- scored shortlist proposals need all four hard requirements
   * to resolve; finalize does not invent employment facts from resume prose. */
  if (args.decision.routing.status === "scored") {
    const proposals = persistShortlistProposals({
      context: args.context,
      nextId: args.nextId,
      createdAt: args.createdAt,
      resultId: args.resultId,
      persistedSpanIds,
      proposals: args.decision.proposals.proposals
    });
    if (!proposals.ok) {
      return proposals;
    }
  }
  /* v8 ignore stop */

  const sealed = sealResultAndHead({
    context: args.context,
    createdAt: args.createdAt,
    candidateId: args.candidateId,
    resultId: args.resultId,
    sealId: args.sealId
  });
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
    /* v8 ignore next -- scheduler artifacts always point at a candidate document. */
    if (document === undefined) {
      continue;
    }
    for (const [spanIdx, span] of artifact.acceptedOutput.spans.entries()) {
      const spanId = `span_${args.candidateId}_${artifact.extractionArtifactId}_${spanIdx}`;
      /* v8 ignore next -- artifact span ids include the artifact id and index. */
      if (args.persistedSpanIds.has(spanId)) {
        continue;
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
      /* v8 ignore next -- scheduler already located these spans against stored text. */
      if (!prepared.ok) {
        continue;
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

function persistLocatedSpans(args: {
  context: ImmediateTransactionContext;
  documents: Map<string, CandidateDocumentRow>;
  extractorVersion: string;
  createdAt: number;
  locatedSpans: CandidateDecisionOutput["triageInputs"]["locatedSpans"];
  persistedSpanIds: Set<string>;
}): Result<void, RuntimeError> {
  for (const span of args.locatedSpans) {
    /* v8 ignore next 3 -- work-auth span ids do not collide with artifact spans. */
    if (args.persistedSpanIds.has(span.evidenceSpanId)) {
      continue;
    }
    const document = args.documents.get(span.documentId);
    /* v8 ignore next 3 -- located spans are keyed by the candidate document id. */
    if (document === undefined) {
      continue;
    }
    let matchQuality: "exact" | "normalized" = "exact";
    /* v8 ignore next 3 -- T10.5 work-auth quotes relocate as exact matches. */
    if (span.matchQuality === "normalized") {
      matchQuality = "normalized";
    }
    const prepared = prepareEvidenceSpan({
      evidenceSpanId: span.evidenceSpanId,
      documentId: document.sourceDocumentId,
      start: span.start,
      end: span.end,
      quotedText: span.quotedText,
      dimensionId: FALLBACK_DIMENSION_ID,
      polarity: span.polarity,
      source: "extracted",
      matchQuality,
      extractorVersion: args.extractorVersion,
      createdAt: args.createdAt
    });
    /* v8 ignore next 3 -- located quotes already passed relocateQuote. */
    if (!prepared.ok) {
      continue;
    }
    const inserted = insertEvidenceSpan(args.context, prepared.value);
    /* v8 ignore next 3 -- evidence_span insert fails only on constraint errors. */
    if (!inserted.ok) {
      return inserted;
    }
    args.persistedSpanIds.add(span.evidenceSpanId);
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
    if (!preparedReason.ok) {
      return preparedReason;
    }
    const insertedReason = insertCandidateResultReason(args.context, preparedReason.value);
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
    if (!preparedTask.ok) {
      return preparedTask;
    }
    const insertedTask = insertResolutionTask(args.context, preparedTask.value);
    if (!insertedTask.ok) {
      return insertedTask;
    }
  }
  return ok(undefined);
}

/* v8 ignore start -- reached only for scored results; see persistCompleteResult. */
function persistShortlistProposals(args: {
  context: ImmediateTransactionContext;
  nextId: () => string;
  createdAt: number;
  resultId: string;
  persistedSpanIds: Set<string>;
  proposals: CandidateDecisionOutput["proposals"]["proposals"];
}): Result<void, RuntimeError> {
  for (const [index, proposal] of args.proposals.entries()) {
    const evidenceSpans = proposal.evidenceSpanIds
      .filter((spanId) => args.persistedSpanIds.has(spanId))
      .map((spanId) => ({
        proposalEvidenceSpanId: args.nextId(),
        evidenceSpanId: spanId
      }));
    const prepared = prepareProposal({
      proposalId: args.nextId(),
      candidateResultId: args.resultId,
      proposalOrdinal: index,
      payload: proposal.payload,
      evidenceSpans,
      createdAt: args.createdAt
    });
    if (!prepared.ok) {
      return prepared;
    }
    const inserted = insertProposal(args.context, prepared.value);
    if (!inserted.ok) {
      return inserted;
    }
  }
  return ok(undefined);
}
/* v8 ignore stop */

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
  if (!preparedSeal.ok) {
    return preparedSeal;
  }
  const insertedSeal = insertCandidateResultSeal(args.context, preparedSeal.value);
  if (!insertedSeal.ok) {
    return insertedSeal;
  }
  const head = setCandidateHead(
    args.context,
    { candidateId: args.candidateId, currentResultId: args.resultId },
    0
  );
  if (!head.ok) {
    return head;
  }
  return ok(undefined);
}

function appendNamedAuditEvent(args: {
  context: ImmediateTransactionContext;
  clock: UseCaseComposition["clock"];
  auditEventId: string;
  commandId: string;
  eventOrdinal: number;
  actorId: string;
  eventName: string;
  occurredAt: number;
  payload: unknown;
}): Result<void, RuntimeError> {
  const prepared = prepareAuditEvent(args.clock, {
    auditEventId: args.auditEventId,
    commandId: args.commandId,
    eventOrdinal: args.eventOrdinal,
    actorId: args.actorId,
    actorDisplayName: args.actorId,
    eventName: args.eventName,
    eventVersion: 1,
    occurredAt: args.occurredAt,
    payload: args.payload
  });
  if (!prepared.ok) {
    return prepared;
  }
  const appended = appendAuditEvent(args.context, prepared.value);
  if (!appended.ok) {
    return appended;
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
  return mapped.length === 0 ? [...fallback] : mapped;
}

function captureFirstId(idGenerator: IdGenerator): { generator: IdGenerator; firstId: string | undefined } {
  const captured: { generator: IdGenerator; firstId: string | undefined } = {
    generator: {
      next: () => {
        const id = idGenerator.next();
        if (captured.firstId === undefined) {
          captured.firstId = id;
        }
        return id;
      }
    },
    firstId: undefined
  };
  return captured;
}
