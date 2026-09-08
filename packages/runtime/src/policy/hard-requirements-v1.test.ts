import {
  consolidateStructuredFacts,
  type HardRequirementPolicy,
  resolveHardRequirements,
  type StructuredFactPayload
} from "@recruitos/core";
import { describe, expect, it } from "vitest";

import {
  createHardRequirementPolicyV1,
  DEFAULT_ALLOWED_WORK_AUTHORIZATIONS,
  DEFAULT_MINIMUM_EXPERIENCE_MONTHS,
  hashHardRequirementPolicy
} from "./hard-requirements-v1.js";

describe("hard-requirements-v1 policy", () => {
  it("creates a valid default policy for frozen asOfMonth", () => {
    const policyResult = createHardRequirementPolicyV1("2026-09");
    expect(policyResult.ok).toBe(true);
    if (!policyResult.ok) {
      return;
    }
    const policy = policyResult.value;
    expect(policy.asOfMonth).toBe("2026-09");
    expect(policy.requirements).toHaveLength(4);

    const yearsReq = policy.requirements.find((r) => r.requirementId === "years_experience");
    expect(yearsReq).toBeDefined();
    expect(yearsReq?.predicate).toEqual({
      kind: "minimum_experience_months",
      months: DEFAULT_MINIMUM_EXPERIENCE_MONTHS
    });

    const workAuthReq = policy.requirements.find((r) => r.requirementId === "work_authorization");
    expect(workAuthReq).toBeDefined();
    expect(workAuthReq?.predicate).toEqual({
      kind: "work_authorization_in",
      allowed: [...DEFAULT_ALLOWED_WORK_AUTHORIZATIONS]
    });

    const titleReq = policy.requirements.find((r) => r.requirementId === "current_title");
    expect(titleReq?.predicate).toEqual({
      kind: "fact_present",
      factKind: "current_title"
    });

    const employerReq = policy.requirements.find((r) => r.requirementId === "employer_history");
    expect(employerReq?.predicate).toEqual({
      kind: "fact_present",
      factKind: "employer_history_entry"
    });
  });

  it("supports custom minimum experience months when >= 24", () => {
    const policyResult = createHardRequirementPolicyV1("2026-09", {
      minimumExperienceMonths: 36
    });
    expect(policyResult.ok).toBe(true);
    if (!policyResult.ok) {
      return;
    }
    const yearsReq = policyResult.value.requirements.find(
      (r) => r.requirementId === "years_experience"
    );
    expect(yearsReq?.predicate).toEqual({
      kind: "minimum_experience_months",
      months: 36
    });
  });

  it("supports custom allowed work authorizations", () => {
    const policyResult = createHardRequirementPolicyV1("2026-09", {
      allowedWorkAuthorizations: ["authorized", "requires_sponsorship"]
    });
    expect(policyResult.ok).toBe(true);
    if (!policyResult.ok) {
      return;
    }
    const workAuthReq = policyResult.value.requirements.find(
      (r) => r.requirementId === "work_authorization"
    );
    expect(workAuthReq?.predicate).toEqual({
      kind: "work_authorization_in",
      allowed: ["authorized", "requires_sponsorship"]
    });
  });

  it("rejects invalid asOfMonth format", () => {
    const policyResult = createHardRequirementPolicyV1("not-a-date");
    expect(policyResult.ok).toBe(false);
    if (policyResult.ok) {
      return;
    }
    expect(policyResult.error.message).toContain("Invalid asOfMonth");
  });

  it("rejects minimum experience months under the OQ-7 floor of 24", () => {
    const policyResult = createHardRequirementPolicyV1("2026-09", {
      minimumExperienceMonths: 12
    });
    expect(policyResult.ok).toBe(false);
    if (policyResult.ok) {
      return;
    }
    expect(policyResult.error.message).toContain("at least 24 per OQ-7");
  });

  it("rejects non-positive or float minimum experience months", () => {
    const nonInteger = createHardRequirementPolicyV1("2026-09", {
      minimumExperienceMonths: 24.5
    });
    expect(nonInteger.ok).toBe(false);

    const negative = createHardRequirementPolicyV1("2026-09", {
      minimumExperienceMonths: -5
    });
    expect(negative.ok).toBe(false);
  });

  it("rejects empty or invalid allowed work authorizations", () => {
    const emptyAllowed = createHardRequirementPolicyV1("2026-09", {
      allowedWorkAuthorizations: []
    });
    expect(emptyAllowed.ok).toBe(false);

    const invalidAuth = createHardRequirementPolicyV1("2026-09", {
      allowedWorkAuthorizations: ["citizen" as unknown as "authorized"]
    });
    expect(invalidAuth.ok).toBe(false);
  });

  it("rejects unrecognized options", () => {
    const extraOptions = createHardRequirementPolicyV1("2026-09", {
      extraField: true
    });
    expect(extraOptions.ok).toBe(false);
  });

  it("deterministically hashes the policy", () => {
    const policyResult1 = createHardRequirementPolicyV1("2026-09");
    const policyResult2 = createHardRequirementPolicyV1("2026-09");
    expect(policyResult1.ok).toBe(true);
    expect(policyResult2.ok).toBe(true);
    if (!policyResult1.ok || !policyResult2.ok) {
      return;
    }

    const hash1 = hashHardRequirementPolicy(policyResult1.value);
    const hash2 = hashHardRequirementPolicy(policyResult2.value);
    expect(hash1.ok).toBe(true);
    expect(hash2.ok).toBe(true);
    if (!hash1.ok || !hash2.ok) {
      return;
    }
    expect(hash1.value).toBe(hash2.value);
    expect(hash1.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it("executes seamlessly with core resolveHardRequirements", () => {
    const policyResult = createHardRequirementPolicyV1("2026-09", {
      minimumExperienceMonths: 24
    });
    expect(policyResult.ok).toBe(true);
    if (!policyResult.ok) {
      return;
    }

    const proposals = [
      {
        documentId: "doc_1",
        provenance: "extracted" as const,
        payload: {
          kind: "employment_interval" as const,
          employer: "TechCorp",
          title: "Senior Engineer",
          startMonth: "2024-01",
          endMonth: "present"
        },
        evidenceSpanIds: ["span_1"]
      },
      {
        provenance: "parsed" as const,
        payload: {
          kind: "work_authorization_statement" as const,
          classification: "authorized" as const,
          statementText: "Legally authorized to work in the US without restriction."
        },
        evidenceSpanIds: []
      },
      {
        documentId: "doc_1",
        provenance: "extracted" as const,
        payload: {
          kind: "current_title" as const,
          title: "Senior Engineer"
        },
        evidenceSpanIds: ["span_3"]
      },
      {
        documentId: "doc_1",
        provenance: "extracted" as const,
        payload: {
          kind: "employer_history_entry" as const,
          employer: "TechCorp",
          startMonth: "2024-01",
          endMonth: "present"
        },
        evidenceSpanIds: ["span_4"]
      }
    ];

    const consolidationResult = consolidateStructuredFacts(proposals);
    expect(consolidationResult.ok).toBe(true);
    if (!consolidationResult.ok) {
      return;
    }

    const resolutionResult = resolveHardRequirements(
      consolidationResult.value,
      policyResult.value
    );
    expect(resolutionResult.ok).toBe(true);
    if (!resolutionResult.ok) {
      return;
    }

    const resolution = resolutionResult.value;
    expect(resolution.rejected).toBe(false);
    expect(resolution.unknownCount).toBe(0);
    expect(resolution.derivedTenureMonths).toBe(33); // 2024-01 to 2026-09 = 33 months

    const yearsAssessment = resolution.assessments.find((a) => a.requirementId === "years_experience");
    expect(yearsAssessment?.outcome).toBe("pass");
    expect(yearsAssessment?.reason).toBe("satisfied");

    const workAuthAssessment = resolution.assessments.find((a) => a.requirementId === "work_authorization");
    expect(workAuthAssessment?.outcome).toBe("pass");
    expect(workAuthAssessment?.reason).toBe("satisfied");
  });

  it("returns error when policy cannot be canonically serialized", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = hashHardRequirementPolicy(cyclic as unknown as HardRequirementPolicy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("persistence_failed");
      expect(result.error.message).toContain("Failed to hash hard requirement policy");
    }
  });
});
