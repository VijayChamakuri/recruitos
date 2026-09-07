import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import {
  actors,
  auditEvents,
  candidateDocuments,
  candidateResultDimensionAssessments,
  candidateResultEvidenceGaps,
  candidateResultEvidenceSpans,
  candidateResultFactConflicts,
  candidateResultHardRequirementAssessments,
  candidateResultReasons,
  candidateResultStructuredFacts,
  candidateTriageResults,
  candidates,
  commandReceipts,
  corpusManifestSeals,
  corpusManifests,
  corpusMemberDocuments,
  corpusMembers,
  dimensionAssessmentEvidenceSpans,
  dimensionAssessments,
  evidenceGaps,
  evidenceSpans,
  extractionArtifacts,
  extractionFailures,
  extractionRuns,
  extractionSpecs,
  factConflictMembers,
  factConflicts,
  hardRequirementAssessmentFacts,
  hardRequirementAssessments,
  requirements,
  roles,
  rubricDimensions,
  rubrics,
  runInputSnapshots,
  runtimeMigrationSmoke,
  scoreResults,
  sourceDocuments,
  structuredFactEvidenceSpans,
  structuredFactProvenances,
  structuredFacts
} from "./schema.js";

/**
 * The runtime writes these tables through raw SQL, so nothing else compares the
 * Drizzle definitions against the migrations that actually build the database.
 * Without this test a column renamed in one and not the other would pass every
 * suite. Parsing the committed SQL is the cross-check.
 */
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

type SqlColumn = Readonly<{
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}>;

type SqlForeignKey = Readonly<{
  columns: readonly string[];
  foreignTable: string;
  foreignColumns: readonly string[];
  onDelete: string | undefined;
}>;

type SqlIndex = Readonly<{
  name: string;
  unique: boolean;
  columns: readonly string[];
  where: string | undefined;
}>;

type SqlTable = {
  name: string;
  strict: boolean;
  columns: SqlColumn[];
  checks: string[];
  foreignKeys: SqlForeignKey[];
  indexes: SqlIndex[];
};

/** Splits a CREATE TABLE body on commas that are not inside parentheses or quotes. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (quoted) {
      current += character;
      if (character === "'") {
        quoted = false;
      }
      continue;
    }
    if (character === "'") {
      quoted = true;
      current += character;
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    }
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);

  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function backtickedList(source: string): string[] {
  return [...source.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);
}

function normalizeSqlPredicate(text: string): string {
  return text.replace(/\s+/gu, " ").replace(/;$/u, "").trim();
}

/**
 * Turns a Drizzle index WHERE into the same table-qualified predicate the
 * committed SQL uses. Without this, dropping `.where()` still matches on name
 * and columns, which is exactly how SQLite would silently stop enforcing
 * nullable-subject uniqueness.
 */
function drizzleIndexWhere(where: unknown): string | undefined {
  if (where === undefined || where === null) {
    return undefined;
  }
  if (typeof where !== "object" || !("queryChunks" in where)) {
    throw new Error("Drizzle index WHERE is not an SQL fragment");
  }
  const chunks = (where as { queryChunks: readonly unknown[] }).queryChunks;
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (typeof chunk === "string") {
      parts.push(chunk);
      continue;
    }
    if (
      typeof chunk === "object" &&
      chunk !== null &&
      "value" in chunk &&
      Array.isArray((chunk as { value: unknown }).value)
    ) {
      parts.push((chunk as { value: string[] }).value.join(""));
      continue;
    }
    if (
      typeof chunk === "object" &&
      chunk !== null &&
      "name" in chunk &&
      "table" in chunk
    ) {
      const column = chunk as { name: string; table: SQLiteTable };
      parts.push(`"${getTableConfig(column.table).name}"."${column.name}"`);
      continue;
    }
    throw new Error("Unhandled SQL chunk in Drizzle index WHERE");
  }
  return normalizeSqlPredicate(parts.join(""));
}

/** Parses every committed migration into the table shapes it actually creates. */
function parseMigrations(): Map<string, SqlTable> {
  const tables = new Map<string, SqlTable>();
  const files = readdirSync(migrationsFolder)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(migrationsFolder, file), "utf8");
    for (const rawStatement of sql.split("--> statement-breakpoint")) {
      const statement = rawStatement.trim();

      const createTable = /^CREATE TABLE `([^`]+)` \(([\s\S]*)\)\s*(STRICT)?\s*;?$/u.exec(
        statement
      );
      if (createTable !== null) {
        const table: SqlTable = {
          name: createTable[1]!,
          strict: createTable[3] !== undefined,
          columns: [],
          checks: [],
          foreignKeys: [],
          indexes: []
        };

        for (const item of splitTopLevel(createTable[2]!)) {
          const check = /^CONSTRAINT "([^"]+)" CHECK/u.exec(item);
          if (check !== null) {
            table.checks.push(check[1]!);
            continue;
          }

          const foreignKey =
            /^FOREIGN KEY \(([^)]*)\) REFERENCES `([^`]+)`\(([^)]*)\)([\s\S]*)$/u.exec(item);
          if (foreignKey !== null) {
            const onDelete = /ON DELETE (\w+)/u.exec(foreignKey[4]!);
            table.foreignKeys.push({
              columns: backtickedList(foreignKey[1]!),
              foreignTable: foreignKey[2]!,
              foreignColumns: backtickedList(foreignKey[3]!),
              onDelete:
                onDelete === null || onDelete[1] === "no" ? undefined : onDelete[1]!
            });
            continue;
          }

          const column = /^`([^`]+)`\s+(\w+)/u.exec(item);
          if (column !== null) {
            table.columns.push({
              name: column[1]!,
              type: column[2]!,
              notNull: /\bNOT NULL\b/u.test(item),
              primaryKey: /\bPRIMARY KEY\b/u.test(item)
            });
          }
        }

        tables.set(table.name, table);
        continue;
      }

      const createIndex =
        /^CREATE (UNIQUE )?INDEX `([^`]+)` ON `([^`]+)` \(([^)]*)\)(?:\s+WHERE\s+([\s\S]+?))?\s*;?$/u.exec(
          statement
        );
      if (createIndex !== null) {
        const target = tables.get(createIndex[3]!);
        expect(target, `index ${createIndex[2]!} targets an unknown table`).toBeDefined();
        target!.indexes.push({
          name: createIndex[2]!,
          unique: createIndex[1] !== undefined,
          columns: backtickedList(createIndex[4]!),
          where:
            createIndex[5] === undefined
              ? undefined
              : normalizeSqlPredicate(createIndex[5])
        });
      }
    }
  }

  return tables;
}

const migrationTables = parseMigrations();

function describeDrizzleTable(table: SQLiteTable): SqlTable {
  const config = getTableConfig(table);
  return {
    name: config.name,
    strict: true,
    columns: config.columns.map((column) => ({
      name: column.name,
      type: column.getSQLType(),
      notNull: column.notNull,
      primaryKey: column.primary
    })),
    checks: config.checks.map((check) => check.name),
    foreignKeys: config.foreignKeys.map((foreignKey) => {
      // Resolving the reference runs the lazy target callbacks in schema.ts,
      // which is the only thing that proves they point where they claim.
      const reference = foreignKey.reference();
      return {
        columns: reference.columns.map((column) => column.name),
        foreignTable: getTableConfig(reference.foreignTable).name,
        foreignColumns: reference.foreignColumns.map((column) => column.name),
        onDelete: foreignKey.onDelete
      };
    }),
    indexes: config.indexes.map((index) => ({
      name: index.config.name,
      unique: index.config.unique,
      columns: index.config.columns.map((column) => (column as { name: string }).name),
      where: drizzleIndexWhere(index.config.where)
    }))
  };
}

const byName = <T extends { name: string }>(items: readonly T[]): T[] =>
  [...items].sort((left, right) => left.name.localeCompare(right.name));

const tableCases: ReadonlyArray<readonly [string, SQLiteTable]> = [
  ["runtime_migration_smoke", runtimeMigrationSmoke],
  ["command_receipt", commandReceipts],
  ["audit_event", auditEvents],
  ["actor", actors],
  ["candidate", candidates],
  ["source_document", sourceDocuments],
  ["candidate_document", candidateDocuments],
  ["corpus_manifest", corpusManifests],
  ["corpus_member", corpusMembers],
  ["corpus_member_document", corpusMemberDocuments],
  ["corpus_manifest_seal", corpusManifestSeals],
  ["role", roles],
  ["requirement", requirements],
  ["rubric", rubrics],
  ["rubric_dimension", rubricDimensions],
  ["extraction_run", extractionRuns],
  ["evidence_span", evidenceSpans],
  ["evidence_gap", evidenceGaps],
  ["dimension_assessment", dimensionAssessments],
  ["dimension_assessment_evidence_span", dimensionAssessmentEvidenceSpans],
  ["extraction_spec", extractionSpecs],
  ["extraction_artifact", extractionArtifacts],
  ["extraction_failure", extractionFailures],
  ["run_input_snapshot", runInputSnapshots],
  ["structured_fact", structuredFacts],
  ["structured_fact_evidence_span", structuredFactEvidenceSpans],
  ["structured_fact_provenance", structuredFactProvenances],
  ["fact_conflict", factConflicts],
  ["fact_conflict_member", factConflictMembers],
  ["hard_requirement_assessment", hardRequirementAssessments],
  ["hard_requirement_assessment_fact", hardRequirementAssessmentFacts],
  ["candidate_triage_result", candidateTriageResults],
  ["score_result", scoreResults],
  ["candidate_result_evidence_span", candidateResultEvidenceSpans],
  ["candidate_result_evidence_gap", candidateResultEvidenceGaps],
  ["candidate_result_dimension_assessment", candidateResultDimensionAssessments],
  ["candidate_result_structured_fact", candidateResultStructuredFacts],
  ["candidate_result_fact_conflict", candidateResultFactConflicts],
  ["candidate_result_hard_requirement_assessment", candidateResultHardRequirementAssessments],
  ["candidate_result_reason", candidateResultReasons]
];

describe("Drizzle schema matches the committed migrations", () => {
  it("parses every migrated table", () => {
    expect([...migrationTables.keys()].sort()).toEqual(
      tableCases.map(([name]) => name).sort()
    );
  });

  it.each(tableCases)("%s columns match the migration", (name, table) => {
    const drizzle = describeDrizzleTable(table);
    const sql = migrationTables.get(name);
    expect(sql).toBeDefined();
    expect(drizzle.name).toBe(name);
    expect(byName(drizzle.columns)).toEqual(byName(sql!.columns));
  });

  it.each(tableCases)("%s constraints and indexes match the migration", (name, table) => {
    const drizzle = describeDrizzleTable(table);
    const sql = migrationTables.get(name)!;

    expect([...drizzle.checks].sort()).toEqual([...sql.checks].sort());
    expect(byName(drizzle.indexes)).toEqual(byName(sql.indexes));
    expect(
      [...drizzle.foreignKeys].sort((left, right) =>
        left.columns.join().localeCompare(right.columns.join())
      )
    ).toEqual(
      [...sql.foreignKeys].sort((left, right) =>
        left.columns.join().localeCompare(right.columns.join())
      )
    );
  });

  it.each(tableCases)("%s is declared STRICT", (name) => {
    expect(migrationTables.get(name)!.strict).toBe(true);
  });
});
