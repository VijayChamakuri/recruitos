import {
  ProposalPayloadSchema,
  ProposalStatusSchema,
  ReviewDecisionKindSchema,
  type Result,
  type ReviewDecisionPayload
} from "@recruitos/core";

import {
  createErrorEnvelope,
  createSuccessEnvelope,
  formatEnvelopeJson,
  formatTable
} from "../envelopes.js";
import { EXIT_SUCCESS, EXIT_USAGE_ERROR, mapErrorToExitCode } from "../exit-codes.js";
import type { ParsedArgs } from "../parser.js";
import type {
  ProposalSummary,
  RecruitosComposition,
  ResolutionTaskDetail,
  ResolutionTaskStatus,
  ResolutionTaskSummary
} from "../composition/types.js";
import type { CommandResult } from "./triage.js";

function usageError(
  flags: ParsedArgs["flags"],
  startTime: number,
  code: string,
  message: string
): CommandResult {
  const durationMs = Date.now() - startTime;
  if (flags.json) {
    return {
      exitCode: EXIT_USAGE_ERROR,
      stderr: formatEnvelopeJson(
        createErrorEnvelope("review", code, message, EXIT_USAGE_ERROR, durationMs)
      )
    };
  }
  return {
    exitCode: EXIT_USAGE_ERROR,
    stderr: `Usage error: ${message}`
  };
}

function parseCliReviewDecision(args: ParsedArgs): Result<ReviewDecisionPayload, string> {
  const parsedKind = ReviewDecisionKindSchema.safeParse(args.options.decision);
  if (!parsedKind.success) {
    return {
      ok: false,
      error: `Invalid decision '${args.options.decision}'. Must be 'approve', 'reject', 'edit', or 'request_evidence'`
    };
  }
  if (parsedKind.data === "approve") {
    return { ok: true, value: { kind: "approve" } };
  }
  if (parsedKind.data === "reject" || parsedKind.data === "request_evidence") {
    const rationale = args.options.rationale?.trim() ?? "";
    if (rationale.length === 0) {
      return {
        ok: false,
        error: `--rationale is required when recording a ${parsedKind.data} decision`
      };
    }
    return { ok: true, value: { kind: parsedKind.data, rationale } };
  }
  const raw = args.options.editedPayload;
  if (raw === undefined || raw.trim().length === 0) {
    return {
      ok: false,
      error: "--edited-payload is required when recording an edit decision"
    };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { ok: false, error: "--edited-payload must be valid JSON" };
  }
  const parsedPayload = ProposalPayloadSchema.safeParse(decoded);
  if (!parsedPayload.success) {
    return {
      ok: false,
      error: "--edited-payload must be a ProposalPayload JSON object whose kind matches the stored proposal"
    };
  }
  return { ok: true, value: { kind: "edit", editedPayload: parsedPayload.data } };
}

export async function runReviewCommand(
  args: ParsedArgs,
  composition: RecruitosComposition,
  startTime: number
): Promise<CommandResult> {
  const taskId = args.options.task;
  const proposalId = args.options.proposal;

  // Case 1: Act on or inspect specific resolution task
  if (taskId) {
    if (args.options.action) {
      if (args.options.versionNum === undefined || Number.isNaN(args.options.versionNum)) {
        const durationMs = Date.now() - startTime;
        const msg = "--version-num is required when recording a resolution action";
        if (args.flags.json) {
          return {
            exitCode: EXIT_USAGE_ERROR,
            stderr: formatEnvelopeJson(
              createErrorEnvelope("review", "missing_version", msg, EXIT_USAGE_ERROR, durationMs)
            )
          };
        }
        return {
          exitCode: EXIT_USAGE_ERROR,
          stderr: `Usage error: ${msg}`
        };
      }

      if (args.options.action === "reextraction_completed") {
        const durationMs = Date.now() - startTime;
        const msg = "reextraction_completed is a system-only action";
        if (args.flags.json) {
          return {
            exitCode: EXIT_USAGE_ERROR,
            stderr: formatEnvelopeJson(
              createErrorEnvelope("review", "command_conflict", msg, EXIT_USAGE_ERROR, durationMs)
            )
          };
        }
        return {
          exitCode: EXIT_USAGE_ERROR,
          stderr: `Usage error: ${msg}`
        };
      }

      if (args.options.action === "request_re_extraction") {
        if (
          args.options.candidateVersion === undefined ||
          Number.isNaN(args.options.candidateVersion)
        ) {
          const durationMs = Date.now() - startTime;
          const msg = "--candidate-version is required when requesting re-extraction";
          if (args.flags.json) {
            return {
              exitCode: EXIT_USAGE_ERROR,
              stderr: formatEnvelopeJson(
                createErrorEnvelope(
                  "review",
                  "missing_candidate_version",
                  msg,
                  EXIT_USAGE_ERROR,
                  durationMs
                )
              )
            };
          }
          return {
            exitCode: EXIT_USAGE_ERROR,
            stderr: `Usage error: ${msg}`
          };
        }
      }

      const actionResult = await composition.recordResolutionAction({
        taskId,
        actionKind: args.options.action,
        actorId: args.options.actor ?? "human:operator",
        rationale: args.options.rationale ?? "Resolution applied via CLI",
        expectedVersion: args.options.versionNum,
        ...(args.options.candidateVersion === undefined
          ? {}
          : { expectedCandidateHeadVersion: args.options.candidateVersion }),
        ...(args.options.commandId === undefined ? {} : { commandId: args.options.commandId })
      });

      const durationMs = Date.now() - startTime;

      if (!actionResult.ok) {
        const exitCode = mapErrorToExitCode(actionResult.error.code);
        if (args.flags.json) {
          return {
            exitCode,
            stderr: formatEnvelopeJson(
              createErrorEnvelope(
                "review",
                actionResult.error.code,
                actionResult.error.message,
                exitCode,
                durationMs,
                actionResult.error.details
              )
            )
          };
        }
        return {
          exitCode,
          stderr: `Error [${actionResult.error.code}]: ${actionResult.error.message}`
        };
      }

      const res = actionResult.value;
      if (args.flags.json) {
        return {
          exitCode: EXIT_SUCCESS,
          stdout: formatEnvelopeJson(createSuccessEnvelope("review", res, durationMs))
        };
      }

      return {
        exitCode: EXIT_SUCCESS,
        stdout: [
          `Resolution action recorded for task: ${taskId}`,
          `Action ID:      ${res.actionId}`,
          `Command ID:     ${res.commandId}`,
          `New Version:    ${res.newVersion}`,
          `Derived Status: ${res.derivedStatus}`,
          ...(res.triageAttemptId === undefined
            ? []
            : [`Attempt ID:     ${res.triageAttemptId}`])
        ].join("\n")
      };
    }

    // Inspect task
    const taskResult = await composition.getResolutionTask(taskId);
    const durationMs = Date.now() - startTime;

    if (!taskResult.ok) {
      const exitCode = mapErrorToExitCode(taskResult.error.code);
      if (args.flags.json) {
        return {
          exitCode,
          stderr: formatEnvelopeJson(
            createErrorEnvelope(
              "review",
              taskResult.error.code,
              taskResult.error.message,
              exitCode,
              durationMs,
              taskResult.error.details
            )
          )
        };
      }
      return {
        exitCode,
        stderr: `Error [${taskResult.error.code}]: ${taskResult.error.message}`
      };
    }

    const task: ResolutionTaskDetail = taskResult.value;

    if (args.flags.json) {
      return {
        exitCode: EXIT_SUCCESS,
        stdout: formatEnvelopeJson(createSuccessEnvelope("review", task, durationMs))
      };
    }

    const lines = [
      `Resolution Task: ${task.resolutionTaskId}`,
      "=".repeat(40),
      `Candidate ID:       ${task.candidateId}`,
      `Reason Code:        ${task.reasonCode}`,
      `Status:             ${task.status}`,
      `Task Ordinal:       ${task.taskOrdinal}`,
      `Current Action ID:  ${task.currentActionId ?? "(none)"}`,
      `Head Version:       ${task.version}`,
      "",
      "Action History:"
    ];

    if (task.actions.length === 0) {
      lines.push("  (no actions recorded)");
    } else {
      const actionHeaders = ["Action ID", "Actor", "Kind", "Rationale"];
      const actionRows = task.actions.map((a) => [
        a.actionId,
        a.actorId,
        a.actionKind,
        a.rationale
      ]);
      lines.push(formatTable(actionHeaders, actionRows));
    }

    return {
      exitCode: EXIT_SUCCESS,
      stdout: lines.join("\n")
    };
  }

  // Case 2: Act on specific proposal
  if (proposalId) {
    if (args.options.decision) {
      if (args.options.versionNum === undefined || Number.isNaN(args.options.versionNum)) {
        return usageError(
          args.flags,
          startTime,
          "missing_version",
          "--version-num is required when recording a review decision"
        );
      }

      const parsedDecision = parseCliReviewDecision(args);
      if (!parsedDecision.ok) {
        return usageError(args.flags, startTime, "invalid_decision", parsedDecision.error);
      }

      const decisionResult = await composition.recordReviewDecision({
        proposalId,
        decision: parsedDecision.value,
        actorId: args.options.actor ?? "human:operator",
        expectedVersion: args.options.versionNum,
        ...(args.options.commandId === undefined ? {} : { commandId: args.options.commandId })
      });

      const durationMs = Date.now() - startTime;

      if (!decisionResult.ok) {
        const exitCode = mapErrorToExitCode(decisionResult.error.code);
        if (args.flags.json) {
          return {
            exitCode,
            stderr: formatEnvelopeJson(
              createErrorEnvelope(
                "review",
                decisionResult.error.code,
                decisionResult.error.message,
                exitCode,
                durationMs,
                decisionResult.error.details
              )
            )
          };
        }
        return {
          exitCode,
          stderr: `Error [${decisionResult.error.code}]: ${decisionResult.error.message}`
        };
      }

      const res = decisionResult.value;
      if (args.flags.json) {
        return {
          exitCode: EXIT_SUCCESS,
          stdout: formatEnvelopeJson(createSuccessEnvelope("review", res, durationMs))
        };
      }

      return {
        exitCode: EXIT_SUCCESS,
        stdout: [
          `Review decision recorded for proposal: ${proposalId}`,
          `Decision ID: ${res.decisionId}`,
          `New Version: ${res.newVersion}`,
          `Status:      ${res.status}`,
          `Command ID:  ${res.commandId}`
        ].join("\n")
      };
    }
  }

  // Case 3: List tasks and proposals
  const tasksResult = await composition.listResolutionTasks({
    candidateId: args.options.candidate,
    status: args.options.status as ResolutionTaskStatus | undefined
  });

  const parsedProposalStatus = ProposalStatusSchema.safeParse(args.options.status);
  const proposalsResult = await composition.listProposals({
    candidateId: args.options.candidate,
    ...(parsedProposalStatus.success ? { status: parsedProposalStatus.data } : {})
  });

  const durationMs = Date.now() - startTime;

  if (!tasksResult.ok) {
    const exitCode = mapErrorToExitCode(tasksResult.error.code);
    return {
      exitCode,
      stderr: args.flags.json
        ? formatEnvelopeJson(
            createErrorEnvelope("review", tasksResult.error.code, tasksResult.error.message, exitCode, durationMs)
          )
        : `Error: ${tasksResult.error.message}`
    };
  }

  if (!proposalsResult.ok) {
    const exitCode = mapErrorToExitCode(proposalsResult.error.code);
    return {
      exitCode,
      stderr: args.flags.json
        ? formatEnvelopeJson(
            createErrorEnvelope("review", proposalsResult.error.code, proposalsResult.error.message, exitCode, durationMs)
          )
        : `Error: ${proposalsResult.error.message}`
    };
  }

  const tasks = tasksResult.value;
  const proposals = proposalsResult.value;

  if (args.flags.json) {
    return {
      exitCode: EXIT_SUCCESS,
      stdout: formatEnvelopeJson(createSuccessEnvelope("review", { tasks, proposals }, durationMs))
    };
  }

  const taskHeaders = ["Task ID", "Candidate", "Reason Code", "Status", "Ver", "Current Action"];
  const taskRows = tasks.map((t: ResolutionTaskSummary) => [
    t.resolutionTaskId,
    t.candidateId,
    t.reasonCode,
    t.status,
    String(t.version),
    t.currentActionId ?? "(none)"
  ]);

  const proposalHeaders = ["Proposal ID", "Candidate", "Kind", "Status", "Ver", "Proposed Change"];
  const proposalRows = proposals.map((p: ProposalSummary) => [
    p.proposalId,
    p.candidateId,
    p.kind,
    p.status,
    String(p.version),
    p.proposedChange
  ]);

  const output = [
    "RecruitOS Review Queue",
    "",
    `Resolution Tasks (${tasks.length}):`,
    formatTable(taskHeaders, taskRows),
    "",
    `Pending Proposals (${proposals.length}):`,
    formatTable(proposalHeaders, proposalRows)
  ].join("\n");

  return {
    exitCode: EXIT_SUCCESS,
    stdout: output
  };
}
