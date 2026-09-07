import { err, ok, type Result } from "@recruitos/core";
import { z } from "zod";

import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  SqlIdentifierSchema,
  quoteSqlIdentifier,
  quoteSqlIdentifierList
} from "./sql.js";

/**
 * SQLite treats every NULL as distinct, so one unique index over a nullable
 * subject column enforces nothing at all for the rows whose subject is absent.
 * The pattern that does work is a matched pair of partial indexes: one covering
 * the rows that name a subject, one covering the rows that do not. Getting only
 * half of the pair right is the failure this helper exists to prevent, so it
 * always returns both statements together.
 */

export const MAXIMUM_NULLABLE_SUBJECT_SCOPE_COLUMNS = 8;

export type NullableSubjectUniqueIndexes = Readonly<{
  presentIndexName: string;
  absentIndexName: string;
  /** Both CREATE UNIQUE INDEX statements, present first. */
  statements: readonly string[];
}>;

const NullableSubjectUniqueIndexConfigSchema = z
  .object({
    tableName: SqlIdentifierSchema,
    scopeColumns: z
      .array(SqlIdentifierSchema)
      .min(1)
      .max(MAXIMUM_NULLABLE_SUBJECT_SCOPE_COLUMNS),
    subjectColumn: SqlIdentifierSchema
  })
  .strict()
  .refine(
    (config) =>
      new Set(config.scopeColumns).size === config.scopeColumns.length &&
      !config.scopeColumns.includes(config.subjectColumn),
    "Scope columns must be distinct and must not include the subject column"
  );

export type NullableSubjectUniqueIndexConfig = z.input<
  typeof NullableSubjectUniqueIndexConfigSchema
>;

function persistenceFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

export function createNullableSubjectUniqueIndexes(
  configInput: unknown
): Result<NullableSubjectUniqueIndexes, RuntimeError> {
  const config = NullableSubjectUniqueIndexConfigSchema.safeParse(configInput);
  if (!config.success) {
    return err(persistenceFailure("Invalid nullable subject index configuration"));
  }

  const presentIndexName = `${config.data.tableName}_${config.data.subjectColumn}_present_unique`;
  const absentIndexName = `${config.data.tableName}_${config.data.subjectColumn}_absent_unique`;
  const names = z.array(SqlIdentifierSchema).safeParse([presentIndexName, absentIndexName]);
  if (!names.success) {
    return err(persistenceFailure("Derived nullable subject index name is not valid SQL"));
  }

  const table = quoteSqlIdentifier(config.data.tableName);
  const subject = quoteSqlIdentifier(config.data.subjectColumn);
  const scope = quoteSqlIdentifierList(config.data.scopeColumns);

  return ok(
    Object.freeze({
      presentIndexName,
      absentIndexName,
      statements: Object.freeze([
        `CREATE UNIQUE INDEX ${quoteSqlIdentifier(presentIndexName)} ON ${table} (${scope}, ${subject}) WHERE ${subject} IS NOT NULL`,
        `CREATE UNIQUE INDEX ${quoteSqlIdentifier(absentIndexName)} ON ${table} (${scope}) WHERE ${subject} IS NULL`
      ])
    })
  );
}
