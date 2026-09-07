import {
  consolidateStructuredFacts,
  deriveDimensionAssessments,
  DRAFT_RUBRIC_V1,
  foldForMatching,
  HardRequirementPolicySchema,
  normalizeSourceText,
  relocateQuote,
  resolveHardRequirements,
  type FactConsolidation,
  type HardRequirementPolicy
} from "../../packages/core/src/index.js";
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

  const rawResumeText =
    "\uFEFFSenior Distributed Systems Architect\r\n" +
    "Over 10 years of experience designing high-availability backends.\r\n" +
    "Led cross-functional team across 'Core Infrastructure' and Platform Reliability.\r\n" +
    "Specialized in consensus protocols, Paxos, Raft, and distributed storage.";

  const normalizedResult = normalizeSourceText(rawResumeText);
  const normalizedResumeText = normalizedResult.ok
    ? normalizedResult.value.normalizedText
    : rawResumeText;

  const exactQuote = "Over 10 years of experience designing high-availability backends.";
  const foldedQuote =
    "led cross-functional team across 'core infrastructure' and platform reliability.";

  const sampleFactProposals = [
    {
      documentId: "doc-resume",
      provenance: "parsed" as const,
      payload: {
        kind: "employment_interval" as const,
        employer: "Acme Corp",
        title: "Senior Staff Engineer",
        startMonth: "2019-01",
        endMonth: "2024-06"
      },
      evidenceSpanIds: ["span-1"]
    },
    {
      documentId: "doc-linkedin",
      provenance: "extracted" as const,
      payload: {
        kind: "employment_interval" as const,
        employer: "Acme Corp",
        title: "Senior Staff Engineer",
        startMonth: "2019-01",
        endMonth: "2024-06"
      },
      evidenceSpanIds: ["span-2"]
    },
    {
      documentId: "doc-resume",
      provenance: "parsed" as const,
      payload: {
        kind: "current_title" as const,
        title: "Senior Staff Engineer"
      },
      evidenceSpanIds: ["span-3"]
    },
    {
      documentId: "doc-linkedin",
      provenance: "extracted" as const,
      payload: {
        kind: "current_title" as const,
        title: "Principal Engineer"
      },
      evidenceSpanIds: ["span-4"]
    },
    {
      documentId: "doc-resume",
      provenance: "extracted" as const,
      payload: {
        kind: "work_authorization_statement" as const,
        classification: "authorized" as const,
        statementText: "Authorized to work in the US without sponsorship"
      },
      evidenceSpanIds: ["span-5"]
    },
    {
      documentId: "doc-resume",
      provenance: "parsed" as const,
      payload: {
        kind: "employer_history_entry" as const,
        employer: "Acme Corp",
        startMonth: "2019-01",
        endMonth: "2024-06"
      },
      evidenceSpanIds: ["span-6"]
    }
  ];

  const precomputedConsolidationResult = consolidateStructuredFacts(sampleFactProposals);
  const precomputedConsolidation: FactConsolidation = precomputedConsolidationResult.ok
    ? precomputedConsolidationResult.value
    : { facts: [], conflicts: [], documentIds: [] };

  const hardRequirementPolicy: HardRequirementPolicy = HardRequirementPolicySchema.parse({
    asOfMonth: "2026-09",
    requirements: [
      {
        requirementId: "years_experience",
        predicate: { kind: "minimum_experience_months", months: 48 }
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
    ]
  });

  const sampleDimensionEvidence = DRAFT_RUBRIC_V1.dimensions.map((dim, idx) => {
    if (idx === 0) {
      return {
        dimensionId: dim.dimensionId,
        proposals: [
          {
            kind: "document_level" as const,
            documentId: "doc-resume",
            level: "proficient" as const
          },
          {
            kind: "document_level" as const,
            documentId: "doc-linkedin",
            level: "advanced" as const
          }
        ],
        spans: [
          {
            evidenceSpanId: "span-1",
            documentId: "doc-resume",
            polarity: "supporting" as const,
            source: "extracted" as const
          },
          {
            evidenceSpanId: "span-2",
            documentId: "doc-linkedin",
            polarity: "supporting" as const,
            source: "extracted" as const
          }
        ]
      };
    }
    return {
      dimensionId: dim.dimensionId,
      proposals: [
        {
          kind: "document_level" as const,
          documentId: "doc-resume",
          level: "none" as const
        }
      ],
      spans: []
    };
  });

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
    },
    {
      name: "Matching: Source Text Normalization",
      iterations,
      fn: () => {
        normalizeSourceText(rawResumeText);
      }
    },
    {
      name: "Matching: Text Folding",
      iterations,
      fn: () => {
        foldForMatching(normalizedResumeText);
      }
    },
    {
      name: "Matching: Quote Relocation (Tier 1 Exact)",
      iterations,
      fn: () => {
        relocateQuote(normalizedResumeText, exactQuote);
      }
    },
    {
      name: "Matching: Quote Relocation (Tier 2 Folded)",
      iterations,
      fn: () => {
        relocateQuote(normalizedResumeText, foldedQuote);
      }
    },
    {
      name: "Pipeline: Fact Consolidation",
      iterations,
      fn: () => {
        consolidateStructuredFacts(sampleFactProposals);
      }
    },
    {
      name: "Pipeline: Dimension Assessment Derivation",
      iterations,
      fn: () => {
        deriveDimensionAssessments(sampleDimensionEvidence, DRAFT_RUBRIC_V1);
      }
    },
    {
      name: "Pipeline: Hard Requirement Resolution",
      iterations,
      fn: () => {
        resolveHardRequirements(precomputedConsolidation, hardRequirementPolicy);
      }
    }
  ];
}
