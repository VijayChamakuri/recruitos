import {
  createErrorEnvelope,
  createSuccessEnvelope,
  formatEnvelopeJson,
  formatTable
} from "../envelopes.js";
import { EXIT_SUCCESS, mapErrorToExitCode } from "../exit-codes.js";
import type { ParsedArgs } from "../parser.js";
import type {
  AuditEventSummary,
  RecruitosComposition,
  SystemStatusSummary
} from "../composition/types.js";
import type { CommandResult } from "./triage.js";

export async function runStatusCommand(
  args: ParsedArgs,
  composition: RecruitosComposition,
  startTime: number
): Promise<CommandResult> {
  const statusResult = await composition.getStatus();
  const durationMs = Date.now() - startTime;

  if (!statusResult.ok) {
    const exitCode = mapErrorToExitCode(statusResult.error.code);
    if (args.flags.json) {
      return {
        exitCode,
        stderr: formatEnvelopeJson(
          createErrorEnvelope(
            "status",
            statusResult.error.code,
            statusResult.error.message,
            exitCode,
            durationMs,
            statusResult.error.details
          )
        )
      };
    }
    return {
      exitCode,
      stderr: `Error [${statusResult.error.code}]: ${statusResult.error.message}`
    };
  }

  const status: SystemStatusSummary = statusResult.value;

  let auditEvents: readonly AuditEventSummary[] = [];
  if (args.flags.detailed) {
    const auditResult = await composition.listAuditEvents({ limit: 10 });
    if (auditResult.ok) {
      auditEvents = auditResult.value;
    }
  }

  if (args.flags.json) {
    const payload = args.flags.detailed
      ? { ...status, recentAuditEvents: auditEvents }
      : status;

    return {
      exitCode: EXIT_SUCCESS,
      stdout: formatEnvelopeJson(createSuccessEnvelope("status", payload, durationMs))
    };
  }

  const lines = [
    "RecruitOS System Status",
    "=======================",
    `Database:               ${status.databasePath}`,
    `Schema Version:         ${status.schemaVersion}`,
    `Active Run ID:          ${status.activeRunId}`,
    `Total Candidates:       ${status.candidateCount}`,
    `Open Resolution Tasks:  ${status.openTasksCount}`,
    `Pending Proposals:      ${status.pendingProposalsCount}`,
    `Recorded Audit Events:  ${status.auditEventsCount}`,
    `Known Limitations:      ${status.knownLimitationsCount}`,
    `Corpus Sealed:          ${status.isSealed ? "yes (immutable)" : "no"}`
  ];

  if (args.flags.detailed) {
    lines.push("");
    lines.push(`Recent Audit Events (${auditEvents.length}):`);
    if (auditEvents.length === 0) {
      lines.push("  (no audit events)");
    } else {
      const headers = ["Event ID", "Name", "Actor", "Time", "Payload Hash"];
      const rows = auditEvents.map((e: AuditEventSummary) => [
        e.auditEventId,
        e.eventName,
        e.actorId,
        new Date(e.occurredAt).toISOString(),
        e.payloadHash.slice(0, 16) + "..."
      ]);
      lines.push(formatTable(headers, rows));
    }
  }

  return {
    exitCode: EXIT_SUCCESS,
    stdout: lines.join("\n")
  };
}
