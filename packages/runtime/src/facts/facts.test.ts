import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJsonStringify, ok, sha256Hex, type Result } from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runImmediateTransaction, type ImmediateTransactionContext } from "../commands/index.js";
import { openRuntimeDatabase, type RuntimeDatabaseConnection } from "../db/index.js";
import {
  insertActor,
  insertCandidate,
  insertSourceDocument,
  prepareActor,
  prepareCandidate,
  prepareSourceDocument
} from "../entities/index.js";
import { type RuntimeError } from "../errors/index.js";
import { insertEvidenceSpan, prepareEvidenceSpan } from "../evidence/index.js";
import {
  hashFactConflictContent,
  hashHardRequirementAssessmentContent,
  hashStructuredFactContent,
  insertFactConflict,
  insertHardRequirementAssessment,
  insertStructuredFact,
  prepareFactConflict,
  prepareHardRequirementAssessment,
  prepareStructuredFact,
  readFactConflict,
  readHardRequirementAssessment,
  readStructuredFact,
  readStructuredFactByContentHash,
  validateStructuredFactContent
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const DOCUMENT_TEXT = "ABCDEFGHIJ";
const TRANSACTION_REQUIRED = "Structured fact rows require an active command transaction";

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-facts-test-"));
  temporaryDirectories.push(directory);
  const opened = openRuntimeDatabase({
    filename: join(directory, "runtime.db"),
    migrationsFolder
  });
  expect(opened.ok).toBe(true);
  if (!opened.ok) {
    throw new Error(opened.error.message);
  }
  const migrated = opened.value.migrate();
  expect(migrated.ok).toBe(true);
  if (!migrated.ok) {
    throw new Error(migrated.error.message);
  }
  return opened.value;
}

function nativeDatabase(connection: RuntimeDatabaseConnection): BetterSqlite3.Database {
  return (connection.database as unknown as { $client: BetterSqlite3.Database }).$client;
}

function unwrap<T>(result: Result<T, RuntimeError>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function withThrowingGetter(
  base: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const poisoned: Record<string, unknown> = { ...base };
  Object.defineProperty(poisoned, key, {
    get() {
      throw new TypeError("hostile getter");
    },
    enumerable: true
  });
  return poisoned;
}

function candidateDraft(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: "candidate-1",
    sourceSystem: "synthetic_corpus",
    sourceKey: "tier-one/0001",
    channel: "inbound",
    corpusTag: "main",
    createdAt: CREATED_AT,
    ...overrides
  };
}

function actorDraft(overrides: Record<string, unknown> = {}) {
  return {
    actorId: "actor-recruiter-1",
    displayName: "Dana Recruiter",
    createdAt: CREATED_AT,
    ...overrides
  };
}

function sourceDocumentDraft(overrides: Record<string, unknown> = {}) {
  return {
    sourceDocumentId: "source-document-1",
    rawText: DOCUMENT_TEXT,
    normalizedText: DOCUMENT_TEXT,
    createdAt: CREATED_AT,
    ...overrides
  };
}

function evidenceSpanDraft(overrides: Record<string, unknown> = {}) {
  return {
    evidenceSpanId: "evidence-span-1",
    documentId: "source-document-1",
    start: 2,
    end: 5,
    quotedText: "CDE",
    dimensionId: "evaluation_practice",
    polarity: "supporting",
    source: "extracted",
    matchQuality: "exact",
    extractorVersion: "extractor-v1",
    createdAt: CREATED_AT,
    ...overrides
  };
}

function titlePayload(title = "Staff Engineer") {
  return { kind: "current_title", title };
}

function factDraft(overrides: Record<string, unknown> = {}) {
  return {
    structuredFactId: "structured-fact-1",
    candidateId: "candidate-1",
    payload: titlePayload(),
    evidenceSpans: [
      {
        structuredFactEvidenceSpanId: "structured-fact-span-1",
        evidenceSpanId: "evidence-span-1"
      }
    ],
    provenances: [
      {
        structuredFactProvenanceId: "structured-fact-provenance-1",
        source: "extracted",
        actorId: null
      }
    ],
    createdAt: CREATED_AT,
    ...overrides
  };
}

function conflictDraft(overrides: Record<string, unknown> = {}) {
  return {
    factConflictId: "fact-conflict-1",
    members: [
      {
        factConflictMemberId: "fact-conflict-member-1",
        structuredFactId: "structured-fact-1"
      },
      {
        factConflictMemberId: "fact-conflict-member-2",
        structuredFactId: "structured-fact-2"
      }
    ],
    createdAt: CREATED_AT,
    ...overrides
  };
}

function assessmentDraft(overrides: Record<string, unknown> = {}) {
  return {
    hardRequirementAssessmentId: "hard-requirement-assessment-1",
    candidateId: "candidate-1",
    requirementFieldId: "current_title",
    outcome: "pass",
    facts: [
      {
        hardRequirementAssessmentFactId: "hard-requirement-assessment-fact-1",
        structuredFactId: "structured-fact-1",
        polarity: "supporting"
      }
    ],
    createdAt: CREATED_AT,
    ...overrides
  };
}

function seedParents(context: ImmediateTransactionContext): void {
  unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
  unwrap(insertSourceDocument(context, unwrap(prepareSourceDocument(sourceDocumentDraft()))));
  unwrap(insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft()))));
  unwrap(insertActor(context, unwrap(prepareActor(actorDraft()))));
}

function seedTwoTitleFacts(context: ImmediateTransactionContext): void {
  seedParents(context);
  unwrap(insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft({
    evidenceSpanId: "evidence-span-2",
    start: 0,
    end: 3,
    quotedText: "ABC"
  })))));
  unwrap(insertStructuredFact(context, unwrap(prepareStructuredFact(factDraft()))));
  unwrap(
    insertStructuredFact(
      context,
      unwrap(
        prepareStructuredFact(
          factDraft({
            structuredFactId: "structured-fact-2",
            payload: titlePayload("Principal Engineer"),
            evidenceSpans: [
              {
                structuredFactEvidenceSpanId: "structured-fact-span-2",
                evidenceSpanId: "evidence-span-2"
              }
            ],
            provenances: [
              {
                structuredFactProvenanceId: "structured-fact-provenance-2",
                source: "parsed",
                actorId: null
              }
            ]
          })
        )
      )
    )
  );
}

function failingContext(prepareImpl?: (sql: string) => unknown): object {
  return {
    nativeDatabase: {
      inTransaction: true,
      prepare(sql: string) {
        if (prepareImpl !== undefined) {
          return prepareImpl(sql);
        }
        throw new Error("disk I/O error");
      }
    }
  };
}

function rebuildTableWithoutChecks(
  database: BetterSqlite3.Database,
  table: string,
  columns: string
): void {
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS ${table}_reject_update;
    DROP TRIGGER IF EXISTS ${table}_reject_delete;
    DROP TRIGGER IF EXISTS ${table}_reject_replace;
    CREATE TABLE ${table}_rebuilt (
      ${columns}
    ) STRICT;
    INSERT INTO ${table}_rebuilt SELECT * FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE ${table}_rebuilt RENAME TO ${table};
    PRAGMA foreign_keys = ON;
  `);
}

const STRUCTURED_FACT_COLUMNS = `
  structured_fact_id text PRIMARY KEY NOT NULL,
  candidate_id text NOT NULL,
  kind text NOT NULL,
  semantic_key text NOT NULL,
  payload_json text NOT NULL,
  content_json text NOT NULL,
  content_hash text NOT NULL,
  created_at integer NOT NULL
`;

const FACT_CONFLICT_COLUMNS = `
  fact_conflict_id text PRIMARY KEY NOT NULL,
  content_json text NOT NULL,
  content_hash text NOT NULL,
  created_at integer NOT NULL
`;

const HARD_REQUIREMENT_ASSESSMENT_COLUMNS = `
  hard_requirement_assessment_id text PRIMARY KEY NOT NULL,
  candidate_id text NOT NULL,
  requirement_field_id text NOT NULL,
  outcome text NOT NULL,
  content_json text NOT NULL,
  content_hash text NOT NULL,
  created_at integer NOT NULL
`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("structured fact preparation", () => {
  it("hashes payload identity independently of authoring key order", () => {
    const fact = unwrap(
      prepareStructuredFact(
        factDraft({
          payload: { title: "Staff Engineer", kind: "current_title" }
        })
      )
    );
    expect(fact.kind).toBe("current_title");
    expect(fact.semanticKey).toBe("Staff Engineer");
    expect(fact.contentHash).toBe(
      unwrap(hashStructuredFactContent("candidate-1", titlePayload()))
    );
    const canonical = canonicalJsonStringify(fact.payload);
    expect(canonical.ok).toBe(true);
    if (canonical.ok) {
      expect(JSON.stringify(fact.payload)).toBe(canonical.value);
    }
    expect(Object.isFrozen(fact)).toBe(true);
    expect(
      unwrap(validateStructuredFactContent({
        candidateId: "candidate-1",
        payload: titlePayload(),
        semanticKey: "Staff Engineer"
      })).semanticKey
    ).toBe("Staff Engineer");
  });

  it("derives employment, authorization, history, and claimed-experience keys", () => {
    expect(
      unwrap(
        prepareStructuredFact(
          factDraft({
            payload: {
              kind: "employment_interval",
              employer: "Acme",
              title: "Engineer",
              startMonth: "2020-01",
              endMonth: "present"
            }
          })
        )
      ).semanticKey
    ).toBe("Acme\u001f2020-01");
    expect(
      unwrap(
        prepareStructuredFact(
          factDraft({
            payload: {
              kind: "work_authorization_statement",
              classification: "authorized",
              statementText: "Authorized to work in the United States."
            }
          })
        )
      ).semanticKey
    ).toBe("authorized");
    expect(
      unwrap(
        prepareStructuredFact(
          factDraft({
            payload: {
              kind: "employer_history_entry",
              employer: "Acme",
              startMonth: "2018-06",
              endMonth: "2020-01"
            }
          })
        )
      ).semanticKey
    ).toBe("Acme\u001f2018-06");
    expect(
      unwrap(
        prepareStructuredFact(factDraft({ payload: { kind: "claimed_experience", claimedMonths: 84 } }))
      ).semanticKey
    ).toBe("claimed:84");
  });

  it("rejects duplicate spans, provenance actor mismatches, and hostile drafts", () => {
    expect(
      prepareStructuredFact(
        factDraft({
          evidenceSpans: [
            {
              structuredFactEvidenceSpanId: "structured-fact-span-1",
              evidenceSpanId: "evidence-span-1"
            },
            {
              structuredFactEvidenceSpanId: "structured-fact-span-2",
              evidenceSpanId: "evidence-span-1"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Structured fact evidence spans must be unique" })
    });
    expect(
      prepareStructuredFact(
        factDraft({
          provenances: [
            {
              structuredFactProvenanceId: "structured-fact-provenance-1",
              source: "human",
              actorId: null
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message:
          "Structured fact provenance actor is required for human source and forbidden otherwise"
      })
    });
    expect(prepareStructuredFact(withThrowingGetter(factDraft(), "structuredFactId"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Structured fact preparation failed" })
    });
    expect(prepareStructuredFact({ structuredFactId: "structured-fact-1" })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid structured fact input" })
    });
    expect(
      validateStructuredFactContent({
        candidateId: "candidate-1",
        payload: titlePayload(),
        semanticKey: "other"
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Structured fact semantic key does not match payload"
      })
    });
    expect(hashStructuredFactContent("", titlePayload())).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid structured fact content" })
    });
    expect(hashStructuredFactContent("candidate-1", {})).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid structured fact content" })
    });
    expect(validateStructuredFactContent({})).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid structured fact content" })
    });
    expect(
      prepareStructuredFact(
        factDraft({
          evidenceSpans: [
            {
              structuredFactEvidenceSpanId: "structured-fact-span-1",
              evidenceSpanId: "evidence-span-1"
            },
            {
              structuredFactEvidenceSpanId: "structured-fact-span-1",
              evidenceSpanId: "evidence-span-2"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Structured fact evidence span IDs must be unique"
      })
    });
    expect(
      prepareStructuredFact(
        factDraft({
          provenances: [
            {
              structuredFactProvenanceId: "structured-fact-provenance-1",
              source: "extracted",
              actorId: null
            },
            {
              structuredFactProvenanceId: "structured-fact-provenance-1",
              source: "parsed",
              actorId: null
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Structured fact provenance IDs must be unique"
      })
    });
    expect(
      prepareStructuredFact(
        factDraft({
          provenances: [
            {
              structuredFactProvenanceId: "structured-fact-provenance-1",
              source: "extracted",
              actorId: "actor-recruiter-1"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message:
          "Structured fact provenance actor is required for human source and forbidden otherwise"
      })
    });
    expect(
      prepareStructuredFact(
        factDraft({
          payload: {
            kind: "employment_interval",
            employer: "Acme",
            title: "Engineer",
            startMonth: "2021-01",
            endMonth: "2020-12"
          }
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid structured fact content" })
    });
  });
});

describe("structured fact persistence", () => {
  it("round-trips a grounded fact and looks it up by content hash", async () => {
    const connection = await openMigratedDatabase();
    const fact = unwrap(prepareStructuredFact(factDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        unwrap(insertStructuredFact(context, fact));
        expect(unwrap(readStructuredFact(context, fact.structuredFactId))).toEqual(fact);
        expect(unwrap(readStructuredFactByContentHash(context, fact.contentHash))).toEqual(fact);
        expect(unwrap(readStructuredFact(context, "structured-fact-missing"))).toBeUndefined();
        expect(
          unwrap(readStructuredFactByContentHash(context, sha256Hex("missing-fact")))
        ).toBeUndefined();
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("refuses missing parents, duplicate identity, and writes outside a transaction", async () => {
    const connection = await openMigratedDatabase();
    const fact = unwrap(prepareStructuredFact(factDraft()));
    expect(insertStructuredFact({}, fact)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
    });
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(insertStructuredFact(context, fact)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Structured fact requires a stored candidate"
          })
        });
        unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft()))));
        expect(insertStructuredFact(context, fact)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Structured fact requires stored evidence spans"
          })
        });
        unwrap(insertSourceDocument(context, unwrap(prepareSourceDocument(sourceDocumentDraft()))));
        unwrap(insertEvidenceSpan(context, unwrap(prepareEvidenceSpan(evidenceSpanDraft()))));
        const humanFact = unwrap(
          prepareStructuredFact(
            factDraft({
              provenances: [
                {
                  structuredFactProvenanceId: "structured-fact-provenance-1",
                  source: "human",
                  actorId: "actor-recruiter-1"
                }
              ]
            })
          )
        );
        expect(insertStructuredFact(context, humanFact)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Structured fact human provenance requires a stored actor"
          })
        });
        unwrap(insertActor(context, unwrap(prepareActor(actorDraft()))));
        unwrap(insertStructuredFact(context, fact));
        expect(
          insertStructuredFact(
            context,
            unwrap(prepareStructuredFact(factDraft({ structuredFactId: "structured-fact-dup" })))
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Structured fact insert failed" })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });
});

describe("fact conflict persistence", () => {
  it("orders members canonically and round-trips the conflict", async () => {
    const connection = await openMigratedDatabase();
    const conflict = unwrap(
      prepareFactConflict(
        conflictDraft({
          members: [
            {
              factConflictMemberId: "fact-conflict-member-2",
              structuredFactId: "structured-fact-2"
            },
            {
              factConflictMemberId: "fact-conflict-member-1",
              structuredFactId: "structured-fact-1"
            }
          ]
        })
      )
    );
    expect(conflict.content.memberIds).toEqual(["structured-fact-1", "structured-fact-2"]);
    expect(conflict.contentHash).toBe(
      unwrap(hashFactConflictContent(["structured-fact-2", "structured-fact-1"]))
    );
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedTwoTitleFacts(context);
        unwrap(insertFactConflict(context, conflict));
        expect(unwrap(readFactConflict(context, conflict.factConflictId))).toEqual(conflict);
        expect(unwrap(readFactConflict(context, "fact-conflict-missing"))).toBeUndefined();
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("rejects duplicate members, missing facts, and mixed candidates", async () => {
    expect(
      prepareFactConflict(
        conflictDraft({
          members: [
            {
              factConflictMemberId: "fact-conflict-member-1",
              structuredFactId: "structured-fact-1"
            },
            {
              factConflictMemberId: "fact-conflict-member-2",
              structuredFactId: "structured-fact-1"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Fact conflict members must be unique" })
    });
    expect(
      prepareFactConflict(
        conflictDraft({
          members: [
            {
              factConflictMemberId: "fact-conflict-member-1",
              structuredFactId: "structured-fact-1"
            },
            {
              factConflictMemberId: "fact-conflict-member-1",
              structuredFactId: "structured-fact-2"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Fact conflict member IDs must be unique" })
    });
    expect(prepareFactConflict({ factConflictId: "fact-conflict-1" })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid fact conflict input" })
    });
    expect(prepareFactConflict(withThrowingGetter(conflictDraft(), "factConflictId"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Fact conflict preparation failed" })
    });
    expect(hashFactConflictContent([])).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid fact conflict content" })
    });
    expect(
      hashFactConflictContent(["structured-fact-1", "structured-fact-1"]).ok
    ).toBe(true);
    const connection = await openMigratedDatabase();
    const conflict = unwrap(prepareFactConflict(conflictDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(insertFactConflict(context, conflict)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Fact conflict requires stored member facts"
          })
        });
        seedParents(context);
        unwrap(insertStructuredFact(context, unwrap(prepareStructuredFact(factDraft()))));
        unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft({
          candidateId: "candidate-2",
          sourceKey: "tier-one/0002"
        })))));
        unwrap(
          insertStructuredFact(
            context,
            unwrap(
              prepareStructuredFact(
                factDraft({
                  structuredFactId: "structured-fact-2",
                  candidateId: "candidate-2",
                  payload: titlePayload("Principal Engineer"),
                  evidenceSpans: [
                    {
                      structuredFactEvidenceSpanId: "structured-fact-span-2",
                      evidenceSpanId: "evidence-span-1"
                    }
                  ],
                  provenances: [
                    {
                      structuredFactProvenanceId: "structured-fact-provenance-2",
                      source: "parsed",
                      actorId: null
                    }
                  ]
                })
              )
            )
          )
        );
        expect(insertFactConflict(context, conflict)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Fact conflict members must belong to one candidate"
          })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });
});

describe("hard requirement assessment persistence", () => {
  it("stores pass, fail, and evidenceless unknown outcomes", async () => {
    const connection = await openMigratedDatabase();
    const pass = unwrap(prepareHardRequirementAssessment(assessmentDraft()));
    expect(pass.contentHash).toBe(
      unwrap(
        hashHardRequirementAssessmentContent({
          requirementFieldId: "current_title",
          outcome: "pass",
          facts: [{ structuredFactId: "structured-fact-1", polarity: "supporting" }],
          candidateId: "candidate-1"
        })
      )
    );
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedTwoTitleFacts(context);
        unwrap(insertHardRequirementAssessment(context, pass));
        expect(
          unwrap(readHardRequirementAssessment(context, pass.hardRequirementAssessmentId))
        ).toEqual(pass);
        const fail = unwrap(
          prepareHardRequirementAssessment(
            assessmentDraft({
              hardRequirementAssessmentId: "hard-requirement-assessment-fail",
              outcome: "fail",
              facts: [
                {
                  hardRequirementAssessmentFactId: "hard-requirement-assessment-fact-fail",
                  structuredFactId: "structured-fact-2",
                  polarity: "contradicting"
                }
              ]
            })
          )
        );
        unwrap(insertHardRequirementAssessment(context, fail));
        const unknown = unwrap(
          prepareHardRequirementAssessment(
            assessmentDraft({
              hardRequirementAssessmentId: "hard-requirement-assessment-unknown",
              outcome: "unknown",
              facts: []
            })
          )
        );
        unwrap(insertHardRequirementAssessment(context, unknown));
        expect(
          unwrap(readHardRequirementAssessment(context, unknown.hardRequirementAssessmentId)).facts
        ).toEqual([]);
        const twoSupporting = unwrap(
          prepareHardRequirementAssessment(
            assessmentDraft({
              hardRequirementAssessmentId: "hard-requirement-assessment-two",
              facts: [
                {
                  hardRequirementAssessmentFactId: "hard-requirement-assessment-fact-b",
                  structuredFactId: "structured-fact-2",
                  polarity: "supporting"
                },
                {
                  hardRequirementAssessmentFactId: "hard-requirement-assessment-fact-a",
                  structuredFactId: "structured-fact-1",
                  polarity: "supporting"
                }
              ]
            })
          )
        );
        expect(twoSupporting.content.facts.map((fact) => fact.structuredFactId)).toEqual([
          "structured-fact-1",
          "structured-fact-2"
        ]);
        unwrap(insertHardRequirementAssessment(context, twoSupporting));
        expect(
          unwrap(readHardRequirementAssessment(context, twoSupporting.hardRequirementAssessmentId))
        ).toEqual(twoSupporting);
        expect(
          unwrap(readHardRequirementAssessment(context, "hard-requirement-assessment-missing"))
        ).toBeUndefined();
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });

  it("rejects polarity mismatches and facts owned by another candidate", async () => {
    expect(
      prepareHardRequirementAssessment(
        assessmentDraft({
          outcome: "pass",
          facts: [
            {
              hardRequirementAssessmentFactId: "hard-requirement-assessment-fact-1",
              structuredFactId: "structured-fact-1",
              polarity: "contradicting"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Pass assessments require supporting facts and no contradicting facts"
      })
    });
    expect(
      prepareHardRequirementAssessment(
        assessmentDraft({
          outcome: "fail",
          facts: [
            {
              hardRequirementAssessmentFactId: "hard-requirement-assessment-fact-1",
              structuredFactId: "structured-fact-1",
              polarity: "supporting"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Fail assessments require contradicting facts and no supporting facts"
      })
    });
    expect(
      prepareHardRequirementAssessment(
        assessmentDraft({
          facts: [
            {
              hardRequirementAssessmentFactId: "hard-requirement-assessment-fact-1",
              structuredFactId: "structured-fact-1",
              polarity: "supporting"
            },
            {
              hardRequirementAssessmentFactId: "hard-requirement-assessment-fact-2",
              structuredFactId: "structured-fact-1",
              polarity: "supporting"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Hard requirement assessment facts must be unique"
      })
    });
    expect(
      prepareHardRequirementAssessment(
        assessmentDraft({
          facts: [
            {
              hardRequirementAssessmentFactId: "hard-requirement-assessment-fact-1",
              structuredFactId: "structured-fact-1",
              polarity: "supporting"
            },
            {
              hardRequirementAssessmentFactId: "hard-requirement-assessment-fact-1",
              structuredFactId: "structured-fact-2",
              polarity: "supporting"
            }
          ]
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Hard requirement assessment fact IDs must be unique"
      })
    });
    expect(
      prepareHardRequirementAssessment({
        hardRequirementAssessmentId: "hard-requirement-assessment-1"
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid hard requirement assessment input" })
    });
    expect(
      prepareHardRequirementAssessment(
        withThrowingGetter(assessmentDraft(), "hardRequirementAssessmentId")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Hard requirement assessment preparation failed"
      })
    });
    expect(hashHardRequirementAssessmentContent({})).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Invalid hard requirement assessment content"
      })
    });
    expect(
      hashHardRequirementAssessmentContent({
        candidateId: "candidate-1",
        facts: [
          { polarity: "supporting", structuredFactId: "structured-fact-1" },
          { polarity: "contradicting", structuredFactId: "structured-fact-1" }
        ],
        outcome: "unknown",
        requirementFieldId: "current_title"
      }).ok
    ).toBe(true);
    const connection = await openMigratedDatabase();
    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(
          insertHardRequirementAssessment(
            context,
            unwrap(prepareHardRequirementAssessment(assessmentDraft()))
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Hard requirement assessment requires a stored candidate"
          })
        });
        seedParents(context);
        expect(
          insertHardRequirementAssessment(
            context,
            unwrap(prepareHardRequirementAssessment(assessmentDraft()))
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Hard requirement assessment requires stored facts"
          })
        });
        unwrap(insertStructuredFact(context, unwrap(prepareStructuredFact(factDraft()))));
        unwrap(insertCandidate(context, unwrap(prepareCandidate(candidateDraft({
          candidateId: "candidate-2",
          sourceKey: "tier-one/0002"
        })))));
        expect(
          insertHardRequirementAssessment(
            context,
            unwrap(
              prepareHardRequirementAssessment(
                assessmentDraft({
                  candidateId: "candidate-2"
                })
              )
            )
          )
        ).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Hard requirement assessment facts must belong to the candidate"
          })
        });
        expect(
          insertHardRequirementAssessment(
            context,
            unwrap(prepareHardRequirementAssessment(assessmentDraft()))
          )
        ).toEqual({
          ok: true,
          value: expect.objectContaining({ outcome: "pass" })
        });
        return ok(undefined);
      })
    );
    expect(connection.close().ok).toBe(true);
  });
});

describe("structured fact boundary failures", () => {
  it("rejects unprepared records, invalid IDs, and storage faults", () => {
    const fact = unwrap(prepareStructuredFact(factDraft()));
    const conflict = unwrap(prepareFactConflict(conflictDraft()));
    const assessment = unwrap(prepareHardRequirementAssessment(assessmentDraft()));
    const contexts = [undefined, null, {}, { nativeDatabase: null }];
    for (const context of contexts) {
      expect(insertStructuredFact(context, fact)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readStructuredFact(context, "structured-fact-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(insertFactConflict(context, conflict)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(insertHardRequirementAssessment(context, assessment)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readFactConflict(context, "fact-conflict-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readHardRequirementAssessment(context, "hard-requirement-assessment-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readStructuredFactByContentHash(context, fact.contentHash)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
    }
    expect(
      insertStructuredFact({ nativeDatabase: { inTransaction: false } }, fact)
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
    });
    expect(insertStructuredFact(failingContext(), fact)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Structured fact insert failed" })
    });
    expect(insertStructuredFact(failingContext(), { structuredFactId: "structured-fact-1" })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid prepared structured fact" })
    });
    expect(readStructuredFact(failingContext(), "structured-fact-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Structured fact read failed" })
    });
    expect(readStructuredFact(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid structured fact ID" })
    });
    expect(readStructuredFactByContentHash(failingContext(), "not-a-hash")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid structured fact content hash" })
    });
    expect(readStructuredFactByContentHash(failingContext(), fact.contentHash)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Structured fact read failed" })
    });
    expect(readFactConflict(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid fact conflict ID" })
    });
    expect(readFactConflict(failingContext(), "fact-conflict-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Fact conflict read failed" })
    });
    expect(readHardRequirementAssessment(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid hard requirement assessment ID" })
    });
    expect(readHardRequirementAssessment(failingContext(), "hard-requirement-assessment-1")).toEqual(
      {
        ok: false,
        error: expect.objectContaining({ message: "Hard requirement assessment read failed" })
      }
    );
    expect(insertFactConflict(failingContext(), conflict)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Fact conflict insert failed" })
    });
    expect(insertFactConflict(failingContext(), { factConflictId: "fact-conflict-1" })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid prepared fact conflict" })
    });
    expect(insertHardRequirementAssessment(failingContext(), assessment)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Hard requirement assessment insert failed" })
    });
    expect(
      insertHardRequirementAssessment(failingContext(), {
        hardRequirementAssessmentId: "hard-requirement-assessment-1"
      })
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid prepared hard requirement assessment" })
    });
  });
});

describe("structured fact schema checks and immutability", () => {
  it("declares fact tables STRICT and rejects replace, update, and delete", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const fact = unwrap(prepareStructuredFact(factDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        unwrap(insertStructuredFact(context, fact));
        return ok(undefined);
      })
    );
    for (const table of [
      "structured_fact",
      "structured_fact_evidence_span",
      "structured_fact_provenance",
      "fact_conflict",
      "fact_conflict_member",
      "hard_requirement_assessment",
      "hard_requirement_assessment_fact"
    ]) {
      expect(
        database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)
      ).toEqual({ sql: expect.stringContaining("STRICT") });
    }
    expect(() =>
      database
        .prepare(
          `INSERT INTO structured_fact (
            structured_fact_id, candidate_id, kind, semantic_key, payload_json, content_json,
            content_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          fact.structuredFactId,
          fact.candidateId,
          fact.kind,
          fact.semanticKey,
          fact.contentJson,
          fact.contentJson,
          fact.contentHash,
          CREATED_AT
        )
    ).toThrow(/immutable/u);
    expect(() =>
      database.prepare("UPDATE structured_fact SET kind = kind").run()
    ).toThrow(/immutable/u);
    expect(() => database.prepare("DELETE FROM structured_fact").run()).toThrow(/immutable/u);
    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored facts whose denormalized identity drifted", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const fact = unwrap(prepareStructuredFact(factDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        unwrap(insertStructuredFact(context, fact));
        return ok(undefined);
      })
    );
    database.exec("DROP TRIGGER structured_fact_reject_update");
    database.prepare("UPDATE structured_fact SET kind = ?").run("claimed_experience");
    expect(
      runImmediateTransaction(connection, (context) =>
        readStructuredFact(context, fact.structuredFactId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored structured fact failed integrity validation"
      })
    });
    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored facts whose payload or semantic key drifted from hashed content", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const fact = unwrap(prepareStructuredFact(factDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        unwrap(insertStructuredFact(context, fact));
        return ok(undefined);
      })
    );
    database.exec("DROP TRIGGER structured_fact_reject_update");
    database.prepare("UPDATE structured_fact SET semantic_key = ?").run("other-title");
    expect(
      runImmediateTransaction(connection, (context) =>
        readStructuredFact(context, fact.structuredFactId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored structured fact failed integrity validation"
      })
    });
    database.prepare("UPDATE structured_fact SET semantic_key = ?").run(fact.semanticKey);
    database
      .prepare("UPDATE structured_fact SET payload_json = ?")
      .run(JSON.stringify({ kind: "current_title", title: "Other Engineer" }));
    expect(
      runImmediateTransaction(connection, (context) =>
        readStructuredFactByContentHash(context, fact.contentHash)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored structured fact failed integrity validation"
      })
    });
    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored fact content that fails integrity or schema validation", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const fact = unwrap(prepareStructuredFact(factDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedParents(context);
        unwrap(insertStructuredFact(context, fact));
        return ok(undefined);
      })
    );
    rebuildTableWithoutChecks(database, "structured_fact", STRUCTURED_FACT_COLUMNS);
    database.prepare("UPDATE structured_fact SET content_hash = ?").run("a".repeat(64));
    expect(
      runImmediateTransaction(connection, (context) =>
        readStructuredFact(context, fact.structuredFactId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored structured fact failed integrity validation"
      })
    });
    database.prepare("UPDATE structured_fact SET content_json = ?").run("not-json");
    expect(
      runImmediateTransaction(connection, (context) =>
        readStructuredFact(context, fact.structuredFactId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored structured fact content is not valid JSON"
      })
    });
    const pretty = `{\n  "not": "canonical"\n}`;
    database
      .prepare("UPDATE structured_fact SET content_json = ?, content_hash = ?")
      .run(pretty, sha256Hex(pretty));
    expect(
      runImmediateTransaction(connection, (context) =>
        readStructuredFact(context, fact.structuredFactId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored structured fact failed integrity validation"
      })
    });
    const unsafeNumber = '{"n":9007199254740993}';
    database
      .prepare("UPDATE structured_fact SET content_json = ?, content_hash = ?")
      .run(unsafeNumber, sha256Hex(unsafeNumber));
    expect(
      runImmediateTransaction(connection, (context) =>
        readStructuredFact(context, fact.structuredFactId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored structured fact failed integrity validation"
      })
    });
    const invalidObject = '{"candidateId":"candidate-1"}';
    database
      .prepare("UPDATE structured_fact SET content_json = ?, content_hash = ?")
      .run(invalidObject, sha256Hex(invalidObject));
    expect(
      runImmediateTransaction(connection, (context) =>
        readStructuredFact(context, fact.structuredFactId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored structured fact is invalid" })
    });
    database
      .prepare(
        "UPDATE structured_fact SET content_json = ?, content_hash = ?, payload_json = ?"
      )
      .run(fact.contentJson, fact.contentHash, "not-json");
    expect(
      runImmediateTransaction(connection, (context) =>
        readStructuredFact(context, fact.structuredFactId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored structured fact payload is not valid JSON"
      })
    });
    database
      .prepare("UPDATE structured_fact SET payload_json = ?")
      .run(JSON.stringify({ kind: "current_title" }));
    expect(
      runImmediateTransaction(connection, (context) =>
        readStructuredFact(context, fact.structuredFactId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored structured fact is invalid" })
    });
    database
      .prepare(
        "UPDATE structured_fact SET payload_json = ?, content_json = ?, content_hash = ?, candidate_id = ?"
      )
      .run(JSON.stringify(fact.payload), fact.contentJson, fact.contentHash, "candidate-2");
    expect(
      runImmediateTransaction(connection, (context) =>
        readStructuredFact(context, fact.structuredFactId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored structured fact failed integrity validation"
      })
    });
    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored conflict content that fails integrity or member matching", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const conflict = unwrap(prepareFactConflict(conflictDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedTwoTitleFacts(context);
        unwrap(insertFactConflict(context, conflict));
        return ok(undefined);
      })
    );
    rebuildTableWithoutChecks(database, "fact_conflict", FACT_CONFLICT_COLUMNS);
    database.prepare("UPDATE fact_conflict SET content_json = ?").run("not-json");
    expect(
      runImmediateTransaction(connection, (context) =>
        readFactConflict(context, conflict.factConflictId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored fact conflict content is not valid JSON"
      })
    });
    const pretty = `{\n  "memberIds": ["structured-fact-1", "structured-fact-2"]\n}`;
    database
      .prepare("UPDATE fact_conflict SET content_json = ?, content_hash = ?")
      .run(pretty, sha256Hex(pretty));
    expect(
      runImmediateTransaction(connection, (context) =>
        readFactConflict(context, conflict.factConflictId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored fact conflict failed integrity validation"
      })
    });
    const invalidObject = '{"memberIds":[1,2]}';
    database
      .prepare("UPDATE fact_conflict SET content_json = ?, content_hash = ?")
      .run(invalidObject, sha256Hex(invalidObject));
    expect(
      runImmediateTransaction(connection, (context) =>
        readFactConflict(context, conflict.factConflictId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored fact conflict is invalid" })
    });
    const mismatched = JSON.stringify({
      memberIds: ["structured-fact-2", "structured-fact-3"]
    });
    database
      .prepare("UPDATE fact_conflict SET content_json = ?, content_hash = ?")
      .run(mismatched, sha256Hex(mismatched));
    expect(
      runImmediateTransaction(connection, (context) =>
        readFactConflict(context, conflict.factConflictId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored fact conflict failed integrity validation"
      })
    });
    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored assessment content that fails integrity or denormalized matching", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const assessment = unwrap(prepareHardRequirementAssessment(assessmentDraft()));
    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedTwoTitleFacts(context);
        unwrap(insertHardRequirementAssessment(context, assessment));
        return ok(undefined);
      })
    );
    rebuildTableWithoutChecks(
      database,
      "hard_requirement_assessment",
      HARD_REQUIREMENT_ASSESSMENT_COLUMNS
    );
    database.prepare("UPDATE hard_requirement_assessment SET content_json = ?").run("not-json");
    expect(
      runImmediateTransaction(connection, (context) =>
        readHardRequirementAssessment(context, assessment.hardRequirementAssessmentId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored hard requirement assessment content is not valid JSON"
      })
    });
    const pretty = `{\n  "candidateId": "candidate-1"\n}`;
    database
      .prepare("UPDATE hard_requirement_assessment SET content_json = ?, content_hash = ?")
      .run(pretty, sha256Hex(pretty));
    expect(
      runImmediateTransaction(connection, (context) =>
        readHardRequirementAssessment(context, assessment.hardRequirementAssessmentId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored hard requirement assessment failed integrity validation"
      })
    });
    const invalidObject = '{"candidateId":"candidate-1"}';
    database
      .prepare("UPDATE hard_requirement_assessment SET content_json = ?, content_hash = ?")
      .run(invalidObject, sha256Hex(invalidObject));
    expect(
      runImmediateTransaction(connection, (context) =>
        readHardRequirementAssessment(context, assessment.hardRequirementAssessmentId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored hard requirement assessment is invalid"
      })
    });
    const mismatched = JSON.stringify({
      candidateId: "candidate-1",
      facts: [
        { polarity: "supporting", structuredFactId: "structured-fact-2" }
      ],
      outcome: "pass",
      requirementFieldId: "current_title"
    });
    database
      .prepare("UPDATE hard_requirement_assessment SET content_json = ?, content_hash = ?")
      .run(mismatched, sha256Hex(mismatched));
    expect(
      runImmediateTransaction(connection, (context) =>
        readHardRequirementAssessment(context, assessment.hardRequirementAssessmentId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored hard requirement assessment failed integrity validation"
      })
    });
    database
      .prepare(
        "UPDATE hard_requirement_assessment SET content_json = ?, content_hash = ?, outcome = ?"
      )
      .run(assessment.contentJson, assessment.contentHash, "fail");
    expect(
      runImmediateTransaction(connection, (context) =>
        readHardRequirementAssessment(context, assessment.hardRequirementAssessmentId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored hard requirement assessment failed integrity validation"
      })
    });
    database
      .prepare(
        "UPDATE hard_requirement_assessment SET outcome = ?, requirement_field_id = ?"
      )
      .run("pass", "years_experience");
    expect(
      runImmediateTransaction(connection, (context) =>
        readHardRequirementAssessment(context, assessment.hardRequirementAssessmentId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored hard requirement assessment failed integrity validation"
      })
    });
    database
      .prepare(
        "UPDATE hard_requirement_assessment SET requirement_field_id = ?, candidate_id = ?"
      )
      .run("current_title", "candidate-2");
    expect(
      runImmediateTransaction(connection, (context) =>
        readHardRequirementAssessment(context, assessment.hardRequirementAssessmentId)
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored hard requirement assessment failed integrity validation"
      })
    });
    expect(connection.close().ok).toBe(true);
  });
});
