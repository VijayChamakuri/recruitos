import {
  ActorIdSchema,
  CommandIdSchema,
  NonnegativeIntegerSchema,
  Sha256HexSchema
} from "@recruitos/core";
import { z } from "zod";

export const CommandNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u)
  .brand<"CommandName">();

export type CommandName = z.infer<typeof CommandNameSchema>;

export const CommandStatusSchema = z.enum(["in_progress", "succeeded", "failed"]);
export type CommandStatus = z.infer<typeof CommandStatusSchema>;

export const CommandConflictReasonSchema = z.enum([
  "command_identity_mismatch",
  "command_in_progress",
  "command_failed",
  "expected_version_mismatch"
]);
export type CommandConflictReason = z.infer<typeof CommandConflictReasonSchema>;

export const CommandEnvelopeSchema = z
  .object({
    commandId: CommandIdSchema,
    actorId: ActorIdSchema,
    expectedVersion: NonnegativeIntegerSchema,
    commandName: CommandNameSchema,
    payload: z.unknown(),
    payloadHash: Sha256HexSchema.optional()
  })
  .strict();

export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

const commandReceiptIdentityShape = {
  commandId: CommandIdSchema,
  actorId: ActorIdSchema,
  expectedVersion: NonnegativeIntegerSchema,
  commandName: CommandNameSchema,
  payloadHash: Sha256HexSchema,
  createdAt: NonnegativeIntegerSchema
};

export const CommandReceiptSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...commandReceiptIdentityShape,
      status: z.literal("in_progress"),
      resultJson: z.null(),
      resultHash: z.null(),
      errorCode: z.null(),
      errorMessage: z.null(),
      completedAt: z.null()
    })
    .strict(),
  z
    .object({
      ...commandReceiptIdentityShape,
      status: z.literal("succeeded"),
      resultJson: z.string(),
      resultHash: Sha256HexSchema,
      errorCode: z.null(),
      errorMessage: z.null(),
      completedAt: NonnegativeIntegerSchema
    })
    .strict(),
  z
    .object({
      ...commandReceiptIdentityShape,
      status: z.literal("failed"),
      resultJson: z.null(),
      resultHash: z.null(),
      errorCode: z.string().min(1).max(128),
      errorMessage: z.string().min(1).max(500),
      completedAt: NonnegativeIntegerSchema
    })
    .strict()
]);

export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;

export const CommandExecutionMetadataSchema = z
  .object({
    commandId: CommandIdSchema,
    status: z.literal("succeeded"),
    resultHash: Sha256HexSchema,
    completedAt: NonnegativeIntegerSchema,
    replayed: z.boolean()
  })
  .strict();

export type CommandExecutionMetadata = z.infer<typeof CommandExecutionMetadataSchema>;

export type CommandExecution<TResult> = Readonly<{
  metadata: CommandExecutionMetadata;
  result: TResult;
}>;
