import { describe, expect, it } from "vitest";

import { DRAFT_RUBRIC_V1 } from "../rubric/draft-v1.js";
import { createRubric, type Rubric } from "../rubric/rubric.js";
import type { DimensionLevel } from "../rubric/levels.js";
import {
  deriveDimensionAssessments,
  MAXIMUM_DIMENSION_PROPOSALS,
  type DimensionAssessment,
  type DimensionAssessmentDerivation
} from "./assess-dimensions.js";

const DIMENSION_IDS = DRAFT_RUBRIC_V1.dimensions.map((dimension) => dimension.dimensionId);
const FIRST = DIMENSION_IDS[0]!;

type SpanInput = Readonly<{
  evidenceSpanId: string;
  documentId: string;
  polarity: "supporting" | "contradicting";
  source: "extracted" | "human";
}>;

type ProposalInput =
  | Readonly<{ kind: "document_level"; documentId: string; level: DimensionLevel }>
  | Readonly<{ kind: "document_failure"; documentId: string }>
  | Readonly<{ kind: "human_level"; level: DimensionLevel }>;

type DimensionInput = Readonly<{
  dimensionId: string;
  proposals: readonly ProposalInput[];
  spans: readonly SpanInput[];
}>;

function span(
  evidenceSpanId: string,
  documentId = "document_resume",
  polarity: SpanInput["polarity"] = "supporting",
  source: SpanInput["source"] = "extracted"
): SpanInput {
  return { evidenceSpanId, documentId, polarity, source };
}

function documentLevel(level: DimensionLevel, documentId = "document_resume"): ProposalInput {
  return { kind: "document_level", documentId, level };
}

function noEvidence(dimensionId: string): DimensionInput {
  return {
    dimensionId,
    proposals: [documentLevel("none")],
    spans: []
  };
}

/** Every dimension after the first is a plain, evidence-free `none`. */
function withFirst(first: DimensionInput): readonly DimensionInput[] {
  return [first, ...DIMENSION_IDS.slice(1).map(noEvidence)];
}

function derived(
  dimensions: readonly DimensionInput[],
  rubric: Rubric = DRAFT_RUBRIC_V1
): DimensionAssessmentDerivation {
  const result = deriveDimensionAssessments(dimensions, rubric);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function firstAssessment(first: DimensionInput): DimensionAssessment {
  const result = derived(withFirst(first));
  const assessment = result.assessments.find((entry) => entry.dimensionId === first.dimensionId);
  if (assessment === undefined) {
    throw new Error("Expected an assessment for the first dimension");
  }
  return assessment;
}

describe("deriveDimensionAssessments rubric coverage", () => {
  it("rejects input that is not dimension evidence", () => {
    expect(deriveDimensionAssessments("nope", DRAFT_RUBRIC_V1)).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "Invalid dimension evidence" }
    });
  });

  it("rejects a duplicated dimension", () => {
    expect(
      deriveDimensionAssessments(
        [noEvidence(FIRST), ...DIMENSION_IDS.map(noEvidence)],
        DRAFT_RUBRIC_V1
      )
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_evidence", message: "Duplicate evidence for a rubric dimension" }
    });
  });

  it("rejects evidence that does not cover the rubric exactly once", () => {
    expect(
      deriveDimensionAssessments(DIMENSION_IDS.slice(1).map(noEvidence), DRAFT_RUBRIC_V1)
    ).toMatchObject({
      ok: false,
      error: { message: "Evidence must cover every rubric dimension exactly once" }
    });
  });

  it("rejects evidence whose dimension ids are not the rubric's", () => {
    const wrong = [...DIMENSION_IDS.slice(1).map(noEvidence), noEvidence("unknown_dimension")];
    expect(deriveDimensionAssessments(wrong, DRAFT_RUBRIC_V1)).toMatchObject({
      ok: false,
      error: { message: "Evidence does not match the rubric dimensions" }
    });
  });

  it("returns one assessment per rubric dimension in rubric order", () => {
    const result = derived(DIMENSION_IDS.map(noEvidence));
    expect(result.assessments.map((entry) => entry.dimensionId)).toEqual(DIMENSION_IDS);
    expect(result.availability).toBe("complete");
  });

  it("works against any rubric passed in, not just the draft", () => {
    const single = createRubric({
      rubricId: "rubric_single",
      version: "test-v1",
      dimensions: [
        {
          dimensionId: "only_dimension",
          weight: 1,
          required: true,
          definition: "Only dimension.",
          jobRelatedJustification: "Only dimension."
        }
      ]
    });
    if (!single.ok) {
      throw new Error(single.error.message);
    }
    const result = derived([noEvidence("only_dimension")], single.value);
    expect(result.assessments).toHaveLength(1);
  });
});

describe("deriveDimensionAssessments proposal validation", () => {
  it("rejects a dimension with only a human proposal", () => {
    expect(
      deriveDimensionAssessments(
        withFirst({
          dimensionId: FIRST,
          proposals: [{ kind: "human_level", level: "none" }],
          spans: []
        }),
        DRAFT_RUBRIC_V1
      )
    ).toMatchObject({
      ok: false,
      error: { message: "A dimension must carry at least one document proposal or failure" }
    });
  });

  it("rejects more documents than a candidate can carry", () => {
    const proposals = Array.from({ length: MAXIMUM_DIMENSION_PROPOSALS }, (_unused, index) =>
      documentLevel("none", `document_${index}`)
    );
    expect(
      deriveDimensionAssessments(
        withFirst({ dimensionId: FIRST, proposals, spans: [] }),
        DRAFT_RUBRIC_V1
      )
    ).toMatchObject({
      ok: false,
      error: { message: "A dimension covers at most four documents" }
    });
  });

  it("rejects a span pointing at a document the dimension does not have", () => {
    expect(
      deriveDimensionAssessments(
        withFirst({
          dimensionId: FIRST,
          proposals: [documentLevel("weak")],
          spans: [span("span_1", "document_elsewhere")]
        }),
        DRAFT_RUBRIC_V1
      )
    ).toMatchObject({
      ok: false,
      error: { message: "An evidence span references a document the dimension lacks" }
    });
  });

  it("rejects an unknown proposal kind and unknown fields", () => {
    expect(
      deriveDimensionAssessments(
        withFirst({
          dimensionId: FIRST,
          proposals: [{ kind: "guessed_level", level: "weak" } as unknown as ProposalInput],
          spans: []
        }),
        DRAFT_RUBRIC_V1
      ).ok
    ).toBe(false);
  });
});

describe("deriveDimensionAssessments level selection", () => {
  it("selects the highest grounded non-none level across documents", () => {
    const assessment = firstAssessment({
      dimensionId: FIRST,
      proposals: [
        documentLevel("weak", "document_resume"),
        documentLevel("strong", "document_cover_letter")
      ],
      spans: [span("span_1", "document_resume"), span("span_2", "document_cover_letter")]
    });
    expect(assessment.level).toBe("strong");
    expect(assessment.source).toBe("extracted");
    expect(assessment.documentIds).toEqual(["document_cover_letter", "document_resume"]);
  });

  it("selects a valid none when every successful document proposes none", () => {
    const assessment = firstAssessment({
      dimensionId: FIRST,
      proposals: [documentLevel("none"), documentLevel("none", "document_cover_letter")],
      spans: [span("span_1", "document_resume", "contradicting")]
    });
    expect(assessment.level).toBe("none");
    expect(assessment.levelDisagreement).toBe(false);
  });

  it("marks distinct non-none levels as a disagreement and keeps the selected level", () => {
    const assessment = firstAssessment({
      dimensionId: FIRST,
      proposals: [
        documentLevel("weak", "document_resume"),
        documentLevel("partial", "document_cover_letter")
      ],
      spans: [span("span_1", "document_resume"), span("span_2", "document_cover_letter")]
    });
    expect(assessment.level).toBe("partial");
    expect(assessment.levelDisagreement).toBe(true);
  });

  it("does not call one grounded non-none level a disagreement", () => {
    const assessment = firstAssessment({
      dimensionId: FIRST,
      proposals: [documentLevel("strong"), documentLevel("none", "document_cover_letter")],
      spans: [span("span_1")]
    });
    expect(assessment.levelDisagreement).toBe(false);
  });

  it("refuses a non-none level that no supporting span from its own document grounds", () => {
    const assessment = firstAssessment({
      dimensionId: FIRST,
      proposals: [
        documentLevel("strong", "document_resume"),
        documentLevel("weak", "document_cover_letter")
      ],
      spans: [span("span_1", "document_cover_letter")]
    });
    expect(assessment.level).toBe("weak");
    expect(assessment.ungroundedDocumentIds).toEqual(["document_resume"]);
    expect(assessment.levelDisagreement).toBe(false);
  });

  it("falls back to none when every non-none proposal is ungrounded", () => {
    const assessment = firstAssessment({
      dimensionId: FIRST,
      proposals: [documentLevel("strong")],
      spans: [span("span_1", "document_resume", "contradicting")]
    });
    expect(assessment.level).toBe("none");
    expect(assessment.ungroundedDocumentIds).toEqual(["document_resume"]);
  });
});

describe("deriveDimensionAssessments human writes", () => {
  it("lets a human level override the document selection", () => {
    const assessment = firstAssessment({
      dimensionId: FIRST,
      proposals: [documentLevel("weak"), { kind: "human_level", level: "strong" }],
      spans: [span("span_1"), span("span_2", "document_resume", "supporting", "human")]
    });
    expect(assessment).toMatchObject({ level: "strong", source: "human" });
  });

  it("takes the highest of several human levels", () => {
    const assessment = firstAssessment({
      dimensionId: FIRST,
      proposals: [
        documentLevel("none"),
        { kind: "human_level", level: "weak" },
        { kind: "human_level", level: "partial" }
      ],
      spans: [span("span_1")]
    });
    expect(assessment.level).toBe("partial");
  });

  it("lets a human set none explicitly", () => {
    const assessment = firstAssessment({
      dimensionId: FIRST,
      proposals: [documentLevel("strong"), { kind: "human_level", level: "none" }],
      spans: [span("span_1")]
    });
    expect(assessment).toMatchObject({ level: "none", source: "human" });
  });

  it("refuses a non-none human level with no supporting span", () => {
    expect(
      deriveDimensionAssessments(
        withFirst({
          dimensionId: FIRST,
          proposals: [documentLevel("none"), { kind: "human_level", level: "strong" }],
          spans: [span("span_1", "document_resume", "contradicting")]
        }),
        DRAFT_RUBRIC_V1
      )
    ).toMatchObject({
      ok: false,
      error: { message: "A non-none human level requires a located supporting span" }
    });
  });
});

describe("deriveDimensionAssessments calibration diagnostic", () => {
  it("carries deriveLevel over the span counts without giving it authority", () => {
    const assessment = firstAssessment({
      dimensionId: FIRST,
      proposals: [documentLevel("weak")],
      spans: [span("span_1"), span("span_2"), span("span_3")]
    });
    expect(assessment.level).toBe("weak");
    expect(assessment.derivedLevel).toBe("strong");
  });

  it("counts contradicting spans in the diagnostic", () => {
    const assessment = firstAssessment({
      dimensionId: FIRST,
      proposals: [documentLevel("strong")],
      spans: [
        span("span_1"),
        span("span_2"),
        span("span_3", "document_resume", "contradicting")
      ]
    });
    expect(assessment.derivedLevel).toBe("weak");
    expect(assessment.supportingSpanIds).toEqual(["span_1", "span_2"]);
    expect(assessment.contradictingSpanIds).toEqual(["span_3"]);
  });
});

describe("deriveDimensionAssessments gaps and availability", () => {
  it("records an explicit gap without folding it into the level", () => {
    const result = derived(
      withFirst({
        dimensionId: FIRST,
        proposals: [documentLevel("none"), { kind: "document_failure", documentId: "document_two" }],
        spans: []
      })
    );
    expect(result.gaps[0]).toEqual({
      dimensionId: FIRST,
      documentsSearched: ["document_resume", "document_two"]
    });
    expect(result.assessments[0]).toMatchObject({ dimensionId: FIRST, level: "none" });
    expect(result.availability).toBe("complete");
  });

  it("records no gap once any span of either polarity exists", () => {
    const result = derived(
      withFirst({
        dimensionId: FIRST,
        proposals: [documentLevel("none")],
        spans: [span("span_1", "document_resume", "contradicting")]
      })
    );
    expect(result.gaps.map((gap) => gap.dimensionId)).not.toContain(FIRST);
  });

  it("gaps every evidence-free dimension in rubric order", () => {
    const result = derived(DIMENSION_IDS.map(noEvidence));
    expect(result.gaps.map((gap) => gap.dimensionId)).toEqual(DIMENSION_IDS);
  });

  it("makes a dimension unavailable when every document failed", () => {
    const result = derived(
      withFirst({
        dimensionId: FIRST,
        proposals: [
          { kind: "document_failure", documentId: "document_two" },
          { kind: "document_failure", documentId: "document_resume" }
        ],
        spans: []
      })
    );
    expect(result.availability).toBe("unavailable");
    expect(result.unavailable).toEqual([
      { dimensionId: FIRST, failedDocumentIds: ["document_resume", "document_two"] }
    ]);
    expect(result.assessments.map((entry) => entry.dimensionId)).toEqual(DIMENSION_IDS.slice(1));
    expect(result.gaps.map((gap) => gap.dimensionId)).not.toContain(FIRST);
  });

  it("consolidates a success beside a failure instead of becoming unavailable", () => {
    const result = derived(
      withFirst({
        dimensionId: FIRST,
        proposals: [
          documentLevel("partial", "document_resume"),
          { kind: "document_failure", documentId: "document_two" }
        ],
        spans: [span("span_1")]
      })
    );
    expect(result.availability).toBe("complete");
    expect(result.assessments[0]).toMatchObject({
      level: "partial",
      failedDocumentIds: ["document_two"]
    });
  });

  it("keeps a human resolution available even when every document failed", () => {
    const result = derived(
      withFirst({
        dimensionId: FIRST,
        proposals: [
          { kind: "document_failure", documentId: "document_resume" },
          { kind: "human_level", level: "weak" }
        ],
        spans: [span("span_1", "document_resume", "supporting", "human")]
      })
    );
    expect(result.availability).toBe("complete");
    expect(result.assessments[0]).toMatchObject({ level: "weak", source: "human" });
  });
});
