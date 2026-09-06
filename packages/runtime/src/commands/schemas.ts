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
    payloadHash: Sha256HexSchema
  })
  .strict();

export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

export const CommandReceiptSchema = z
  .object({
    commandId: CommandIdSchema,
    actorId: ActorIdSchema,
    expectedVersion: NonnegativeIntegerSchema,
    commandName: CommandNameSchema,
    payloadHash: Sha256HexSchema,
    status: CommandStatusSchema,
    resultJson: z.string().nullable(),
    resultHash: Sha256HexSchema.nullable(),
    errorCode: z.string().min(1).max(128).nullable(),
    errorMessage: z.string().min(1).max(500).nullable(),
    createdAt: NonnegativeIntegerSchema,
    completedAt: NonnegativeIntegerSchema.nullable()
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.status === "succeeded" &&
      (receipt.resultJson === null ||
        receipt.resultHash === null ||
        receipt.completedAt === null ||
        receipt.errorCode !== null ||
        receipt.errorMessage !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A successful command receipt must contain only success metadata"
      });
    }
    if (
      receipt.status === "in_progress" &&
      (receipt.resultJson !== null ||
        receipt.resultHash !== null ||
        receipt.errorCode !== null ||
        receipt.errorMessage !== null ||
        receipt.completedAt !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "An in-progress command receipt cannot contain terminal metadata"
      });
    }
    if (
      receipt.status === "failed" &&
      (receipt.resultJson !== null ||
        receipt.resultHash !== null ||
        receipt.errorCode === null ||
        receipt.errorMessage === null ||
        receipt.completedAt === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A failed command receipt must contain only failure metadata"
      });
    }
  });

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
