import { assignSpanMatches, computeCharacterIou } from "../../tests/eval/index.js";
import type { BenchmarkTask } from "../types.js";

export function createMatchingTasks(iterations = 2000): BenchmarkTask[] {
  const spanA = { start: 100, end: 350 };
  const spanB = { start: 200, end: 450 };

  const expectedSpans = [
    {
      id: "exp-1",
      candidateId: "cand-1",
      documentId: "doc-1",
      dimension: "years_experience",
      polarity: "supporting" as const,
      start: 50,
      end: 250,
      text: "Extensive distributed systems experience"
    },
    {
      id: "exp-2",
      candidateId: "cand-1",
      documentId: "doc-1",
      dimension: "leadership",
      polarity: "supporting" as const,
      start: 300,
      end: 500,
      text: "Led a team of 12 engineers"
    }
  ];

  const predictedSpans = [
    {
      id: "pred-1",
      candidateId: "cand-1",
      documentId: "doc-1",
      dimension: "years_experience",
      polarity: "supporting" as const,
      start: 60,
      end: 240,
      text: "Extensive distributed systems"
    },
    {
      id: "pred-2",
      candidateId: "cand-1",
      documentId: "doc-1",
      dimension: "leadership",
      polarity: "supporting" as const,
      start: 310,
      end: 490,
      text: "Led a team of 12"
    }
  ];

  return [
    {
      name: "Matching: Character IoU Calculation",
      iterations: iterations * 5,
      fn: () => {
        computeCharacterIou(spanA, spanB);
      }
    },
    {
      name: "Matching: Bipartite Span Assignment",
      iterations,
      fn: () => {
        assignSpanMatches(expectedSpans, predictedSpans, 0.5);
      }
    }
  ];
}
