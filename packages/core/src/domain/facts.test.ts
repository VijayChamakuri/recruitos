import { describe, expect, it } from "vitest";

import { REQUIRED_FIELD_IDS } from "../scoring/constants.js";
import {
  FACT_PROVENANCE_SOURCES,
  FactProvenanceSourceSchema,
  HARD_REQUIREMENT_FIELD_IDS,
  HARD_REQUIREMENT_OUTCOMES,
  HardRequirementFieldIdSchema,
  HardRequirementOutcomeSchema,
  MAXIMUM_CLAIMED_MONTHS,
  STRUCTURED_FACT_KINDS,
  StructuredFactKindSchema,
  StructuredFactPayloadSchema,
  StructuredFactPayloadUnionSchema,
  WORK_AUTHORIZATION_CLASSIFICATIONS,
  WorkAuthorizationClassificationSchema,
  structuredFactSemanticKey
} from "./facts.js";

describe("structured fact vocabulary", () => {
  it("accepts exactly the closed v1 fact kinds", () => {
    expect(STRUCTURED_FACT_KINDS).toEqual([
      "employment_interval",
      "work_authorization_statement",
      "current_title",
      "employer_history_entry",
      "claimed_experience"
    ]);
    for (const kind of STRUCTURED_FACT_KINDS) {
      expect(StructuredFactKindSchema.parse(kind)).toBe(kind);
    }
    expect(StructuredFactKindSchema.safeParse("education_interval").success).toBe(false);
  });

  it("pins hard-requirement field ids to the committed scoring list", () => {
    expect(HARD_REQUIREMENT_FIELD_IDS).toEqual([...REQUIRED_FIELD_IDS]);
    for (const fieldId of HARD_REQUIREMENT_FIELD_IDS) {
      expect(HardRequirementFieldIdSchema.parse(fieldId)).toBe(fieldId);
    }
    expect(HardRequirementFieldIdSchema.safeParse("location").success).toBe(false);
  });

  it("accepts exactly the three-valued requirement outcomes", () => {
    for (const outcome of HARD_REQUIREMENT_OUTCOMES) {
      expect(HardRequirementOutcomeSchema.parse(outcome)).toBe(outcome);
    }
    expect(HardRequirementOutcomeSchema.safeParse("rejected").success).toBe(false);
  });

  it("accepts exactly the closed provenance sources and authorization classes", () => {
    for (const source of FACT_PROVENANCE_SOURCES) {
      expect(FactProvenanceSourceSchema.parse(source)).toBe(source);
    }
    expect(FactProvenanceSourceSchema.safeParse("model").success).toBe(false);
    for (const classification of WORK_AUTHORIZATION_CLASSIFICATIONS) {
      expect(WorkAuthorizationClassificationSchema.parse(classification)).toBe(classification);
    }
    expect(WorkAuthorizationClassificationSchema.safeParse("citizen").success).toBe(false);
  });
});

describe("structured fact payloads", () => {
  it("accepts each v1 payload and derives a type-specific semantic key", () => {
    const employment = StructuredFactPayloadSchema.parse({
      kind: "employment_interval",
      employer: "  Acme  ",
      title: "  Engineer  ",
      startMonth: "2020-01",
      endMonth: "present"
    });
    expect(employment).toEqual({
      kind: "employment_interval",
      employer: "Acme",
      title: "Engineer",
      startMonth: "2020-01",
      endMonth: "present"
    });
    expect(structuredFactSemanticKey(employment)).toBe("Acme\u001f2020-01");

    const authorization = StructuredFactPayloadSchema.parse({
      kind: "work_authorization_statement",
      classification: "requires_sponsorship",
      statementText: "Requires H-1B sponsorship."
    });
    expect(structuredFactSemanticKey(authorization)).toBe("requires_sponsorship");

    const currentTitle = StructuredFactPayloadSchema.parse({
      kind: "current_title",
      title: "Staff Engineer"
    });
    expect(structuredFactSemanticKey(currentTitle)).toBe("Staff Engineer");

    const history = StructuredFactPayloadSchema.parse({
      kind: "employer_history_entry",
      employer: "Acme",
      startMonth: "2018-06",
      endMonth: "2020-01"
    });
    expect(structuredFactSemanticKey(history)).toBe("Acme\u001f2018-06");

    const claimed = StructuredFactPayloadSchema.parse({
      kind: "claimed_experience",
      claimedMonths: 96
    });
    expect(structuredFactSemanticKey(claimed)).toBe("claimed:96");
  });

  it("rejects inverted employment ranges and unknown payload kinds", () => {
    expect(
      StructuredFactPayloadSchema.safeParse({
        kind: "employment_interval",
        employer: "Acme",
        title: "Engineer",
        startMonth: "2021-01",
        endMonth: "2020-12"
      }).success
    ).toBe(false);
    expect(
      StructuredFactPayloadSchema.safeParse({
        kind: "employer_history_entry",
        employer: "Acme",
        startMonth: "2021-01",
        endMonth: "2020-12"
      }).success
    ).toBe(false);
    expect(
      StructuredFactPayloadSchema.safeParse({
        kind: "education_interval",
        school: "State"
      }).success
    ).toBe(false);
    expect(
      StructuredFactPayloadSchema.safeParse({
        kind: "claimed_experience",
        claimedMonths: MAXIMUM_CLAIMED_MONTHS + 1
      }).success
    ).toBe(false);
    const invertedEmployment = {
      kind: "employment_interval" as const,
      employer: "Acme",
      title: "Engineer",
      startMonth: "2021-01",
      endMonth: "2020-12"
    };
    expect(StructuredFactPayloadUnionSchema.safeParse(invertedEmployment).success).toBe(true);
    expect(StructuredFactPayloadSchema.safeParse(invertedEmployment).success).toBe(false);
  });
});
