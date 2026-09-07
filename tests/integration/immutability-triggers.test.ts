import { afterEach, describe, expect, it } from "vitest";

import { SYSTEM_ACTOR_ID } from "../../packages/runtime/src/entities/index.js";
import {
  countRow,
  nativeDatabase,
  openMigratedDatabase,
  removeTemporaryDatabases
} from "./harness/database.js";
import {
  seedAuditEvent,
  seedImmutableEntities,
  seedRoleAndRubric
} from "./harness/seed.js";

/**
 * The append-only and immutability guarantees are enforced by SQL triggers, not
 * by TypeScript. Only a real driver issuing a real UPDATE, DELETE, or INSERT OR
 * REPLACE proves they fire, so these assertions belong to the integration lane
 * rather than to the store unit tests.
 */

afterEach(removeTemporaryDatabases);

describe("audit event append-only triggers", () => {
  it("rejects update, delete, and replacement of a stored audit event", async () => {
    const connection = await openMigratedDatabase("triggers-audit");
    seedAuditEvent(connection);
    const database = nativeDatabase(connection);

    expect(() =>
      database.prepare("UPDATE audit_event SET actor_display_name = 'Changed'").run()
    ).toThrowError("audit_event is append-only");
    expect(() => database.prepare("DELETE FROM audit_event").run()).toThrowError(
      "audit_event is append-only"
    );
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO audit_event
           SELECT
             audit_event_id,
             command_id,
             event_ordinal,
             actor_id,
             'Replacement',
             event_name,
             event_version,
             payload_json,
             payload_hash,
             occurred_at,
             recorded_at
           FROM audit_event`
        )
        .run()
    ).toThrowError("audit_event is append-only");

    expect(countRow(database, "SELECT COUNT(*) AS total FROM audit_event")).toBe(1);
    expect(connection.close().ok).toBe(true);
  });
});

describe("immutable entity triggers", () => {
  it("rejects updates, deletes, and replacements of stored rows", async () => {
    const connection = await openMigratedDatabase("triggers-entities");
    seedImmutableEntities(connection);
    const database = nativeDatabase(connection);

    expect(() =>
      database
        .prepare("UPDATE candidate SET channel = 'sourced' WHERE candidate_id = ?")
        .run("candidate-1")
    ).toThrow(/candidate is immutable/u);
    expect(() =>
      database.prepare("DELETE FROM candidate WHERE candidate_id = ?").run("candidate-1")
    ).toThrow(/candidate is immutable/u);
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO candidate (
            candidate_id, source_system, source_key, channel, corpus_tag, is_synthetic, created_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?)`
        )
        .run("candidate-1", "synthetic_corpus", "tier-one/0001", "sourced", "main", 1)
    ).toThrow(/candidate is immutable/u);

    expect(() =>
      database
        .prepare(
          "UPDATE source_document SET raw_text = 'tampered' WHERE source_document_id = ?"
        )
        .run("source-document-1")
    ).toThrow(/source_document is immutable/u);
    expect(() =>
      database
        .prepare("DELETE FROM source_document WHERE source_document_id = ?")
        .run("source-document-1")
    ).toThrow(/source_document is immutable/u);

    expect(() =>
      database
        .prepare("UPDATE candidate_document SET label = 'Tampered' WHERE candidate_document_id = ?")
        .run("candidate-document-1")
    ).toThrow(/candidate_document is immutable/u);
    expect(() =>
      database
        .prepare("DELETE FROM candidate_document WHERE candidate_document_id = ?")
        .run("candidate-document-1")
    ).toThrow(/candidate_document is immutable/u);

    expect(() =>
      database.prepare("DELETE FROM actor WHERE actor_id = ?").run(SYSTEM_ACTOR_ID)
    ).toThrow(/actor is immutable/u);

    expect(connection.close().ok).toBe(true);
  });
});

describe("role and rubric immutability triggers", () => {
  it("rejects updates, deletes, and replacements of stored rows", async () => {
    const connection = await openMigratedDatabase("triggers-roles");
    seedRoleAndRubric(connection);
    const database = nativeDatabase(connection);

    expect(() =>
      database
        .prepare("UPDATE role SET title = 'Tampered' WHERE role_id = ?")
        .run("role-applied-ai-engineer")
    ).toThrow(/role is immutable/u);
    expect(() =>
      database
        .prepare("DELETE FROM role WHERE role_id = ?")
        .run("role-applied-ai-engineer")
    ).toThrow(/role is immutable/u);
    expect(() =>
      database
        .prepare(
          "INSERT OR REPLACE INTO role (role_id, title, created_at) VALUES (?, ?, ?)"
        )
        .run("role-applied-ai-engineer", "Replacement", 1)
    ).toThrow(/role is immutable/u);

    expect(() =>
      database
        .prepare("UPDATE requirement SET kind = 'scored' WHERE requirement_id = ?")
        .run("requirement-work-authorization")
    ).toThrow(/requirement is immutable/u);
    expect(() =>
      database
        .prepare("DELETE FROM requirement WHERE requirement_id = ?")
        .run("requirement-work-authorization")
    ).toThrow(/requirement is immutable/u);

    expect(() =>
      database
        .prepare("UPDATE rubric SET version = 'other' WHERE rubric_id = ?")
        .run("rubric-sample")
    ).toThrow(/rubric is immutable/u);
    expect(() =>
      database.prepare("DELETE FROM rubric WHERE rubric_id = ?").run("rubric-sample")
    ).toThrow(/rubric is immutable/u);
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO rubric (
            rubric_id, role_id, version, created_at
          ) VALUES (?, ?, ?, ?)`
        )
        .run("rubric-sample", "role-applied-ai-engineer", "other", 1)
    ).toThrow(/rubric is immutable/u);

    expect(() =>
      database
        .prepare("UPDATE rubric_dimension SET weight = 9 WHERE rubric_dimension_id = ?")
        .run("rubric-dimension-sample")
    ).toThrow(/rubric_dimension is immutable/u);
    expect(() =>
      database
        .prepare("DELETE FROM rubric_dimension WHERE rubric_dimension_id = ?")
        .run("rubric-dimension-sample")
    ).toThrow(/rubric_dimension is immutable/u);
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO rubric_dimension (
            rubric_dimension_id, rubric_id, dimension_id, weight, required,
            definition, job_related_justification, ordinal, created_at
          ) VALUES (?, ?, ?, 1, 0, 'd', 'j', 0, 1)`
        )
        .run("rubric-dimension-sample", "rubric-sample", "sample_dimension")
    ).toThrow(/rubric_dimension is immutable/u);

    expect(connection.close().ok).toBe(true);
  });
});
