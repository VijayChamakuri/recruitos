import {
  createErrorEnvelope,
  createSuccessEnvelope,
  formatEnvelopeJson,
  formatTable
} from "../envelopes.js";
import { EXIT_DOMAIN_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, mapErrorToExitCode } from "../exit-codes.js";
import type { ParsedArgs } from "../parser.js";
import type { CandidateSummary, CandidateTriageStatus, RecruitosComposition } from "../composition/types.js";

export type CommandResult = Readonly<{
  exitCode: number;
  stdout?: string;
  stderr?: string;
}>;

export async function runTriageCommand(
  args: ParsedArgs,
  composition: RecruitosComposition,
  startTime: number
): Promise<CommandResult> {
  const isRunAction = args.positionals[0] === "run" || args.flags.dryRun;

  if (isRunAction) {
    const runResult = await composition.runTriage({
      roleId: args.options.role,
      candidateIds: args.options.candidate ? [args.options.candidate] : undefined,
      dryRun: args.flags.dryRun
    });

    const durationMs = Date.now() - startTime;

    if (!runResult.ok) {
      const exitCode = mapErrorToExitCode(runResult.error.code);
      if (args.flags.json) {
        return {
          exitCode,
          stderr: formatEnvelopeJson(
            createErrorEnvelope(
              "triage",
              runResult.error.code,
              runResult.error.message,
              exitCode,
              durationMs,
              runResult.error.details
            )
          )
        };
      }
      return {
        exitCode,
        stderr: `Error [${runResult.error.code}]: ${runResult.error.message}`
      };
    }

    const run = runResult.value;
    if (args.flags.json) {
      return {
        exitCode: EXIT_SUCCESS,
        stdout: formatEnvelopeJson(createSuccessEnvelope("triage", run, durationMs))
      };
    }

    const lines = [
      "RecruitOS Triage Run Summary",
      "============================",
      `Run ID:          ${run.runId}`,
      `Role ID:         ${run.roleId}`,
      `Total Processed: ${run.totalCandidates}`,
      `Scored:          ${run.scoredCount}`,
      `Shortlisted:     ${run.shortlistCount}`,
      `Escalated:       ${run.escalatedCount}`,
      `Sealed:          ${run.sealed ? "yes" : "no"}`,
      `Duration:        ${run.durationMs}ms`
    ];

    return {
      exitCode: EXIT_SUCCESS,
      stdout: lines.join("\n")
    };
  }

  // Otherwise list candidate triage queue
  const validStatuses: readonly CandidateTriageStatus[] = [
    "scored",
    "rejected_hard_requirement",
    "shortlisted",
    "reviewed",
    "escalated",
    "rejected",
    "pending"
  ];
  if (args.options.status && !validStatuses.includes(args.options.status as CandidateTriageStatus)) {
    const durationMs = Date.now() - startTime;
    const msg = `Invalid candidate status: '${args.options.status}'. Valid: ${validStatuses.join(", ")}`;
    if (args.flags.json) {
      return {
        exitCode: EXIT_USAGE_ERROR,
        stderr: formatEnvelopeJson(
          createErrorEnvelope("triage", "invalid_status", msg, EXIT_USAGE_ERROR, durationMs)
        )
      };
    }
    return {
      exitCode: EXIT_USAGE_ERROR,
      stderr: `Usage error: ${msg}`
    };
  }

  const listResult = await composition.listCandidates({
    roleId: args.options.role,
    channel: args.options.channel as "inbound" | "sourced" | undefined,
    status: args.options.status as CandidateTriageStatus | undefined,
    limit: args.options.limit
  });

  const durationMs = Date.now() - startTime;

  if (!listResult.ok) {
    const exitCode = mapErrorToExitCode(listResult.error.code);
    if (args.flags.json) {
      return {
        exitCode,
        stderr: formatEnvelopeJson(
          createErrorEnvelope(
            "triage",
            listResult.error.code,
            listResult.error.message,
            exitCode,
            durationMs,
            listResult.error.details
          )
        )
      };
    }
    return {
      exitCode,
      stderr: `Error [${listResult.error.code}]: ${listResult.error.message}`
    };
  }

  const candidates = listResult.value;

  if (args.flags.json) {
    return {
      exitCode: EXIT_SUCCESS,
      stdout: formatEnvelopeJson(createSuccessEnvelope("triage", candidates, durationMs))
    };
  }

  const headers = [
    "Candidate ID",
    "Role",
    "Channel",
    "Status",
    "Score",
    "Conf",
    "Tasks",
    "Sealed"
  ];

  const rows = candidates.map((c: CandidateSummary) => [
    c.candidateId,
    c.roleTitle,
    c.channel,
    c.status,
    c.score !== null ? c.score.toFixed(1) : "-",
    c.confidence !== null ? `${Math.round(c.confidence * 100)}%` : "-",
    String(c.tasksCount),
    c.sealed ? "yes" : "no"
  ]);

  const output = [
    "RecruitOS Candidate Triage Queue",
    `Total candidates: ${candidates.length}`,
    "",
    formatTable(headers, rows)
  ].join("\n");

  return {
    exitCode: EXIT_SUCCESS,
    stdout: output
  };
}
