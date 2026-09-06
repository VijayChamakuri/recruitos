import {
  NonnegativeIntegerSchema,
  canonicalJsonStringify,
  err,
  ok,
  sha256Hex,
  type Result
} from "@recruitos/core";
import { z } from "zod";

import type { RuntimeDatabaseConnection } from "../db/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  CommandEnvelopeSchema,
  CommandExecutionMetadataSchema,
  CommandReceiptSchema,
  type CommandEnvelope,
  type CommandExecution,
  type CommandConflictReason,
  type CommandReceipt
} from "./schemas.js";
import {
  runImmediateTransaction,
  type ImmediateTransactionContext
} from "./transaction.js";

type CommandReceiptRow = Readonly<{
  commandId: unknown;
  commandName: unknown;
  actorId: unknown;
  expectedVersion: unknown;
  payloadHash: unknown;
  status: unknown;
  resultJson: unknown;
  resultHash: unknown;
  errorCode: unknown;
  errorMessage: unknown;
  createdAt: unknown;
  completedAt: unknown;
}>;

type CommandIdentity = Readonly<
  Pick<
    CommandReceipt,
    "commandId" | "actorId" | "expectedVersion" | "commandName" | "payloadHash"
  >
>;

export type ExecuteCommandOptions<
  TPayloadSchema extends z.ZodType,
  TResultSchema extends z.ZodType
> = Readonly<{
  connection: RuntimeDatabaseConnection;
  command: CommandEnvelope;
  completedAt: number;
  payloadSchema: TPayloadSchema;
  resultSchema: TResultSchema;
  readVersion: (
    context: ImmediateTransactionContext
  ) => Result<number, RuntimeError>;
  mutate: (
    context: ImmediateTransactionContext,
    payload: z.output<TPayloadSchema>
  ) => Result<z.input<TResultSchema>, RuntimeError>;
}>;

function persistenceFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function commandConflict(
  reason: CommandConflictReason,
  details?: Readonly<Record<string, string | number | boolean | null>>
): RuntimeError {
  return createRuntimeError("command_conflict", "Command cannot be applied", false, {
    reason,
    ...details
  });
}

function readReceipt(
  context: ImmediateTransactionContext,
  commandId: string
): Result<CommandReceipt | undefined, RuntimeError> {
  const row = context.nativeDatabase
    .prepare(
      `SELECT
        command_id AS commandId,
        command_name AS commandName,
        actor_id AS actorId,
        expected_version AS expectedVersion,
        payload_hash AS payloadHash,
        status,
        result_json AS resultJson,
        result_hash AS resultHash,
        error_code AS errorCode,
        error_message AS errorMessage,
        created_at AS createdAt,
        completed_at AS completedAt
       FROM command_receipt
       WHERE command_id = ?`
    )
    .get(commandId) as CommandReceiptRow | undefined;

  if (row === undefined) {
    return ok(undefined);
  }
  const parsed = CommandReceiptSchema.safeParse(row);
  return parsed.success
    ? ok(parsed.data)
    : err(persistenceFailure("Stored command receipt is invalid"));
}

function verifyIdentity(
  receipt: CommandReceipt,
  command: CommandIdentity
): Result<void, RuntimeError> {
  const mismatchedFields = [
    receipt.commandName === command.commandName ? undefined : "commandName",
    receipt.actorId === command.actorId ? undefined : "actorId",
    receipt.expectedVersion === command.expectedVersion ? undefined : "expectedVersion",
    receipt.payloadHash === command.payloadHash ? undefined : "payloadHash"
  ].filter((field): field is string => field !== undefined);

  return mismatchedFields.length === 0
    ? ok(undefined)
    : err(
        commandConflict("command_identity_mismatch", {
          mismatchedFields: mismatchedFields.join(",")
        })
      );
}

function parseStoredResult<TResultSchema extends z.ZodType>(
  receipt: CommandReceipt,
  resultSchema: TResultSchema
): Result<CommandExecution<z.output<TResultSchema>>, RuntimeError> {
  if (receipt.status !== "succeeded") {
    return err(
      commandConflict(
        receipt.status === "in_progress" ? "command_in_progress" : "command_failed"
      )
    );
  }

  const { resultJson, resultHash, completedAt } = receipt;

  let decoded: unknown;
  try {
    decoded = JSON.parse(resultJson);
  } catch {
    return err(persistenceFailure("Stored command result is not valid JSON"));
  }
  const canonical = canonicalJsonStringify(decoded);
  if (!canonical.ok || canonical.value !== resultJson || sha256Hex(resultJson) !== resultHash) {
    return err(persistenceFailure("Stored command result failed integrity validation"));
  }
  const parsed = resultSchema.safeParse(decoded);
  if (!parsed.success) {
    return err(persistenceFailure("Stored command result does not match its schema"));
  }

  return ok(
    Object.freeze({
      metadata: CommandExecutionMetadataSchema.parse({
        commandId: receipt.commandId,
        status: "succeeded",
        resultHash,
        completedAt,
        replayed: true
      }),
      result: parsed.data
    })
  );
}

function storeSuccess(
  context: ImmediateTransactionContext,
  command: CommandIdentity,
  resultJson: string,
  resultHash: string,
  completedAt: number
): void {
  context.nativeDatabase
    .prepare(
      `INSERT INTO command_receipt (
        command_id,
        command_name,
        actor_id,
        expected_version,
        payload_hash,
        status,
        result_json,
        result_hash,
        error_code,
        error_message,
        created_at,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, 'succeeded', ?, ?, NULL, NULL, ?, ?)`
    )
    .run(
      command.commandId,
      command.commandName,
      command.actorId,
      command.expectedVersion,
      command.payloadHash,
      resultJson,
      resultHash,
      completedAt,
      completedAt
    );
}

export function executeCommand<
  TPayloadSchema extends z.ZodType,
  TResultSchema extends z.ZodType
>(
  options: ExecuteCommandOptions<TPayloadSchema, TResultSchema>
): Result<CommandExecution<z.output<TResultSchema>>, RuntimeError> {
  if (typeof options !== "object" || options === null) {
    return err(persistenceFailure("Invalid command execution input"));
  }

  const optionRecord = options as unknown as Record<string, unknown>;
  if (
    typeof optionRecord.payloadSchema !== "object" ||
    optionRecord.payloadSchema === null ||
    typeof (optionRecord.payloadSchema as { safeParse?: unknown }).safeParse !== "function" ||
    typeof optionRecord.resultSchema !== "object" ||
    optionRecord.resultSchema === null ||
    typeof (optionRecord.resultSchema as { safeParse?: unknown }).safeParse !== "function" ||
    typeof optionRecord.readVersion !== "function" ||
    typeof optionRecord.mutate !== "function"
  ) {
    return err(persistenceFailure("Invalid command execution input"));
  }

  try {
    const command = CommandEnvelopeSchema.safeParse(optionRecord.command);
    const completedAt = NonnegativeIntegerSchema.safeParse(optionRecord.completedAt);
    if (!command.success || !completedAt.success) {
      return err(persistenceFailure("Invalid command execution input"));
    }
    const payload = options.payloadSchema.safeParse(command.data.payload);
    if (!payload.success) {
      return err(persistenceFailure("Invalid command payload"));
    }
    const canonicalPayload = canonicalJsonStringify(command.data.payload);
    if (!canonicalPayload.ok) {
      return err(persistenceFailure("Command payload is not canonical JSON"));
    }
    const commandIdentity: CommandIdentity = {
      commandId: command.data.commandId,
      actorId: command.data.actorId,
      expectedVersion: command.data.expectedVersion,
      commandName: command.data.commandName,
      payloadHash: sha256Hex(canonicalPayload.value)
    };

    return executeValidatedCommand(
      options,
      commandIdentity,
      payload.data,
      completedAt.data
    );
  } catch {
    return err(persistenceFailure("Invalid command execution input"));
  }
}

function executeValidatedCommand<
  TPayloadSchema extends z.ZodType,
  TResultSchema extends z.ZodType
>(
  options: ExecuteCommandOptions<TPayloadSchema, TResultSchema>,
  commandIdentity: CommandIdentity,
  payload: z.output<TPayloadSchema>,
  completedAt: number
): Result<CommandExecution<z.output<TResultSchema>>, RuntimeError> {
  return runImmediateTransaction(options.connection, (context) => {
    const storedReceipt = readReceipt(context, commandIdentity.commandId);
    if (!storedReceipt.ok) {
      return storedReceipt;
    }
    if (storedReceipt.value !== undefined) {
      const identity = verifyIdentity(storedReceipt.value, commandIdentity);
      return identity.ok
        ? parseStoredResult(storedReceipt.value, options.resultSchema)
        : identity;
    }

    const currentVersion = options.readVersion(context);
    if (!currentVersion.ok) {
      return currentVersion;
    }
    const parsedVersion = NonnegativeIntegerSchema.safeParse(currentVersion.value);
    if (!parsedVersion.success) {
      return err(persistenceFailure("Aggregate version is invalid"));
    }
    if (parsedVersion.data !== commandIdentity.expectedVersion) {
      return err(
        commandConflict("expected_version_mismatch", {
          expectedVersion: commandIdentity.expectedVersion,
          actualVersion: parsedVersion.data
        })
      );
    }

    const mutated = options.mutate(context, payload);
    if (!mutated.ok) {
      return mutated;
    }
    const canonical = canonicalJsonStringify(mutated.value);
    if (!canonical.ok) {
      return err(persistenceFailure("Command result is not canonical JSON"));
    }
    const parsedResult = options.resultSchema.safeParse(mutated.value);
    if (!parsedResult.success) {
      return err(persistenceFailure("Command result does not match its schema"));
    }
    const resultHash = sha256Hex(canonical.value);
    storeSuccess(
      context,
      commandIdentity,
      canonical.value,
      resultHash,
      completedAt
    );

    return ok(
      Object.freeze({
        metadata: CommandExecutionMetadataSchema.parse({
          commandId: commandIdentity.commandId,
          status: "succeeded",
          resultHash,
          completedAt,
          replayed: false
        }),
        result: parsedResult.data
      })
    );
  });
}
