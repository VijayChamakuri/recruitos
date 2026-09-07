import { describe, expect, it } from "vitest";

import { IsoYearMonthSchema, type IsoYearMonth } from "../domain/dates.js";
import { HARD_REQUIREMENT_FIELD_IDS } from "../domain/facts.js";
import {
  consolidateStructuredFacts,
  type FactConsolidation
} from "./consolidate-facts.js";
import {
  deriveTenureMonths,
  resolveHardRequirements,
  type HardRequirementAssessment,
  type HardRequirementResolution
} from "./hard-requirements.js";

const AS_OF: IsoYearMonth = IsoYearMonthSchema.parse("2026-09");

const REQUIREMENTS = [
  {
    requirementId: "years_experience",
    predicate: { kind: "minimum_experience_months", months: 60 }
  },
  {
    requirementId: "work_authorization",
    predicate: { kind: "work_authorization_in", allowed: ["authorized"] }
  },
  {
    requirementId: "current_title",
    predicate: { kind: "fact_present", factKind: "current_title" }
  },
  {
    requirementId: "employer_history",
    predicate: { kind: "fact_present", factKind: "employer_history_entry" }
  }
] as const;

function policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { asOfMonth: AS_OF, requirements: REQUIREMENTS, ...overrides };
}

function employment(
  employer: string,
  startMonth: string,
  endMonth: string,
  title = "Engineer"
): Record<string, unknown> {
  return { kind: "employment_interval", employer, title, startMonth, endMonth };
}

function proposal(payload: Record<string, unknown>, documentId = "document_resume") {
  return {
    documentId,
    provenance: "extracted",
    payload,
    evidenceSpanIds: ["span_1"]
  };
}

function consolidate(payloads: readonly Record<string, unknown>[]): FactConsolidation {
  const result = consolidateStructuredFacts(payloads.map((payload) => proposal(payload)));
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function resolve(
  payloads: readonly Record<string, unknown>[],
  policyOverrides: Record<string, unknown> = {}
): HardRequirementResolution {
  const result = resolveHardRequirements(consolidate(payloads), policy(policyOverrides));
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function outcomeFor(
  resolution: HardRequirementResolution,
  requirementId: string
): HardRequirementAssessment {
  const assessment = resolution.assessments.find(
    (entry) => entry.requirementId === requirementId
  );
  if (assessment === undefined) {
    throw new Error(`Expected an assessment for ${requirementId}`);
  }
  return assessment;
}

const AUTHORIZED = {
  kind: "work_authorization_statement",
  classification: "authorized",
  statementText: "Authorized to work without sponsorship."
};

const NEEDS_SPONSORSHIP = {
  kind: "work_authorization_statement",
  classification: "requires_sponsorship",
  statementText: "Will require sponsorship."
};

const TITLE = { kind: "current_title", title: "Staff Engineer" };

const HISTORY = {
  kind: "employer_history_entry",
  employer: "Acme",
  startMonth: "2020-01",
  endMonth: "2022-06"
};

describe("deriveTenureMonths", () => {
  it("counts an explicit ending month inclusively", () => {
    expect(deriveTenureMonths(consolidate([employment("Acme", "2020-01", "2020-12")]).facts, AS_OF)).toBe(
      12
    );
  });

  it("resolves present against the frozen snapshot month, not a clock", () => {
    expect(
      deriveTenureMonths(consolidate([employment("Acme", "2026-01", "present")]).facts, AS_OF)
    ).toBe(9);
  });

  it("unions overlapping ranges instead of summing concurrent work", () => {
    const facts = consolidate([
      employment("Acme", "2020-01", "2021-12"),
      employment("Globex", "2021-01", "2022-12")
    ]).facts;
    expect(deriveTenureMonths(facts, AS_OF)).toBe(36);
  });

  it("absorbs a fully contained range", () => {
    const facts = consolidate([
      employment("Acme", "2020-01", "2023-12"),
      employment("Globex", "2021-01", "2021-06")
    ]).facts;
    expect(deriveTenureMonths(facts, AS_OF)).toBe(48);
  });

  it("merges adjacent ranges without double counting the seam", () => {
    const facts = consolidate([
      employment("Acme", "2020-01", "2020-06"),
      employment("Globex", "2020-07", "2020-12")
    ]).facts;
    expect(deriveTenureMonths(facts, AS_OF)).toBe(12);
  });

  it("keeps a gap between ranges", () => {
    const facts = consolidate([
      employment("Acme", "2020-01", "2020-06"),
      employment("Globex", "2021-01", "2021-06")
    ]).facts;
    expect(deriveTenureMonths(facts, AS_OF)).toBe(12);
  });

  it("ignores an ongoing job that starts after the snapshot month", () => {
    const facts = consolidate([employment("Future", "2027-01", "present")]).facts;
    expect(deriveTenureMonths(facts, AS_OF)).toBe(0);
  });

  it("ignores facts that are not employment intervals", () => {
    expect(deriveTenureMonths(consolidate([TITLE, HISTORY]).facts, AS_OF)).toBe(0);
  });
});

describe("resolveHardRequirements policy validation", () => {
  it("rejects a policy that is not the committed shape", () => {
    expect(resolveHardRequirements(consolidate([TITLE]), "nope")).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "Invalid hard requirement policy" }
    });
  });

  it("rejects a policy that does not carry every committed requirement", () => {
    expect(
      resolveHardRequirements(
        consolidate([TITLE]),
        policy({ requirements: REQUIREMENTS.slice(0, 3) })
      )
    ).toMatchObject({
      ok: false,
      error: { message: "The policy must cover every committed hard requirement once" }
    });
  });

  it("rejects a duplicated requirement", () => {
    expect(
      resolveHardRequirements(
        consolidate([TITLE]),
        policy({
          requirements: [REQUIREMENTS[0], REQUIREMENTS[0], REQUIREMENTS[1], REQUIREMENTS[2]]
        })
      )
    ).toMatchObject({ ok: false, error: { message: "Duplicate hard requirement" } });
  });

  it("rejects a policy whose requirement ids are not the committed ones", () => {
    expect(
      resolveHardRequirements(
        consolidate([TITLE]),
        policy({
          requirements: [
            REQUIREMENTS[1],
            REQUIREMENTS[1],
            REQUIREMENTS[2],
            REQUIREMENTS[3]
          ]
        })
      ).ok
    ).toBe(false);
  });

  it("returns one assessment per committed requirement, in committed order", () => {
    const resolution = resolve([TITLE]);
    expect(resolution.assessments.map((entry) => entry.requirementId)).toEqual([
      ...HARD_REQUIREMENT_FIELD_IDS
    ]);
  });
});

describe("resolveHardRequirements three-valued outcomes", () => {
  it("passes a conclusively satisfied requirement and links the facts", () => {
    const resolution = resolve([
      employment("Acme", "2018-01", "present"),
      AUTHORIZED,
      TITLE,
      HISTORY
    ]);
    for (const assessment of resolution.assessments) {
      expect(assessment.outcome).toBe("pass");
      expect(assessment.reason).toBe("satisfied");
      expect(assessment.supportingFactKeys.length).toBeGreaterThanOrEqual(1);
      expect(assessment.contradictingFactKeys).toEqual([]);
    }
    expect(resolution).toMatchObject({ rejected: false, unknownCount: 0 });
  });

  it("fails a conclusively violated requirement and links the facts", () => {
    const resolution = resolve([
      employment("Acme", "2024-01", "2024-12"),
      NEEDS_SPONSORSHIP,
      TITLE,
      HISTORY
    ]);
    const experience = outcomeFor(resolution, "years_experience");
    const authorization = outcomeFor(resolution, "work_authorization");
    expect(experience).toMatchObject({ outcome: "fail", reason: "violated" });
    expect(experience.contradictingFactKeys.length).toBeGreaterThanOrEqual(1);
    expect(experience.supportingFactKeys).toEqual([]);
    expect(authorization).toMatchObject({ outcome: "fail", reason: "violated" });
    expect(resolution.rejected).toBe(true);
  });

  it("resolves absence to unknown and never to a rejection", () => {
    const resolution = resolve([TITLE]);
    expect(outcomeFor(resolution, "years_experience")).toMatchObject({
      outcome: "unknown",
      reason: "absent",
      supportingFactKeys: [],
      contradictingFactKeys: []
    });
    expect(outcomeFor(resolution, "work_authorization").outcome).toBe("unknown");
    expect(outcomeFor(resolution, "employer_history").outcome).toBe("unknown");
    expect(outcomeFor(resolution, "current_title").outcome).toBe("pass");
    expect(resolution).toMatchObject({ rejected: false, unknownCount: 3 });
  });

  it("resolves a conflict on the kind a predicate reads to unknown", () => {
    const consolidation = consolidate([
      employment("Acme", "2010-01", "present"),
      AUTHORIZED,
      NEEDS_SPONSORSHIP,
      TITLE,
      HISTORY
    ]);
    const result = resolveHardRequirements(consolidation, policy());
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(outcomeFor(result.value, "work_authorization")).toMatchObject({
      outcome: "unknown",
      reason: "conflicted"
    });
    expect(outcomeFor(result.value, "years_experience").outcome).toBe("pass");
    expect(result.value.rejected).toBe(false);
  });

  it("resolves a disputed employment interval to unknown rather than a violation", () => {
    const consolidation = consolidate([
      employment("Acme", "2024-01", "2024-12"),
      employment("Acme", "2024-01", "2025-12"),
      AUTHORIZED,
      TITLE,
      HISTORY
    ]);
    const result = resolveHardRequirements(consolidation, policy());
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(outcomeFor(result.value, "years_experience")).toMatchObject({
      outcome: "unknown",
      reason: "conflicted"
    });
    expect(result.value.rejected).toBe(false);
  });

  it("resolves a mixed authorization claim with no recorded conflict to unknown", () => {
    const consolidation = consolidate([AUTHORIZED, NEEDS_SPONSORSHIP, TITLE, HISTORY]);
    const withoutConflicts: FactConsolidation = Object.freeze({
      facts: consolidation.facts,
      conflicts: Object.freeze([]),
      documentIds: consolidation.documentIds
    });
    const result = resolveHardRequirements(withoutConflicts, policy());
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(outcomeFor(result.value, "work_authorization")).toMatchObject({
      outcome: "unknown",
      reason: "ambiguous"
    });
  });

  it("counts unknowns for the confidence miss rate and reports derived tenure", () => {
    const resolution = resolve([employment("Acme", "2021-01", "2022-12")]);
    expect(resolution.derivedTenureMonths).toBe(24);
    expect(resolution.unknownCount).toBe(3);
    expect(outcomeFor(resolution, "years_experience").outcome).toBe("fail");
  });

  it("treats the exact threshold as satisfied", () => {
    const resolution = resolve(
      [employment("Acme", "2021-01", "2025-12"), AUTHORIZED, TITLE, HISTORY],
      {}
    );
    expect(resolution.derivedTenureMonths).toBe(60);
    expect(outcomeFor(resolution, "years_experience").outcome).toBe("pass");
  });

  it("treats one month below the threshold as a violation", () => {
    const resolution = resolve([employment("Acme", "2021-02", "2025-12"), AUTHORIZED, TITLE, HISTORY]);
    expect(resolution.derivedTenureMonths).toBe(59);
    expect(outcomeFor(resolution, "years_experience").outcome).toBe("fail");
  });

  it("accepts any allowed classification the policy names", () => {
    const resolution = resolve([NEEDS_SPONSORSHIP, TITLE, HISTORY], {
      requirements: [
        REQUIREMENTS[0],
        {
          requirementId: "work_authorization",
          predicate: {
            kind: "work_authorization_in",
            allowed: ["authorized", "requires_sponsorship"]
          }
        },
        REQUIREMENTS[2],
        REQUIREMENTS[3]
      ]
    });
    expect(outcomeFor(resolution, "work_authorization").outcome).toBe("pass");
  });
});
