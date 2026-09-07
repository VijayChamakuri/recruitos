import { sha256Hex } from "@recruitos/core";
import { describe, expect, it } from "vitest";

import type { CandidateSourceRecord } from "./candidate-source.js";
import {
  createFixtureExtractionAdapter,
  FIXTURE_EXTRACTION_ADAPTER_ID,
  FIXTURE_EXTRACTION_CONTRACT_VERSION,
  FixtureExtractionAdapter
} from "./fixture-extraction.js";
import {
  createSyntheticCandidateSourceAdapter,
  SYNTHETIC_CANDIDATE_SOURCE_ADAPTER_ID,
  SYNTHETIC_CANDIDATE_SOURCE_CONTRACT_VERSION,
  SYNTHETIC_CANDIDATE_SOURCE_SYSTEM,
  SyntheticCandidateSourceAdapter
} from "./synthetic-candidate-source.js";

describe("FixtureExtractionAdapter", () => {
  it("initializes with default descriptor and empty fixtures", () => {
    const adapter = createFixtureExtractionAdapter();
    expect(adapter.descriptor).toEqual({
      adapterId: FIXTURE_EXTRACTION_ADAPTER_ID,
      mode: "fixture",
      contractVersion: FIXTURE_EXTRACTION_CONTRACT_VERSION
    });
    expect(adapter.hasFixture("unknown-hash")).toBe(false);
  });

  it("accepts custom options and Map of fixtures", () => {
    const fixtureMap = new Map([["hash-1", "output-body-1"]]);
    const adapter = new FixtureExtractionAdapter({
      adapterId: "custom-extractor",
      contractVersion: 2,
      fixtures: fixtureMap
    });
    expect(adapter.descriptor).toEqual({
      adapterId: "custom-extractor",
      mode: "fixture",
      contractVersion: 2
    });
    expect(adapter.hasFixture("hash-1")).toBe(true);
  });

  it("accepts an object dictionary of fixtures", () => {
    const adapter = createFixtureExtractionAdapter({
      fixtures: { "hash-obj": "output-obj" }
    });
    expect(adapter.hasFixture("hash-obj")).toBe(true);
  });

  it("registers fixtures dynamically with validation", () => {
    const adapter = createFixtureExtractionAdapter();
    adapter.registerFixture("spec-123", "result-payload");
    expect(adapter.hasFixture("spec-123")).toBe(true);

    expect(() => adapter.registerFixture("", "body")).toThrow(
      /non-empty string/
    );
    expect(() =>
      adapter.registerFixture(123 as unknown as string, "body")
    ).toThrow(/non-empty string/);
    expect(() =>
      adapter.registerFixture("spec-123", 456 as unknown as string)
    ).toThrow(/must be a string/);
  });

  it("extracts a registered fixture and returns deterministic body and hash", async () => {
    const body = JSON.stringify({ test: "data" });
    const specHash = "spec-abc";
    const adapter = createFixtureExtractionAdapter({
      fixtures: { [specHash]: body }
    });

    const result = await adapter.extract({
      extractionSpecHash: specHash,
      instructions: "Extract skills",
      documents: [
        {
          documentId: "doc-1",
          documentKind: "resume",
          normalizedText: "Experience with Python",
          normalizedHash: sha256Hex("Experience with Python")
        }
      ]
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.extractionSpecHash).toBe(specHash);
      expect(result.value.body).toBe(body);
      expect(result.value.bodyHash).toBe(sha256Hex(body));
      expect(result.value.descriptor).toEqual(adapter.descriptor);
    }
  });

  it("returns typed error on fixture miss", async () => {
    const adapter = createFixtureExtractionAdapter();
    const result = await adapter.extract({
      extractionSpecHash: "missing-hash",
      instructions: "Extract skills",
      documents: []
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("persistence_failed");
      expect(result.error.message).toContain("missing-hash");
      expect(result.error.details?.extractionSpecHash).toBe("missing-hash");
    }
  });

  it("validates request shape and returns typed errors", async () => {
    const adapter = createFixtureExtractionAdapter();

    const nullResult = await adapter.extract(
      null as unknown as {
        extractionSpecHash: string;
        instructions: string;
        documents: [];
      }
    );
    expect(nullResult.ok).toBe(false);
    if (!nullResult.ok) {
      expect(nullResult.error.message).toContain("non-null object");
    }

    const invalidHashResult = await adapter.extract({
      extractionSpecHash: "",
      instructions: "Extract",
      documents: []
    });
    expect(invalidHashResult.ok).toBe(false);
    if (!invalidHashResult.ok) {
      expect(invalidHashResult.error.message).toContain(
        "non-empty extractionSpecHash"
      );
    }

    const invalidDocsResult = await adapter.extract({
      extractionSpecHash: "hash-1",
      instructions: "Extract",
      documents: "not-an-array" as unknown as []
    });
    expect(invalidDocsResult.ok).toBe(false);
    if (!invalidDocsResult.ok) {
      expect(invalidDocsResult.error.message).toContain("must be an array");
    }

    const invalidInstructionsResult = await adapter.extract({
      extractionSpecHash: "hash-1",
      instructions: 123 as unknown as string,
      documents: []
    });
    expect(invalidInstructionsResult.ok).toBe(false);
    if (!invalidInstructionsResult.ok) {
      expect(invalidInstructionsResult.error.message).toContain(
        "instructions must be a string"
      );
    }
  });
});

describe("SyntheticCandidateSourceAdapter", () => {
  const sampleCandidate: CandidateSourceRecord = {
    sourceKey: "candidate-001",
    channel: "inbound",
    documents: [
      {
        documentKind: "resume",
        label: "resume.pdf",
        documentOrdinal: 0,
        rawText: "Candidate resume text"
      }
    ],
    applicationAnswers: {
      workAuthorization: {
        questionKey: "work_auth",
        selectedOptionKey: "authorized_us",
        freeText: undefined,
        provenance: {
          collectedBy: "ats",
          formId: "app-form-1",
          questionId: "q-auth",
          collectedAt: 1700000000
        }
      }
    }
  };

  it("initializes with default descriptor and registers candidates", () => {
    const adapter = createSyntheticCandidateSourceAdapter();
    expect(adapter.descriptor).toEqual({
      adapterId: SYNTHETIC_CANDIDATE_SOURCE_ADAPTER_ID,
      sourceSystem: SYNTHETIC_CANDIDATE_SOURCE_SYSTEM,
      contractVersion: SYNTHETIC_CANDIDATE_SOURCE_CONTRACT_VERSION
    });
    expect(adapter.hasCandidate("candidate-001")).toBe(false);

    adapter.registerCandidate(sampleCandidate);
    expect(adapter.hasCandidate("candidate-001")).toBe(true);
  });

  it("accepts custom options and existing records", () => {
    const adapter = new SyntheticCandidateSourceAdapter({
      adapterId: "custom-ats",
      sourceSystem: "greenhouse",
      contractVersion: 3,
      records: [sampleCandidate]
    });
    expect(adapter.descriptor.adapterId).toBe("custom-ats");
    expect(adapter.descriptor.sourceSystem).toBe("greenhouse");
    expect(adapter.descriptor.contractVersion).toBe(3);
    expect(adapter.hasCandidate("candidate-001")).toBe(true);
  });

  it("updates existing candidates when re-registering the same sourceKey", () => {
    const adapter = createSyntheticCandidateSourceAdapter({
      records: [sampleCandidate]
    });
    const updated = {
      ...sampleCandidate,
      channel: "sourced"
    };
    adapter.registerCandidate(updated);
    expect(adapter.hasCandidate("candidate-001")).toBe(true);
  });

  it("throws TypeError on malformed candidate registration", () => {
    const adapter = createSyntheticCandidateSourceAdapter();
    expect(() =>
      adapter.registerCandidate(null as unknown as CandidateSourceRecord)
    ).toThrow(/must be an object/);
    expect(() =>
      adapter.registerCandidate({
        sourceKey: ""
      } as unknown as CandidateSourceRecord)
    ).toThrow(/non-empty string/);
  });

  it("paginates candidates using cursor and limit", async () => {
    const records: CandidateSourceRecord[] = [
      { ...sampleCandidate, sourceKey: "c-1" },
      { ...sampleCandidate, sourceKey: "c-2" },
      { ...sampleCandidate, sourceKey: "c-3" },
      { ...sampleCandidate, sourceKey: "c-4" },
      { ...sampleCandidate, sourceKey: "c-5" }
    ];
    const adapter = createSyntheticCandidateSourceAdapter({ records });

    const page1 = await adapter.listCandidates({ cursor: undefined, limit: 2 });
    expect(page1.ok).toBe(true);
    if (page1.ok) {
      expect(page1.value.records.map((r) => r.sourceKey)).toEqual([
        "c-1",
        "c-2"
      ]);
      expect(page1.value.nextCursor).toBe("c-2");
    }

    const page2 = await adapter.listCandidates({
      cursor: "c-2",
      limit: 2
    });
    expect(page2.ok).toBe(true);
    if (page2.ok) {
      expect(page2.value.records.map((r) => r.sourceKey)).toEqual([
        "c-3",
        "c-4"
      ]);
      expect(page2.value.nextCursor).toBe("c-4");
    }

    const page3 = await adapter.listCandidates({
      cursor: "c-4",
      limit: 2
    });
    expect(page3.ok).toBe(true);
    if (page3.ok) {
      expect(page3.value.records.map((r) => r.sourceKey)).toEqual(["c-5"]);
      expect(page3.value.nextCursor).toBeUndefined();
    }
  });

  it("handles empty candidate list", async () => {
    const adapter = createSyntheticCandidateSourceAdapter({ records: [] });
    const page = await adapter.listCandidates({ cursor: undefined, limit: 10 });
    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.value.records).toEqual([]);
      expect(page.value.nextCursor).toBeUndefined();
    }
  });

  it("validates listCandidates request and returns typed errors", async () => {
    const adapter = createSyntheticCandidateSourceAdapter({
      records: [sampleCandidate]
    });

    const nullResult = await adapter.listCandidates(
      null as unknown as { cursor: undefined; limit: number }
    );
    expect(nullResult.ok).toBe(false);
    if (!nullResult.ok) {
      expect(nullResult.error.message).toContain("non-null object");
    }

    const invalidLimitResult = await adapter.listCandidates({
      cursor: undefined,
      limit: 0
    });
    expect(invalidLimitResult.ok).toBe(false);
    if (!invalidLimitResult.ok) {
      expect(invalidLimitResult.error.message).toContain(
        "limit must be a positive integer"
      );
    }

    const invalidCursorTypeResult = await adapter.listCandidates({
      cursor: 123 as unknown as string,
      limit: 5
    });
    expect(invalidCursorTypeResult.ok).toBe(false);
    if (!invalidCursorTypeResult.ok) {
      expect(invalidCursorTypeResult.error.message).toContain(
        "cursor must be a string or undefined"
      );
    }

    const unknownCursorResult = await adapter.listCandidates({
      cursor: "non-existent-key",
      limit: 5
    });
    expect(unknownCursorResult.ok).toBe(false);
    if (!unknownCursorResult.ok) {
      expect(unknownCursorResult.error.message).toContain(
        "Invalid cursor: non-existent-key"
      );
    }
  });
});
