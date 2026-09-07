import { err, ok, type Result } from "@recruitos/core";

import {
  createFixtureExtractionAdapter,
  createSyntheticCandidateSourceAdapter,
  type CandidateSourceAdapter,
  type ExtractionAdapter
} from "../adapters/index.js";
import {
  openRuntimeDatabase,
  type RuntimeDatabaseConnection,
  type RuntimeDatabaseOptions
} from "../db/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  createIncrementingIdGenerator,
  systemClock,
  type Clock,
  type IdGenerator
} from "./ports.js";

const DEFAULT_ID_PREFIX = "runtime";

/**
 * The one shared runtime composition. CLI, web, and eval entry points build this
 * and reach the database connection, clock, id generator, and adapters through
 * it rather than constructing their own.
 */
export type RuntimeComposition = Readonly<{
  connection: RuntimeDatabaseConnection;
  clock: Clock;
  idGenerator: IdGenerator;
  extraction: ExtractionAdapter;
  candidateSource: CandidateSourceAdapter;
  close: () => Result<void, RuntimeError>;
}>;

export type CreateRuntimeOptions = Readonly<{
  /** Database connection options, validated by the connection factory. */
  database: RuntimeDatabaseOptions;
  /** Run migrations on open. Defaults to true. */
  migrate?: boolean;
  /** Time source. Defaults to the system clock. */
  clock?: Clock;
  /** Identifier source. Defaults to a process-local incrementing generator. */
  idGenerator?: IdGenerator;
  /** Extraction adapter. Defaults to the fixture adapter. */
  extraction?: ExtractionAdapter;
  /** Candidate source adapter. Defaults to the synthetic adapter. */
  candidateSource?: CandidateSourceAdapter;
}>;

function compositionFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createRuntime(
  options: CreateRuntimeOptions
): Result<RuntimeComposition, RuntimeError> {
  if (!isObject(options)) {
    return err(compositionFailure("Invalid runtime composition options"));
  }

  const clock = options.clock === undefined ? systemClock : options.clock;
  if (!isObject(clock) || typeof clock.now !== "function") {
    return err(compositionFailure("Invalid runtime clock"));
  }

  const idGenerator =
    options.idGenerator === undefined
      ? createIncrementingIdGenerator(DEFAULT_ID_PREFIX)
      : options.idGenerator;
  if (!isObject(idGenerator) || typeof idGenerator.next !== "function") {
    return err(compositionFailure("Invalid runtime id generator"));
  }

  if (options.extraction !== undefined && !isObject(options.extraction)) {
    return err(compositionFailure("Invalid extraction adapter"));
  }
  if (options.candidateSource !== undefined && !isObject(options.candidateSource)) {
    return err(compositionFailure("Invalid candidate source adapter"));
  }

  const extraction: ExtractionAdapter =
    options.extraction === undefined
      ? createFixtureExtractionAdapter()
      : options.extraction;
  const candidateSource: CandidateSourceAdapter =
    options.candidateSource === undefined
      ? createSyntheticCandidateSourceAdapter()
      : options.candidateSource;

  const opened = openRuntimeDatabase(options.database);
  if (!opened.ok) {
    return opened;
  }
  const connection = opened.value;

  if (options.migrate !== false) {
    const migrated = connection.migrate();
    if (!migrated.ok) {
      connection.close();
      return migrated;
    }
  }

  return ok(
    Object.freeze({
      connection,
      clock: clock as Clock,
      idGenerator: idGenerator as IdGenerator,
      extraction,
      candidateSource,
      close: (): Result<void, RuntimeError> => connection.close()
    })
  );
}
