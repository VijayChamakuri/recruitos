import {
  NonnegativeIntegerSchema,
  canonicalJsonStringify,
  err,
  ok,
  sha256Hex,
  type Result
} from "@recruitos/core";
import type { z } from "zod";

import {
  CommandEnvelopeSchema,
  executeCommand,
  type CommandEnvelope,
  type CommandExecution
} from "../commands/index.js";
import type { ImmediateTransactionContext } from "../commands/index.js";
import type { RuntimeComposition } from "../composition/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";

/**
 * The standard return of a mutation use case: a replay-safe command execution,
 * or a typed runtime failure.
 */
export type UseCaseResult<TResult> = Result<
  CommandExecution<TResult>,
  RuntimeError
>;

/** The slice of the runtime composition a mutation use case needs. */
export type UseCaseComposition = Pick<
  RuntimeComposition,
  "connection" | "clock" | "idGenerator"
>;

export type BuildCommandEnvelopeInput = Readonly<{
  commandId: string;
  actorId: string;
  commandName: string;
  expectedVersion: number;
  payload: unknown;
}>;

function contractFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Validates the identity fields and attaches the canonical payload hash. The
 * command executor recomputes the hash itself, so this is for callers that need
 * the resolved envelope before running it.
 */
export function buildCommandEnvelope(
  input: BuildCommandEnvelopeInput
): Result<CommandEnvelope, RuntimeError> {
  if (!isObject(input)) {
    return err(contractFailure("Invalid command envelope input"));
  }
  const canonicalPayload = canonicalJsonStringify(input.payload);
  if (!canonicalPayload.ok) {
    return err(contractFailure("Command payload is not canonical JSON"));
  }
  const parsed = CommandEnvelopeSchema.safeParse({
    commandId: input.commandId,
    actorId: input.actorId,
    expectedVersion: input.expectedVersion,
    commandName: input.commandName,
    payload: input.payload,
    payloadHash: sha256Hex(canonicalPayload.value)
  });
  if (!parsed.success) {
    return err(contractFailure("Invalid command envelope"));
  }
  return ok(Object.freeze(parsed.data));
}

export type RunUseCaseCommandOptions<
  TPayloadSchema extends z.ZodType,
  TResultSchema extends z.ZodType
> = Readonly<{
  actorId: string;
  commandName: string;
  expectedVersion: number;
  payload: z.input<TPayloadSchema>;
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

/**
 * Runs one mutation as a command: mints a command id from the composition's id
 * generator, stamps the completion time from its clock, builds the envelope, and
 * delegates to the transactional executor. Replay, expected-version checks, and
 * receipt storage all come from the executor.
 */
export function runUseCaseCommand<
  TPayloadSchema extends z.ZodType,
  TResultSchema extends z.ZodType
>(
  composition: UseCaseComposition,
  options: RunUseCaseCommandOptions<TPayloadSchema, TResultSchema>
): UseCaseResult<z.output<TResultSchema>> {
  if (!isObject(composition)) {
    return err(contractFailure("Invalid runtime composition"));
  }
  const { connection, clock, idGenerator } = composition;
  if (!isObject(connection)) {
    return err(contractFailure("Invalid runtime composition"));
  }
  if (!isObject(clock) || typeof clock.now !== "function") {
    return err(contractFailure("Invalid runtime clock"));
  }
  if (!isObject(idGenerator) || typeof idGenerator.next !== "function") {
    return err(contractFailure("Invalid runtime id generator"));
  }

  const commandId = idGenerator.next();
  if (typeof commandId !== "string") {
    return err(contractFailure("Id generator did not return a string"));
  }

  const completedAt = clock.now();
  if (!NonnegativeIntegerSchema.safeParse(completedAt).success) {
    return err(contractFailure("Clock did not return a valid completion time"));
  }

  const envelope = buildCommandEnvelope({
    commandId,
    actorId: options.actorId,
    commandName: options.commandName,
    expectedVersion: options.expectedVersion,
    payload: options.payload
  });
  if (!envelope.ok) {
    return envelope;
  }

  return executeCommand({
    connection,
    command: envelope.value,
    completedAt: completedAt as number,
    payloadSchema: options.payloadSchema,
    resultSchema: options.resultSchema,
    readVersion: options.readVersion,
    mutate: options.mutate
  });
}
