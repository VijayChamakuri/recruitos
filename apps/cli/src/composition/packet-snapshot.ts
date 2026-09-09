import { err, ok, type Result } from "@recruitos/core";
import {
  createRuntimeError,
  listResolutionTasks,
  readCandidatePacket,
  runDeferredTransaction,
  type CandidatePacketModel,
  type ResolutionTaskItem,
  type RuntimeDatabaseConnection,
  type RuntimeError
} from "@recruitos/runtime";

export type PacketSnapshotReadOptions = Readonly<{
  resultId?: string;
  afterSelectedRead?: () => void;
}>;

export type CandidatePacketSnapshot = Readonly<{
  selected: CandidatePacketModel;
  currentResultId: string;
  isHistoricalResult: boolean;
  tasks: readonly ResolutionTaskItem[];
}>;

function readOptions(options?: PacketSnapshotReadOptions):
  | { resultId: string }
  | undefined {
  if (options?.resultId === undefined) {
    return undefined;
  }
  return { resultId: options.resultId };
}

export function listAllResolutionTasksForCandidate(
  database: unknown,
  candidateId: string
): Result<readonly ResolutionTaskItem[], RuntimeError> {
  const items: ResolutionTaskItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const listed = listResolutionTasks(database, {
      candidateId,
      ...(cursor === undefined ? {} : { cursor })
    });
    if (!listed.ok) {
      return listed;
    }
    items.push(...listed.value.items);
    const nextCursor = listed.value.nextCursor;
    if (nextCursor === undefined) {
      return ok(items);
    }
    if (nextCursor === cursor || seenCursors.has(nextCursor)) {
      return err(
        createRuntimeError(
          "persistence_failed",
          "Resolution task pagination did not advance",
          false
        )
      );
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export function readCandidatePacketSnapshotParts(
  database: unknown,
  candidateId: string,
  options?: PacketSnapshotReadOptions
): Result<CandidatePacketSnapshot, RuntimeError> {
  const selected = readCandidatePacket(database, candidateId, readOptions(options));
  if (!selected.ok) {
    return selected;
  }
  options?.afterSelectedRead?.();
  const current = readCandidatePacket(database, candidateId);
  if (!current.ok) {
    return current;
  }
  const tasks = listAllResolutionTasksForCandidate(database, candidateId);
  if (!tasks.ok) {
    return tasks;
  }
  return ok({
    selected: selected.value,
    currentResultId: current.value.resultId,
    isHistoricalResult: selected.value.resultId !== current.value.resultId,
    tasks: tasks.value
  });
}

export function loadCandidatePacketSnapshot(
  connection: RuntimeDatabaseConnection,
  candidateId: string,
  options?: PacketSnapshotReadOptions
): Result<CandidatePacketSnapshot, RuntimeError> {
  return runDeferredTransaction(connection, (context) =>
    readCandidatePacketSnapshotParts(context.database, candidateId, options)
  );
}
