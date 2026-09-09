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

const DIMENSION_KEYS: readonly DimensionKey[] = [
  "applied",
  "production",
  "evaluation",
  "data",
  "ambiguity",
  "communication"
];

function token(sourceKey: string): string {
  return `[ref ${sourceKey}]`;
}

function narrativeLine(dimension: DimensionKey, candidate: DemoCandidate): string {
  return `${candidate.narratives[dimension]} ${token(candidate.sourceKey)}`;
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
  displayName: string;
  profileSummary: string;
  narratives: Readonly<Record<DimensionKey, string>>;
  experienceBlock: readonly string[];
  workAuthorized: boolean;
  bodies: Readonly<Record<string, DimensionBody>>;
  /** A dimension whose body carries a second, deliberately unlocatable quote. */
  droppedQuoteDimension?: string;
  /** A located resume statement that contradicts evidence for one dimension. */
  contradiction?: Readonly<{ dimensionId: string; narrative: string }>;
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
    displayName: "Priya Natarajan",
    profileSummary: "Applied AI engineer focused on production retrieval systems and evaluation.",
    narratives: {
      applied: "Built and shipped a retrieval augmented generation service for 30000 monthly users, owning prompt design and tool use across an agent loop.",
      production: "Ran the service on call for eighteen months, wrote the continuous integration pipeline, and led two schema migrations without downtime.",
      evaluation: "Defined an offline evaluation set of 400 labeled questions, tracked answer accuracy before every release, and blocked one regressing launch.",
      data: "Owned the ingestion path that parsed and normalized every candidate document before scoring.",
      ambiguity: "Framed the ambiguity in the routing requirements in a design document, chose the escalation thresholds, and carried the rollout past the first week.",
      communication: "Published an internal write up explaining why we chose deterministic scoring over a learned ranker and what that traded away."
    },
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
    displayName: "Marcus Chen",
    profileSummary: "Early-career ML engineer with strong project exposure and limited production tenure.",
    narratives: {
      applied: "Prototyped an FAQ classifier during an internship and connected it to a sandbox support chatbot.",
      production: "Added unit tests and fixed queue worker defects with guidance from the service owner.",
      evaluation: "Compared predictions against 50 hand labeled examples in a spreadsheet before a team demo.",
      data: "Cleaned partner CSV exports and wrote SQL transformations for a graduate capstone project.",
      ambiguity: "Broke an unclear model monitoring ticket into smaller tasks with help from a senior engineer.",
      communication: "Presented the capstone approach and its known limits during an internal learning session."
    },
    experienceBlock: ["Machine Learning Engineer | SmallCo | 2025-06 | 2026-02"],
    workAuthorized: true,
    bodies: withOverrides({
      applied_ml_llm_systems: { proposedLevel: "weak", quoteDimension: "applied" },
      production_software_engineering: { proposedLevel: "weak", quoteDimension: "production" },
      evaluation_and_measurement: { proposedLevel: "weak", quoteDimension: "evaluation" },
      ambiguity_and_ownership: { proposedLevel: "weak", quoteDimension: "ambiguity" },
      communication_of_reasoning: { proposedLevel: "weak", quoteDimension: "communication" }
    }),
    expected: {
      sourceKey: "demo/route-2-rejected",
      status: "rejected_hard_requirement",
      availability: "complete",
      // A conclusive hard-requirement failure sets the status; routing adds no
      // separate reason code for it (route-result keeps reasons empty here).
      reasonCodes: [],
      sealed: true,
      scoreText: "33/1",
      confidenceText: "7/10",
      spansReturned: 6,
      spansLocated: 6
    }
  },
  {
    route: "escalation-missing-work-authorization",
    sourceKey: "demo/route-3-escalated",
    displayName: "Elena Rodriguez",
    profileSummary: "Senior ML engineer with broad delivery experience and an incomplete application.",
    narratives: {
      applied: "Led delivery of a clinical search assistant that combined retrieval, reranking, and constrained generation for care coordinators.",
      production: "Containerized the assistant and joined the support rotation while the platform team retained deployment ownership.",
      evaluation: "Reviewed a small sample of answers each week but did not define a release-blocking quality threshold.",
      data: "Built normalization jobs for provider directories and encounter summaries used by the retrieval index.",
      ambiguity: "Defined a safe fallback workflow when policy owners could not initially agree on which clinical questions the assistant should answer.",
      communication: "Shared experiment results in sprint reviews without producing a formal decision record."
    },
    experienceBlock: [
      "Senior Machine Learning Engineer | Northstar Health | 2021-03 | present"
    ],
    workAuthorized: false,
    bodies: withOverrides({
      production_software_engineering: { proposedLevel: "partial", quoteDimension: "production" },
      evaluation_and_measurement: { proposedLevel: "weak", quoteDimension: "evaluation" },
      data_and_pipeline_work: { proposedLevel: "partial", quoteDimension: "data" },
      ambiguity_and_ownership: { proposedLevel: "strong", quoteDimension: "ambiguity" },
      communication_of_reasoning: { proposedLevel: "weak", quoteDimension: "communication" }
    }),
    expected: {
      sourceKey: "demo/route-3-escalated",
      status: "escalated",
      availability: "complete",
      reasonCodes: ["missing_evidence:work_authorization"],
      sealed: true,
      scoreText: "139/2",
      confidenceText: "27/40",
      spansReturned: 6,
      spansLocated: 6
    }
  },
  {
    route: "reviewable-extraction-failure",
    sourceKey: "demo/route-4-reviewable-failure",
    displayName: "Jordan Okafor",
    profileSummary: "Applied ML lead whose first extraction omits a required evaluation assessment.",
    narratives: {
      applied: "Shipped a support copilot that retrieved policy passages and drafted grounded responses for enterprise agents.",
      production: "Owned deployment automation, service alerts, and the weekly on-call rotation for the copilot API.",
      evaluation: "Created a blinded test set from resolved support cases and measured citation accuracy before rollout.",
      data: "Maintained the document ingestion service that split, tagged, and indexed policy updates every hour.",
      ambiguity: "Resolved unclear ownership between support operations and engineering by defining escalation boundaries and service objectives.",
      communication: "Wrote the rollout RFC and presented failure examples to engineering, legal, and support leadership."
    },
    experienceBlock: [
      "Applied Machine Learning Lead | CivicSignal | 2021-03 | present"
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
    displayName: "Maya Patel",
    profileSummary: "Data platform engineer with useful adjacent experience and a major evidence gap.",
    narratives: {
      applied: "Experimented with keyword routing rules but provided no evidence of deploying an ML or language model system.",
      production: "Operated event processing services and improved retry handling for delayed customer records.",
      evaluation: "Established baseline completeness checks for incoming datasets and reviewed failures with analysts.",
      data: "Built batch and streaming pipelines that standardized product events from twelve source systems.",
      ambiguity: "Scoped a migration from inconsistent partner schemas and negotiated a minimum shared contract.",
      communication: "Authored an operations playbook that explained recovery steps and data ownership to support teams."
    },
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
    displayName: "Lucas Ferreira",
    profileSummary: "Machine learning engineer whose work authorization comes from the application form.",
    narratives: {
      applied: "Integrated a hosted language model into an internal research workflow and added retrieval over approved reports.",
      production: "Owned the inference service, deployment pipeline, latency alerts, and incident response for two years.",
      evaluation: "Designed a gold dataset, measured answer faithfulness by release, and stopped launches that missed the agreed target.",
      data: "Rebuilt the batch feature pipeline and added validation for late and duplicated records.",
      ambiguity: "Defined the first pilot scope with research leads and documented which questions required manual review.",
      communication: "Produced architecture notes, evaluation reports, and operator guidance used by both engineering and research teams."
    },
    experienceBlock: [],
    workAuthorized: true,
    bodies: withOverrides({
      applied_ml_llm_systems: { proposedLevel: "partial", quoteDimension: "applied" },
      evaluation_and_measurement: { proposedLevel: "strong", quoteDimension: "evaluation" },
      data_and_pipeline_work: { proposedLevel: "partial", quoteDimension: "data" },
      communication_of_reasoning: { proposedLevel: "strong", quoteDimension: "communication" }
    }),
    expected: {
      sourceKey: "demo/route-6-work-authorization",
      status: "escalated",
      availability: "complete",
      reasonCodes: [...MISSING_TENURE],
      sealed: true,
      scoreText: "167/2",
      confidenceText: "5/8",
      spansReturned: 6,
      spansLocated: 6
    }
  },
  {
    route: "quote-grounding-dropped-quote",
    sourceKey: "demo/route-7-quote-grounding",
    displayName: "Aisha Rahman",
    profileSummary: "Evaluation engineer with a strong packet and one deliberately ungrounded quote.",
    narratives: {
      applied: "Built an evaluation harness for a multi-step research agent that used retrieval, tools, and structured outputs.",
      production: "Maintained the harness service and release jobs while a platform team owned the underlying model gateway.",
      evaluation: "Created a 1200-case gold set, added regression slices, and required passing thresholds before prompt releases.",
      data: "Built the labeling export, normalization, and aggregation pipeline used for weekly quality reporting.",
      ambiguity: "Investigated poorly defined citation failures and proposed a taxonomy that separated retrieval misses from generation errors.",
      communication: "Published a model comparison explaining the evidence, unresolved risks, and recommendation to product leaders."
    },
    experienceBlock: [
      "Machine Learning Evaluation Engineer | Verity AI | 2021-03 | present",
      "Data Scientist | SignalWorks | 2019-06 | 2021-02"
    ],
    workAuthorized: true,
    bodies: withOverrides({
      production_software_engineering: { proposedLevel: "partial", quoteDimension: "production" },
      evaluation_and_measurement: { proposedLevel: "strong", quoteDimension: "evaluation" },
      data_and_pipeline_work: { proposedLevel: "strong", quoteDimension: "data" }
    }),
    droppedQuoteDimension: "applied_ml_llm_systems",
    contradiction: {
      dimensionId: "production_software_engineering",
      narrative: "Post-launch notes state that the evaluation service had no automated rollback and depended on manual recovery during incidents."
    },
    expected: {
      sourceKey: "demo/route-7-quote-grounding",
      status: "scored",
      availability: "complete",
      reasonCodes: [],
      sealed: true,
      scoreText: "345/4",
      confidenceText: "61/96",
      // One dropped quote and one located contradiction are both visible.
      spansReturned: 8,
      spansLocated: 7
    }
  }
];

function resumeText(candidate: DemoCandidate): string {
  const lines = [
    `Candidate reference ${candidate.sourceKey}`,
    candidate.displayName,
    DEMO_ROLE_TITLE,
    "",
    "Summary",
    candidate.profileSummary,
    ...DIMENSION_KEYS.map((dimension) => narrativeLine(dimension, candidate))
  ];
  if (candidate.contradiction !== undefined) {
    lines.push(
      "",
      "LIMITATIONS",
      `${candidate.contradiction.narrative} ${token(candidate.sourceKey)}`
    );
  }
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
      quotedText: narrativeLine(body.quoteDimension, candidate),
      polarity: "supporting"
    });
  } else {
    spans.push({ quotedText: DROPPED_QUOTE_TEXT, polarity: "supporting" });
  }
  if (candidate.droppedQuoteDimension === dimensionId) {
    spans.push({ quotedText: DROPPED_QUOTE_TEXT, polarity: "supporting" });
  }
  if (candidate.contradiction?.dimensionId === dimensionId) {
    spans.push({
      quotedText: `${candidate.contradiction.narrative} ${token(candidate.sourceKey)}`,
      polarity: "contradicting"
    });
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
  const candidate = CANDIDATE_BY_SOURCE_KEY.get(sourceKey)!;
  const body = FULL_COVERAGE[dimensionId];
  if (body === undefined) {
    throw new Error(`No demo extraction fixture for dimension "${dimensionId}"`);
  }
  const spans: Array<{ quotedText: string; polarity: "supporting" | "contradicting" }> = [];
  if (body.quoteDimension !== null) {
    spans.push({
      quotedText: narrativeLine(body.quoteDimension, candidate),
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
      displayName: candidate.displayName,
      profileSummary: candidate.profileSummary,
      resumeText: resumeText(candidate),
      workAuthorized: candidate.workAuthorized,
      bodies: candidate.bodies,
      droppedQuoteDimension: candidate.droppedQuoteDimension ?? null,
      contradiction: candidate.contradiction ?? null
    }))
  });
  /* v8 ignore next 3 -- the literal above is closed, string-valued, and canonical. */
  if (!canonical.ok) {
    throw new Error("Demo corpus is not canonical JSON");
  }
  return sha256Hex(canonical.value);
})();
