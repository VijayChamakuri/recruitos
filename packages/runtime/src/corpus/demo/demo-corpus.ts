import { canonicalJsonStringify, sha256Hex } from "@recruitos/core";

import type { CandidateSourceRecord } from "../../adapters/index.js";

/**
 * The seven-route proving corpus for the local demo spine.
 *
 * Seven synthetic candidates, each authored to exercise one primary route
 * through the runtime: scored, hard-requirement rejection, escalation on a
 * missing structured answer, a reviewable extraction failure, a missing-evidence
 * dimension gap, work authorization resolved from a structured application
 * answer, and quote grounding with a dropped quote.
 *
 * Every candidate's resume and extraction quotes carry a per-candidate token so
 * no two candidates ever produce an identical extraction for a dimension. The
 * extraction artifact content hash is offset-independent (it hashes dimension,
 * level, quoted text, and polarity), so identical quotes across candidates with
 * different source documents would collide on the unique content hash and fail
 * the `attempt_work_item_reject_terminal_owner` trigger.
 *
 * `demoPrepare` imports all seven, extracts against these hand-authored
 * responses, and finalizes in one run. `DEMO_EXPECTED_OUTCOMES` is what the CLI
 * integration test and `eval:class1` assert against. The full tier-one corpus
 * replaces this later and moves to `fixtures/corpus` and `fixtures/expected`.
 */

export const DEMO_ROLE_ID = "role-applied-ai-engineer";
export const DEMO_ROLE_TITLE = "Applied AI Engineer";

/** Frozen instant for the demo runtime clock, so every run is reproducible. */
export const DEMO_CLOCK_MS = 1_788_700_000_000;

/**
 * Frozen corpus date. Matches `startTriageRun`'s default and drives the OQ-7
 * hard-requirement policy's as-of month (2026-09).
 */
export const DEMO_FROZEN_DATE = "2026-09-07";

export const DEMO_CANDIDATE_SOURCE_SYSTEM = "ats_synthetic";
export const DEMO_WORK_AUTHORIZATION_QUESTION_KEY = "eligible_to_work";
export const DEMO_WORK_AUTHORIZATION_AUTHORIZED = "authorized_no_sponsorship";

const DIMENSION_IDS = [
  "applied_ml_llm_systems",
  "production_software_engineering",
  "evaluation_and_measurement",
  "data_and_pipeline_work",
  "ambiguity_and_ownership",
  "communication_of_reasoning"
] as const;

export const DEMO_DIMENSION_IDS: readonly string[] = DIMENSION_IDS;

type Level = "none" | "weak" | "partial" | "strong";
type DimensionKey =
  | "applied"
  | "production"
  | "evaluation"
  | "data"
  | "ambiguity"
  | "communication";

/**
 * Narrative sentences, each ending in a `{ref}` placeholder that is replaced
 * with the candidate token. The extraction quote for a dimension is the
 * sentence up to and including that token, so it is a verbatim contiguous slice
 * and unique per candidate.
 */
const NARRATIVE_TEMPLATES: Readonly<Record<DimensionKey, string>> = {
  applied:
    "Built and shipped a retrieval augmented generation service for 30000 monthly users, owning prompt design and tool use across an agent loop. {ref}",
  production:
    "Ran the service on call for eighteen months, wrote the continuous integration pipeline, and led two schema migrations without downtime. {ref}",
  evaluation:
    "Defined an offline evaluation set of 400 labeled questions, tracked answer accuracy before every release, and blocked one regressing launch. {ref}",
  data: "Owned the ingestion path that parsed and normalized every candidate document before scoring. {ref}",
  ambiguity:
    "Framed the ambiguity in the routing requirements in a design document, chose the escalation thresholds, and carried the rollout past the first week. {ref}",
  communication:
    "Published an internal write up explaining why we chose deterministic scoring over a learned ranker and what that traded away. {ref}"
};

function token(sourceKey: string): string {
  return `[ref ${sourceKey}]`;
}

function narrativeLine(dimension: DimensionKey, sourceKey: string): string {
  return NARRATIVE_TEMPLATES[dimension].replace("{ref}", token(sourceKey));
}

type DimensionBody = Readonly<{ proposedLevel: Level; quoteDimension: DimensionKey | null }>;

/** Full coverage: every dimension quotes its own narrative line. */
const FULL_COVERAGE: Readonly<Record<string, DimensionBody>> = {
  applied_ml_llm_systems: { proposedLevel: "strong", quoteDimension: "applied" },
  production_software_engineering: { proposedLevel: "strong", quoteDimension: "production" },
  evaluation_and_measurement: { proposedLevel: "partial", quoteDimension: "evaluation" },
  data_and_pipeline_work: { proposedLevel: "weak", quoteDimension: "data" },
  ambiguity_and_ownership: { proposedLevel: "partial", quoteDimension: "ambiguity" },
  communication_of_reasoning: { proposedLevel: "partial", quoteDimension: "communication" }
};

function withOverrides(
  overrides: Readonly<Record<string, DimensionBody>>
): Readonly<Record<string, DimensionBody>> {
  return { ...FULL_COVERAGE, ...overrides };
}

type ExpectedOutcome = Readonly<{
  sourceKey: string;
  status: "scored" | "escalated" | "rejected_hard_requirement";
  availability: "complete" | "unavailable";
  reasonCodes: readonly string[];
  sealed: true;
  /**
   * The exact sealed score and confidence fractions, or `null` when the
   * assessment is unavailable. These are reviewed fixture values: a change to
   * scoring, confidence, or the corpus should update them deliberately.
   */
  scoreText: string | null;
  confidenceText: string | null;
  /**
   * Exact extractor span totals behind the confidence resolution term, or
   * `null` when the assessment is unavailable. `spansReturned > spansLocated`
   * is the quote-grounding shortfall.
   */
  spansReturned: number | null;
  spansLocated: number | null;
}>;

type DemoCandidate = Readonly<{
  route: string;
  sourceKey: string;
  experienceBlock: readonly string[];
  workAuthorized: boolean;
  bodies: Readonly<Record<string, DimensionBody>>;
  /** A dimension whose body carries a second, deliberately unlocatable quote. */
  droppedQuoteDimension?: string;
  expected: ExpectedOutcome;
}>;

const MISSING_TENURE = [
  "missing_evidence:current_title",
  "missing_evidence:employer_history",
  "missing_evidence:years_experience"
] as const;

const DEMO_CANDIDATES: readonly DemoCandidate[] = [
  {
    route: "scored",
    sourceKey: "demo/route-1-scored",
    experienceBlock: [
      "Senior Machine Learning Engineer | TechCorp | 2021-03 | present",
      "Machine Learning Engineer | DataCo | 2019-06 | 2021-02"
    ],
    workAuthorized: true,
    bodies: FULL_COVERAGE,
    expected: {
      sourceKey: "demo/route-1-scored",
      status: "scored",
      availability: "complete",
      reasonCodes: [],
      sealed: true,
      scoreText: "467/6",
      confidenceText: "7/10",
      spansReturned: 6,
      spansLocated: 6
    }
  },
  {
    route: "hard-requirement-rejection",
    sourceKey: "demo/route-2-rejected",
    experienceBlock: ["Machine Learning Engineer | SmallCo | 2025-06 | 2026-02"],
    workAuthorized: true,
    bodies: FULL_COVERAGE,
    expected: {
      sourceKey: "demo/route-2-rejected",
      status: "rejected_hard_requirement",
      availability: "complete",
      // A conclusive hard-requirement failure sets the status; routing adds no
      // separate reason code for it (route-result keeps reasons empty here).
      reasonCodes: [],
      sealed: true,
      scoreText: "467/6",
      confidenceText: "7/10",
      spansReturned: 6,
      spansLocated: 6
    }
  },
  {
    route: "escalation-missing-work-authorization",
    sourceKey: "demo/route-3-escalated",
    experienceBlock: [
      "Senior Machine Learning Engineer | TechCorp | 2021-03 | present"
    ],
    workAuthorized: false,
    bodies: FULL_COVERAGE,
    expected: {
      sourceKey: "demo/route-3-escalated",
      status: "escalated",
      availability: "complete",
      reasonCodes: ["missing_evidence:work_authorization"],
      sealed: true,
      scoreText: "467/6",
      confidenceText: "27/40",
      spansReturned: 6,
      spansLocated: 6
    }
  },
  {
    route: "reviewable-extraction-failure",
    sourceKey: "demo/route-4-reviewable-failure",
    experienceBlock: [
      "Senior Machine Learning Engineer | TechCorp | 2021-03 | present"
    ],
    workAuthorized: true,
    bodies: withOverrides({
      evaluation_and_measurement: { proposedLevel: "partial", quoteDimension: null }
    }),
    expected: {
      sourceKey: "demo/route-4-reviewable-failure",
      status: "escalated",
      availability: "unavailable",
      reasonCodes: ["assessment_unavailable"],
      sealed: true,
      scoreText: null,
      confidenceText: null,
      spansReturned: null,
      spansLocated: null
    }
  },
  {
    route: "missing-evidence-dimension-gap",
    sourceKey: "demo/route-5-missing-evidence",
    experienceBlock: [],
    workAuthorized: true,
    bodies: withOverrides({
      applied_ml_llm_systems: { proposedLevel: "none", quoteDimension: null }
    }),
    expected: {
      sourceKey: "demo/route-5-missing-evidence",
      status: "escalated",
      availability: "complete",
      reasonCodes: [
        "missing_evidence:applied_ml_llm_systems",
        ...MISSING_TENURE
      ],
      sealed: true,
      scoreText: "317/6",
      confidenceText: "61/120",
      spansReturned: 6,
      spansLocated: 5
    }
  },
  {
    route: "work-authorization-from-structured-answer",
    sourceKey: "demo/route-6-work-authorization",
    experienceBlock: [],
    workAuthorized: true,
    bodies: FULL_COVERAGE,
    expected: {
      sourceKey: "demo/route-6-work-authorization",
      status: "escalated",
      availability: "complete",
      reasonCodes: [...MISSING_TENURE],
      sealed: true,
      scoreText: "467/6",
      confidenceText: "5/8",
      spansReturned: 6,
      spansLocated: 6
    }
  },
  {
    route: "quote-grounding-dropped-quote",
    sourceKey: "demo/route-7-quote-grounding",
    experienceBlock: [
      "Senior Machine Learning Engineer | TechCorp | 2021-03 | present",
      "Machine Learning Engineer | DataCo | 2019-06 | 2021-02"
    ],
    workAuthorized: true,
    bodies: FULL_COVERAGE,
    droppedQuoteDimension: "applied_ml_llm_systems",
    expected: {
      sourceKey: "demo/route-7-quote-grounding",
      status: "scored",
      availability: "complete",
      reasonCodes: [],
      sealed: true,
      scoreText: "467/6",
      confidenceText: "93/140",
      // The deliberately dropped quote: one extractor span returned, not located.
      spansReturned: 7,
      spansLocated: 6
    }
  }
];

function resumeText(candidate: DemoCandidate): string {
  const lines = [
    `Candidate reference ${candidate.sourceKey}`,
    "Priya Natarajan",
    DEMO_ROLE_TITLE,
    "",
    "Summary",
    ...(Object.keys(NARRATIVE_TEMPLATES) as DimensionKey[]).map((dimension) =>
      narrativeLine(dimension, candidate.sourceKey)
    )
  ];
  if (candidate.experienceBlock.length > 0) {
    lines.push("", "EXPERIENCE (STRUCTURED)", ...candidate.experienceBlock);
  }
  return lines.join("\n");
}

/** The synthetic candidate source records the demo composition is seeded with. */
export function demoCandidateSourceRecords(): readonly CandidateSourceRecord[] {
  return DEMO_CANDIDATES.map((candidate) =>
    Object.freeze({
      sourceKey: candidate.sourceKey,
      channel: "inbound",
      documents: [
        Object.freeze({
          documentKind: "resume",
          label: "Resume",
          documentOrdinal: 0,
          rawText: resumeText(candidate)
        })
      ],
      applicationAnswers: Object.freeze({
        workAuthorization: candidate.workAuthorized
          ? Object.freeze({
              questionKey: DEMO_WORK_AUTHORIZATION_QUESTION_KEY,
              selectedOptionKey: DEMO_WORK_AUTHORIZATION_AUTHORIZED,
              freeText: undefined,
              provenance: Object.freeze({
                collectedBy: "ats_synthetic",
                formId: "demo-application-form",
                questionId: "demo-q-work-auth",
                collectedAt: DEMO_CLOCK_MS - 86_400_000
              })
            })
          : undefined
      })
    })
  );
}

const CANDIDATE_BY_SOURCE_KEY = new Map(
  DEMO_CANDIDATES.map((candidate) => [candidate.sourceKey, candidate])
);

const DROPPED_QUOTE_TEXT = "an achievement that is deliberately absent from this resume";

/** The hand-authored extraction response body for one work item. */
export function demoExtractionResponseBody(dimensionId: string, sourceKey: string): string {
  const candidate = CANDIDATE_BY_SOURCE_KEY.get(sourceKey);
  if (candidate === undefined) {
    throw new Error(`No demo candidate for source key "${sourceKey}"`);
  }
  const body = candidate.bodies[dimensionId];
  if (body === undefined) {
    throw new Error(`No demo extraction fixture for dimension "${dimensionId}"`);
  }
  const spans: Array<{ quotedText: string; polarity: "supporting" | "contradicting" }> = [];
  if (body.quoteDimension !== null) {
    spans.push({
      quotedText: narrativeLine(body.quoteDimension, sourceKey),
      polarity: "supporting"
    });
  } else {
    spans.push({ quotedText: DROPPED_QUOTE_TEXT, polarity: "supporting" });
  }
  if (candidate.droppedQuoteDimension === dimensionId) {
    spans.push({ quotedText: DROPPED_QUOTE_TEXT, polarity: "supporting" });
  }
  return JSON.stringify({
    dimensionId,
    proposedLevel: body.proposedLevel,
    spans,
    rejectedClaims: []
  });
}

/** Source key of the reviewable-extraction-failure proving candidate. */
export const DEMO_REVIEWABLE_FAILURE_SOURCE_KEY = "demo/route-4-reviewable-failure";

/**
 * Fixture body for a correction attempt. For the reviewable-failure candidate
 * this supplies the located evaluation quote the initial extraction withheld.
 * Every other route reuses the initial body so an identical re-extraction is
 * still possible and still creates a superseding result.
 */
export function demoCorrectionExtractionResponseBody(
  dimensionId: string,
  sourceKey: string
): string {
  if (sourceKey !== DEMO_REVIEWABLE_FAILURE_SOURCE_KEY) {
    return demoExtractionResponseBody(dimensionId, sourceKey);
  }
  const body = FULL_COVERAGE[dimensionId];
  if (body === undefined) {
    throw new Error(`No demo extraction fixture for dimension "${dimensionId}"`);
  }
  const spans: Array<{ quotedText: string; polarity: "supporting" | "contradicting" }> = [];
  if (body.quoteDimension !== null) {
    spans.push({
      quotedText: narrativeLine(body.quoteDimension, sourceKey),
      polarity: "supporting"
    });
  }
  return JSON.stringify({
    dimensionId,
    proposedLevel: body.proposedLevel,
    spans,
    rejectedClaims: []
  });
}

/** Expected finalized outcomes, one per demo candidate, in import order. */
export const DEMO_EXPECTED_OUTCOMES: readonly ExpectedOutcome[] = DEMO_CANDIDATES.map(
  (candidate) => candidate.expected
);

export const DEMO_CANDIDATE_SOURCE_KEYS: readonly string[] = DEMO_CANDIDATES.map(
  (candidate) => candidate.sourceKey
);

/**
 * A content address of the demo corpus. Written to `demo_session.seed_hash` so
 * `demo:reset` can tell whether a database already holds this exact corpus.
 */
export const DEMO_CORPUS_SEED_HASH: string = (() => {
  const canonical = canonicalJsonStringify({
    roleId: DEMO_ROLE_ID,
    frozenDate: DEMO_FROZEN_DATE,
    candidates: DEMO_CANDIDATES.map((candidate) => ({
      sourceKey: candidate.sourceKey,
      resumeText: resumeText(candidate),
      workAuthorized: candidate.workAuthorized,
      bodies: candidate.bodies,
      droppedQuoteDimension: candidate.droppedQuoteDimension ?? null
    }))
  });
  /* v8 ignore next 3 -- the literal above is closed, string-valued, and canonical. */
  if (!canonical.ok) {
    throw new Error("Demo corpus is not canonical JSON");
  }
  return sha256Hex(canonical.value);
})();
