import type { SystemStatusSummary } from "@recruitos/cli";
import { err, ok, type Result } from "@recruitos/core";

type NativePrepare = (sql: string) => {
  all: (...parameters: readonly unknown[]) => unknown;
  get: (...parameters: readonly unknown[]) => unknown;
};

type WebFailure = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
}>;

type PersistedTriageRun = Readonly<{
  runId: string;
  sealed: boolean;
}>;

function nativePrepare(database: unknown): NativePrepare | null {
  if (typeof database !== "object" || database === null) {
    return null;
  }
  const candidate =
    "$client" in database ? (database as { $client: unknown }).$client : database;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("prepare" in candidate) ||
    typeof (candidate as { prepare: unknown }).prepare !== "function"
  ) {
    return null;
  }
  return (candidate as { prepare: NativePrepare }).prepare.bind(candidate);
}

function failure(message: string): WebFailure {
  return {
    code: "persistence_failed",
    message,
    retryable: false
  };
}

/**
 * Reads the newest persisted triage_run. Seal is the run's seal_id, not the
 * presence of any candidate_result_seal row.
 */
export function readPersistedTriageRun(
  database: unknown
): Result<PersistedTriageRun | null, WebFailure> {
  const prepare = nativePrepare(database);
  if (prepare === null) {
    return err(failure("Database client is unavailable for triage run read"));
  }
  try {
    const rows = prepare(
      `SELECT triage_run_id AS runId, seal_id AS sealId
       FROM triage_run
       ORDER BY created_at DESC, triage_run_id DESC`
    ).all();
    if (!Array.isArray(rows)) {
      return err(failure("Triage run query returned a non-list"));
    }
    if (rows.length === 0) {
      return ok(null);
    }
    const row = rows[0] as { runId?: unknown; sealId?: unknown };
    if (typeof row.runId !== "string" || row.runId.length === 0) {
      return err(failure("Stored triage run is missing an id"));
    }
    const sealed = typeof row.sealId === "string" && row.sealId.length > 0;
    return ok({ runId: row.runId, sealed });
  } catch (error) {
    return err(
      failure(
        `Triage run read failed: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

export function overlayPersistedRunStatus(
  status: SystemStatusSummary,
  database: unknown
): Result<SystemStatusSummary, WebFailure> {
  const persisted = readPersistedTriageRun(database);
  if (!persisted.ok) {
    return persisted;
  }
  if (persisted.value === null) {
    return ok({
      ...status,
      activeRunId: "none",
      isSealed: false
    });
  }
  return ok({
    ...status,
    activeRunId: persisted.value.runId,
    isSealed: persisted.value.sealed
  });
}
