import {
  ActorIdSchema,
  AuditEventIdSchema,
  CommandIdSchema,
  NonnegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256HexSchema
} from "@recruitos/core";
import { z } from "zod";

export const AuditEventNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u)
  .brand<"AuditEventName">();

export type AuditEventName = z.infer<typeof AuditEventNameSchema>;

const auditIdentityShape = {
  auditEventId: AuditEventIdSchema,
  commandId: CommandIdSchema.nullable(),
  eventOrdinal: NonnegativeIntegerSchema.nullable(),
  actorId: ActorIdSchema,
  actorDisplayName: z.string().min(1).max(200),
  eventName: AuditEventNameSchema,
  eventVersion: PositiveIntegerSchema,
  occurredAt: NonnegativeIntegerSchema
};

function commandLinkageIsValid(value: {
  commandId: string | null;
  eventOrdinal: number | null;
}): boolean {
  return (value.commandId === null) === (value.eventOrdinal === null);
}

export const AuditEventDraftSchema = z
  .object({
    ...auditIdentityShape,
    payload: z.unknown()
  })
  .strict()
  .refine(commandLinkageIsValid, {
    message: "Command ID and event ordinal must either both be present or both be absent"
  });

export type AuditEventDraft = z.infer<typeof AuditEventDraftSchema>;

export const AuditEventSchema = z
  .object({
    ...auditIdentityShape,
    payloadJson: z.string(),
    payloadHash: Sha256HexSchema,
    recordedAt: NonnegativeIntegerSchema
  })
  .strict()
  .refine(commandLinkageIsValid, {
    message: "Command ID and event ordinal must either both be present or both be absent"
  })
  .refine((event) => event.recordedAt >= event.occurredAt, {
    message: "Recorded time cannot precede occurred time",
    path: ["recordedAt"]
  });

export type AuditEvent = z.infer<typeof AuditEventSchema>;
