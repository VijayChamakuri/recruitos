import { describe, expect, it } from "vitest";
import type { AuditEventSummary } from "@recruitos/cli";
import {
  AUDIT_APPEND_ONLY_DISCLAIMER,
  actorGlyph,
  formatAuditTimestamp,
  groupAuditEventsByCommand
} from "./audit-ledger.js";

function event(
  overrides: Partial<AuditEventSummary> & Pick<AuditEventSummary, "auditEventId">
): AuditEventSummary {
  return {
    eventName: "test.event",
    actorId: "system:runtime",
    occurredAt: 1_788_700_000_000,
    payloadHash: "a".repeat(64),
    commandId: null,
    eventOrdinal: null,
    ...overrides
  };
}

describe("audit ledger grouping", () => {
  it("groups consecutive events that share a command ID and leaves unlinked events alone", () => {
    const events = [
      event({ auditEventId: "e1", commandId: "cmd-1", eventOrdinal: 1 }),
      event({ auditEventId: "e2", commandId: "cmd-1", eventOrdinal: 0 }),
      event({ auditEventId: "e3", commandId: null }),
      event({ auditEventId: "e4", commandId: "cmd-2", eventOrdinal: 0 }),
      event({ auditEventId: "e5", commandId: "cmd-1", eventOrdinal: 2 })
    ];

    const groups = groupAuditEventsByCommand(events);
    expect(groups).toHaveLength(4);
    expect(groups[0]?.commandId).toBe("cmd-1");
    expect(groups[0]?.events.map((item) => item.auditEventId)).toEqual(["e1", "e2"]);
    expect(groups[1]?.commandId).toBeNull();
    expect(groups[1]?.events.map((item) => item.auditEventId)).toEqual(["e3"]);
    expect(groups[2]?.commandId).toBe("cmd-2");
    expect(groups[3]?.commandId).toBe("cmd-1");
    expect(groups[3]?.events.map((item) => item.auditEventId)).toEqual(["e5"]);
  });

  it("formats timestamps with milliseconds and distinguishes system actors by glyph", () => {
    expect(formatAuditTimestamp(1_788_700_000_482)).toBe("2026-09-06T13:06:40.482Z");
    expect(actorGlyph("system:runtime")).toBe("◆");
    expect(actorGlyph("human:operator")).toBe("●");
    expect(AUDIT_APPEND_ONLY_DISCLAIMER).toBe(
      "Append-only, enforced by database triggers. Not cryptographically tamper-proof. An administrator with file access can replace history."
    );
  });
});
