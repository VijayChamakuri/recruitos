import { err, ok, type Result } from "@recruitos/core";
import { z } from "zod";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import { SqlIdentifierSchema, quoteSqlIdentifier } from "./sql.js";

/**
 * A mutable head is the one row per subject that is allowed to move. Its
 * identity never changes; the pointer swings to whichever immutable row is
 * current, and the version increments on every swing. Writers state the version
 * they read, and a swing that loses the race returns `version_conflict` rather
 * than overwriting the winner.
 *
 * This module owns the pattern, not any particular head. Callers supply the
 * table and column names; nothing here knows what a head points at.
 */

export const FIRST_MUTABLE_HEAD_VERSION = 1;

const MAXIMUM_MUTABLE_HEAD_VERSION = Number.MAX_SAFE_INTEGER - 1;

export type MutableHeadDefinition = Readonly<{
  tableName: string;
  identityColumn: string;
  pointerColumn: string;
  versionColumn: string;
  /** DDL for a head table shaped exactly the way these statements expect. */
  createTableSql: string;
}>;

export type MutableHeadRow = Readonly<{
  identity: string;
  pointer: string;
  version: number;
}>;

const MutableHeadConfigSchema = z
  .object({
    tableName: SqlIdentifierSchema,
    identityColumn: SqlIdentifierSchema,
    pointerColumn: SqlIdentifierSchema,
    versionColumn: SqlIdentifierSchema
  })
  .strict()
  .refine(
    (config) =>
      new Set([config.identityColumn, config.pointerColumn, config.versionColumn])
        .size === 3,
    "Mutable head columns must be distinct"
  );

export type MutableHeadConfig = z.input<typeof MutableHeadConfigSchema>;

const MutableHeadKeySchema = z.string().min(1).max(200);

const MutableHeadVersionSchema = z
  .number()
  .int()
  .min(FIRST_MUTABLE_HEAD_VERSION)
  .max(MAXIMUM_MUTABLE_HEAD_VERSION);

const MutableHeadRowSchema = z
  .object({
    identity: MutableHeadKeySchema,
    pointer: MutableHeadKeySchema,
    version: MutableHeadVersionSchema
  })
  .strict();

const InitializeInputSchema = z
  .object({ identity: MutableHeadKeySchema, pointer: MutableHeadKeySchema })
  .strict();

const CompareAndSetInputSchema = z
  .object({
    identity: MutableHeadKeySchema,
    pointer: MutableHeadKeySchema,
    expectedVersion: MutableHeadVersionSchema
  })
  .strict();

const definitions = new WeakSet<object>();

function persistenceFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function versionConflict(
  definition: MutableHeadDefinition,
  identity: string,
  expectedVersion: number,
  actualVersion: number | null
): RuntimeError {
  return createRuntimeError("version_conflict", "Mutable head version conflict", false, {
    table: definition.tableName,
    identity,
    expectedVersion,
    actualVersion
  });
}

function validateContext(
  contextInput: unknown
): Result<ImmediateTransactionContext, RuntimeError> {
  if (typeof contextInput !== "object" || contextInput === null) {
    return err(persistenceFailure("Mutable heads require an active command transaction"));
  }
  const context = contextInput as Partial<ImmediateTransactionContext>;
  if (
    typeof context.nativeDatabase !== "object" ||
    context.nativeDatabase === null ||
    context.nativeDatabase.inTransaction !== true
  ) {
    return err(persistenceFailure("Mutable heads require an active command transaction"));
  }
  return ok(context as ImmediateTransactionContext);
}

function requireDefinition(
  definitionInput: unknown
): Result<MutableHeadDefinition, RuntimeError> {
  if (
    typeof definitionInput !== "object" ||
    definitionInput === null ||
    !definitions.has(definitionInput)
  ) {
    return err(persistenceFailure("Invalid mutable head definition"));
  }
  return ok(definitionInput as MutableHeadDefinition);
}

function selectSql(definition: MutableHeadDefinition): string {
  return `SELECT
      ${quoteSqlIdentifier(definition.identityColumn)} AS identity,
      ${quoteSqlIdentifier(definition.pointerColumn)} AS pointer,
      ${quoteSqlIdentifier(definition.versionColumn)} AS version
    FROM ${quoteSqlIdentifier(definition.tableName)}
    WHERE ${quoteSqlIdentifier(definition.identityColumn)} = ?`;
}

/**
 * Validates a head shape and returns the only definition value the statements
 * below will accept. Registering the frozen result means a caller cannot smuggle
 * unvalidated identifiers past the schema by hand-building the definition.
 */
export function defineMutableHead(
  configInput: unknown
): Result<MutableHeadDefinition, RuntimeError> {
  const config = MutableHeadConfigSchema.safeParse(configInput);
  if (!config.success) {
    return err(persistenceFailure("Invalid mutable head configuration"));
  }

  const table = quoteSqlIdentifier(config.data.tableName);
  const identity = quoteSqlIdentifier(config.data.identityColumn);
  const pointer = quoteSqlIdentifier(config.data.pointerColumn);
  const version = quoteSqlIdentifier(config.data.versionColumn);

  const definition = Object.freeze({
    tableName: config.data.tableName,
    identityColumn: config.data.identityColumn,
    pointerColumn: config.data.pointerColumn,
    versionColumn: config.data.versionColumn,
    createTableSql: `CREATE TABLE ${table} (
      ${identity} TEXT PRIMARY KEY NOT NULL,
      ${pointer} TEXT NOT NULL,
      ${version} INTEGER NOT NULL,
      CONSTRAINT "${config.data.tableName}_${config.data.versionColumn}_positive" CHECK(${version} >= ${FIRST_MUTABLE_HEAD_VERSION})
    ) STRICT`
  });

  definitions.add(definition);
  return ok(definition);
}

export function readMutableHead(
  contextInput: unknown,
  definitionInput: unknown,
  identityInput: unknown
): Result<MutableHeadRow | undefined, RuntimeError> {
  const context = validateContext(contextInput);
  if (!context.ok) {
    return context;
  }
  const definition = requireDefinition(definitionInput);
  if (!definition.ok) {
    return definition;
  }
  const identity = MutableHeadKeySchema.safeParse(identityInput);
  if (!identity.success) {
    return err(persistenceFailure("Invalid mutable head identity"));
  }

  try {
    const row = context.value.nativeDatabase
      .prepare(selectSql(definition.value))
      .get(identity.data);
    if (row === undefined) {
      return ok(undefined);
    }

    const parsed = MutableHeadRowSchema.safeParse(row);
    if (!parsed.success) {
      return err(persistenceFailure("Stored mutable head row is invalid"));
    }
    return ok(Object.freeze(parsed.data));
  } catch {
    return err(persistenceFailure("Mutable head read failed"));
  }
}

/** Creates the head at version 1. A head that already exists is a failure. */
export function initializeMutableHead(
  contextInput: unknown,
  definitionInput: unknown,
  headInput: unknown
): Result<MutableHeadRow, RuntimeError> {
  const context = validateContext(contextInput);
  if (!context.ok) {
    return context;
  }
  const definition = requireDefinition(definitionInput);
  if (!definition.ok) {
    return definition;
  }
  const head = InitializeInputSchema.safeParse(headInput);
  if (!head.success) {
    return err(persistenceFailure("Invalid mutable head input"));
  }

  try {
    context.value.nativeDatabase
      .prepare(
        `INSERT INTO ${quoteSqlIdentifier(definition.value.tableName)} (
          ${quoteSqlIdentifier(definition.value.identityColumn)},
          ${quoteSqlIdentifier(definition.value.pointerColumn)},
          ${quoteSqlIdentifier(definition.value.versionColumn)}
        ) VALUES (?, ?, ?)`
      )
      .run(head.data.identity, head.data.pointer, FIRST_MUTABLE_HEAD_VERSION);

    return ok(
      Object.freeze({
        identity: head.data.identity,
        pointer: head.data.pointer,
        version: FIRST_MUTABLE_HEAD_VERSION
      })
    );
  } catch {
    return err(persistenceFailure("Mutable head initialization failed"));
  }
}

/**
 * Moves the pointer only when the stored version still equals the version the
 * caller read. A lost race returns `version_conflict` carrying the version that
 * actually won, so the caller can re-read and decide rather than retry blindly.
 */
export function compareAndSetMutableHead(
  contextInput: unknown,
  definitionInput: unknown,
  swingInput: unknown
): Result<MutableHeadRow, RuntimeError> {
  const context = validateContext(contextInput);
  if (!context.ok) {
    return context;
  }
  const definition = requireDefinition(definitionInput);
  if (!definition.ok) {
    return definition;
  }
  const swing = CompareAndSetInputSchema.safeParse(swingInput);
  if (!swing.success) {
    return err(persistenceFailure("Invalid mutable head input"));
  }

  try {
    const table = quoteSqlIdentifier(definition.value.tableName);
    const identityColumn = quoteSqlIdentifier(definition.value.identityColumn);
    const pointerColumn = quoteSqlIdentifier(definition.value.pointerColumn);
    const versionColumn = quoteSqlIdentifier(definition.value.versionColumn);

    const updated = context.value.nativeDatabase
      .prepare(
        `UPDATE ${table}
         SET ${pointerColumn} = ?, ${versionColumn} = ${versionColumn} + 1
         WHERE ${identityColumn} = ? AND ${versionColumn} = ?`
      )
      .run(swing.data.pointer, swing.data.identity, swing.data.expectedVersion);

    if (updated.changes === 0) {
      const current = MutableHeadRowSchema.safeParse(
        context.value.nativeDatabase
          .prepare(selectSql(definition.value))
          .get(swing.data.identity)
      );
      return err(
        versionConflict(
          definition.value,
          swing.data.identity,
          swing.data.expectedVersion,
          current.success ? current.data.version : null
        )
      );
    }

    return ok(
      Object.freeze({
        identity: swing.data.identity,
        pointer: swing.data.pointer,
        version: swing.data.expectedVersion + 1
      })
    );
  } catch {
    return err(persistenceFailure("Mutable head update failed"));
  }
}
