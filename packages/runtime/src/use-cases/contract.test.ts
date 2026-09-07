import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createIncrementingIdGenerator,
  createRuntime,
  fixedClock,
  systemClock
} from "../composition/index.js";
import { ok, type Result } from "@recruitos/core";
import type { ImmediateTransactionContext } from "../commands/index.js";
import type { RuntimeError } from "../errors/index.js";
import {
  buildCommandEnvelope,
  runUseCaseCommand,
  type UseCaseComposition
} from "./contract.js";

const temporaryDirectories: string[] = [];
const EchoSchema = z.object({ value: z.string() }).strict();

async function migratedComposition(): Promise<UseCaseComposition> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-usecase-"));
  temporaryDirectories.push(directory);
  const result = createRuntime({
    database: { filename: join(directory, "runtime.db") }
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

const echoMutate = (
  _context: ImmediateTransactionContext,
  payload: z.output<typeof EchoSchema>
): Result<z.input<typeof EchoSchema>, RuntimeError> => ok(payload);

const readVersionZero = (): Result<number, RuntimeError> => ok(0);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("buildCommandEnvelope", () => {
  const base = {
    commandId: "command-0000000001",
    actorId: "actor-1",
    commandName: "candidate.import",
    expectedVersion: 0,
    payload: { value: "x" }
  };

  it("attaches the canonical payload hash and freezes the envelope", () => {
    const result = buildCommandEnvelope(base);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.commandName).toBe("candidate.import");
    expect(result.value.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("rejects a non-object input", () => {
    expect(buildCommandEnvelope(null as never)).toMatchObject({
      ok: false,
      error: { message: "Invalid command envelope input" }
    });
  });

  it("rejects a payload that is not canonical JSON", () => {
    expect(
      buildCommandEnvelope({ ...base, payload: { value: 1n } })
    ).toMatchObject({
      ok: false,
      error: { message: "Command payload is not canonical JSON" }
    });
  });

  it("rejects invalid identity fields", () => {
    expect(
      buildCommandEnvelope({ ...base, commandName: "Bad Name" })
    ).toMatchObject({ ok: false, error: { message: "Invalid command envelope" } });
    expect(
      buildCommandEnvelope({ ...base, expectedVersion: -1 })
    ).toMatchObject({ ok: false, error: { message: "Invalid command envelope" } });
  });
});

describe("runUseCaseCommand", () => {
  const options = {
    actorId: "actor-1",
    commandName: "candidate.import",
    expectedVersion: 0,
    payload: { value: "hello" },
    payloadSchema: EchoSchema,
    resultSchema: EchoSchema,
    readVersion: readVersionZero,
    mutate: echoMutate
  };

  it("mints an id, stamps the clock, and runs the command", async () => {
    const composition = await migratedComposition();
    const result = runUseCaseCommand(composition, options);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.metadata.replayed).toBe(false);
    expect(result.value.result).toEqual({ value: "hello" });
  });

  it("passes an executor conflict straight back to the caller", async () => {
    const composition = await migratedComposition();
    const result = runUseCaseCommand(composition, {
      ...options,
      expectedVersion: 1
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "command_conflict" }
    });
  });

  it("rejects a non-object composition", () => {
    expect(
      runUseCaseCommand(null as unknown as UseCaseComposition, options)
    ).toMatchObject({ ok: false, error: { message: "Invalid runtime composition" } });
  });

  it("rejects a missing connection", () => {
    expect(
      runUseCaseCommand(
        {
          connection: null,
          clock: systemClock,
          idGenerator: createIncrementingIdGenerator("cmd")
        } as unknown as UseCaseComposition,
        options
      )
    ).toMatchObject({ ok: false, error: { message: "Invalid runtime composition" } });
  });

  it("rejects an invalid clock", async () => {
    const composition = await migratedComposition();
    expect(
      runUseCaseCommand(
        { ...composition, clock: { now: 5 } as unknown as never },
        options
      )
    ).toMatchObject({ ok: false, error: { message: "Invalid runtime clock" } });
  });

  it("rejects an invalid id generator", async () => {
    const composition = await migratedComposition();
    expect(
      runUseCaseCommand(
        { ...composition, idGenerator: { next: 5 } as unknown as never },
        options
      )
    ).toMatchObject({
      ok: false,
      error: { message: "Invalid runtime id generator" }
    });
  });

  it("rejects an id generator that does not return a string", async () => {
    const composition = await migratedComposition();
    expect(
      runUseCaseCommand(
        {
          ...composition,
          idGenerator: { next: () => 5 as unknown as string }
        },
        options
      )
    ).toMatchObject({
      ok: false,
      error: { message: "Id generator did not return a string" }
    });
  });

  it("rejects a clock that returns an invalid completion time", async () => {
    const composition = await migratedComposition();
    expect(
      runUseCaseCommand({ ...composition, clock: { now: () => -1 } }, options)
    ).toMatchObject({
      ok: false,
      error: { message: "Clock did not return a valid completion time" }
    });
  });

  it("returns the envelope failure when identity fields are invalid", async () => {
    const composition = await migratedComposition();
    expect(
      runUseCaseCommand(
        { ...composition, clock: fixedClock(1_788_700_000_100) },
        { ...options, commandName: "Bad Name" }
      )
    ).toMatchObject({ ok: false, error: { message: "Invalid command envelope" } });
  });
});
