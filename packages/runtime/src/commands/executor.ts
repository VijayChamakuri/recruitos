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

export type ExecuteCommandOptions<TResult> = Readonly<{
  connection: RuntimeDatabaseConnection;
  command: CommandEnvelope;
  completedAt: number;
  resultSchema: z.ZodType<TResult>;
  readVersion: (
    context: ImmediateTransactionContext
  ) => Result<number, RuntimeError>;
  mutate: (
    context: ImmediateTransactionContext
  ) => Result<TResult, RuntimeError>;
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
  command: CommandEnvelope
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

function parseStoredResult<TResult>(
  receipt: CommandReceipt,
  resultSchema: z.ZodType<TResult>
): Result<CommandExecution<TResult>, RuntimeError> {
  if (receipt.status !== "succeeded") {
    return err(
      commandConflict(
        receipt.status === "in_progress" ? "command_in_progress" : "command_failed"
      )
    );
  }

  const resultJson = receipt.resultJson;
  const resultHash = receipt.resultHash;
  const completedAt = receipt.completedAt;
  if (resultJson === null || resultHash === null || completedAt === null) {
    return err(persistenceFailure("Stored successful command receipt is incomplete"));
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(resultJson);
  } catch {
    return err(persistenceFailure("Stored command result is not valid JSON"));
  }
  const parsed = resultSchema.safeParse(decoded);
  if (!parsed.success) {
    return err(persistenceFailure("Stored command result does not match its schema"));
  }
  const canonical = canonicalJsonStringify(parsed.data);
  if (!canonical.ok || canonical.value !== resultJson || sha256Hex(resultJson) !== resultHash) {
    return err(persistenceFailure("Stored command result failed integrity validation"));
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
  command: CommandEnvelope,
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

export function executeCommand<TResult>(
  options: ExecuteCommandOptions<TResult>
): Result<CommandExecution<TResult>, RuntimeError> {
  const command = CommandEnvelopeSchema.safeParse(options.command);
  const completedAt = NonnegativeIntegerSchema.safeParse(options.completedAt);
  if (!command.success || !completedAt.success) {
    return err(persistenceFailure("Invalid command execution input"));
  }

  return runImmediateTransaction(options.connection, (context) => {
    const storedReceipt = readReceipt(context, command.data.commandId);
    if (!storedReceipt.ok) {
      return storedReceipt;
    }
    if (storedReceipt.value !== undefined) {
      const identity = verifyIdentity(storedReceipt.value, command.data);
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
    if (parsedVersion.data !== command.data.expectedVersion) {
      return err(
        commandConflict("expected_version_mismatch", {
          expectedVersion: command.data.expectedVersion,
          actualVersion: parsedVersion.data
        })
      );
    }

    const mutated = options.mutate(context);
    if (!mutated.ok) {
      return mutated;
    }
    const parsedResult = options.resultSchema.safeParse(mutated.value);
    if (!parsedResult.success) {
      return err(persistenceFailure("Command result does not match its schema"));
    }
    const canonical = canonicalJsonStringify(parsedResult.data);
    if (!canonical.ok) {
      return err(persistenceFailure("Command result is not canonical JSON"));
    }
    const resultHash = sha256Hex(canonical.value);
    storeSuccess(
      context,
      command.data,
      canonical.value,
      resultHash,
      completedAt.data
    );

    return ok(
      Object.freeze({
        metadata: CommandExecutionMetadataSchema.parse({
          commandId: command.data.commandId,
          status: "succeeded",
          resultHash,
          completedAt: completedAt.data,
          replayed: false
        }),
        result: parsedResult.data
      })
    );
  });
}
