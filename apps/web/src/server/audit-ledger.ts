import type { AuditEventSummary } from "@recruitos/cli";

export type AuditEventCommandGroup = Readonly<{
  commandId: string | null;
  events: readonly AuditEventSummary[];
}>;

/**
 * Groups consecutive events that share a non-null command ID. Events without a
 * command ID stay ungrouped. The input order is preserved.
 */
export function groupAuditEventsByCommand(
  events: readonly AuditEventSummary[]
): readonly AuditEventCommandGroup[] {
  const groups: AuditEventCommandGroup[] = [];
  for (const event of events) {
    const current = groups[groups.length - 1];
    if (
      event.commandId !== null &&
      current !== undefined &&
      current.commandId === event.commandId
    ) {
      groups[groups.length - 1] = {
        commandId: current.commandId,
        events: [...current.events, event]
      };
      continue;
    }
    groups.push({
      commandId: event.commandId,
      events: [event]
    });
  }
  return Object.freeze(groups);
}

export function actorGlyph(actorId: string): string {
  return actorId === "system:runtime" ? "◆" : "●";
}

export function formatAuditTimestamp(occurredAt: number): string {
  return new Date(occurredAt).toISOString();
}

export const AUDIT_APPEND_ONLY_DISCLAIMER =
  "Append-only, enforced by database triggers. Not cryptographically tamper-proof. An administrator with file access can replace history.";
