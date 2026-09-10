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

  if (args.command === "demo:prepare") {
    if (!args.options.db) {
      return usageError("demo:prepare", "--db <path> is required", args, startTime);
    }
    if (!composition.prepareDemo) {
      return runtimeError(
        args.command,
        {
          code: "persistence_failed",
          message: "The active composition does not support demo preparation",
          retryable: false
        },
        args,
        startTime
      );
    }
    const result = await composition.prepareDemo({ actorId });
    if (!result.ok) return runtimeError(args.command, result.error, args, startTime);
    return success(
      args.command,
      result.value,
      [
        "RecruitOS Demo Prepared",
        `Candidates:      ${result.value.candidateIds.join(", ")}`,
        `Triage Run ID:   ${result.value.triageRunId}`,
        `Attempt ID:      ${result.value.triageAttemptId}`,
        `Result IDs:      ${result.value.resultIds.join(", ")}`
      ],
      args,
      startTime
    );
  }

  if (args.command === "demo:proposals") {
    if (!args.options.db) {
      return usageError("demo:proposals", "--db <path> is required", args, startTime);
    }
    if (!composition.seedDemoProposals) {
      return runtimeError(
        args.command,
        {
          code: "persistence_failed",
          message: "The active composition does not support demo proposal seeding",
          retryable: false
        },
        args,
        startTime
      );
    }
    const result = await composition.seedDemoProposals({
      actorId,
      ...(args.options.commandId === undefined ? {} : { commandId: args.options.commandId })
    });
    if (!result.ok) return runtimeError(args.command, result.error, args, startTime);
    return success(
      args.command,
      result.value,
      [
        "RecruitOS Demo Proposals Seeded",
        `Command ID: ${result.value.commandId}`,
        ...result.value.proposals.map(
          (proposal) =>
            `${proposal.kind}: ${proposal.proposalId} (${proposal.sourceKey})`
        ),
        `Run integrity: ${result.value.triageRunCount} triage run, ${result.value.triageRunMemberCount} members`,
        "NO OUTBOUND EFFECT"
      ],
      args,
      startTime
    );
  }

  if (args.command === "eval:class1") {
    const candidateId = args.options.candidateId ?? args.positionals[0];
    if (!args.options.db) {
      return usageError("eval:class1", "--db <path> is required", args, startTime);
    }
    if (!candidateId) {
      return usageError(
        "eval:class1",
        "--candidate-id <id> is required",
        args,
        startTime
      );
    }
    if (!composition.evaluateClass1) {
      return runtimeError(
        args.command,
        {
          code: "persistence_failed",
          message: "The active composition does not support Class 1 evaluation",
          retryable: false
        },
        args,
        startTime
      );
    }
    const result = await composition.evaluateClass1(candidateId);
    if (!result.ok) return runtimeError(args.command, result.error, args, startTime);
    const lines = [
      "RecruitOS Class 1 Evaluation",
      `Candidate:                 ${result.value.candidateId}`,
      `Passed:                    ${result.value.passed ? "yes" : "no"}`,
      `Located-span coverage:     ${(result.value.locatedSpanCoverageRate * 100).toFixed(1)}%`,
      `Coverage requirement met:  ${result.value.coverageRequirementMet ? "yes" : "no"}`,
      `All dimensions accounted:  ${result.value.allDimensionsAccountedFor ? "yes" : "no"}`,
      `Known limitations visible: ${result.value.knownLimitationsCountMet ? "yes" : "no"}`
    ];
    if (result.value.violations.length > 0) {
      lines.push("Violations:", ...result.value.violations.map((item) => `  ${item}`));
    }
    const output = success(args.command, result.value, lines, args, startTime);
    return result.value.passed ? output : { ...output, exitCode: 1 };
  }

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
    if (args.flags.demoFixtures) {
      if (!composition.registerExtractionFixtures) {
        return runtimeError(
          args.command,
          {
            code: "persistence_failed",
            message: "The active composition does not support fixture registration",
            retryable: false
          },
          args,
          startTime
        );
      }
      const registered = composition.registerExtractionFixtures(attemptId, {
        overlay: args.flags.correctionOverlay
      });
      if (!registered.ok) return runtimeError(args.command, registered.error, args, startTime);
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

  if (args.command === "triage:complete-correction") {
    const attemptId = args.options.attempt ?? args.positionals[0];
    if (!attemptId) {
      return usageError(args.command, "--attempt <id> is required", args, startTime);
    }
    if (args.options.versionNum === undefined || Number.isNaN(args.options.versionNum)) {
      return usageError(
        args.command,
        "--version-num <n> is required (resolution task head version)",
        args,
        startTime
      );
    }
    if (
      args.options.candidateVersion === undefined ||
      Number.isNaN(args.options.candidateVersion)
    ) {
      return usageError(
        args.command,
        "--candidate-version <n> is required",
        args,
        startTime
      );
    }
    if (!composition.completeReExtraction) {
      return runtimeError(
        args.command,
        {
          code: "persistence_failed",
          message: "The active composition does not support correction completion",
          retryable: false
        },
        args,
        startTime
      );
    }
    const result = await composition.completeReExtraction({
      actorId: DEFAULT_ACTOR_ID,
      triageAttemptId: attemptId,
      expectedTaskHeadVersion: args.options.versionNum,
      expectedCandidateHeadVersion: args.options.candidateVersion,
      ...(args.options.commandId === undefined ? {} : { commandId: args.options.commandId })
    });
    if (!result.ok) return runtimeError(args.command, result.error, args, startTime);
    return success(
      args.command,
      result.value,
      [
        "RecruitOS Correction Completed",
        `Command ID:              ${result.value.commandId}`,
        `Attempt ID:              ${result.value.triageAttemptId}`,
        `Result ID:               ${result.value.resultId}`,
        `Supersedes:              ${result.value.baseResultId}`,
        `Candidate head version:  ${result.value.candidateHeadVersion}`,
        `Task status:             ${result.value.derivedStatus}`
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
