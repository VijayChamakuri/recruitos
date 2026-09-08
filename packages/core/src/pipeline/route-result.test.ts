import { describe, expect, it } from "vitest";

import { createRational, type Rational } from "../canonical/rational.js";
import { formatReasonCode } from "../domain/reason-code.js";
import { RUBRIC_V1 } from "../rubric/rubric-v1.js";
import { T_ESCALATE } from "../scoring/constants.js";
import type { DimensionAssessment, DimensionAssessmentDerivation } from "./assess-dimensions.js";
import type { FactConsolidation } from "./consolidate-facts.js";
import type { HardRequirementResolution } from "./hard-requirements.js";
import {
  DEFAULT_ROUTING_POLICY,
  routeCandidateResult,
  type CandidateRouting,
  type RoutingInput
} from "./route-result.js";

const REQUIRED_DIMENSION = RUBRIC_V1.dimensions.find((entry) => entry.required)!.dimensionId;
const OPTIONAL_DIMENSION = RUBRIC_V1.dimensions.find((entry) => !entry.required)!
  .dimensionId;

function rational(numerator: bigint, denominator: bigint): Rational {
  const result = createRational(numerator, denominator);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

const HIGH_CONFIDENCE = rational(90n, 100n);
const LOW_CONFIDENCE = rational(54n, 100n);

function assessment(overrides: Partial<DimensionAssessment> = {}): DimensionAssessment {
  return {
    dimensionId: REQUIRED_DIMENSION,
    level: "weak",
    source: "extracted",
    derivedLevel: "weak",
    levelDisagreement: false,
    supportingSpanIds: ["span_1"],
    contradictingSpanIds: [],
    documentIds: ["document_resume"],
    failedDocumentIds: [],
    ungroundedDocumentIds: [],
    ...overrides
  };
}

function derivation(
  overrides: Partial<DimensionAssessmentDerivation> = {}
): DimensionAssessmentDerivation {
  return {
    availability: "complete",
    assessments: [assessment()],
    gaps: [],
    unavailable: [],
    ...overrides
  };
}

function requirements(
  overrides: Partial<HardRequirementResolution> = {}
): HardRequirementResolution {
  return {
    assessments: [
      {
        requirementId: "years_experience",
        outcome: "pass",
        reason: "satisfied",
        factKind: "employment_interval",
        supportingFactKeys: ["fact_1"],
        contradictingFactKeys: []
      }
    ],
    rejected: false,
    unknownCount: 0,
    derivedTenureMonths: 120,
    ...overrides
  };
}

function consolidation(claimedMonths?: number): FactConsolidation {
  return {
    facts:
      claimedMonths === undefined
        ? []
        : [
            {
              factKey: "claimed",
              subjectKey: "claimed_experience",
              payload: { kind: "claimed_experience", claimedMonths },
              provenance: ["extracted"],
              documentIds: ["document_resume"],
              evidenceSpanIds: ["span_1"]
            }
          ],
    conflicts: [],
    documentIds: ["document_resume"]
  };
}

const NO_SIGNALS = {
  parseFailure: false,
  possibleDuplicate: false,
  promptInjectionFlagged: false,
  ambiguousSubjectIds: []
};

function input(overrides: Partial<RoutingInput> = {}): RoutingInput {
  return {
    consolidation: consolidation(),
    derivation: derivation(),
    requirements: requirements(),
    confidence: HIGH_CONFIDENCE,
    ...overrides
  };
}

function route(
  routingInput: RoutingInput = input(),
  signals: Record<string, unknown> = NO_SIGNALS
): CandidateRouting {
  const result = routeCandidateResult(routingInput, RUBRIC_V1, signals);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function reasonStrings(routing: CandidateRouting): readonly string[] {
  return routing.reasons.map(formatReasonCode);
}

describe("routeCandidateResult input validation", () => {
  it("rejects signals that are not the committed shape", () => {
    expect(routeCandidateResult(input(), RUBRIC_V1, "nope")).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "Invalid routing signals" }
    });
    expect(
      routeCandidateResult(input(), RUBRIC_V1, { ...NO_SIGNALS, extra: true }).ok
    ).toBe(false);
  });

  it("requires an available result to carry confidence", () => {
    expect(
      routeCandidateResult(input({ confidence: null }), RUBRIC_V1, NO_SIGNALS)
    ).toMatchObject({
      ok: false,
      error: {
        message: "An unavailable result carries no confidence and an available result must"
      }
    });
  });

  it("requires an unavailable result to carry no confidence", () => {
    expect(
      routeCandidateResult(
        input({ derivation: derivation({ availability: "unavailable" }) }),
        RUBRIC_V1,
        NO_SIGNALS
      ).ok
    ).toBe(false);
  });

  it("rejects an ambiguity subject that is not a valid reason subject", () => {
    expect(
      routeCandidateResult(input(), RUBRIC_V1, {
        ...NO_SIGNALS,
        ambiguousSubjectIds: ["two words"]
      })
    ).toMatchObject({
      ok: false,
      error: { message: "Routing produced a reason outside the closed vocabulary" }
    });
  });
});

describe("routeCandidateResult status", () => {
  it("scores a candidate with no matched predicate", () => {
    const routing = route();
    expect(routing).toMatchObject({ status: "scored", availability: "complete" });
    expect(routing.reasons).toEqual([]);
  });

  it("escalates on any matched predicate", () => {
    const routing = route(input(), { ...NO_SIGNALS, possibleDuplicate: true });
    expect(routing.status).toBe("escalated");
    expect(reasonStrings(routing)).toEqual(["possible_duplicate"]);
  });

  it("rejects only on a conclusive hard requirement failure, keeping every reason", () => {
    const routing = route(
      input({ requirements: requirements({ rejected: true }) }),
      { ...NO_SIGNALS, possibleDuplicate: true }
    );
    expect(routing.status).toBe("rejected_hard_requirement");
    expect(reasonStrings(routing)).toEqual(["possible_duplicate"]);
  });

  it("rejects even when no reason matched", () => {
    const routing = route(input({ requirements: requirements({ rejected: true }) }));
    expect(routing).toMatchObject({ status: "rejected_hard_requirement", reasons: [] });
  });

  it("escalates an unavailable result with assessment_unavailable and no confidence", () => {
    const routing = route(
      input({
        derivation: derivation({ availability: "unavailable", assessments: [], gaps: [] }),
        confidence: null
      })
    );
    expect(routing).toMatchObject({ status: "escalated", availability: "unavailable" });
    expect(reasonStrings(routing)).toContain("assessment_unavailable");
  });
});

describe("routeCandidateResult predicates", () => {
  it("names a missing_evidence reason for a required dimension gap only", () => {
    const routing = route(
      input({
        derivation: derivation({
          gaps: [
            { dimensionId: REQUIRED_DIMENSION, documentsSearched: ["document_resume"] },
            { dimensionId: OPTIONAL_DIMENSION, documentsSearched: ["document_resume"] }
          ]
        })
      })
    );
    expect(reasonStrings(routing)).toEqual([`missing_evidence:${REQUIRED_DIMENSION}`]);
  });

  it("names a missing_evidence reason for every unknown hard requirement", () => {
    const routing = route(
      input({
        requirements: requirements({
          assessments: [
            {
              requirementId: "work_authorization",
              outcome: "unknown",
              reason: "absent",
              factKind: "work_authorization_statement",
              supportingFactKeys: [],
              contradictingFactKeys: []
            }
          ],
          unknownCount: 1
        })
      })
    );
    expect(reasonStrings(routing)).toEqual(["missing_evidence:work_authorization"]);
  });

  it("names an ambiguity for a document level disagreement", () => {
    const routing = route(
      input({
        derivation: derivation({
          assessments: [assessment({ levelDisagreement: true })]
        })
      })
    );
    expect(reasonStrings(routing)).toEqual([`ambiguous:${REQUIRED_DIMENSION}`]);
  });

  it("names a caller-supplied ambiguity such as seniority", () => {
    const routing = route(input(), { ...NO_SIGNALS, ambiguousSubjectIds: ["seniority"] });
    expect(reasonStrings(routing)).toEqual(["ambiguous:seniority"]);
  });

  it("deduplicates an ambiguity named twice", () => {
    const routing = route(
      input({
        derivation: derivation({ assessments: [assessment({ levelDisagreement: true })] })
      }),
      { ...NO_SIGNALS, ambiguousSubjectIds: [REQUIRED_DIMENSION] }
    );
    expect(reasonStrings(routing)).toEqual([`ambiguous:${REQUIRED_DIMENSION}`]);
  });

  it("names parse_failure from the parser signal", () => {
    const routing = route(input(), { ...NO_SIGNALS, parseFailure: true });
    expect(reasonStrings(routing)).toEqual(["parse_failure"]);
  });

  it("names parse_failure when no span located anywhere", () => {
    const routing = route(
      input({
        derivation: derivation({
          assessments: [assessment({ supportingSpanIds: [], contradictingSpanIds: [] })]
        })
      })
    );
    expect(reasonStrings(routing)).toContain("parse_failure");
  });

  it("names prompt_injection_flagged from the heuristic signal", () => {
    const routing = route(input(), { ...NO_SIGNALS, promptInjectionFlagged: true });
    expect(reasonStrings(routing)).toEqual(["prompt_injection_flagged"]);
  });

  it("names a tenure contradiction only past the committed month margin", () => {
    const atMargin = route(
      input({
        consolidation: consolidation(132),
        requirements: requirements({ derivedTenureMonths: 120 })
      })
    );
    expect(reasonStrings(atMargin)).toEqual([]);

    const pastMargin = route(
      input({
        consolidation: consolidation(133),
        requirements: requirements({ derivedTenureMonths: 120 })
      })
    );
    expect(reasonStrings(pastMargin)).toEqual(["contradiction:tenure_vs_claim"]);
  });

  it("takes the highest grounded claim when several are present", () => {
    const routing = route(
      input({
        consolidation: {
          ...consolidation(24),
          facts: [
            ...consolidation(24).facts,
            {
              factKey: "claimed_high",
              subjectKey: "claimed_experience",
              payload: { kind: "claimed_experience", claimedMonths: 200 },
              provenance: ["extracted"],
              documentIds: ["document_resume"],
              evidenceSpanIds: ["span_2"]
            }
          ]
        },
        requirements: requirements({ derivedTenureMonths: 120 })
      })
    );
    expect(reasonStrings(routing)).toEqual(["contradiction:tenure_vs_claim"]);
  });
});

describe("routeCandidateResult low confidence", () => {
  it("fires only when no other predicate matched", () => {
    const routing = route(input({ confidence: LOW_CONFIDENCE }));
    expect(reasonStrings(routing)).toEqual(["low_confidence"]);
    expect(routing.status).toBe("escalated");
  });

  it("stays silent when another predicate already named the escalation", () => {
    const routing = route(input({ confidence: LOW_CONFIDENCE }), {
      ...NO_SIGNALS,
      possibleDuplicate: true
    });
    expect(reasonStrings(routing)).toEqual(["possible_duplicate"]);
  });

  it("treats the threshold itself as not low", () => {
    const routing = route(input({ confidence: T_ESCALATE }));
    expect(reasonStrings(routing)).toEqual([]);
    expect(routing.status).toBe("scored");
  });

  it("honours a policy threshold the caller supplies", () => {
    const result = routeCandidateResult(
      input({ confidence: rational(95n, 100n) }),
      RUBRIC_V1,
      NO_SIGNALS,
      { ...DEFAULT_ROUTING_POLICY, escalateThreshold: rational(99n, 100n) }
    );
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.reasons.map(formatReasonCode)).toEqual(["low_confidence"]);
  });
});

describe("routeCandidateResult ordering", () => {
  it("orders reasons by committed precedence, then by subject", () => {
    const routing = route(
      input({
        derivation: derivation({
          availability: "unavailable",
          assessments: [assessment({ levelDisagreement: true })],
          gaps: [{ dimensionId: REQUIRED_DIMENSION, documentsSearched: ["document_resume"] }]
        }),
        consolidation: consolidation(240),
        requirements: requirements({
          derivedTenureMonths: 12,
          assessments: [
            {
              requirementId: "work_authorization",
              outcome: "unknown",
              reason: "absent",
              factKind: "work_authorization_statement",
              supportingFactKeys: [],
              contradictingFactKeys: []
            }
          ],
          unknownCount: 1
        }),
        confidence: null
      }),
      { ...NO_SIGNALS, possibleDuplicate: true, promptInjectionFlagged: true }
    );

    expect(reasonStrings(routing)).toEqual([
      "assessment_unavailable",
      "prompt_injection_flagged",
      "possible_duplicate",
      "contradiction:tenure_vs_claim",
      `missing_evidence:${REQUIRED_DIMENSION}`,
      "missing_evidence:work_authorization",
      `ambiguous:${REQUIRED_DIMENSION}`
    ]);
  });
});
