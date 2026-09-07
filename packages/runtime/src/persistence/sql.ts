import { z } from "zod";

/**
 * Every identifier these helpers interpolate into SQL has to pass this first.
 * SQLite has no bind parameters for table or column names, so the guard is the
 * only thing standing between a caller-supplied name and the statement text.
 */
export const SqlIdentifierSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/u, "SQL identifier must be lower snake case");

export function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier}"`;
}

export function quoteSqlIdentifierList(identifiers: readonly string[]): string {
  return identifiers.map(quoteSqlIdentifier).join(", ");
}
