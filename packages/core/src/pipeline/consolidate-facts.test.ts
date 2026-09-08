import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { StructuredFactPayloadSchema, type StructuredFactPayload } from "../domain/facts.js";
import {
  consolidateStructuredFacts,
  MAXIMUM_CANDIDATE_DOCUMENTS,
  MAXIMUM_FACT_PROPOSALS,
  structuredFactIdentityKey,
  structuredFactSubjectKey,
  type FactConsolidation
} from "./consolidate-facts.js";

type ProposalInput = Readonly<{
  documentId?: string;
  provenance: string;
  payload: StructuredFactPayload;
  evidenceSpanIds: readonly string[];
}>;

function fact(input: unknown): StructuredFactPayload {
  return StructuredFactPayloadSchema.parse(input);
}

const ACME_2020 = fact({
  kind: "employment_interval",
  employer: "Acme",
  title: "Engineer",
  startMonth: "2020-01",
  endMonth: "2022-06"
});

const ACME_2020_LONGER = fact({ ...ACME_2020, endMonth: "2023-06" });

const GLOBEX_2023 = fact({
  kind: "employment_interval",
  employer: "Globex",
  title: "Staff Engineer",
  startMonth: "2023-01",
  endMonth: "present"
});

const TITLE_STAFF = fact({ kind: "current_title", title: "Staff Engineer" });
const TITLE_SENIOR = fact({ kind: "current_title", title: "Senior Engineer" });
const TITLE_PRINCIPAL = fact({ kind: "current_title", title: "Principal Engineer" });

const AUTHORIZED = fact({
  kind: "work_authorization_statement",
  classification: "authorized",
  statementText: "Authorized to work without sponsorship."
});

const NEEDS_SPONSORSHIP = fact({
  kind: "work_authorization_statement",
  classification: "requires_sponsorship",
  statementText: "Will require sponsorship."
});

const CLAIMED_TEN_YEARS = fact({ kind: "claimed_experience", claimedMonths: 120 });

const EMPLOYER_HISTORY = fact({
  kind: "employer_history_entry",
  employer: "Acme",
  startMonth: "2020-01",
  endMonth: "2022-06"
});

function applicationAnswerProposal(
  payload: StructuredFactPayload,
  overrides: Partial<ProposalInput> = {}
): ProposalInput {
  return {
    provenance: "parsed",
    payload,
    evidenceSpanIds: [],
    ...overrides
  };
}

function proposal(
  payload: StructuredFactPayload,
  overrides: Partial<ProposalInput> = {}
): ProposalInput {
  return {
    documentId: "document_resume",
    provenance: "extracted",
    payload,
    evidenceSpanIds: ["span_1"],
    ...overrides
  };
}

function consolidated(proposals: readonly ProposalInput[]): FactConsolidation {
  const result = consolidateStructuredFacts(proposals);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

describe("structuredFactIdentityKey", () => {
  it("distinguishes every field of every fact kind", () => {
    const keys = [
      ACME_2020,
      ACME_2020_LONGER,
      GLOBEX_2023,
      TITLE_STAFF,
      TITLE_SENIOR,
      AUTHORIZED,
      NEEDS_SPONSORSHIP,
      CLAIMED_TEN_YEARS,
      EMPLOYER_HISTORY
    ].map(structuredFactIdentityKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is stable for an identical payload", () => {
    expect(structuredFactIdentityKey(fact({ ...ACME_2020 }))).toBe(
      structuredFactIdentityKey(ACME_2020)
    );
  });
});

describe("structuredFactSubjectKey", () => {
  it("collapses single-subject kinds to the kind itself", () => {
    expect(structuredFactSubjectKey(TITLE_STAFF)).toBe("current_title");
    expect(structuredFactSubjectKey(TITLE_SENIOR)).toBe("current_title");
    expect(structuredFactSubjectKey(AUTHORIZED)).toBe("work_authorization_statement");
    expect(structuredFactSubjectKey(CLAIMED_TEN_YEARS)).toBe("claimed_experience");
  });

  it("keys employment kinds by employer and start month", () => {
    expect(structuredFactSubjectKey(ACME_2020)).toBe(structuredFactSubjectKey(ACME_2020_LONGER));
    expect(structuredFactSubjectKey(ACME_2020)).not.toBe(structuredFactSubjectKey(GLOBEX_2023));
    expect(structuredFactSubjectKey(EMPLOYER_HISTORY)).not.toBe(
      structuredFactSubjectKey(ACME_2020)
    );
  });
});

describe("consolidateStructuredFacts input validation", () => {
  it("rejects input that is not a list of proposals", () => {
    expect(consolidateStructuredFacts("nope")).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "Invalid structured fact proposals" }
    });
  });

  it("rejects an empty proposal set", () => {
    expect(consolidateStructuredFacts([]).ok).toBe(false);
  });

  it("rejects a document-grounded proposal with no grounding evidence", () => {
    expect(consolidateStructuredFacts([proposal(ACME_2020, { evidenceSpanIds: [] })]).ok).toBe(
      false
    );
  });

  it("rejects a document-grounded proposal with no document id", () => {
    expect(
      consolidateStructuredFacts([
        {
          provenance: "extracted",
          payload: ACME_2020,
          evidenceSpanIds: ["span_1"]
        }
      ]).ok
    ).toBe(false);
  });

  it("accepts a parsed work-authorization statement grounded only in the application answer", () => {
    const result = consolidated([applicationAnswerProposal(AUTHORIZED)]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({
      payload: AUTHORIZED,
      provenance: ["parsed"],
      documentIds: [],
      evidenceSpanIds: []
    });
  });

  it("rejects a parsed work-authorization statement that cites a document", () => {
    expect(
      consolidateStructuredFacts([
        applicationAnswerProposal(AUTHORIZED, { documentId: "document_resume" })
      ]).ok
    ).toBe(false);
  });

  it("rejects a parsed work-authorization statement that cites document spans", () => {
    expect(
      consolidateStructuredFacts([
        applicationAnswerProposal(AUTHORIZED, { evidenceSpanIds: ["span_1"] })
      ]).ok
    ).toBe(false);
  });

  it("rejects unknown fields and unknown provenance", () => {
    expect(consolidateStructuredFacts([{ ...proposal(ACME_2020), extra: true }]).ok).toBe(false);
    expect(consolidateStructuredFacts([proposal(ACME_2020, { provenance: "guessed" })]).ok).toBe(
      false
    );
  });

  it("rejects more proposals than the committed bound", () => {
    const many = Array.from({ length: MAXIMUM_FACT_PROPOSALS + 1 }, (_unused, index) =>
      proposal(fact({ kind: "current_title", title: `Title ${index}` }))
    );
    expect(consolidateStructuredFacts(many).ok).toBe(false);
  });

  it("rejects more than four documents", () => {
    const proposals = Array.from({ length: MAXIMUM_CANDIDATE_DOCUMENTS + 1 }, (_unused, index) =>
      proposal(fact({ kind: "current_title", title: `Title ${index}` }), {
        documentId: `document_${index}`
      })
    );
    expect(consolidateStructuredFacts(proposals)).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "A candidate carries at most four documents" }
    });
  });
});

describe("consolidateStructuredFacts deduplication", () => {
  it("merges an identical claim across documents and provenances", () => {
    const result = consolidated([
      proposal(ACME_2020, {
        documentId: "document_resume",
        provenance: "extracted",
        evidenceSpanIds: ["span_2", "span_1"]
      }),
      proposal(ACME_2020, {
        documentId: "document_cover_letter",
        provenance: "parsed",
        evidenceSpanIds: ["span_3"]
      }),
      proposal(ACME_2020, {
        documentId: "document_resume",
        provenance: "human",
        evidenceSpanIds: ["span_1"]
      })
    ]);

    expect(result.facts).toHaveLength(1);
    expect(result.conflicts).toEqual([]);
    expect(result.facts[0]).toMatchObject({
      payload: ACME_2020,
      provenance: ["parsed", "extracted", "human"],
      documentIds: ["document_cover_letter", "document_resume"],
      evidenceSpanIds: ["span_1", "span_2", "span_3"]
    });
    expect(result.documentIds).toEqual(["document_cover_letter", "document_resume"]);
  });

  it("keeps distinct claims separate and orders them canonically", () => {
    const result = consolidated([proposal(GLOBEX_2023), proposal(TITLE_STAFF), proposal(ACME_2020)]);
    const keys = result.facts.map((entry) => entry.factKey);
    expect(keys).toEqual([...keys].sort());
    expect(result.facts).toHaveLength(3);
  });

  it("produces identical output regardless of proposal order", () => {
    const proposals = [
      proposal(GLOBEX_2023, { provenance: "parsed" }),
      proposal(ACME_2020, { evidenceSpanIds: ["span_9", "span_4"] }),
      proposal(TITLE_STAFF, { provenance: "human" }),
      proposal(ACME_2020, { provenance: "parsed", evidenceSpanIds: ["span_4"] })
    ];
    const forward = consolidated(proposals);
    const reversed = consolidated([...proposals].reverse());
    expect(reversed).toEqual(forward);
  });
});

describe("consolidateStructuredFacts conflicts", () => {
  it("names a conflict when the parser and the extractor disagree about one job", () => {
    const result = consolidated([
      proposal(ACME_2020, { provenance: "parsed" }),
      proposal(ACME_2020_LONGER, { provenance: "extracted" })
    ]);

    expect(result.facts).toHaveLength(2);
    expect(result.conflicts).toHaveLength(1);
    const [conflict] = result.conflicts;
    expect(conflict?.kind).toBe("employment_interval");
    expect(conflict?.memberFactKeys).toEqual(
      [structuredFactIdentityKey(ACME_2020), structuredFactIdentityKey(ACME_2020_LONGER)].sort()
    );
  });

  it("names a conflict for two different current titles", () => {
    const result = consolidated([proposal(TITLE_STAFF), proposal(TITLE_SENIOR)]);
    expect(result.conflicts).toMatchObject([
      { subjectKey: "current_title", kind: "current_title" }
    ]);
  });

  it("names a conflict for two different work authorization classifications", () => {
    const result = consolidated([
      applicationAnswerProposal(AUTHORIZED),
      proposal(NEEDS_SPONSORSHIP)
    ]);
    expect(result.conflicts).toMatchObject([{ kind: "work_authorization_statement" }]);
  });

  it("does not treat two different employers as a conflict", () => {
    const result = consolidated([proposal(ACME_2020), proposal(GLOBEX_2023)]);
    expect(result.conflicts).toEqual([]);
    expect(result.facts).toHaveLength(2);
  });

  it("orders multiple conflicts canonically", () => {
    const result = consolidated([
      proposal(TITLE_STAFF),
      proposal(TITLE_SENIOR),
      proposal(AUTHORIZED),
      proposal(NEEDS_SPONSORSHIP),
      proposal(ACME_2020),
      proposal(ACME_2020_LONGER)
    ]);
    const subjects = result.conflicts.map((conflict) => conflict.subjectKey);
    expect(subjects).toEqual([...subjects].sort());
    expect(result.conflicts).toHaveLength(3);
  });

  it("keeps every member of a three-way disagreement", () => {
    const result = consolidated([
      proposal(TITLE_STAFF, { provenance: "parsed" }),
      proposal(TITLE_SENIOR, { provenance: "extracted" }),
      proposal(TITLE_PRINCIPAL, { provenance: "human" })
    ]);
    expect(result.facts).toHaveLength(3);
    expect(result.conflicts[0]?.memberFactKeys).toHaveLength(3);
  });
});

describe("consolidateStructuredFacts invariants", () => {
  const PAYLOADS = [
    ACME_2020,
    ACME_2020_LONGER,
    GLOBEX_2023,
    TITLE_STAFF,
    TITLE_SENIOR,
    AUTHORIZED,
    NEEDS_SPONSORSHIP,
    CLAIMED_TEN_YEARS,
    EMPLOYER_HISTORY
  ] as const;

  it("is order independent, deduplicating, and complete", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            payloadIndex: fc.nat(PAYLOADS.length - 1),
            documentIndex: fc.nat(MAXIMUM_CANDIDATE_DOCUMENTS - 1),
            provenance: fc.constantFrom("parsed", "extracted", "human"),
            spanIndex: fc.nat(5)
          }),
          { minLength: 1, maxLength: 16 }
        ),
        fc.nat(1000),
        (rows, rotation) => {
          const proposals = rows.map((row) => {
            const payload = PAYLOADS[row.payloadIndex]!;
            if (row.provenance === "parsed" && payload.kind === "work_authorization_statement") {
              return applicationAnswerProposal(payload);
            }
            return proposal(payload, {
              documentId: `document_${row.documentIndex}`,
              provenance: row.provenance,
              evidenceSpanIds: [`span_${row.spanIndex}`]
            });
          });
          const shift = rotation % proposals.length;
          const rotated = [...proposals.slice(shift), ...proposals.slice(0, shift)];

          const result = consolidated(proposals);
          expect(consolidated(rotated)).toEqual(result);

          const distinctClaims = new Set(
            proposals.map((entry) => structuredFactIdentityKey(entry.payload))
          );
          expect(result.facts).toHaveLength(distinctClaims.size);
          expect(new Set(result.facts.map((entry) => entry.factKey))).toEqual(distinctClaims);
          for (const conflict of result.conflicts) {
            expect(conflict.memberFactKeys.length).toBeGreaterThanOrEqual(2);
          }
        }
      )
    );
  });
});
