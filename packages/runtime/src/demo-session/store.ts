import { DemoSessionIdSchema, SYNTHETIC_DEMO_SESSION_ID, err, ok, type Result } from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  DemoSessionDraftSchema,
  DemoSessionSchema,
  RefreshDemoSessionHeartbeatInputSchema,
  demoSessionExpiryAt,
  isDemoSessionOwnershipShape,
  type DemoSession
} from "./schemas.js";

const preparedDemoSessions = new WeakSet<object>();

const TRANSACTION_REQUIRED = "Demo session rows require an active command transaction";

const DEMO_SESSION_SELECT = `SELECT
  demo_session_id AS demoSessionId,
  purpose,
  generation,
  web_owner AS webOwner,
  heartbeat_at AS heartbeatAt,
  expires_at AS expiresAt,
  seed_hash AS seedHash,
  version,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM demo_session`;

function persistenceFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function versionConflict(
  expectedVersion: number,
  actualVersion: number | null
): RuntimeError {
  return createRuntimeError("version_conflict", "Demo session version conflict", false, {
    table: "demo_session",
    identity: SYNTHETIC_DEMO_SESSION_ID,
    expectedVersion,
    actualVersion
  });
}

function validateContext(
  contextInput: unknown
): Result<ImmediateTransactionContext, RuntimeError> {
  if (typeof contextInput !== "object" || contextInput === null) {
    return err(persistenceFailure(TRANSACTION_REQUIRED));
  }
  const context = contextInput as Partial<ImmediateTransactionContext>;
  if (
    typeof context.nativeDatabase !== "object" ||
    context.nativeDatabase === null ||
    context.nativeDatabase.inTransaction !== true
  ) {
    return err(persistenceFailure(TRANSACTION_REQUIRED));
  }
  return ok(context as ImmediateTransactionContext);
}

function requirePrepared<TRecord>(
  registry: WeakSet<object>,
  preparedInput: unknown,
  message: string
): Result<TRecord, RuntimeError> {
  if (
    typeof preparedInput !== "object" ||
    preparedInput === null ||
    !registry.has(preparedInput)
  ) {
    return err(persistenceFailure(message));
  }
  return ok(preparedInput as TRecord);
}

function register<TRecord extends object>(registry: WeakSet<object>, record: TRecord): TRecord {
  const frozen = Object.freeze(record);
  registry.add(frozen);
  return frozen;
}

function parseStoredSession(row: unknown): Result<DemoSession, RuntimeError> {
  const session = DemoSessionSchema.safeParse(row);
  if (!session.success || !isDemoSessionOwnershipShape(session.data)) {
    return err(persistenceFailure("Stored demo session is invalid"));
  }
  return ok(Object.freeze(session.data));
}

function readStoredSession(
  context: ImmediateTransactionContext
): Result<DemoSession | undefined, RuntimeError> {
  const row = context.nativeDatabase
    .prepare(`${DEMO_SESSION_SELECT} WHERE demo_session_id = ?`)
    .get(SYNTHETIC_DEMO_SESSION_ID);
  if (row === undefined) {
    return ok(undefined);
  }
  return parseStoredSession(row);
}

export function prepareDemoSession(draftInput: unknown): Result<DemoSession, RuntimeError> {
  try {
    const draft = DemoSessionDraftSchema.safeParse(draftInput);
    if (!draft.success || !isDemoSessionOwnershipShape(draft.data)) {
      return err(persistenceFailure("Invalid demo session input"));
    }
    return ok(register(preparedDemoSessions, DemoSessionSchema.parse(draft.data)));
  } catch {
    return err(persistenceFailure("Demo session preparation failed"));
  }
}

export function insertDemoSession(
  contextInput: unknown,
  preparedInput: unknown
): Result<DemoSession, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<DemoSession>(
      preparedDemoSessions,
      preparedInput,
      "Invalid prepared demo session"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const session = prepared.value;

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO demo_session (
          demo_session_id,
          purpose,
          generation,
          web_owner,
          heartbeat_at,
          expires_at,
          seed_hash,
          version,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.demoSessionId,
        session.purpose,
        session.generation,
        session.webOwner,
        session.heartbeatAt,
        session.expiresAt,
        session.seedHash,
        session.version,
        session.createdAt,
        session.updatedAt
      );

    return ok(session);
  } catch {
    return err(persistenceFailure("Demo session insert failed"));
  }
}

export function readDemoSession(
  contextInput: unknown,
  demoSessionIdInput: unknown = SYNTHETIC_DEMO_SESSION_ID
): Result<DemoSession | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const demoSessionId = DemoSessionIdSchema.safeParse(demoSessionIdInput);
    if (!demoSessionId.success) {
      return err(persistenceFailure("Invalid demo session ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(`${DEMO_SESSION_SELECT} WHERE demo_session_id = ?`)
      .get(demoSessionId.data);
    if (row === undefined) {
      return ok(undefined);
    }
    return parseStoredSession(row);
  } catch {
    return err(persistenceFailure("Demo session read failed"));
  }
}

export function refreshDemoSessionHeartbeat(
  contextInput: unknown,
  input: unknown
): Result<DemoSession, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const parsed = RefreshDemoSessionHeartbeatInputSchema.safeParse(input);
    const expiresAt =
      parsed.success ? demoSessionExpiryAt(parsed.data.heartbeatAt) : null;
    if (!parsed.success || expiresAt === null) {
      return err(persistenceFailure("Invalid demo session heartbeat input"));
    }
    const refresh = parsed.data;
    const current = readStoredSession(context.value);
    if (!current.ok) {
      return current;
    }
    if (current.value === undefined) {
      return err(createRuntimeError("not_found", "Demo session is missing", false, {
        table: "demo_session",
        identity: SYNTHETIC_DEMO_SESSION_ID
      }));
    }
    const session = current.value;
    if (session.version !== refresh.expectedVersion) {
      return err(versionConflict(refresh.expectedVersion, session.version));
    }

    const leaseActive =
      session.webOwner !== null &&
      session.expiresAt !== null &&
      session.expiresAt > refresh.heartbeatAt;
    if (leaseActive && session.webOwner !== refresh.webOwner) {
      return err(
        createRuntimeError("demo_session_active", "Demo session web owner is active", false, {
          table: "demo_session",
          identity: SYNTHETIC_DEMO_SESSION_ID,
          webOwner: session.webOwner
        })
      );
    }

    context.value.nativeDatabase
      .prepare(
        `UPDATE demo_session
         SET web_owner = ?,
             heartbeat_at = ?,
             expires_at = ?,
             version = ?,
             updated_at = ?
         WHERE demo_session_id = ?`
      )
      .run(
        refresh.webOwner,
        refresh.heartbeatAt,
        expiresAt,
        session.version + 1,
        refresh.heartbeatAt,
        session.demoSessionId
      );

    const stored = readStoredSession(context.value);
    if (!stored.ok) {
      return stored;
    }
    if (stored.value === undefined) {
      return err(persistenceFailure("Demo session is missing after heartbeat"));
    }
    return ok(stored.value);
  } catch {
    return err(persistenceFailure("Demo session heartbeat failed"));
  }
}
