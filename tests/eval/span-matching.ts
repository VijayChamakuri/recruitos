import type {
  EvalMetrics,
  ExpectedSpan,
  MatchedSpanPair,
  PredictedSpan,
  SpanInterval,
  SpanMatchResult
} from "./types.js";

/**
 * Computes exact character-level Intersection over Union (IoU) between two intervals.
 */
export function computeCharacterIou(a: SpanInterval, b: SpanInterval): number {
  if (a.start >= a.end || b.start >= b.end) {
    return 0;
  }
  const intersectionStart = Math.max(a.start, b.start);
  const intersectionEnd = Math.min(a.end, b.end);
  const intersectionLength = Math.max(0, intersectionEnd - intersectionStart);

  const unionStart = Math.min(a.start, b.start);
  const unionEnd = Math.max(a.end, b.end);
  const unionLength = Math.max(0, unionEnd - unionStart);

  if (unionLength === 0) {
    return 0;
  }

  return Number((intersectionLength / unionLength).toFixed(6));
}

/**
 * Calculates precision, recall, and F1 adhering to Class 2 evaluation rules:
 * - Zero predictions with nonzero expectations -> noncomputable precision (null), 0 recall
 * - Empty prediction and expectation sets -> noncomputable (null), never perfect
 * - Zero expectations with nonzero predictions -> 0 precision, noncomputable recall (null)
 */
export function calculateMetrics(
  matchedCount: number,
  predictedCount: number,
  expectedCount: number
): EvalMetrics {
  if (predictedCount === 0 && expectedCount === 0) {
    return { precision: null, recall: null, f1: null };
  }
  if (predictedCount === 0 && expectedCount > 0) {
    return { precision: null, recall: 0, f1: null };
  }
  if (expectedCount === 0 && predictedCount > 0) {
    return { precision: 0, recall: null, f1: null };
  }

  const precision = matchedCount / predictedCount;
  const recall = matchedCount / expectedCount;
  const sum = precision + recall;
  const f1 = sum > 0 ? (2 * precision * recall) / sum : 0;

  return {
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1: Number(f1.toFixed(4))
  };
}

interface CandidatePair {
  expected: ExpectedSpan;
  predicted: PredictedSpan;
  iou: number;
}

/**
 * Performs one-to-one bipartite matching maximizing total IoU with deterministic tie-breaking.
 * Eligible pairs require matching candidate, document, dimension, polarity, and IoU >= minIou.
 */
export function assignSpanMatches(
  expectedSpans: readonly ExpectedSpan[],
  predictedSpans: readonly PredictedSpan[],
  minIou = 0.5
): SpanMatchResult {
  const eligiblePairs: CandidatePair[] = [];

  for (const exp of expectedSpans) {
    for (const pred of predictedSpans) {
      if (
        exp.candidateId === pred.candidateId &&
        exp.documentId === pred.documentId &&
        exp.dimension === pred.dimension &&
        exp.polarity === pred.polarity
      ) {
        const iou = computeCharacterIou(exp, pred);
        if (iou >= minIou) {
          eligiblePairs.push({ expected: exp, predicted: pred, iou });
        }
      }
    }
  }

  // Sort by IoU descending, breaking ties deterministically by expected.id then predicted.id
  eligiblePairs.sort((a, b) => {
    if (b.iou !== a.iou) {
      return b.iou - a.iou;
    }
    const expCmp = a.expected.id.localeCompare(b.expected.id);
    if (expCmp !== 0) return expCmp;
    return a.predicted.id.localeCompare(b.predicted.id);
  });

  const matchedExpectedIds = new Set<string>();
  const matchedPredictedIds = new Set<string>();
  const matches: MatchedSpanPair[] = [];

  for (const pair of eligiblePairs) {
    if (
      !matchedExpectedIds.has(pair.expected.id) &&
      !matchedPredictedIds.has(pair.predicted.id)
    ) {
      matchedExpectedIds.add(pair.expected.id);
      matchedPredictedIds.add(pair.predicted.id);
      matches.push({
        expected: pair.expected,
        predicted: pair.predicted,
        iou: pair.iou,
        isExactBoundary:
          pair.expected.start === pair.predicted.start &&
          pair.expected.end === pair.predicted.end
      });
    }
  }

  const unmatchedExpected = expectedSpans.filter(
    (exp) => !matchedExpectedIds.has(exp.id)
  );
  const unmatchedPredicted = predictedSpans.filter(
    (pred) => !matchedPredictedIds.has(pred.id)
  );

  const metrics = calculateMetrics(
    matches.length,
    predictedSpans.length,
    expectedSpans.length
  );

  let meanIou: number | null = null;
  let medianIou: number | null = null;
  let exactBoundaryMatchRate: number | null = null;

  if (matches.length > 0) {
    const ious = matches.map((m) => m.iou).sort((a, b) => a - b);
    const sum = ious.reduce((acc, curr) => acc + curr, 0);
    meanIou = Number((sum / matches.length).toFixed(4));

    const mid = Math.floor(ious.length / 2);
    medianIou =
      ious.length % 2 === 0
        ? Number((((ious[mid - 1] ?? 0) + (ious[mid] ?? 0)) / 2).toFixed(4))
        : (ious[mid] ?? null);

    const exactCount = matches.filter((m) => m.isExactBoundary).length;
    exactBoundaryMatchRate = Number((exactCount / matches.length).toFixed(4));
  }

  return {
    matches,
    unmatchedExpected,
    unmatchedPredicted,
    metrics,
    meanIou,
    medianIou,
    exactBoundaryMatchRate
  };
}
