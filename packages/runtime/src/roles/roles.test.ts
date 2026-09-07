import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DRAFT_RUBRIC_V1, err, ok, type Result } from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runImmediateTransaction, type ImmediateTransactionContext } from "../commands/index.js";
import { openRuntimeDatabase, type RuntimeDatabaseConnection } from "../db/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  insertRequirement,
  insertRole,
  insertRubric,
  insertRubricDimension,
  prepareRequirement,
  prepareRole,
  prepareRubric,
  prepareRubricDimension,
  readCoreRubric,
  readRequirement,
  readRole,
  readRubric,
  readRubricDimension
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-roles-test-"));
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

function roleDraft(overrides: Record<string, unknown> = {}) {
  return {
    roleId: "role-applied-ai-engineer",
    title: "Applied AI Engineer",
    createdAt: 1_788_700_000_000,
    ...overrides
  };
}

function requirementDraft(overrides: Record<string, unknown> = {}) {
  return {
    requirementId: "requirement-work-authorization",
    roleId: "role-applied-ai-engineer",
    kind: "hard",
    description: "Must be authorized to work in the United States.",
    createdAt: 1_788_700_000_000,
    ...overrides
  };
}

function rubricDraft(overrides: Record<string, unknown> = {}) {
  return {
    rubricId: "rubric-sample",
    roleId: "role-applied-ai-engineer",
    version: "test-v1",
    createdAt: 1_788_700_000_000,
    ...overrides
  };
}

function dimensionDraft(overrides: Record<string, unknown> = {}) {
  return {
    rubricDimensionId: "rubric-dimension-sample",
    rubricId: "rubric-sample",
    dimensionId: "sample_dimension",
    weight: 2,
    required: true,
    definition: "A sample dimension definition.",
    jobRelatedJustification: "It is job related for the sample role.",
    ordinal: 0,
    createdAt: 1_788_700_000_000,
    ...overrides
  };
}

function seedRole(context: ImmediateTransactionContext): void {
  unwrap(insertRole(context, unwrap(prepareRole(roleDraft()))));
}

function seedRoleAndRubric(context: ImmediateTransactionContext): void {
  seedRole(context);
  unwrap(insertRubric(context, unwrap(prepareRubric(rubricDraft()))));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("role and rubric preparation", () => {
  it("trims role titles and requirement descriptions", () => {
    const role = unwrap(prepareRole(roleDraft({ title: "  Applied AI Engineer  " })));
    expect(role.title).toBe("Applied AI Engineer");
    expect(Object.isFrozen(role)).toBe(true);

    const requirement = unwrap(
      prepareRequirement(requirementDraft({ description: "  Must be authorized.  " }))
    );
    expect(requirement.description).toBe("Must be authorized.");
    expect(requirement.kind).toBe("hard");
  });

  it("rejects empty titles, unknown kinds, and blank versions", () => {
    expect(prepareRole(roleDraft({ title: "   " }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid role input" })
    });
    expect(prepareRequirement(requirementDraft({ kind: "optional" }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid requirement input" })
    });
    expect(prepareRubric(rubricDraft({ version: "   " }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid rubric input" })
    });
    expect(prepareRubricDimension(dimensionDraft({ weight: 0 }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid rubric dimension input" })
    });
  });

  it("validates dimension prose against the core RubricDimension model", () => {
    const trimmed = unwrap(
      prepareRubricDimension(
        dimensionDraft({
          definition: "  Padded definition.  ",
          jobRelatedJustification: "  Padded justification.  "
        })
      )
    );
    expect(trimmed.definition).toBe("Padded definition.");
    expect(trimmed.jobRelatedJustification).toBe("Padded justification.");
    expect(Object.isFrozen(trimmed)).toBe(true);

    expect(prepareRubricDimension(dimensionDraft({ definition: "   " }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid rubric dimension input" })
    });
    expect(
      prepareRubricDimension(dimensionDraft({ jobRelatedJustification: "a".repeat(2001) }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid rubric dimension input" })
    });
  });
});

describe("role and rubric persistence", () => {
  it("stores a role, requirements, and a rubric that round-trips to core", async () => {
    const connection = await openMigratedDatabase();

    const stored = unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRole(context);
        const hard = unwrap(
          insertRequirement(context, unwrap(prepareRequirement(requirementDraft())))
        );
        const scored = unwrap(
          insertRequirement(
            context,
            unwrap(
              prepareRequirement(
                requirementDraft({
                  requirementId: "requirement-production-experience",
                  kind: "scored",
                  description: "Evidence of shipping production software."
                })
              )
            )
          )
        );
        unwrap(
          insertRubric(
            context,
            unwrap(
              prepareRubric(
                rubricDraft({
                  rubricId: DRAFT_RUBRIC_V1.rubricId,
                  version: DRAFT_RUBRIC_V1.version
                })
              )
            )
          )
        );
        for (const [ordinal, dimension] of DRAFT_RUBRIC_V1.dimensions.entries()) {
          unwrap(
            insertRubricDimension(
              context,
              unwrap(
                prepareRubricDimension({
                  rubricDimensionId: `rubric-dimension-draft-${ordinal}`,
                  rubricId: DRAFT_RUBRIC_V1.rubricId,
                  dimensionId: dimension.dimensionId,
                  weight: dimension.weight,
                  required: dimension.required,
                  definition: dimension.definition,
                  jobRelatedJustification: dimension.jobRelatedJustification,
                  ordinal,
                  createdAt: 1_788_700_000_000
                })
              )
            )
          );
        }
        return ok({ hard, scored });
      })
    );

    expect(stored.hard.kind).toBe("hard");
    expect(stored.scored.kind).toBe("scored");

    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(unwrap(readRole(context, "role-applied-ai-engineer"))?.title).toBe(
          "Applied AI Engineer"
        );
        expect(unwrap(readRequirement(context, stored.hard.requirementId))).toEqual(stored.hard);
        expect(unwrap(readRubric(context, DRAFT_RUBRIC_V1.rubricId))?.version).toBe("draft-v1");
        expect(unwrap(readCoreRubric(context, DRAFT_RUBRIC_V1.rubricId))).toEqual(DRAFT_RUBRIC_V1);
        expect(
          unwrap(readRubricDimension(context, "rubric-dimension-draft-0"))?.required
        ).toBe(true);
        expect(
          unwrap(readRubricDimension(context, "rubric-dimension-draft-3"))?.required
        ).toBe(false);
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("round-trips a non-product one-dimension rubric", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRoleAndRubric(context);
        unwrap(
          insertRubricDimension(context, unwrap(prepareRubricDimension(dimensionDraft())))
        );
        return ok(undefined);
      })
    );

    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(unwrap(readCoreRubric(context, "rubric-sample"))).toEqual({
          rubricId: "rubric-sample",
          version: "test-v1",
          dimensions: [
            {
              dimensionId: "sample_dimension",
              weight: 2,
              required: true,
              definition: "A sample dimension definition.",
              jobRelatedJustification: "It is job related for the sample role."
            }
          ]
        });
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("returns undefined rather than an error for a row that does not exist", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(unwrap(readRole(context, "missing-role"))).toBeUndefined();
        expect(unwrap(readRequirement(context, "missing-requirement"))).toBeUndefined();
        expect(unwrap(readRubric(context, "missing-rubric"))).toBeUndefined();
        expect(unwrap(readRubricDimension(context, "missing-dimension"))).toBeUndefined();
        expect(unwrap(readCoreRubric(context, "missing-rubric"))).toBeUndefined();
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("rejects malformed identifiers on every read", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(readRole(context, "")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid role ID" })
        });
        expect(readRequirement(context, 42)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid requirement ID" })
        });
        expect(readRubric(context, "has space")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid rubric ID" })
        });
        expect(readRubricDimension(context, null)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid rubric dimension ID" })
        });
        expect(readCoreRubric(context, "has space")).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid rubric ID" })
        });
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("refuses inserts outside an active transaction", async () => {
    const connection = await openMigratedDatabase();
    const message = "Role and rubric rows require an active command transaction";
    const contexts = [undefined, null, {}, { nativeDatabase: null }];
    const role = unwrap(prepareRole(roleDraft()));

    for (const context of contexts) {
      expect(insertRole(context, role)).toEqual({
        ok: false,
        error: expect.objectContaining({ message })
      });
    }

    expect(connection.close().ok).toBe(true);
  });

  it("refuses every read and write outside an active transaction", async () => {
    const connection = await openMigratedDatabase();
    const message = "Role and rubric rows require an active command transaction";
    const contexts = [undefined, null, {}, { nativeDatabase: null }];
    const writes = [
      [insertRole, unwrap(prepareRole(roleDraft()))],
      [insertRequirement, unwrap(prepareRequirement(requirementDraft()))],
      [insertRubric, unwrap(prepareRubric(rubricDraft()))],
      [insertRubricDimension, unwrap(prepareRubricDimension(dimensionDraft()))]
    ] as const;
    const reads = [
      readRole,
      readRequirement,
      readRubric,
      readRubricDimension,
      readCoreRubric
    ];

    for (const context of contexts) {
      for (const [insert, prepared] of writes) {
        expect(insert(context, prepared)).toEqual({
          ok: false,
          error: expect.objectContaining({ message })
        });
      }
      for (const read of reads) {
        expect(read(context, "any-id")).toEqual({
          ok: false,
          error: expect.objectContaining({ message })
        });
      }
    }

    expect(connection.close().ok).toBe(true);
  });

  it("refuses records the runtime did not prepare, including cross-entity records", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        const role = unwrap(prepareRole(roleDraft()));
        const requirement = unwrap(prepareRequirement(requirementDraft()));
        const rubric = unwrap(prepareRubric(rubricDraft()));
        const dimension = unwrap(prepareRubricDimension(dimensionDraft()));

        expect(insertRole(context, { ...role })).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared role" })
        });
        expect(insertRole(context, requirement)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared role" })
        });
        expect(insertRequirement(context, { ...requirement })).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared requirement" })
        });
        expect(insertRequirement(context, role)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared requirement" })
        });
        expect(insertRubric(context, { ...rubric })).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared rubric" })
        });
        expect(insertRubric(context, dimension)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared rubric" })
        });
        expect(insertRubricDimension(context, { ...dimension })).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared rubric dimension" })
        });
        expect(insertRubricDimension(context, rubric)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Invalid prepared rubric dimension" })
        });
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("rolls back every role and rubric row when the command fails", async () => {
    const connection = await openMigratedDatabase();

    const failed = runImmediateTransaction<never>(connection, (context) => {
      seedRoleAndRubric(context);
      unwrap(insertRequirement(context, unwrap(prepareRequirement(requirementDraft()))));
      unwrap(
        insertRubricDimension(context, unwrap(prepareRubricDimension(dimensionDraft())))
      );
      return err(createRuntimeError("command_conflict", "Command rejected", false));
    });

    expect(failed).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "command_conflict" })
    });

    for (const table of ["role", "requirement", "rubric", "rubric_dimension"]) {
      expect(
        nativeDatabase(connection).prepare(`SELECT count(*) AS total FROM ${table}`).get()
      ).toEqual({ total: 0 });
    }

    expect(connection.close().ok).toBe(true);
  });
});

describe("role and rubric database constraints", () => {
  it("rejects a second role or rubric that reuses an identity key", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRoleAndRubric(context);
        return ok(undefined);
      })
    );

    expect(
      runImmediateTransaction(connection, (context) =>
        insertRole(context, unwrap(prepareRole(roleDraft({ title: "Copy" }))))
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Role insert failed" })
    });

    expect(
      runImmediateTransaction(connection, (context) =>
        insertRubric(
          context,
          unwrap(prepareRubric(rubricDraft({ rubricId: "rubric-other", version: "test-v1" })))
        )
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Rubric insert failed" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a requirement or dimension whose parent does not exist", async () => {
    const connection = await openMigratedDatabase();

    expect(
      runImmediateTransaction(connection, (context) =>
        insertRequirement(context, unwrap(prepareRequirement(requirementDraft())))
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Requirement insert failed" })
    });

    expect(
      runImmediateTransaction(connection, (context) =>
        insertRubric(context, unwrap(prepareRubric(rubricDraft())))
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Rubric insert failed" })
    });

    expect(
      runImmediateTransaction(connection, (context) =>
        insertRubricDimension(context, unwrap(prepareRubricDimension(dimensionDraft())))
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Rubric dimension insert failed" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a reused requirement identity or dimension ordinal", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRoleAndRubric(context);
        unwrap(insertRequirement(context, unwrap(prepareRequirement(requirementDraft()))));
        unwrap(
          insertRubricDimension(context, unwrap(prepareRubricDimension(dimensionDraft())))
        );
        return ok(undefined);
      })
    );

    expect(
      runImmediateTransaction(connection, (context) =>
        insertRequirement(
          context,
          unwrap(
            prepareRequirement(
              requirementDraft({ description: "A different description." })
            )
          )
        )
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Requirement insert failed" })
    });

    expect(
      runImmediateTransaction(connection, (context) =>
        insertRubricDimension(
          context,
          unwrap(
            prepareRubricDimension(
              dimensionDraft({
                rubricDimensionId: "rubric-dimension-other",
                dimensionId: "other_dimension"
              })
            )
          )
        )
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Rubric dimension insert failed" })
    });

    expect(connection.close().ok).toBe(true);
  });
});

describe("role and rubric table declarations", () => {
  it("declares every role and rubric table STRICT", async () => {
    const connection = await openMigratedDatabase();

    for (const table of ["role", "requirement", "rubric", "rubric_dimension"]) {
      expect(
        nativeDatabase(connection)
          .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(table)
      ).toEqual({ sql: expect.stringContaining("STRICT") });
    }

    expect(connection.close().ok).toBe(true);
  });
});

describe("role and rubric boundary failures", () => {
  it("converts hostile draft getters into typed preparation errors", () => {
    expect(prepareRole(withThrowingGetter(roleDraft(), "roleId"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Role preparation failed" })
    });
    expect(
      prepareRequirement(withThrowingGetter(requirementDraft(), "requirementId"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Requirement preparation failed" })
    });
    expect(prepareRubric(withThrowingGetter(rubricDraft(), "rubricId"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Rubric preparation failed" })
    });
    expect(
      prepareRubricDimension(withThrowingGetter(dimensionDraft(), "dimensionId"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Rubric dimension preparation failed" })
    });
  });

  it("converts a failing database read into a typed error", () => {
    const failingContext = {
      nativeDatabase: {
        inTransaction: true,
        prepare() {
          throw new Error("disk I/O error");
        }
      }
    };

    expect(readRole(failingContext, "role-applied-ai-engineer")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Role read failed" })
    });
    expect(readRequirement(failingContext, "requirement-work-authorization")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Requirement read failed" })
    });
    expect(readRubric(failingContext, "rubric-sample")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Rubric read failed" })
    });
    expect(readRubricDimension(failingContext, "rubric-dimension-sample")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Rubric dimension read failed" })
    });
    expect(readCoreRubric(failingContext, "rubric-sample")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Rubric read failed" })
    });
  });

  it("converts a failing dimension query into a typed core-rubric read error", () => {
    const failingContext = {
      nativeDatabase: {
        inTransaction: true,
        prepare(sql: string) {
          if (sql.includes("FROM rubric_dimension")) {
            throw new Error("disk I/O error");
          }
          return {
            get() {
              return {
                rubricId: "rubric-sample",
                roleId: "role-applied-ai-engineer",
                version: "test-v1",
                createdAt: 1_788_700_000_000
              };
            }
          };
        }
      }
    };

    expect(readCoreRubric(failingContext, "rubric-sample")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Rubric read failed" })
    });
  });
});

describe("stored role and rubric validation", () => {
  const astralOverTitle = "\u{1F600}".repeat(150);
  const astralOverVersion = "\u{1F600}".repeat(40);
  const astralOverProse = "\u{1F600}".repeat(1500);

  it("rejects a stored role whose title is out of domain range", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRole(context);
        return ok(undefined);
      })
    );

    expect(astralOverTitle.length).toBe(300);
    database.exec("DROP TRIGGER role_reject_update");
    database
      .prepare("UPDATE role SET title = ? WHERE role_id = ?")
      .run(astralOverTitle, "role-applied-ai-engineer");

    expect(
      runImmediateTransaction(connection, (context) =>
        readRole(context, "role-applied-ai-engineer")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored role is invalid" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a stored requirement whose description is out of domain range", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRole(context);
        unwrap(insertRequirement(context, unwrap(prepareRequirement(requirementDraft()))));
        return ok(undefined);
      })
    );

    database.exec("DROP TRIGGER requirement_reject_update");
    database
      .prepare("UPDATE requirement SET description = ? WHERE requirement_id = ?")
      .run(astralOverProse, "requirement-work-authorization");

    expect(
      runImmediateTransaction(connection, (context) =>
        readRequirement(context, "requirement-work-authorization")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored requirement is invalid" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a stored rubric whose version is out of domain range", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRoleAndRubric(context);
        return ok(undefined);
      })
    );

    database.exec("DROP TRIGGER rubric_reject_update");
    database
      .prepare("UPDATE rubric SET version = ? WHERE rubric_id = ?")
      .run(astralOverVersion, "rubric-sample");

    expect(
      runImmediateTransaction(connection, (context) => readRubric(context, "rubric-sample"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored rubric is invalid" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a stored dimension whose definition is out of domain range", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRoleAndRubric(context);
        unwrap(
          insertRubricDimension(context, unwrap(prepareRubricDimension(dimensionDraft())))
        );
        return ok(undefined);
      })
    );

    database.exec("DROP TRIGGER rubric_dimension_reject_update");
    database
      .prepare("UPDATE rubric_dimension SET definition = ? WHERE rubric_dimension_id = ?")
      .run(astralOverProse, "rubric-dimension-sample");

    expect(
      runImmediateTransaction(connection, (context) =>
        readRubricDimension(context, "rubric-dimension-sample")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored rubric dimension is invalid" })
    });

    expect(
      runImmediateTransaction(connection, (context) =>
        readCoreRubric(context, "rubric-sample")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored rubric dimension is invalid" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a stored rubric with no dimensions or a non-zero first ordinal", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRoleAndRubric(context);
        return ok(undefined);
      })
    );

    expect(
      runImmediateTransaction(connection, (context) =>
        readCoreRubric(context, "rubric-sample")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored rubric has no dimensions" })
    });

    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(
          insertRubricDimension(
            context,
            unwrap(prepareRubricDimension(dimensionDraft({ ordinal: 1 })))
          )
        );
        return ok(undefined);
      })
    );

    expect(
      runImmediateTransaction(connection, (context) =>
        readCoreRubric(context, "rubric-sample")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Rubric dimension ordinals must start at 0"
      })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a stored rubric whose dimension ordinals are not contiguous", async () => {
    const connection = await openMigratedDatabase();

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRoleAndRubric(context);
        unwrap(
          insertRubricDimension(context, unwrap(prepareRubricDimension(dimensionDraft())))
        );
        unwrap(
          insertRubricDimension(
            context,
            unwrap(
              prepareRubricDimension(
                dimensionDraft({
                  rubricDimensionId: "rubric-dimension-gap",
                  dimensionId: "gapped_dimension",
                  ordinal: 2
                })
              )
            )
          )
        );
        return ok(undefined);
      })
    );

    expect(
      runImmediateTransaction(connection, (context) =>
        readCoreRubric(context, "rubric-sample")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Rubric dimension ordinals must be contiguous"
      })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects a stored rubric whose dimension ids are not unique", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedRoleAndRubric(context);
        unwrap(
          insertRubricDimension(context, unwrap(prepareRubricDimension(dimensionDraft())))
        );
        return ok(undefined);
      })
    );

    database.exec("DROP TRIGGER rubric_dimension_reject_replace");
    database.exec("DROP INDEX rubric_dimension_rubric_dimension_id_unique");
    database
      .prepare(
        `INSERT INTO rubric_dimension (
          rubric_dimension_id, rubric_id, dimension_id, weight, required,
          definition, job_related_justification, ordinal, created_at
        ) VALUES (?, ?, ?, 1, 0, 'Other definition.', 'Other justification.', 1, ?)`
      )
      .run(
        "rubric-dimension-duplicate",
        "rubric-sample",
        "sample_dimension",
        1_788_700_000_000
      );

    expect(
      runImmediateTransaction(connection, (context) =>
        readCoreRubric(context, "rubric-sample")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored rubric is invalid" })
    });

    expect(connection.close().ok).toBe(true);
  });
});
