import type { CandidateSummary, ResolutionTaskSummary } from "@recruitos/cli";
import { err, ok, type Result } from "@recruitos/core";
import {
  createRuntimeError,
  listCandidates,
  listResolutionTasks,
  type CandidateSummaryItem,
  type ResolutionTaskItem,
  type RuntimeError
} from "@recruitos/runtime";

type Page<T> = Readonly<{
  items: readonly T[];
  nextCursor: string | undefined;
}>;

/**
 * Drains keyset pages until nextCursor is absent. Repeating or stuck cursors
 * fail closed, matching the packet snapshot guard in the CLI adapter.
 */
export function drainPagedRead<T>(
  loadPage: (cursor: string | undefined) => Result<Page<T>, RuntimeError>
): Result<readonly T[], RuntimeError> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const listed = loadPage(cursor);
    if (!listed.ok) {
      return listed;
    }
    items.push(...listed.value.items);
    const nextCursor = listed.value.nextCursor;
    if (nextCursor === undefined) {
      return ok(Object.freeze(items));
    }
    if (nextCursor === cursor || seenCursors.has(nextCursor)) {
      return err(
        createRuntimeError("persistence_failed", "Read-model pagination did not advance", false)
      );
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

function toCandidateSummary(item: CandidateSummaryItem): CandidateSummary {
  return {
    candidateId: item.candidateId,
    sourceKey: item.sourceKey,
    channel: item.channel,
    roleId: "role-default",
    roleTitle: "Staff Software Engineer",
    status: item.status,
    score: item.scoreBasisPoints !== null ? item.scoreBasisPoints / 100 : null,
    confidence:
      item.confidenceBasisPoints !== null ? item.confidenceBasisPoints / 10_000 : null,
    reasons: item.reasons,
    tasksCount: 0,
    sealed: item.isSealed,
    createdAt: item.createdAt
  };
}

function toResolutionTaskSummary(item: ResolutionTaskItem): ResolutionTaskSummary {
  return {
    resolutionTaskId: item.resolutionTaskId,
    candidateId: item.candidateId,
    candidateResultId: item.candidateResultId,
    reasonCode: item.reasonCode,
    status: item.status,
    taskOrdinal: item.taskOrdinal,
    ...(item.currentActionId ? { currentActionId: item.currentActionId } : {}),
    version: item.headVersion,
    createdAt: item.createdAt
  };
}

export function listAllCandidateSummaries(
  database: unknown
): Result<readonly CandidateSummary[], RuntimeError> {
  const pages = drainPagedRead((cursor) =>
    listCandidates(database, {
      limit: 50,
      ...(cursor === undefined ? {} : { cursor })
    })
  );
  if (!pages.ok) {
    return pages;
  }
  return ok(Object.freeze(pages.value.map(toCandidateSummary)));
}

export function listAllResolutionTaskSummaries(
  database: unknown
): Result<readonly ResolutionTaskSummary[], RuntimeError> {
  const pages = drainPagedRead((cursor) =>
    listResolutionTasks(database, {
      limit: 50,
      ...(cursor === undefined ? {} : { cursor })
    })
  );
  if (!pages.ok) {
    return pages;
  }
  return ok(Object.freeze(pages.value.map(toResolutionTaskSummary)));
}
