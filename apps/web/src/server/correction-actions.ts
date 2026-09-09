import type { RecruitosComposition, RuntimeError } from "@recruitos/cli";
import { err, ok, type Result } from "@recruitos/core";
import { SYSTEM_ACTOR_ID } from "@recruitos/runtime";
import { isCorrectionFixtureMode } from "./correction-mode.js";
import {
  CORRECTION_DISABLED_MESSAGE,
  FIXTURE_CORRECTION_SOURCE_KEY,
  HUMAN_OPERATOR_ACTOR_ID,
  forbiddenFactField,
  rejectPostedActor,
  requiredInteger,
  requiredText
} from "./form-body.js";

export type WebActionFailure = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  httpStatus: number;
  details?: unknown;
}>;

export type ReExtractionRequestSuccess = Readonly<{
  actionId: string;
  newVersion: number;
  derivedStatus: string;
  triageAttemptId: string;
  commandId: string;
  candidateId: string;
}>;

export type FixtureCompleteSuccess = Readonly<{
  resultId: string;
  baseResultId: string;
  candidateHeadVersion: number;
  taskHeadVersion: number;
  derivedStatus: "review_required";
  candidateId: string;
}>;

function nativePrepare(
  database: unknown
): ((sql: string) => { get: (...parameters: readonly unknown[]) => unknown }) | null {
  if (typeof database !== "object" || database === null) {
    return null;
  }
  const candidate =
    "$client" in database ? (database as { $client: unknown }).$client : database;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("prepare" in candidate) ||
    typeof (candidate as { prepare: unknown }).prepare !== "function"
  ) {
    return null;
  }
  return (candidate as { prepare: (sql: string) => { get: (...p: readonly unknown[]) => unknown } })
    .prepare.bind(candidate);
}

function failure(
  code: string,
  message: string,
  httpStatus: number,
  details?: unknown
): WebActionFailure {
  return {
    code,
    message,
    retryable: false,
    httpStatus,
    ...(details === undefined ? {} : { details })
  };
}

function correctionDisabled(): WebActionFailure {
  return failure("command_conflict", CORRECTION_DISABLED_MESSAGE, 403);
}

function fromRuntimeError(error: RuntimeError): WebActionFailure {
  const httpStatus =
    error.code === "version_conflict" || error.code === "command_conflict"
      ? 409
      : error.code === "not_found"
        ? 404
        : error.code === "invalid_argument"
          ? 400
          : 500;
  return failure(error.code, error.message, httpStatus, error.details);
}

export function staleConflictCopy(error: {
  code: string;
  message: string;
  details?: unknown;
}): string {
  const details = error.details;
  const record =
    typeof details === "object" && details !== null
      ? (details as Record<string, unknown>)
      : undefined;
  const expected =
    record !== undefined && typeof record.expectedVersion === "number"
      ? record.expectedVersion
      : undefined;
  const actual =
    record !== undefined &&
    (typeof record.actualVersion === "number" || record.actualVersion === null)
      ? record.actualVersion
      : undefined;
  if (error.code === "version_conflict" && expected !== undefined) {
    const actualLabel = actual === null || actual === undefined ? "unknown" : String(actual);
    return [
      `You reviewed task v${expected}. This packet is now v${actualLabel}.`,
      "The submission is stale. Refresh to the current head.",
      "There is no Save anyway."
    ].join(" ");
  }
  return `${error.message}. The submission is stale. Refresh to the current head. There is no Save anyway.`;
}

export function readCorrectionAttemptId(
  database: unknown,
  requestActionId: string
): string | undefined {
  const prepare = nativePrepare(database);
  if (prepare === null) {
    return undefined;
  }
  try {
    const row = prepare(
      `SELECT triage_attempt_id AS triageAttemptId
       FROM triage_attempt
       WHERE request_action_id = ?
       LIMIT 1`
    ).get(requestActionId);
    if (typeof row !== "object" || row === null || !("triageAttemptId" in row)) {
      return undefined;
    }
    const attemptId = (row as { triageAttemptId: unknown }).triageAttemptId;
    return typeof attemptId === "string" && attemptId.length > 0 ? attemptId : undefined;
  } catch {
    return undefined;
  }
}

async function requireFixtureCandidate(
  composition: RecruitosComposition,
  candidateId: string
): Promise<Result<{ sourceKey: string }, WebActionFailure>> {
  const packet = await composition.getCandidatePacket(candidateId);
  if (!packet.ok) {
    return err(fromRuntimeError(packet.error));
  }
  if (packet.value.sourceKey !== FIXTURE_CORRECTION_SOURCE_KEY) {
    return err(
      failure(
        "command_conflict",
        "Fixture correction is only enabled for demo/route-4-reviewable-failure.",
        403
      )
    );
  }
  return ok({ sourceKey: packet.value.sourceKey });
}

export async function requestReExtractionAction(
  composition: RecruitosComposition,
  body: URLSearchParams
): Promise<Result<ReExtractionRequestSuccess, WebActionFailure>> {
  if (!isCorrectionFixtureMode()) {
    return err(correctionDisabled());
  }
  const factField = forbiddenFactField(body);
  if (factField !== undefined) {
    return err(
      failure(
        "invalid_argument",
        `The browser must not supply extracted facts (${factField}).`,
        400
      )
    );
  }
  const actorError = rejectPostedActor(body);
  if (actorError !== undefined) {
    return err(failure("invalid_argument", actorError, 400));
  }
  const actionKind = body.get("actionKind");
  if (actionKind !== null && actionKind !== "request_re_extraction") {
    return err(
      failure(
        "invalid_argument",
        "This slice only records request_re_extraction.",
        400
      )
    );
  }
  const candidateId = requiredText(body, "candidateId");
  const taskId = requiredText(body, "taskId");
  const rationale = requiredText(body, "rationale");
  const expectedTaskHeadVersion = requiredInteger(body, "expectedTaskHeadVersion");
  const expectedCandidateHeadVersion = requiredInteger(body, "expectedCandidateHeadVersion");
  if (
    candidateId === undefined ||
    taskId === undefined ||
    rationale === undefined ||
    expectedTaskHeadVersion === undefined ||
    expectedCandidateHeadVersion === undefined
  ) {
    return err(
      failure(
        "invalid_argument",
        "Request re-extraction requires candidateId, taskId, rationale, expectedTaskHeadVersion, and expectedCandidateHeadVersion.",
        400
      )
    );
  }
  const fixture = await requireFixtureCandidate(composition, candidateId);
  if (!fixture.ok) {
    return fixture;
  }
  const recorded = await composition.recordResolutionAction({
    taskId,
    actionKind: "request_re_extraction",
    actorId: HUMAN_OPERATOR_ACTOR_ID,
    rationale,
    expectedVersion: expectedTaskHeadVersion,
    expectedCandidateHeadVersion
  });
  if (!recorded.ok) {
    return err(fromRuntimeError(recorded.error));
  }
  if (recorded.value.triageAttemptId === undefined) {
    return err(
      failure(
        "persistence_failed",
        "request_re_extraction did not return a triage attempt id.",
        500
      )
    );
  }
  return ok({
    actionId: recorded.value.actionId,
    newVersion: recorded.value.newVersion,
    derivedStatus: recorded.value.derivedStatus,
    triageAttemptId: recorded.value.triageAttemptId,
    commandId: recorded.value.commandId,
    candidateId
  });
}

export async function completeFixtureReExtractionAction(
  composition: RecruitosComposition,
  body: URLSearchParams
): Promise<Result<FixtureCompleteSuccess, WebActionFailure>> {
  if (!isCorrectionFixtureMode()) {
    return err(correctionDisabled());
  }
  const factField = forbiddenFactField(body);
  if (factField !== undefined) {
    return err(
      failure(
        "invalid_argument",
        `The browser must not supply extracted facts (${factField}).`,
        400
      )
    );
  }
  const actorError = rejectPostedActor(body);
  if (actorError !== undefined) {
    return err(failure("invalid_argument", actorError, 400));
  }
  const candidateId = requiredText(body, "candidateId");
  const triageAttemptId = requiredText(body, "triageAttemptId");
  const expectedTaskHeadVersion = requiredInteger(body, "expectedTaskHeadVersion");
  const expectedCandidateHeadVersion = requiredInteger(body, "expectedCandidateHeadVersion");
  if (
    candidateId === undefined ||
    triageAttemptId === undefined ||
    expectedTaskHeadVersion === undefined ||
    expectedCandidateHeadVersion === undefined
  ) {
    return err(
      failure(
        "invalid_argument",
        "Complete fixture extraction requires candidateId, triageAttemptId, expectedTaskHeadVersion, and expectedCandidateHeadVersion.",
        400
      )
    );
  }
  const fixture = await requireFixtureCandidate(composition, candidateId);
  if (!fixture.ok) {
    return fixture;
  }
  if (composition.registerExtractionFixtures === undefined) {
    return err(
      failure(
        "command_conflict",
        "Extraction fixtures are not available on this composition.",
        500
      )
    );
  }
  if (composition.completeReExtraction === undefined) {
    return err(
      failure(
        "command_conflict",
        "completeReExtraction is not available on this composition.",
        500
      )
    );
  }
  const registered = composition.registerExtractionFixtures(triageAttemptId, { overlay: true });
  if (!registered.ok) {
    return err(fromRuntimeError(registered.error));
  }
  const extracted = await composition.extractTriage(triageAttemptId);
  if (!extracted.ok) {
    return err(fromRuntimeError(extracted.error));
  }
  const completed = await composition.completeReExtraction({
    actorId: SYSTEM_ACTOR_ID,
    triageAttemptId,
    expectedTaskHeadVersion,
    expectedCandidateHeadVersion
  });
  if (!completed.ok) {
    return err(fromRuntimeError(completed.error));
  }
  return ok({
    resultId: completed.value.resultId,
    baseResultId: completed.value.baseResultId,
    candidateHeadVersion: completed.value.candidateHeadVersion,
    taskHeadVersion: completed.value.taskHeadVersion,
    derivedStatus: completed.value.derivedStatus,
    candidateId
  });
}
