import {
  createErrorEnvelope,
  createSuccessEnvelope,
  formatEnvelopeJson
} from "../envelopes.js";
import { EXIT_SUCCESS, EXIT_USAGE_ERROR, mapErrorToExitCode } from "../exit-codes.js";
import type { ParsedArgs } from "../parser.js";
import type { RecruitosComposition, RuntimeError } from "../composition/types.js";
import type { CommandResult } from "./triage.js";

const DEFAULT_ACTOR_ID = "system:runtime";

function usageError(
  command: string,
  message: string,
  args: ParsedArgs,
  startTime: number
): CommandResult {
  const durationMs = Date.now() - startTime;
  if (args.flags.json) {
    return {
      exitCode: EXIT_USAGE_ERROR,
      stderr: formatEnvelopeJson(
        createErrorEnvelope(
          command,
          "invalid_argument",
          message,
          EXIT_USAGE_ERROR,
          durationMs
        )
      )
    };
  }
  return { exitCode: EXIT_USAGE_ERROR, stderr: `Usage error: ${message}` };
}

function runtimeError(
  command: string,
  error: RuntimeError,
  args: ParsedArgs,
  startTime: number
): CommandResult {
  const durationMs = Date.now() - startTime;
  const exitCode = mapErrorToExitCode(error.code);
  if (args.flags.json) {
    return {
      exitCode,
      stderr: formatEnvelopeJson(
        createErrorEnvelope(
          command,
          error.code,
          error.message,
          exitCode,
          durationMs,
          error.details
        )
      )
    };
  }
  return { exitCode, stderr: `Error [${error.code}]: ${error.message}` };
}

function success(
  command: string,
  value: unknown,
  lines: readonly string[],
  args: ParsedArgs,
  startTime: number
): CommandResult {
  if (args.flags.json) {
    return {
      exitCode: EXIT_SUCCESS,
      stdout: formatEnvelopeJson(
        createSuccessEnvelope(command, value, Date.now() - startTime)
      )
    };
  }
  return { exitCode: EXIT_SUCCESS, stdout: lines.join("\n") };
}

function candidateIds(args: ParsedArgs): readonly string[] {
  const value = args.options.candidate;
  if (value === undefined) return [];
  return value.split(",").map((candidateId) => candidateId.trim()).filter(Boolean);
}

export async function runRuntimeCommand(
  args: ParsedArgs,
  composition: RecruitosComposition,
  startTime: number
): Promise<CommandResult> {
  const actorId = args.options.actor ?? DEFAULT_ACTOR_ID;

  if (args.command === "db:migrate") {
    if (!args.options.db) {
      return usageError("db:migrate", "--db <path> is required", args, startTime);
    }
    return success(
      "db:migrate",
      { databasePath: args.options.db, migrated: true },
      [`Migrated RecruitOS database: ${args.options.db}`],
      args,
      startTime
    );
  }

  if (args.command === "import" || args.command === "corpus:import") {
    const corpusTag = args.options.corpusTag ?? "variant";
    if (corpusTag !== "main" && corpusTag !== "variant") {
      return usageError(
        args.command,
        "--corpus-tag must be main or variant",
        args,
        startTime
      );
    }
    const result = await composition.importCandidates({ actorId, corpusTag });
    if (!result.ok) return runtimeError(args.command, result.error, args, startTime);
    return success(
      args.command,
      result.value,
      [
        "RecruitOS Candidate Import",
        `Command ID: ${result.value.commandId}`,
        `Imported:   ${result.value.imported}`,
        `Skipped:    ${result.value.skipped}`,
        `Candidates: ${result.value.candidateIds.join(", ") || "none"}`
      ],
      args,
      startTime
    );
  }

  if (args.command === "triage:run" || args.command === "triage:start") {
    const roleId = args.options.role;
    const ids = candidateIds(args);
    if (!roleId) {
      return usageError(args.command, "--role <id> is required", args, startTime);
    }
    if (ids.length === 0) {
      return usageError(args.command, "--candidate <id[,id...]> is required", args, startTime);
    }
    const kind = args.options.kind ?? "variant_run";
    if (kind !== "main_run" && kind !== "variant_run") {
      return usageError(
        args.command,
        "--kind must be main_run or variant_run",
        args,
        startTime
      );
    }
    const result = await composition.startTriage({
      actorId,
      roleId,
      candidateIds: ids,
      kind
    });
    if (!result.ok) return runtimeError(args.command, result.error, args, startTime);
    return success(
      args.command,
      result.value,
      [
        "RecruitOS Triage Attempt Started",
        `Command ID:      ${result.value.commandId}`,
        `Triage Run ID:   ${result.value.triageRunId}`,
        `Attempt ID:      ${result.value.triageAttemptId}`,
        `Work Item Count: ${result.value.workItemCount}`
      ],
      args,
      startTime
    );
  }

  if (args.command === "triage:extract") {
    const attemptId = args.options.attempt ?? args.positionals[0];
    if (!attemptId) {
      return usageError(
        args.command,
        "--attempt <id> is required",
        args,
        startTime
      );
    }
    const result = await composition.extractTriage(attemptId);
    if (!result.ok) return runtimeError(args.command, result.error, args, startTime);
    return success(
      args.command,
      result.value,
      [
        "RecruitOS Fixture Extraction",
        `Attempt ID:         ${result.value.triageAttemptId}`,
        `Processed:          ${result.value.processed}`,
        `Succeeded:          ${result.value.succeeded}`,
        `Reviewable failures:${result.value.reviewableFailures}`,
        `Blocked failures:   ${result.value.blockedFailures}`,
        `Spans located:      ${result.value.spansLocated}/${result.value.spansReturned}`,
        `Dropped quotes:     ${result.value.droppedQuoteCount}`
      ],
      args,
      startTime
    );
  }

  const attemptId = args.options.attempt ?? args.positionals[0];
  if (!attemptId) {
    return usageError(
      args.command,
      "--attempt <id> is required",
      args,
      startTime
    );
  }
  const result = await composition.finalizeTriage({
    actorId,
    triageAttemptId: attemptId,
    ...(args.options.run ? { triageRunId: args.options.run } : {})
  });
  if (!result.ok) return runtimeError(args.command, result.error, args, startTime);
  return success(
    args.command,
    result.value,
    [
      "RecruitOS Triage Run Finalized",
      `Command ID:      ${result.value.commandId}`,
      `Triage Run ID:   ${result.value.triageRunId}`,
      `Attempt ID:      ${result.value.triageAttemptId}`,
      `Candidate Count: ${result.value.candidateCount}`,
      `Result IDs:      ${result.value.resultIds.join(", ") || "none"}`
    ],
    args,
    startTime
  );
}
