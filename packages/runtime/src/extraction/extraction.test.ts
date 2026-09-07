import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_JSON_MAX_NODES,
  EXTRACTION_LIMITS,
  canonicalJsonSha256,
  canonicalJsonStringify,
  ok,
  sha256Hex,
  type Result
} from "@recruitos/core";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runImmediateTransaction, type ImmediateTransactionContext } from "../commands/index.js";
import { openRuntimeDatabase, type RuntimeDatabaseConnection } from "../db/index.js";
import { insertSourceDocument, prepareSourceDocument } from "../entities/index.js";
import { type RuntimeError } from "../errors/index.js";
import {
  hashExtractionSpecContent,
  insertExtractionArtifact,
  insertExtractionFailure,
  insertExtractionSpec,
  prepareExtractionArtifact,
  prepareExtractionFailure,
  prepareExtractionSpec,
  readExtractionArtifact,
  readExtractionArtifactByContentHash,
  readExtractionFailure,
  readExtractionFailureByContentHash,
  readExtractionSpec,
  readExtractionSpecByContentHash,
  validateExtractionSpecContent
} from "./index.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];
const CREATED_AT = 1_788_700_000_000;
const DOCUMENT_TEXT = "ABCDEFGHIJ";
const PROMPT_HASH = sha256Hex("prompt-template-v1");
const SCHEMA_HASH = sha256Hex("extraction-output-schema-v1");
const RESPONSE_HASH = sha256Hex("provider-body");
const TRANSACTION_REQUIRED = "Extraction spec rows require an active command transaction";

async function openMigratedDatabase(): Promise<RuntimeDatabaseConnection> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-extraction-spec-test-"));
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

function unwrapHash(result: ReturnType<typeof canonicalJsonSha256>): string {
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

function specContent(overrides: Record<string, unknown> = {}) {
  return {
    modelId: "test-extractor",
    extractorVersion: "extractor-v1",
    promptTemplateVersion: "prompt-v1",
    promptHash: PROMPT_HASH,
    schemaHash: SCHEMA_HASH,
    dimensionId: "evaluation_practice",
    dimensionDefinition: "Evidence of structured evaluation practice.",
    jobRelatedJustification: "Hiring managers review evaluation quality.",
    limits: { ...EXTRACTION_LIMITS },
    ...overrides
  };
}

function specDraft(overrides: Record<string, unknown> = {}) {
  return {
    extractionSpecId: "extraction-spec-1",
    content: specContent(),
    createdAt: CREATED_AT,
    ...overrides
  };
}

function supportingSpan(overrides: Record<string, unknown> = {}) {
  return {
    start: 2,
    end: 5,
    quotedText: "CDE",
    polarity: "supporting",
    matchQuality: "exact",
    ...overrides
  };
}

function acceptedOutput(overrides: Record<string, unknown> = {}) {
  return {
    dimensionId: "evaluation_practice",
    proposedLevel: "partial",
    spans: [supportingSpan()],
    ...overrides
  };
}

function rejectedClaim(overrides: Record<string, unknown> = {}) {
  return {
    kind: "unlocated_quote",
    quotedText: "missing quote",
    reason: "quote was not found in normalized text",
    ...overrides
  };
}

function artifactDraft(overrides: Record<string, unknown> = {}) {
  return {
    extractionArtifactId: "extraction-artifact-1",
    specId: "extraction-spec-1",
    sourceDocumentId: "source-document-1",
    acceptedOutput: acceptedOutput(),
    rejectedClaims: [rejectedClaim()],
    createdAt: CREATED_AT,
    ...overrides
  };
}

function diagnostic(overrides: Record<string, unknown> = {}) {
  return {
    summary: "Provider output failed schema validation",
    details: ["unknown field score"],
    ...overrides
  };
}

function failureDraft(overrides: Record<string, unknown> = {}) {
  return {
    extractionFailureId: "extraction-failure-1",
    specId: "extraction-spec-1",
    sourceDocumentId: "source-document-1",
    errorClass: "structurally_invalid",
    responseHash: RESPONSE_HASH,
    responseByteLength: 128,
    diagnostic: diagnostic(),
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

function seedDocument(
  context: ImmediateTransactionContext,
  overrides: Record<string, unknown> = {}
): void {
  unwrap(
    insertSourceDocument(context, unwrap(prepareSourceDocument(sourceDocumentDraft(overrides))))
  );
}

function seedSpec(
  context: ImmediateTransactionContext,
  overrides: Record<string, unknown> = {}
): void {
  unwrap(insertExtractionSpec(context, unwrap(prepareExtractionSpec(specDraft(overrides)))));
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("extraction spec preparation", () => {
  it("hashes spec content without weights and independently of field order", () => {
    const spec = unwrap(
      prepareExtractionSpec(
        specDraft({
          content: specContent({
            modelId: "  test-extractor  ",
            dimensionDefinition: "  Evidence of structured evaluation practice.  "
          })
        })
      )
    );
    expect(spec.modelId).toBe("test-extractor");
    expect(spec.content.dimensionDefinition).toBe("Evidence of structured evaluation practice.");
    expect(spec.contentJson.includes("weight")).toBe(false);
    const canonicalContent = canonicalJsonStringify(spec.content);
    expect(canonicalContent.ok).toBe(true);
    if (canonicalContent.ok) {
      expect(spec.contentJson).toBe(canonicalContent.value);
    }
    expect(spec.contentHash).toBe(unwrap(hashExtractionSpecContent(specContent())));
    expect(Object.isFrozen(spec)).toBe(true);

    const reordered = unwrap(
      hashExtractionSpecContent({
        limits: { ...EXTRACTION_LIMITS },
        schemaHash: SCHEMA_HASH,
        promptHash: PROMPT_HASH,
        dimensionId: "evaluation_practice",
        jobRelatedJustification: "Hiring managers review evaluation quality.",
        dimensionDefinition: "Evidence of structured evaluation practice.",
        promptTemplateVersion: "prompt-v1",
        extractorVersion: "extractor-v1",
        modelId: "test-extractor"
      })
    );
    expect(reordered).toBe(spec.contentHash);
    expect(
      unwrap(
        hashExtractionSpecContent(
          specContent({ dimensionDefinition: "A different evaluation-practice definition." })
        )
      )
    ).not.toBe(spec.contentHash);
  });

  it("rejects weights, unknown fields, and non-v1 limits", () => {
    expect(validateExtractionSpecContent({ ...specContent(), weight: 20 })).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Extraction spec content must not include weights"
      })
    });
    expect(validateExtractionSpecContent(specContent({ extra: true }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid extraction spec content" })
    });
    expect(
      validateExtractionSpecContent(
        specContent({ limits: { ...EXTRACTION_LIMITS, maxEvidenceItems: 11 } })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid extraction spec content" })
    });
    expect(prepareExtractionSpec(specDraft({ extractionSpecId: "" }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid extraction spec input" })
    });
    expect(hashExtractionSpecContent(specContent({ modelId: "" }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid extraction spec content" })
    });
    expect(hashExtractionSpecContent({ ...specContent(), weight: 20 })).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Extraction spec content must not include weights"
      })
    });
    expect(
      prepareExtractionSpec(specDraft({ content: { ...specContent(), weight: 20 } }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Extraction spec content must not include weights"
      })
    });

    const oversized: Record<string, unknown> = specContent();
    for (let index = 0; index < CANONICAL_JSON_MAX_NODES; index += 1) {
      oversized[`extra-${index}`] = index;
    }
    expect(hashExtractionSpecContent(oversized)).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Extraction spec content is not canonical JSON"
      })
    });
    expect(validateExtractionSpecContent(oversized)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid extraction spec content" })
    });
  });
});

describe("extraction artifact and failure preparation", () => {
  it("hashes accepted output together with bounded rejected claims", () => {
    const artifact = unwrap(prepareExtractionArtifact(artifactDraft()));
    expect(artifact.rejectedClaims).toEqual([rejectedClaim()]);
    expect(artifact.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(artifact)).toBe(true);

    const emptyRejected = unwrap(
      prepareExtractionArtifact(artifactDraft({ rejectedClaims: [] }))
    );
    expect(emptyRejected.rejectedClaimsJson).toBe("[]");
    expect(emptyRejected.contentHash).not.toBe(artifact.contentHash);

    const noneLevel = unwrap(
      prepareExtractionArtifact(
        artifactDraft({
          acceptedOutput: acceptedOutput({ proposedLevel: "none", spans: [] })
        })
      )
    );
    expect(noneLevel.acceptedOutput.spans).toEqual([]);
  });

  it("rejects empty intervals, missing support, and over-capacity collections", () => {
    expect(prepareExtractionArtifact(artifactDraft({ specId: "" }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid extraction artifact input" })
    });
    expect(
      prepareExtractionArtifact(
        artifactDraft({
          acceptedOutput: acceptedOutput({ spans: [supportingSpan({ start: 4, end: 4 })] })
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Extraction artifact span end must exceed its start"
      })
    });
    expect(
      prepareExtractionArtifact(
        artifactDraft({
          acceptedOutput: acceptedOutput({
            proposedLevel: "strong",
            spans: [supportingSpan({ polarity: "contradicting" })]
          })
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Non-none extraction artifacts require a located supporting span"
      })
    });

    const extraSpan = supportingSpan({ start: 5, end: 8, quotedText: "FGH" });
    expect(
      prepareExtractionArtifact(
        artifactDraft({
          acceptedOutput: acceptedOutput({
            spans: Array.from({ length: EXTRACTION_LIMITS.maxEvidenceItems + 1 }, () => extraSpan)
          })
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Extraction artifact spans exceed the work-item evidence limit"
      })
    });
    expect(
      prepareExtractionArtifact(
        artifactDraft({
          rejectedClaims: Array.from(
            { length: EXTRACTION_LIMITS.maxValidationDetails + 1 },
            () => rejectedClaim()
          )
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Extraction artifact rejected claims exceed the validation-detail limit"
      })
    });
  });

  it("rejects collection payloads that cannot be canonicalized", () => {
    const oversizedSpans = Array.from(
      { length: Math.ceil(CANONICAL_JSON_MAX_NODES / 4) },
      (_, index) => supportingSpan({ quotedText: `span-${index}` })
    );
    expect(
      prepareExtractionArtifact(
        artifactDraft({ acceptedOutput: acceptedOutput({ spans: oversizedSpans }) })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Extraction artifact accepted output is not canonical JSON"
      })
    });

    const oversizedClaims = Array.from(
      { length: Math.ceil(CANONICAL_JSON_MAX_NODES / 4) },
      (_, index) => rejectedClaim({ quotedText: `claim-${index}` })
    );
    expect(prepareExtractionArtifact(artifactDraft({ rejectedClaims: oversizedClaims }))).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Extraction artifact rejected claims are not canonical JSON"
      })
    });

    const oversizedDetails = Array.from(
      { length: CANONICAL_JSON_MAX_NODES },
      (_, index) => `detail-${index}`
    );
    expect(
      prepareExtractionFailure(failureDraft({ diagnostic: diagnostic({ details: oversizedDetails }) }))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Extraction failure diagnostic is not canonical JSON"
      })
    });

    const combinedSpans = Array.from({ length: 1_600 }, (_, index) =>
      supportingSpan({ quotedText: `span-${index}` })
    );
    const combinedClaims = Array.from({ length: 1_600 }, (_, index) =>
      rejectedClaim({ quotedText: `claim-${index}` })
    );
    expect(
      prepareExtractionArtifact(
        artifactDraft({
          acceptedOutput: acceptedOutput({ spans: combinedSpans }),
          rejectedClaims: combinedClaims
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Extraction artifact content is not canonical JSON"
      })
    });

    const combinedDetails = Array.from(
      { length: CANONICAL_JSON_MAX_NODES - 5 },
      (_, index) => `detail-${index}`
    );
    expect(
      prepareExtractionFailure(
        failureDraft({ diagnostic: diagnostic({ details: combinedDetails }) })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Extraction failure content is not canonical JSON"
      })
    });
  });

  it("rejects oversized-class mismatches and over-capacity diagnostics", () => {
    expect(prepareExtractionFailure(failureDraft({ extractionFailureId: "" }))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid extraction failure input" })
    });
    expect(
      prepareExtractionFailure(
        failureDraft({ errorClass: "oversized_response", responseByteLength: 128 })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message:
          "Oversized extraction failures must record a response larger than the provider byte cap"
      })
    });
    expect(
      prepareExtractionFailure(
        failureDraft({
          errorClass: "structurally_invalid",
          responseByteLength: EXTRACTION_LIMITS.maxProviderResponseBytes + 1
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message:
          "Oversized extraction failures must record a response larger than the provider byte cap"
      })
    });
    expect(
      prepareExtractionFailure(
        failureDraft({
          diagnostic: diagnostic({
            details: Array.from(
              { length: EXTRACTION_LIMITS.maxValidationDetails + 1 },
              (_, index) => `detail-${index}`
            )
          })
        })
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Extraction failure diagnostic details exceed the validation-detail limit"
      })
    });

    const oversized = unwrap(
      prepareExtractionFailure(
        failureDraft({
          errorClass: "oversized_response",
          responseByteLength: EXTRACTION_LIMITS.maxProviderResponseBytes + 1
        })
      )
    );
    expect(oversized.errorClass).toBe("oversized_response");
  });
});

describe("extraction spec persistence", () => {
  it("stores and reads specs, artifacts, and failures by ID and content hash", async () => {
    const connection = await openMigratedDatabase();
    const spec = unwrap(prepareExtractionSpec(specDraft()));
    const artifact = unwrap(prepareExtractionArtifact(artifactDraft()));
    const failure = unwrap(prepareExtractionFailure(failureDraft()));

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        expect(insertExtractionSpec(context, spec)).toEqual({ ok: true, value: spec });
        expect(insertExtractionArtifact(context, artifact)).toEqual({ ok: true, value: artifact });
        expect(insertExtractionFailure(context, failure)).toEqual({ ok: true, value: failure });

        expect(readExtractionSpec(context, spec.extractionSpecId)).toEqual({
          ok: true,
          value: spec
        });
        expect(readExtractionSpecByContentHash(context, spec.contentHash)).toEqual({
          ok: true,
          value: spec
        });
        expect(readExtractionArtifact(context, artifact.extractionArtifactId)).toEqual({
          ok: true,
          value: artifact
        });
        expect(readExtractionArtifactByContentHash(context, artifact.contentHash)).toEqual({
          ok: true,
          value: artifact
        });
        expect(readExtractionFailure(context, failure.extractionFailureId)).toEqual({
          ok: true,
          value: failure
        });
        expect(readExtractionFailureByContentHash(context, failure.contentHash)).toEqual({
          ok: true,
          value: failure
        });
        expect(readExtractionSpec(context, "missing-spec")).toEqual({ ok: true, value: undefined });
        expect(readExtractionSpecByContentHash(context, sha256Hex("missing"))).toEqual({
          ok: true,
          value: undefined
        });
        expect(readExtractionArtifact(context, "missing-artifact")).toEqual({
          ok: true,
          value: undefined
        });
        expect(readExtractionArtifactByContentHash(context, sha256Hex("missing"))).toEqual({
          ok: true,
          value: undefined
        });
        expect(readExtractionFailure(context, "missing-failure")).toEqual({
          ok: true,
          value: undefined
        });
        expect(readExtractionFailureByContentHash(context, sha256Hex("missing"))).toEqual({
          ok: true,
          value: undefined
        });
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("allows fuzzy spans that are not exact slices and rejects exact mismatches", async () => {
    const connection = await openMigratedDatabase();
    const fuzzy = unwrap(
      prepareExtractionArtifact(
        artifactDraft({
          extractionArtifactId: "extraction-artifact-fuzzy",
          acceptedOutput: acceptedOutput({
            spans: [supportingSpan({ quotedText: "cde", matchQuality: "fuzzy" })]
          })
        })
      )
    );
    const exactMismatch = unwrap(
      prepareExtractionArtifact(
        artifactDraft({
          extractionArtifactId: "extraction-artifact-mismatch",
          acceptedOutput: acceptedOutput({
            spans: [supportingSpan({ quotedText: "XYZ", matchQuality: "exact" })]
          })
        })
      )
    );

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        seedSpec(context);
        expect(insertExtractionArtifact(context, fuzzy).ok).toBe(true);
        expect(insertExtractionArtifact(context, exactMismatch)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Exact extraction artifact quote is not a slice of the document"
          })
        });
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("rejects artifacts and failures that lack their spec, document, or dimension", async () => {
    const connection = await openMigratedDatabase();
    const artifact = unwrap(prepareExtractionArtifact(artifactDraft()));
    const wrongDimension = unwrap(
      prepareExtractionArtifact(
        artifactDraft({
          extractionArtifactId: "extraction-artifact-wrong-dimension",
          acceptedOutput: acceptedOutput({ dimensionId: "systems_thinking" })
        })
      )
    );
    const outOfRange = unwrap(
      prepareExtractionArtifact(
        artifactDraft({
          extractionArtifactId: "extraction-artifact-range",
          acceptedOutput: acceptedOutput({
            spans: [
              supportingSpan({
                start: 0,
                end: 50,
                quotedText: "ABCDEFGHIJ",
                matchQuality: "normalized"
              })
            ]
          })
        })
      )
    );
    const failure = unwrap(prepareExtractionFailure(failureDraft()));

    unwrap(
      runImmediateTransaction(connection, (context) => {
        expect(insertExtractionArtifact(context, artifact)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Extraction artifact requires a stored extraction spec"
          })
        });
        seedSpec(context);
        expect(insertExtractionArtifact(context, artifact)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Extraction artifact requires a stored source document"
          })
        });
        expect(insertExtractionFailure(context, failure)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Extraction failure requires a stored source document"
          })
        });
        seedDocument(context);
        expect(insertExtractionArtifact(context, wrongDimension)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Extraction artifact dimension must match the spec dimension"
          })
        });
        expect(insertExtractionArtifact(context, outOfRange)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Extraction artifact span offsets do not address the stored document"
          })
        });
        expect(insertExtractionFailure(context, failure).ok).toBe(true);
        return ok(undefined);
      })
    );

    unwrap(
      runImmediateTransaction(connection, (context) => {
        const orphanFailure = unwrap(
          prepareExtractionFailure(
            failureDraft({
              extractionFailureId: "extraction-failure-orphan",
              specId: "missing-spec"
            })
          )
        );
        expect(insertExtractionFailure(context, orphanFailure)).toEqual({
          ok: false,
          error: expect.objectContaining({
            message: "Extraction failure requires a stored extraction spec"
          })
        });
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });

  it("rejects duplicate content hashes as immutability collisions", async () => {
    const connection = await openMigratedDatabase();
    const spec = unwrap(prepareExtractionSpec(specDraft()));
    const duplicateSpec = unwrap(
      prepareExtractionSpec(specDraft({ extractionSpecId: "extraction-spec-2" }))
    );

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        unwrap(insertExtractionSpec(context, spec));
        expect(insertExtractionSpec(context, duplicateSpec)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Extraction spec insert failed" })
        });

        const artifact = unwrap(prepareExtractionArtifact(artifactDraft()));
        unwrap(insertExtractionArtifact(context, artifact));
        const duplicateArtifact = unwrap(
          prepareExtractionArtifact(
            artifactDraft({ extractionArtifactId: "extraction-artifact-2" })
          )
        );
        expect(insertExtractionArtifact(context, duplicateArtifact)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Extraction artifact insert failed" })
        });

        const failure = unwrap(prepareExtractionFailure(failureDraft()));
        unwrap(insertExtractionFailure(context, failure));
        const duplicateFailure = unwrap(
          prepareExtractionFailure(
            failureDraft({ extractionFailureId: "extraction-failure-2" })
          )
        );
        expect(insertExtractionFailure(context, duplicateFailure)).toEqual({
          ok: false,
          error: expect.objectContaining({ message: "Extraction failure insert failed" })
        });
        return ok(undefined);
      })
    );

    expect(connection.close().ok).toBe(true);
  });
});

describe("extraction spec database constraints", () => {
  it("rejects updates, deletes, and replacements of stored rows", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        seedSpec(context);
        unwrap(insertExtractionArtifact(context, unwrap(prepareExtractionArtifact(artifactDraft()))));
        unwrap(insertExtractionFailure(context, unwrap(prepareExtractionFailure(failureDraft()))));
        return ok(undefined);
      })
    );

    expect(() =>
      database.prepare("UPDATE extraction_spec SET model_id = 'tampered' WHERE extraction_spec_id = ?").run(
        "extraction-spec-1"
      )
    ).toThrow(/extraction_spec is immutable/u);
    expect(() =>
      database.prepare("DELETE FROM extraction_spec WHERE extraction_spec_id = ?").run("extraction-spec-1")
    ).toThrow(/extraction_spec is immutable/u);
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO extraction_spec (
            extraction_spec_id, content_json, content_hash, model_id, extractor_version,
            prompt_hash, schema_hash, dimension_id, created_at
          ) VALUES (?, '{}', ?, 'other', 'extractor-v1', ?, ?, 'evaluation_practice', 1)`
        )
        .run("extraction-spec-1", sha256Hex("{}"), PROMPT_HASH, SCHEMA_HASH)
    ).toThrow(/extraction_spec is immutable/u);

    expect(() =>
      database
        .prepare("UPDATE extraction_artifact SET spec_id = 'other' WHERE extraction_artifact_id = ?")
        .run("extraction-artifact-1")
    ).toThrow(/extraction_artifact is immutable/u);
    expect(() =>
      database
        .prepare("DELETE FROM extraction_artifact WHERE extraction_artifact_id = ?")
        .run("extraction-artifact-1")
    ).toThrow(/extraction_artifact is immutable/u);
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO extraction_artifact (
            extraction_artifact_id, spec_id, source_document_id, accepted_output_json,
            accepted_output_hash, rejected_claims_json, rejected_claims_hash, content_hash, created_at
          ) VALUES (?, 'extraction-spec-1', 'source-document-1', '{}', ?, '[]', ?, ?, 1)`
        )
        .run(
          "extraction-artifact-1",
          sha256Hex("{}"),
          sha256Hex("[]"),
          sha256Hex("content")
        )
    ).toThrow(/extraction_artifact is immutable/u);

    expect(() =>
      database
        .prepare("UPDATE extraction_failure SET error_class = 'identity_mismatch' WHERE extraction_failure_id = ?")
        .run("extraction-failure-1")
    ).toThrow(/extraction_failure is immutable/u);
    expect(() =>
      database
        .prepare("DELETE FROM extraction_failure WHERE extraction_failure_id = ?")
        .run("extraction-failure-1")
    ).toThrow(/extraction_failure is immutable/u);
    expect(() =>
      database
        .prepare(
          `INSERT OR REPLACE INTO extraction_failure (
            extraction_failure_id, spec_id, source_document_id, error_class, response_hash,
            response_byte_length, diagnostic_json, diagnostic_hash, content_hash, created_at
          ) VALUES (?, 'extraction-spec-1', 'source-document-1', 'identity_mismatch', ?, 1, '{}', ?, ?, 1)`
        )
        .run("extraction-failure-1", RESPONSE_HASH, sha256Hex("{}"), sha256Hex("content"))
    ).toThrow(/extraction_failure is immutable/u);

    expect(connection.close().ok).toBe(true);
  });

  it("enforces JSON shape, unique hashes, and the oversized-response byte cap", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        seedSpec(context);
        return ok(undefined);
      })
    );

    expect(() =>
      database
        .prepare(
          `INSERT INTO extraction_spec (
            extraction_spec_id, content_json, content_hash, model_id, extractor_version,
            prompt_hash, schema_hash, dimension_id, created_at
          ) VALUES ('extraction-spec-array', '[]', ?, 'test-extractor', 'extractor-v1', ?, ?, 'evaluation_practice', ?)`
        )
        .run(sha256Hex("[]"), PROMPT_HASH, SCHEMA_HASH, CREATED_AT)
    ).toThrow(/CHECK constraint failed/u);

    expect(() =>
      database
        .prepare(
          `INSERT INTO extraction_failure (
            extraction_failure_id, spec_id, source_document_id, error_class, response_hash,
            response_byte_length, diagnostic_json, diagnostic_hash, content_hash, created_at
          ) VALUES (
            'extraction-failure-oversize', 'extraction-spec-1', 'source-document-1',
            'oversized_response', ?, 128, '{"details":[],"summary":"too big"}', ?, ?, ?
          )`
        )
        .run(
          RESPONSE_HASH,
          sha256Hex('{"details":[],"summary":"too big"}'),
          sha256Hex("content"),
          CREATED_AT
        )
    ).toThrow(/CHECK constraint failed/u);

    expect(connection.close().ok).toBe(true);
  });

  it("declares every extraction contract table STRICT", async () => {
    const connection = await openMigratedDatabase();
    for (const table of ["extraction_spec", "extraction_artifact", "extraction_failure"]) {
      expect(
        nativeDatabase(connection)
          .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(table)
      ).toEqual({ sql: expect.stringContaining("STRICT") });
    }
    expect(connection.close().ok).toBe(true);
  });
});

describe("extraction spec boundary failures", () => {
  it("converts hostile draft getters into typed preparation errors", () => {
    expect(prepareExtractionSpec(withThrowingGetter(specDraft(), "extractionSpecId"))).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Extraction spec preparation failed" })
    });
    expect(
      prepareExtractionArtifact(withThrowingGetter(artifactDraft(), "extractionArtifactId"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Extraction artifact preparation failed" })
    });
    expect(
      prepareExtractionFailure(withThrowingGetter(failureDraft(), "extractionFailureId"))
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Extraction failure preparation failed" })
    });
  });

  it("refuses every read and write outside an active transaction", () => {
    const spec = unwrap(prepareExtractionSpec(specDraft()));
    const artifact = unwrap(prepareExtractionArtifact(artifactDraft()));
    const failure = unwrap(prepareExtractionFailure(failureDraft()));
    const contexts = [undefined, null, {}, { nativeDatabase: null }];

    for (const context of contexts) {
      expect(insertExtractionSpec(context, spec)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(insertExtractionArtifact(context, artifact)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(insertExtractionFailure(context, failure)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readExtractionSpec(context, "extraction-spec-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readExtractionSpecByContentHash(context, spec.contentHash)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readExtractionArtifact(context, "extraction-artifact-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readExtractionArtifactByContentHash(context, artifact.contentHash)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readExtractionFailure(context, "extraction-failure-1")).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
      expect(readExtractionFailureByContentHash(context, failure.contentHash)).toEqual({
        ok: false,
        error: expect.objectContaining({ message: TRANSACTION_REQUIRED })
      });
    }
  });

  it("rejects unprepared records, invalid IDs, and storage faults", () => {
    const spec = unwrap(prepareExtractionSpec(specDraft()));
    const artifact = unwrap(prepareExtractionArtifact(artifactDraft()));
    const failure = unwrap(prepareExtractionFailure(failureDraft()));

    expect(insertExtractionSpec(failingContext(), spec)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Extraction spec insert failed" })
    });
    expect(insertExtractionSpec(failingContext(), { extractionSpecId: "extraction-spec-1" })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid prepared extraction spec" })
    });
    expect(insertExtractionArtifact(failingContext(), { extractionArtifactId: "x" })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid prepared extraction artifact" })
    });
    expect(insertExtractionFailure(failingContext(), { extractionFailureId: "x" })).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid prepared extraction failure" })
    });
    expect(insertExtractionArtifact(failingContext(), artifact)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Extraction artifact insert failed" })
    });
    expect(insertExtractionFailure(failingContext(), failure)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Extraction failure insert failed" })
    });

    expect(readExtractionSpec(failingContext(), "extraction-spec-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Extraction spec read failed" })
    });
    expect(readExtractionSpec(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid extraction spec ID" })
    });
    expect(readExtractionSpecByContentHash(failingContext(), "not-a-hash")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid extraction spec content hash" })
    });
    expect(readExtractionSpecByContentHash(failingContext(), spec.contentHash)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Extraction spec read failed" })
    });
    expect(readExtractionArtifact(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid extraction artifact ID" })
    });
    expect(readExtractionArtifactByContentHash(failingContext(), "not-a-hash")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid extraction artifact content hash" })
    });
    expect(readExtractionArtifact(failingContext(), "extraction-artifact-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Extraction artifact read failed" })
    });
    expect(readExtractionArtifactByContentHash(failingContext(), artifact.contentHash)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Extraction artifact read failed" })
    });
    expect(readExtractionFailure(failingContext(), "")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid extraction failure ID" })
    });
    expect(readExtractionFailureByContentHash(failingContext(), "not-a-hash")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid extraction failure content hash" })
    });
    expect(readExtractionFailure(failingContext(), "extraction-failure-1")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Extraction failure read failed" })
    });
    expect(readExtractionFailureByContentHash(failingContext(), failure.contentHash)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Extraction failure read failed" })
    });
  });
});

describe("stored extraction contract validation", () => {
  it("rejects a stored spec whose denormalized identity drifted from hashed content", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertExtractionSpec(context, unwrap(prepareExtractionSpec(specDraft()))));
        return ok(undefined);
      })
    );

    database.exec("DROP TRIGGER extraction_spec_reject_update");
    database
      .prepare("UPDATE extraction_spec SET model_id = ? WHERE extraction_spec_id = ?")
      .run("other-extractor", "extraction-spec-1");

    expect(
      runImmediateTransaction(connection, (context) =>
        readExtractionSpec(context, "extraction-spec-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction spec failed integrity validation"
      })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored spec content that fails integrity validation", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertExtractionSpec(context, unwrap(prepareExtractionSpec(specDraft()))));
        return ok(undefined);
      })
    );

    database.exec("DROP TRIGGER extraction_spec_reject_update");
    database
      .prepare("UPDATE extraction_spec SET content_hash = ? WHERE extraction_spec_id = ?")
      .run("a".repeat(64), "extraction-spec-1");

    expect(
      runImmediateTransaction(connection, (context) =>
        readExtractionSpec(context, "extraction-spec-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction spec failed integrity validation"
      })
    });

    const nonCanonical = '{ "modelId" : "test-extractor" }';
    database
      .prepare(
        "UPDATE extraction_spec SET content_json = ?, content_hash = ? WHERE extraction_spec_id = ?"
      )
      .run(nonCanonical, sha256Hex(nonCanonical), "extraction-spec-1");

    expect(
      runImmediateTransaction(connection, (context) =>
        readExtractionSpec(context, "extraction-spec-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction spec failed integrity validation"
      })
    });

    const unsafeNumber = '{"n":9007199254740993}';
    database
      .prepare(
        "UPDATE extraction_spec SET content_json = ?, content_hash = ? WHERE extraction_spec_id = ?"
      )
      .run(unsafeNumber, sha256Hex(unsafeNumber), "extraction-spec-1");

    expect(
      runImmediateTransaction(connection, (context) =>
        readExtractionSpec(context, "extraction-spec-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction spec failed integrity validation"
      })
    });

    const malformed = '{"dimensionId":1}';
    database
      .prepare(
        "UPDATE extraction_spec SET content_json = ?, content_hash = ? WHERE extraction_spec_id = ?"
      )
      .run(malformed, sha256Hex(malformed), "extraction-spec-1");

    expect(
      runImmediateTransaction(connection, (context) =>
        readExtractionSpec(context, "extraction-spec-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Stored extraction spec is invalid" })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored spec content that is not valid JSON", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        unwrap(insertExtractionSpec(context, unwrap(prepareExtractionSpec(specDraft()))));
        return ok(undefined);
      })
    );

    database.exec(`
      CREATE TABLE extraction_spec_rebuilt (
        extraction_spec_id text PRIMARY KEY NOT NULL,
        content_json text NOT NULL,
        content_hash text NOT NULL,
        model_id text NOT NULL,
        extractor_version text NOT NULL,
        prompt_hash text NOT NULL,
        schema_hash text NOT NULL,
        dimension_id text NOT NULL,
        created_at integer NOT NULL
      ) STRICT;
      INSERT INTO extraction_spec_rebuilt SELECT * FROM extraction_spec;
      DROP TABLE extraction_spec;
      ALTER TABLE extraction_spec_rebuilt RENAME TO extraction_spec;
    `);
    database
      .prepare("UPDATE extraction_spec SET content_json = ?, content_hash = ?")
      .run("{", sha256Hex("{"));

    expect(
      runImmediateTransaction(connection, (context) =>
        readExtractionSpec(context, "extraction-spec-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction spec content is not valid JSON"
      })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects stored artifacts and failures whose hashes no longer match", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        seedSpec(context);
        unwrap(insertExtractionArtifact(context, unwrap(prepareExtractionArtifact(artifactDraft()))));
        unwrap(insertExtractionFailure(context, unwrap(prepareExtractionFailure(failureDraft()))));
        return ok(undefined);
      })
    );

    database.exec("DROP TRIGGER extraction_artifact_reject_update");
    database.exec("DROP TRIGGER extraction_failure_reject_update");

    database
      .prepare("UPDATE extraction_artifact SET content_hash = ? WHERE extraction_artifact_id = ?")
      .run("b".repeat(64), "extraction-artifact-1");
    expect(
      runImmediateTransaction(connection, (context) =>
        readExtractionArtifact(context, "extraction-artifact-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction artifact failed integrity validation"
      })
    });

    database
      .prepare(
        "UPDATE extraction_artifact SET accepted_output_hash = ? WHERE extraction_artifact_id = ?"
      )
      .run("c".repeat(64), "extraction-artifact-1");
    expect(
      runImmediateTransaction(connection, (context) =>
        readExtractionArtifactByContentHash(context, "b".repeat(64))
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction artifact failed integrity validation"
      })
    });

    database
      .prepare("UPDATE extraction_failure SET content_hash = ? WHERE extraction_failure_id = ?")
      .run("e".repeat(64), "extraction-failure-1");
    expect(
      runImmediateTransaction(connection, (context) =>
        readExtractionFailure(context, "extraction-failure-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction failure failed integrity validation"
      })
    });

    database
      .prepare("UPDATE extraction_failure SET diagnostic_hash = ? WHERE extraction_failure_id = ?")
      .run("f".repeat(64), "extraction-failure-1");
    expect(
      runImmediateTransaction(connection, (context) =>
        readExtractionFailureByContentHash(context, "e".repeat(64))
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction failure failed integrity validation"
      })
    });

    expect(connection.close().ok).toBe(true);
  });
});

describe("stored extraction JSON rebuilds", () => {
  it("rejects stored artifacts and failures whose JSON is missing or invalid", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const artifact = unwrap(prepareExtractionArtifact(artifactDraft()));

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        seedSpec(context);
        unwrap(insertExtractionArtifact(context, artifact));
        unwrap(insertExtractionFailure(context, unwrap(prepareExtractionFailure(failureDraft()))));
        return ok(undefined);
      })
    );

    database.exec(`
      CREATE TABLE extraction_artifact_rebuilt (
        extraction_artifact_id text PRIMARY KEY NOT NULL,
        spec_id text NOT NULL,
        source_document_id text NOT NULL,
        accepted_output_json text NOT NULL,
        accepted_output_hash text NOT NULL,
        rejected_claims_json text NOT NULL,
        rejected_claims_hash text NOT NULL,
        content_hash text NOT NULL,
        created_at integer NOT NULL
      ) STRICT;
      INSERT INTO extraction_artifact_rebuilt SELECT * FROM extraction_artifact;
      DROP TABLE extraction_artifact;
      ALTER TABLE extraction_artifact_rebuilt RENAME TO extraction_artifact;
      CREATE TABLE extraction_failure_rebuilt (
        extraction_failure_id text PRIMARY KEY NOT NULL,
        spec_id text NOT NULL,
        source_document_id text NOT NULL,
        error_class text NOT NULL,
        response_hash text NOT NULL,
        response_byte_length integer NOT NULL,
        diagnostic_json text NOT NULL,
        diagnostic_hash text NOT NULL,
        content_hash text NOT NULL,
        created_at integer NOT NULL
      ) STRICT;
      INSERT INTO extraction_failure_rebuilt SELECT * FROM extraction_failure;
      DROP TABLE extraction_failure;
      ALTER TABLE extraction_failure_rebuilt RENAME TO extraction_failure;
    `);

    database
      .prepare("UPDATE extraction_artifact SET accepted_output_json = ?, accepted_output_hash = ?")
      .run("{", sha256Hex("{"));
    expect(
      runImmediateTransaction(connection, (context) =>
        readExtractionArtifact(context, "extraction-artifact-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction artifact accepted output is not valid JSON"
      })
    });

    database
      .prepare(
        `UPDATE extraction_artifact
         SET accepted_output_json = ?, accepted_output_hash = ?, rejected_claims_json = ?, rejected_claims_hash = ?`
      )
      .run(artifact.acceptedOutputJson, artifact.acceptedOutputHash, "{", sha256Hex("{"));
    expect(
      runImmediateTransaction(connection, (context) =>
        readExtractionArtifact(context, "extraction-artifact-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction artifact rejected claims are not valid JSON"
      })
    });

    const invalidAccepted = '{"dimensionId":1,"proposedLevel":"none","spans":[]}';
    const invalidAcceptedObject = { dimensionId: 1, proposedLevel: "none", spans: [] };
    const rejectedObject = JSON.parse(artifact.rejectedClaimsJson) as unknown;
    const invalidArtifactContentHash = unwrapHash(
      canonicalJsonSha256({
        acceptedOutput: invalidAcceptedObject,
        rejectedClaims: rejectedObject
      })
    );
    database
      .prepare(
        `UPDATE extraction_artifact
         SET accepted_output_json = ?, accepted_output_hash = ?, rejected_claims_json = ?, rejected_claims_hash = ?, content_hash = ?`
      )
      .run(
        invalidAccepted,
        sha256Hex(invalidAccepted),
        artifact.rejectedClaimsJson,
        artifact.rejectedClaimsHash,
        invalidArtifactContentHash
      );
    expect(
      runImmediateTransaction(connection, (context) =>
        readExtractionArtifact(context, "extraction-artifact-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction artifact is invalid"
      })
    });

    database
      .prepare("UPDATE extraction_failure SET diagnostic_json = ?, diagnostic_hash = ?")
      .run("{", sha256Hex("{"));
    expect(
      runImmediateTransaction(connection, (context) =>
        readExtractionFailure(context, "extraction-failure-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction failure diagnostic is not valid JSON"
      })
    });

    const parsedInvalid = '{"details":[],"summary":"x"}';
    const invalidFailureContentHash = unwrapHash(
      canonicalJsonSha256({
        diagnostic: { details: [], summary: "x" },
        errorClass: "not_a_class",
        responseByteLength: 128,
        responseHash: RESPONSE_HASH
      })
    );
    database
      .prepare(
        `UPDATE extraction_failure
         SET diagnostic_json = ?, diagnostic_hash = ?, error_class = ?, content_hash = ?`
      )
      .run(
        parsedInvalid,
        sha256Hex(parsedInvalid),
        "not_a_class",
        invalidFailureContentHash
      );
    expect(
      runImmediateTransaction(connection, (context) =>
        readExtractionFailure(context, "extraction-failure-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction failure is invalid"
      })
    });

    expect(connection.close().ok).toBe(true);
  });

  it("rejects remapped stored payloads that cannot be recanonicalized", async () => {
    const connection = await openMigratedDatabase();
    const database = nativeDatabase(connection);
    const artifact = unwrap(prepareExtractionArtifact(artifactDraft()));
    const failure = unwrap(prepareExtractionFailure(failureDraft()));

    unwrap(
      runImmediateTransaction(connection, (context) => {
        seedDocument(context);
        seedSpec(context);
        unwrap(insertExtractionArtifact(context, artifact));
        unwrap(insertExtractionFailure(context, failure));
        return ok(undefined);
      })
    );

    database.exec(`
      CREATE TABLE extraction_artifact_rebuilt (
        extraction_artifact_id text PRIMARY KEY NOT NULL,
        spec_id text NOT NULL,
        source_document_id text NOT NULL,
        accepted_output_json text NOT NULL,
        accepted_output_hash text NOT NULL,
        rejected_claims_json text NOT NULL,
        rejected_claims_hash text NOT NULL,
        content_hash text NOT NULL,
        created_at integer NOT NULL
      ) STRICT;
      INSERT INTO extraction_artifact_rebuilt SELECT * FROM extraction_artifact;
      DROP TABLE extraction_artifact;
      ALTER TABLE extraction_artifact_rebuilt RENAME TO extraction_artifact;
      CREATE TABLE extraction_failure_rebuilt (
        extraction_failure_id text PRIMARY KEY NOT NULL,
        spec_id text NOT NULL,
        source_document_id text NOT NULL,
        error_class text NOT NULL,
        response_hash text NOT NULL,
        response_byte_length integer NOT NULL,
        diagnostic_json text NOT NULL,
        diagnostic_hash text NOT NULL,
        content_hash text NOT NULL,
        created_at integer NOT NULL
      ) STRICT;
      INSERT INTO extraction_failure_rebuilt SELECT * FROM extraction_failure;
      DROP TABLE extraction_failure;
      ALTER TABLE extraction_failure_rebuilt RENAME TO extraction_failure;
    `);

    const emptySpanAccepted =
      '{"dimensionId":"evaluation_practice","proposedLevel":"none","spans":[{}]}';
    database
      .prepare(
        `UPDATE extraction_artifact
         SET accepted_output_json = ?, accepted_output_hash = ?, rejected_claims_json = ?, rejected_claims_hash = ?`
      )
      .run(emptySpanAccepted, sha256Hex(emptySpanAccepted), "[]", sha256Hex("[]"));
    expect(
      runImmediateTransaction(connection, (context) =>
        readExtractionArtifact(context, "extraction-artifact-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction artifact failed integrity validation"
      })
    });

    const missingSummary = '{"details":[]}';
    database
      .prepare("UPDATE extraction_failure SET diagnostic_json = ?, diagnostic_hash = ?")
      .run(missingSummary, sha256Hex(missingSummary));
    expect(
      runImmediateTransaction(connection, (context) =>
        readExtractionFailure(context, "extraction-failure-1")
      )
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Stored extraction failure failed integrity validation"
      })
    });

    expect(connection.close().ok).toBe(true);
  });
});
