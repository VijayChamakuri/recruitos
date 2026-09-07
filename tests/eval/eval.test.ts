import { describe, expect, it } from "vitest";
import {
  assignSpanMatches,
  calculateMetrics,
  computeCharacterIou,
  evaluateGroundedSpans,
  relocateExtractedClaims,
  runClass1EvaluationGate,
  type Class1EvaluationInput,
  type ExpectedSpan,
  type ExtractedQuoteClaim,
  type PredictedSpan
} from "./index.js";

describe("Character IoU Computation", () => {
  it("calculates exact match IoU as 1.0", () => {
    const iou = computeCharacterIou({ start: 10, end: 50 }, { start: 10, end: 50 });
    expect(iou).toBe(1.0);
  });

  it("calculates disjoint intervals IoU as 0", () => {
    const iou = computeCharacterIou({ start: 10, end: 20 }, { start: 30, end: 40 });
    expect(iou).toBe(0);
  });

  it("calculates touching intervals IoU as 0", () => {
    const iou = computeCharacterIou({ start: 10, end: 20 }, { start: 20, end: 30 });
    expect(iou).toBe(0);
  });

  it("calculates partial overlap IoU correctly", () => {
    // [10, 30) and [20, 40): intersection [20, 30) = 10, union [10, 40) = 30 -> 10/30 = 0.333333
    const iou = computeCharacterIou({ start: 10, end: 30 }, { start: 20, end: 40 });
    expect(iou).toBe(0.333333);
  });

  it("returns 0 for empty or inverted intervals", () => {
    expect(computeCharacterIou({ start: 20, end: 10 }, { start: 10, end: 30 })).toBe(0);
    expect(computeCharacterIou({ start: 10, end: 10 }, { start: 10, end: 30 })).toBe(0);
  });
});

describe("Class 2 Metrics and Edge Cases", () => {
  it("treats zero predictions with nonzero expectations as noncomputable precision and 0 recall", () => {
    const metrics = calculateMetrics(0, 0, 5);
    expect(metrics.precision).toBeNull();
    expect(metrics.recall).toBe(0);
    expect(metrics.f1).toBeNull();
  });

  it("treats empty prediction and expectation sets as noncomputable", () => {
    const metrics = calculateMetrics(0, 0, 0);
    expect(metrics.precision).toBeNull();
    expect(metrics.recall).toBeNull();
    expect(metrics.f1).toBeNull();
  });

  it("treats nonzero predictions with zero expectations as zero precision and noncomputable recall", () => {
    const metrics = calculateMetrics(0, 3, 0);
    expect(metrics.precision).toBe(0);
    expect(metrics.recall).toBeNull();
    expect(metrics.f1).toBeNull();
  });

  it("calculates precision, recall, and F1 for standard match counts", () => {
    // 4 matched out of 5 predicted, 8 expected
    const metrics = calculateMetrics(4, 5, 8);
    expect(metrics.precision).toBe(0.8);
    expect(metrics.recall).toBe(0.5);
    // f1 = 2 * 0.8 * 0.5 / (0.8 + 0.5) = 0.8 / 1.3 = 0.6154
    expect(metrics.f1).toBe(0.6154);
  });
});

describe("Span Matching Bipartite Assignment", () => {
  const baseExpected: ExpectedSpan = {
    id: "exp-1",
    candidateId: "cand-1",
    documentId: "doc-1",
    dimension: "years_experience",
    polarity: "supporting",
    start: 100,
    end: 200,
    text: "10 years experience in distributed systems"
  };

  it("matches span pair with IoU >= 0.5 and reports exact boundary", () => {
    const pred: PredictedSpan = {
      id: "pred-1",
      candidateId: "cand-1",
      documentId: "doc-1",
      dimension: "years_experience",
      polarity: "supporting",
      start: 100,
      end: 200,
      text: "10 years experience in distributed systems"
    };

    const result = assignSpanMatches([baseExpected], [pred]);
    expect(result.matches.length).toBe(1);
    expect(result.matches[0]?.iou).toBe(1.0);
    expect(result.matches[0]?.isExactBoundary).toBe(true);
    expect(result.exactBoundaryMatchRate).toBe(1.0);
    expect(result.metrics.precision).toBe(1.0);
    expect(result.metrics.recall).toBe(1.0);
    expect(result.metrics.f1).toBe(1.0);
  });

  it("filters out pairs with IoU < 0.5", () => {
    const lowOverlapPred: PredictedSpan = {
      id: "pred-low",
      candidateId: "cand-1",
      documentId: "doc-1",
      dimension: "years_experience",
      polarity: "supporting",
      start: 170,
      end: 250,
      // Overlap: [170, 200) = 30. Union: [100, 250) = 150. IoU = 30/150 = 0.20 (< 0.50)
      text: "in distributed systems engineering"
    };

    const result = assignSpanMatches([baseExpected], [lowOverlapPred]);
    expect(result.matches.length).toBe(0);
    expect(result.unmatchedExpected.length).toBe(1);
    expect(result.unmatchedPredicted.length).toBe(1);
    expect(result.metrics.precision).toBe(0);
    expect(result.metrics.recall).toBe(0);
  });

  it("does not match across different dimensions or polarities", () => {
    const diffDimensionPred: PredictedSpan = {
      id: "pred-diff",
      candidateId: "cand-1",
      documentId: "doc-1",
      dimension: "education_level",
      polarity: "supporting",
      start: 100,
      end: 200,
      text: "10 years experience in distributed systems"
    };

    const result = assignSpanMatches([baseExpected], [diffDimensionPred]);
    expect(result.matches.length).toBe(0);
  });

  it("enforces 1-to-1 assignment and breaks ties deterministically", () => {
    const pred1: PredictedSpan = {
      id: "pred-a",
      candidateId: "cand-1",
      documentId: "doc-1",
      dimension: "years_experience",
      polarity: "supporting",
      start: 100,
      end: 190, // IoU = 90/100 = 0.90
      text: "10 years experience in distributed"
    };
    const pred2: PredictedSpan = {
      id: "pred-b",
      candidateId: "cand-1",
      documentId: "doc-1",
      dimension: "years_experience",
      polarity: "supporting",
      start: 100,
      end: 200, // IoU = 100/100 = 1.00 (higher IoU wins)
      text: "10 years experience in distributed systems"
    };

    const result = assignSpanMatches([baseExpected], [pred1, pred2]);
    expect(result.matches.length).toBe(1);
    expect(result.matches[0]?.predicted.id).toBe("pred-b");
    expect(result.unmatchedPredicted.length).toBe(1);
    expect(result.unmatchedPredicted[0]?.id).toBe("pred-a");
  });
});

describe("Class 1 Evaluation Gate", () => {
  const validInput: Class1EvaluationInput = {
    candidateId: "cand-tier1-01",
    tier: 1,
    totalDimensions: 5,
    dimensionCoverages: [
      { dimension: "dim1", locatedSpanCount: 2, validatedGapCount: 0, isComplete: true },
      { dimension: "dim2", locatedSpanCount: 1, validatedGapCount: 0, isComplete: true },
      { dimension: "dim3", locatedSpanCount: 3, validatedGapCount: 0, isComplete: true },
      { dimension: "dim4", locatedSpanCount: 1, validatedGapCount: 0, isComplete: true },
      { dimension: "dim5", locatedSpanCount: 0, validatedGapCount: 1, isComplete: true }
    ],
    knownLimitations: [
      "No real fairness conclusions from synthetic corpus",
      "Exact span match requires UTF-16 slice alignment",
      "Contradicting polarity terms supersede unverified claims"
    ]
  };

  it("passes when >= 70% located coverage, all dimensions covered/gapped, and >= 3 limitations", () => {
    const report = runClass1EvaluationGate(validInput);
    expect(report.passed).toBe(true);
    // 4 out of 5 dimensions located = 80.0% >= 70%
    expect(report.locatedSpanCoverageRate).toBe(0.8);
    expect(report.coverageRequirementMet).toBe(true);
    expect(report.allDimensionsAccountedFor).toBe(true);
    expect(report.knownLimitationsCountMet).toBe(true);
    expect(report.violations.length).toBe(0);
  });

  it("fails tier-1 evaluation when located span coverage is below 70%", () => {
    const lowCoverageInput: Class1EvaluationInput = {
      ...validInput,
      dimensionCoverages: [
        { dimension: "dim1", locatedSpanCount: 1, validatedGapCount: 0, isComplete: true },
        { dimension: "dim2", locatedSpanCount: 1, validatedGapCount: 0, isComplete: true },
        { dimension: "dim3", locatedSpanCount: 0, validatedGapCount: 1, isComplete: true },
        { dimension: "dim4", locatedSpanCount: 0, validatedGapCount: 1, isComplete: true },
        { dimension: "dim5", locatedSpanCount: 0, validatedGapCount: 1, isComplete: true }
      ]
    };
    // 2 out of 5 dimensions located = 40.0% < 70%
    const report = runClass1EvaluationGate(lowCoverageInput);
    expect(report.passed).toBe(false);
    expect(report.coverageRequirementMet).toBe(false);
    expect(report.violations.some((v) => v.includes("coverage"))).toBe(true);
  });

  it("fails when a dimension is silently absent (neither located nor gapped)", () => {
    const absentDimensionInput: Class1EvaluationInput = {
      ...validInput,
      dimensionCoverages: [
        { dimension: "dim1", locatedSpanCount: 2, validatedGapCount: 0, isComplete: true },
        { dimension: "dim2", locatedSpanCount: 1, validatedGapCount: 0, isComplete: true },
        { dimension: "dim3", locatedSpanCount: 1, validatedGapCount: 0, isComplete: true },
        { dimension: "dim4", locatedSpanCount: 1, validatedGapCount: 0, isComplete: true },
        // dim5 has 0 located and 0 gapped -> silently absent!
        { dimension: "dim5", locatedSpanCount: 0, validatedGapCount: 0, isComplete: false }
      ]
    };
    const report = runClass1EvaluationGate(absentDimensionInput);
    expect(report.passed).toBe(false);
    expect(report.allDimensionsAccountedFor).toBe(false);
    expect(report.violations.some((v) => v.includes("silently absent"))).toBe(true);
  });

  it("fails when fewer than 3 known limitations are present", () => {
    const missingLimitationsInput: Class1EvaluationInput = {
      ...validInput,
      knownLimitations: ["Single limitation"]
    };
    const report = runClass1EvaluationGate(missingLimitationsInput);
    expect(report.passed).toBe(false);
    expect(report.knownLimitationsCountMet).toBe(false);
    expect(report.violations.some((v) => v.includes("visible known limitations"))).toBe(true);
  });
});

describe("Quote Claim Relocation", () => {
  const sampleResume =
    "Senior Distributed Systems Engineer with 8 years of experience building high-throughput services.";

  it("relocates exact quote claim and ignores inaccurate model offsets", () => {
    const claims: ExtractedQuoteClaim[] = [
      {
        id: "claim-1",
        candidateId: "cand-1",
        documentId: "doc-resume",
        dimension: "years_experience",
        polarity: "supporting",
        quotedText: "8 years of experience",
        claimedStart: 999, // Inaccurate offset model proposed
        claimedEnd: 1200,
        confidence: 0.95
      }
    ];

    const result = relocateExtractedClaims({ "doc-resume": sampleResume }, claims);
    expect(result.totalClaims).toBe(1);
    expect(result.relocatedSpans.length).toBe(1);
    expect(result.unlocatedClaims.length).toBe(0);
    expect(result.exactMatches).toBe(1);
    expect(result.normalizedMatches).toBe(0);
    expect(result.relocationRate).toBe(1.0);

    const span = result.relocatedSpans[0];
    expect(span?.id).toBe("claim-1");
    expect(span?.start).toBe(41);
    expect(span?.end).toBe(62);
    expect(span?.matchedText).toBe("8 years of experience");
    expect(span?.matchQuality).toBe("exact");
    expect(span?.confidence).toBe(0.95);
  });

  it("relocates folded quote claim with case and punctuation normalization", () => {
    const sourceWithPunctuation =
      'Led "Mission-Critical" initiatives across distributed platforms.';
    // Model extract with standard quotes and lower case
    const claims: ExtractedQuoteClaim[] = [
      {
        id: "claim-folded",
        candidateId: "cand-1",
        documentId: "doc-resume",
        dimension: "leadership",
        polarity: "supporting",
        quotedText: 'led "mission-critical" initiatives'
      }
    ];

    const result = relocateExtractedClaims(
      { "doc-resume": sourceWithPunctuation },
      claims
    );
    expect(result.relocatedSpans.length).toBe(1);
    expect(result.normalizedMatches).toBe(1);
    expect(result.exactMatches).toBe(0);

    const span = result.relocatedSpans[0];
    expect(span?.start).toBe(0);
    expect(span?.end).toBe(34);
    expect(span?.matchedText).toBe('Led "Mission-Critical" initiatives');
    expect(span?.matchQuality).toBe("normalized");
  });

  it("records unlocated quote failure when quote does not locate in document", () => {
    const claims: ExtractedQuoteClaim[] = [
      {
        id: "claim-missing",
        candidateId: "cand-1",
        documentId: "doc-resume",
        dimension: "certifications",
        polarity: "supporting",
        quotedText: "Certified Kubernetes Administrator CKA-2024"
      }
    ];

    const result = relocateExtractedClaims({ "doc-resume": sampleResume }, claims);
    expect(result.relocatedSpans.length).toBe(0);
    expect(result.unlocatedClaims.length).toBe(1);
    expect(result.relocationRate).toBe(0);

    const failure = result.unlocatedClaims[0];
    expect(failure?.claimId).toBe("claim-missing");
    expect(failure?.reason).toBe("unlocated");
    expect(failure?.error).toContain("Quote did not locate in the source text");
  });

  it("reports failure when documentId is absent from document texts", () => {
    const claims: ExtractedQuoteClaim[] = [
      {
        id: "claim-no-doc",
        candidateId: "cand-1",
        documentId: "unknown-document",
        dimension: "skills",
        polarity: "supporting",
        quotedText: "Distributed Systems"
      }
    ];

    const result = relocateExtractedClaims({ "doc-resume": sampleResume }, claims);
    expect(result.relocatedSpans.length).toBe(0);
    expect(result.unlocatedClaims.length).toBe(1);
    expect(result.unlocatedClaims[0]?.error).toContain("not found in documentTexts");
  });

  it("supports ReadonlyMap for document texts lookup", () => {
    const docMap = new Map<string, string>([["doc-map", sampleResume]]);
    const claims: ExtractedQuoteClaim[] = [
      {
        id: "claim-map",
        candidateId: "cand-1",
        documentId: "doc-map",
        dimension: "title",
        polarity: "supporting",
        quotedText: "Senior Distributed Systems Engineer"
      }
    ];

    const result = relocateExtractedClaims(docMap, claims);
    expect(result.relocatedSpans.length).toBe(1);
    expect(result.relocatedSpans[0]?.start).toBe(0);
    expect(result.relocatedSpans[0]?.end).toBe(35);
  });

  it("reports failure when document text cannot be normalized", () => {
    const claims: ExtractedQuoteClaim[] = [
      {
        id: "claim-empty-doc",
        candidateId: "cand-1",
        documentId: "doc-empty",
        dimension: "skills",
        polarity: "supporting",
        quotedText: "Distributed Systems"
      }
    ];

    const result = relocateExtractedClaims({ "doc-empty": "" }, claims);
    expect(result.relocatedSpans.length).toBe(0);
    expect(result.unlocatedClaims.length).toBe(1);
    expect(result.unlocatedClaims[0]?.error).toContain("Source text is empty");
  });

  it("handles empty claims array gracefully", () => {
    const result = relocateExtractedClaims({ "doc-resume": sampleResume }, []);
    expect(result.totalClaims).toBe(0);
    expect(result.relocatedSpans.length).toBe(0);
    expect(result.unlocatedClaims.length).toBe(0);
    expect(result.relocationRate).toBeNull();
  });
});

describe("Grounded Span Evaluation", () => {
  const resumeText =
    "Senior Engineer with 8 years of experience building scalable systems. Based in San Francisco.";

  const expected: ExpectedSpan[] = [
    {
      id: "exp-years",
      candidateId: "cand-1",
      documentId: "doc-1",
      dimension: "years_experience",
      polarity: "supporting",
      start: 21,
      end: 42,
      text: "8 years of experience"
    }
  ];

  it("evaluates end-to-end relocation and bipartite span matching", () => {
    const claims: ExtractedQuoteClaim[] = [
      {
        id: "claim-1",
        candidateId: "cand-1",
        documentId: "doc-1",
        dimension: "years_experience",
        polarity: "supporting",
        quotedText: "8 years of experience",
        confidence: 0.98
      },
      {
        id: "claim-hallucinated",
        candidateId: "cand-1",
        documentId: "doc-1",
        dimension: "education",
        polarity: "supporting",
        quotedText: "Ph.D. in Computer Science from Stanford University"
      }
    ];

    const evaluation = evaluateGroundedSpans(expected, { "doc-1": resumeText }, claims);

    // Relocation checks
    expect(evaluation.relocation.totalClaims).toBe(2);
    expect(evaluation.relocation.relocatedSpans.length).toBe(1);
    expect(evaluation.relocation.unlocatedClaims.length).toBe(1);
    expect(evaluation.relocation.exactMatches).toBe(1);

    // Span match checks
    expect(evaluation.spanMatches.matches.length).toBe(1);
    expect(evaluation.spanMatches.matches[0]?.iou).toBe(1.0);
    expect(evaluation.spanMatches.matches[0]?.isExactBoundary).toBe(true);

    // Relocated precision: 1 match / 1 relocated = 1.0
    expect(evaluation.spanMatches.metrics.precision).toBe(1.0);
    // Effective precision over all claims: 1 match / 2 claims = 0.5
    expect(evaluation.effectivePrecision).toBe(0.5);
  });

  it("handles empty claims in grounded span evaluation", () => {
    const evaluation = evaluateGroundedSpans(expected, { "doc-1": resumeText }, []);
    expect(evaluation.relocation.totalClaims).toBe(0);
    expect(evaluation.spanMatches.matches.length).toBe(0);
    expect(evaluation.effectivePrecision).toBeNull();
  });
});
