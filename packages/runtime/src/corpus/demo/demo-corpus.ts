import { canonicalJsonStringify, sha256Hex } from "@recruitos/core";

import type { CandidateSourceRecord } from "../../adapters/index.js";

/**
 * The one-candidate proving corpus for the local demo spine.
 *
 * It is deliberately minimal: one synthetic candidate, one resume, and one
 * hand-authored extraction response per rubric dimension. Its only job is to
 * prove the full runtime path end to end (import, start run, fixture
 * extraction, finalize, sealed packet) and to give `demoPrepare` a stable set
 * of fixtures keyed exactly the way `startTriageRun` and the scheduler compute
 * request hashes. The seven-route slice and the full tier-one corpus replace
 * this later and move to `fixtures/corpus` and `fixtures/expected`.
 *
 * Every extraction quote below is a verbatim contiguous substring of the resume
 * so `relocateQuote` locates it on the exact or folded tier.
 */

export const DEMO_ROLE_ID = "role-applied-ai-engineer";
export const DEMO_ROLE_TITLE = "Applied AI Engineer";

/** Frozen instant for the demo runtime clock, so every run is reproducible. */
export const DEMO_CLOCK_MS = 1_788_700_000_000;

/**
 * Frozen corpus date. Matches `startTriageRun`'s default and drives the OQ-7
 * hard-requirement policy's as-of month.
 */
export const DEMO_FROZEN_DATE = "2026-09-07";

export const DEMO_CANDIDATE_SOURCE_SYSTEM = "ats_synthetic";
export const DEMO_CANDIDATE_SOURCE_KEY = "demo/0001";

export const DEMO_WORK_AUTHORIZATION_QUESTION_KEY = "eligible_to_work";
export const DEMO_WORK_AUTHORIZATION_OPTION_KEY = "authorized_no_sponsorship";

const DEMO_RESUME_TEXT = [
  "Priya Natarajan",
  "Applied AI Engineer",
  "",
  "Experience",
  "Built and shipped a retrieval augmented generation service that answered support questions for 30000 monthly users, owning prompt design, context windowing, and tool use across an agent loop.",
  "Ran the service on call for eighteen months, wrote the continuous integration pipeline, and led two schema migrations without downtime.",
  "Defined an offline evaluation set of 400 labeled questions, tracked answer accuracy against it before every release, and blocked one launch when accuracy regressed.",
  "Wrote the design document that framed the ambiguity in the routing requirements, chose the escalation thresholds, and carried the rollout past the first noisy week.",
  "Published an internal write up explaining why we chose deterministic scoring over a learned ranker and what that traded away."
].join("\n");

type DemoDimensionFixture = Readonly<{
  proposedLevel: "none" | "weak" | "partial" | "strong";
  supportingQuote: string;
}>;

/**
 * One extraction outcome per rubric dimension id. Each supporting quote is a
 * verbatim slice of `DEMO_RESUME_TEXT`.
 */
const DEMO_DIMENSION_FIXTURES: Readonly<Record<string, DemoDimensionFixture>> = {
  applied_ml_llm_systems: {
    proposedLevel: "strong",
    supportingQuote:
      "Built and shipped a retrieval augmented generation service that answered support questions for 30000 monthly users"
  },
  production_software_engineering: {
    proposedLevel: "strong",
    supportingQuote:
      "Ran the service on call for eighteen months, wrote the continuous integration pipeline, and led two schema migrations without downtime."
  },
  evaluation_and_measurement: {
    proposedLevel: "partial",
    supportingQuote:
      "Defined an offline evaluation set of 400 labeled questions, tracked answer accuracy against it before every release"
  },
  data_and_pipeline_work: {
    proposedLevel: "weak",
    supportingQuote: "context windowing"
  },
  ambiguity_and_ownership: {
    proposedLevel: "partial",
    supportingQuote:
      "Wrote the design document that framed the ambiguity in the routing requirements, chose the escalation thresholds"
  },
  communication_of_reasoning: {
    proposedLevel: "partial",
    supportingQuote:
      "Published an internal write up explaining why we chose deterministic scoring over a learned ranker"
  }
};

export const DEMO_DIMENSION_IDS: readonly string[] = Object.keys(DEMO_DIMENSION_FIXTURES);

/** The synthetic candidate source records the demo composition is seeded with. */
export function demoCandidateSourceRecords(): readonly CandidateSourceRecord[] {
  return [
    Object.freeze({
      sourceKey: DEMO_CANDIDATE_SOURCE_KEY,
      channel: "inbound",
      documents: [
        Object.freeze({
          documentKind: "resume",
          label: "Resume",
          documentOrdinal: 0,
          rawText: DEMO_RESUME_TEXT
        })
      ],
      applicationAnswers: Object.freeze({
        workAuthorization: Object.freeze({
          questionKey: DEMO_WORK_AUTHORIZATION_QUESTION_KEY,
          selectedOptionKey: DEMO_WORK_AUTHORIZATION_OPTION_KEY,
          freeText: undefined,
          provenance: Object.freeze({
            collectedBy: "ats_synthetic",
            formId: "demo-application-form",
            questionId: "demo-q-work-auth",
            collectedAt: DEMO_CLOCK_MS - 86_400_000
          })
        })
      })
    })
  ];
}

/**
 * The hand-authored extraction response body for one work item, keyed by
 * rubric dimension id. `sourceKey` is accepted for forward compatibility with
 * the multi-candidate slice; the proving corpus has one candidate.
 */
export function demoExtractionResponseBody(
  dimensionId: string,
  _sourceKey: string = DEMO_CANDIDATE_SOURCE_KEY
): string {
  const fixture = DEMO_DIMENSION_FIXTURES[dimensionId];
  if (fixture === undefined) {
    throw new Error(`No demo extraction fixture for dimension "${dimensionId}"`);
  }
  return JSON.stringify({
    dimensionId,
    proposedLevel: fixture.proposedLevel,
    spans: [{ quotedText: fixture.supportingQuote, polarity: "supporting" }],
    rejectedClaims: []
  });
}

/**
 * The expected finalized outcome for the demo candidate. `demoPrepare` produces
 * exactly one sealed result; the CLI integration test and `eval:class1` assert
 * against this. The candidate escalates because the resume carries no structured
 * employment facts, so years of experience, current title, and employer history
 * all resolve to `unknown`. Work authorization resolves from the structured
 * application answer and is therefore not missing.
 */
export const DEMO_EXPECTED_OUTCOME = Object.freeze({
  sourceKey: DEMO_CANDIDATE_SOURCE_KEY,
  status: "escalated" as const,
  availability: "complete" as const,
  reasonCodes: Object.freeze([
    "missing_evidence:current_title",
    "missing_evidence:employer_history",
    "missing_evidence:years_experience"
  ]),
  hasScore: true,
  hasConfidence: true,
  sealed: true
});

/**
 * A content address of the demo corpus. Written to `demo_session.seed_hash` so
 * `demo:reset` can tell whether a database already holds this exact corpus.
 */
export const DEMO_CORPUS_SEED_HASH: string = (() => {
  const canonical = canonicalJsonStringify({
    roleId: DEMO_ROLE_ID,
    frozenDate: DEMO_FROZEN_DATE,
    sourceKey: DEMO_CANDIDATE_SOURCE_KEY,
    resumeText: DEMO_RESUME_TEXT,
    workAuthorizationOptionKey: DEMO_WORK_AUTHORIZATION_OPTION_KEY,
    dimensionFixtures: DEMO_DIMENSION_FIXTURES
  });
  /* v8 ignore next 3 -- the literal above is closed, string-valued, and canonical. */
  if (!canonical.ok) {
    throw new Error("Demo corpus is not canonical JSON");
  }
  return sha256Hex(canonical.value);
})();
