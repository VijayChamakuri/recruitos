import { existsSync, statSync } from "node:fs";
import {
  createDefaultRuntimeComposition,
  RuntimeRecruitosComposition,
  type RecruitosComposition
} from "@recruitos/cli";
import { err, ok, type Result } from "@recruitos/core";
import type { RuntimeComposition } from "@recruitos/runtime/composition";

type CompositionFailure = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
}>;

let activeComposition: RecruitosComposition | null = null;
let activeRuntime: RuntimeComposition | null = null;

function databaseOpenError(message: string): CompositionFailure {
  return {
    code: "database_not_found",
    message,
    retryable: false
  };
}

/**
 * Opens a RecruitOS composition against an already-prepared SQLite file.
 * An explicit path never falls back to StubRecruitosComposition. A missing
 * path fails closed instead of creating an empty database.
 */
export function openExplicitDatabaseComposition(
  databasePath: string
): Result<RecruitosComposition, CompositionFailure> {
  if (!existsSync(databasePath)) {
    return err(databaseOpenError(`Database not found: ${databasePath}`));
  }
  try {
    if (!statSync(databasePath).isFile()) {
      return err(databaseOpenError(`Database path is not a file: ${databasePath}`));
    }
  } catch (error) {
    return err(
      databaseOpenError(
        `Database path could not be opened: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }

  const result = createDefaultRuntimeComposition({
    database: { filename: databasePath }
  });
  if (!result.ok) {
    return result;
  }
  return ok(result.value);
}

export function getServerComposition(): Result<RecruitosComposition, CompositionFailure> {
  if (activeComposition === null) {
    return err({
      code: "composition_unconfigured",
      message:
        "Web composition is not configured. Start the server with --db or DATABASE_PATH pointing at a prepared database.",
      retryable: false
    });
  }
  return ok(activeComposition);
}

export function setServerComposition(composition: RecruitosComposition): void {
  activeComposition = composition;
  if (composition instanceof RuntimeRecruitosComposition) {
    activeRuntime = composition.runtime;
  }
}

export function resetServerComposition(): void {
  activeComposition = null;
  activeRuntime = null;
}

export function getServerRuntime(): RuntimeComposition | null {
  return activeRuntime;
}

export function setServerRuntime(runtime: RuntimeComposition): void {
  activeRuntime = runtime;
}
