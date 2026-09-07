import {
  LockedRubricSchema,
  mustRubricCanonicalSnapshot,
  type LockedRubric
} from "./rubric.js";

/**
 * Locked rubric v1 for the Applied AI Engineer role (Gate 2).
 *
 * Structure is frozen: six dimension ids, weights 3/3/2/2/1/1 (total 12),
 * required flags true/true/true/false/false/false, and the four-level closed
 * enum. Definition prose, justifications, and the twenty-four level anchors
 * come from Part 2 of docs/designs/rubric-lock-prep.md as amended by the
 * signed RubricAssumptionRecord (OQ-1 through OQ-10). Provenance is
 * product-authored. Do not mutate this snapshot; a later change is a new
 * version with a new hash.
 */
export const RUBRIC_V1_RESTS_ON = [
  "WA-05",
  "WA-09",
  "WA-10",
  "WA-11",
  "WA-12",
  "WA-13",
  "WA-16",
  "WA-17",
  "WA-26",
  "WA-32"
] as const;

const RUBRIC_V1_INPUT = {
  rubricId: "rubric_applied_ai_engineer_v1",
  version: 1,
  provenance: {
    authorship: "product-authored",
    restsOn: [...RUBRIC_V1_RESTS_ON]
  },
  dimensions: [
    {
      dimensionId: "applied_ml_llm_systems",
      weight: 3,
      required: true,
      definition:
        "Evidence that the candidate has built, shipped, or operated systems in which a machine learning model or a large language model is a load-bearing component of product behavior. Covers model integration and serving, prompt and context design, retrieval, tool use and agent loops, fine-tuning or adaptation, inference latency and cost work, and handling the failure modes specific to non-deterministic components. Evidence is a named system, the candidate's own described contribution to its model-bearing part, and something concrete about how it behaved. A tool name, a course, or a claim of familiarity is not evidence.",
      jobRelatedJustification:
        "The role's daily work is building internal tooling in which model output drives product behavior that people act on. A candidate who has only called a model API inside a notebook has not met the failure modes this role hits in its first week: non-determinism, context limits, cost under load, and output that is confidently wrong. Weighted 3, jointly highest, because it is the half of the role title that cannot be substituted by adjacent experience.",
      levelAnchors: {
        none: "No located span of any polarity ties the candidate to a system in which a model was a working component. Skills-list mentions, coursework, and certifications with no system attached leave this at none. Because this dimension is required, a none level with zero located spans opens missing_evidence:applied_ml_llm_systems and routes the candidate to a human rather than silently scoring zero.",
        weak: "Machine learning or LLM work is named but stays unanchored. A project title with no system behind it, a hackathon or coursework build, a tools inventory, or a claim of involvement with no described responsibility, scope, or result.",
        partial:
          "At least one named system with a real user or a real business purpose, in which the candidate describes their own contribution to the model-bearing part, but the text leaves scope, scale, production status, or outcome unstated.",
        strong:
          "A system in production with users, in which the candidate owned model-bearing behavior, and the text names concrete detail: the approach or architecture, plus at least one of scale, latency, cost, output quality, or failure handling, with an outcome attributable to the candidate rather than to the team in general."
      }
    },
    {
      dimensionId: "production_software_engineering",
      weight: 3,
      required: true,
      definition:
        "Evidence of writing, reviewing, shipping, and operating software that other people depend on. Covers language and systems fluency demonstrated on a named system, testing, code review, continuous integration, deployment, monitoring, on-call and incident response, migrations, and continued ownership of a codebase after launch, including code the candidate did not write. Evidence is a system with users and a described engineering practice attached to it, not a list of languages.",
      jobRelatedJustification:
        "The systems this role builds are production software with real users, an audit trail, and consequences when they are wrong. The role is expected to own a service end to end rather than hand a prototype to a platform team. Weighted 3, equal to applied ML, because an applied AI engineer who cannot operate what they build produces demonstrations rather than tools, and this project's own thesis is that the difference between those two is the whole product.",
      levelAnchors: {
        none: "No located span of any polarity ties the candidate to software that other people used. Because this dimension is required, none with zero located spans opens missing_evidence:production_software_engineering and routes to a human.",
        weak: "Engineering appears only as language and framework names, or the only shipped work is a personal or course project with no described users, no collaborators, and no responsibility that continued past the build.",
        partial:
          "The candidate shipped software that other people used and describes their own engineering contribution to it, but the text says nothing about how it was tested, reviewed, deployed, or operated after release.",
        strong:
          "The candidate shipped and then operated software that others depended on, and the text names concrete practice (tests, review, continuous integration, deployment, monitoring, on-call, a migration, performance or reliability work) attached to a named system, with responsibility that continued past launch."
      }
    },
    {
      dimensionId: "evaluation_and_measurement",
      weight: 2,
      required: true,
      definition:
        "Evidence that the candidate measures whether a system works rather than asserting that it does. Covers offline and online evaluation, test sets and golden data, metric definition, labeling and annotation processes, holdout or A/B design, regression detection, error analysis, calibration, and drift monitoring, with particular weight on measuring components whose output is not deterministic. Evidence names what was measured, against what, and what decision followed.",
      jobRelatedJustification:
        "This is the dimension that separates an applied AI engineer from a model API consumer, and it is the same practice this role must apply to its own output: the role ships automation that makes consequential recommendations about people, and without measurement it ships a system whose failures nobody can name. Weighted 2 rather than 3 because a strong production engineer can be brought into a measurement practice faster than the reverse. Marked required because it belongs to the non-substitutable core of the role: absence of any measurement signal is the most common and most consequential gap in this candidate pool, and a candidate with zero located evidence of it deserves a human look on merit before any shortlist decision, not a silent zero chosen to keep a demo path alive.",
      levelAnchors: {
        none: "No located span of any polarity relates to measuring a system's behavior. Because this dimension is required, none with zero located spans opens missing_evidence:evaluation_and_measurement and routes to a human. Applied ML systems, production software, and evaluation are the non-substitutable core of this role; a missing measurement signal interrupts on merit, not to preserve a scored population for a demo.",
        weak: "Measurement appears only as a noun or a claim. Metrics, A/B testing, data-driven decisions, a dashboard, or a benchmark number the candidate did not produce, with no named metric, no dataset, and no decision that turned on it.",
        partial:
          "The candidate names a specific metric, test set, or evaluation they ran for a system they worked on, but the text does not say how the comparison or ground truth was constructed, or what changed as a result.",
        strong:
          "The candidate built or owned an evaluation for a system whose correctness was not self-evident, and the text names what was measured, how the ground truth or baseline was obtained, and a decision or change that followed from the result."
      }
    },
    {
      dimensionId: "data_and_pipeline_work",
      weight: 2,
      required: false,
      definition:
        "Evidence of building or operating the data path a product or model depends on. Covers ingestion, parsing and extraction from messy or unstructured sources, schema and storage design, transformation, batch and streaming pipelines, data quality checks, and backfills or migrations. Evidence is a data path the candidate changed or owned, with something said about what it moved and who consumed it. Use of a warehouse somebody else built is not evidence of building one.",
      jobRelatedJustification:
        "This product is a parsing and normalization problem before it is a model problem: candidate documents arrive in inconsistent formats and the pipeline is what makes them scorable at all, which is why quote location has three tiers and why normalization is a committed policy. Weighted 2 because that work is a large and unglamorous share of the role. Not required because a strong applied ML engineer may have worked entirely on top of a platform team's data path, which is a real gap in the score but not a reason to interrupt a human.",
      levelAnchors: {
        none: "No located span of any polarity relates to moving, shaping, or storing data. Because this dimension is not required, none records an EvidenceGap with its documents_searched list and contributes 0 to the aggregate, without opening a resolution task.",
        weak: "Data work appears only as tool names (SQL, Spark, Airflow, dbt, a named warehouse) or as consumption of a pipeline someone else built, with no described contribution to how the data arrived.",
        partial:
          "The candidate built or changed a specific data path and describes what it produced, but volume, reliability practice, ownership duration, or downstream consumer is unstated.",
        strong:
          "The candidate owned a data path in production that other systems or people depended on, and the text names the sources, the transformation or schema decisions, and at least one of volume, reliability practice, data quality handling, or a migration or backfill they ran."
      }
    },
    {
      dimensionId: "ambiguity_and_ownership",
      weight: 1,
      required: false,
      definition:
        "Evidence that the candidate has taken a problem that arrived underspecified and driven it to a decided outcome: choosing the scope, making a call without a full specification, crossing a team boundary to unblock it, and staying with the work past the interesting part. Read from what the candidate did and what followed, never from how the candidate describes themselves. Self-starter, thrives in ambiguity, and an unqualified led are self-description and are not evidence.",
      jobRelatedJustification:
        "The role is an early internal build where nobody has written the specification and the requirements arrive as a recruiter's frustration rather than as a ticket. Weighted 1, the lowest available weight, precisely because resume text is thin evidence for it: every point of weight placed here would be a point taken from a dimension the documents can actually support. It is kept in the rubric because it is genuinely job related and its absence should be visible in the packet; it is kept small and not required because escalating on it would route a human to a question a resume cannot answer.",
      levelAnchors: {
        none: "No located span describes work the candidate initiated, scoped, or decided. Self-description with no action attached leaves this at none. Not required, so this records an EvidenceGap and contributes 0.",
        weak: "Ownership appears only as self-description, or as an unqualified verb (led, drove, owned) with no problem, no decision, and no outcome attached to it.",
        partial:
          "The candidate names specific work they initiated or scoped, and an outcome, but the text does not show what was undecided at the start or what call they made about it.",
        strong:
          "The text names a problem that arrived without a specification, a decision the candidate made about scope or approach, and what followed from that decision, including work carried past the point where it stopped being interesting."
      }
    },
    {
      dimensionId: "communication_of_reasoning",
      weight: 1,
      required: false,
      definition:
        "Evidence that the candidate can make technical reasoning legible to someone who will not read the code. Covers design documents, requests for comment, incident write-ups, documentation named as a deliverable, talks, published technical writing, teaching and mentoring with a described audience, and, as directly observable evidence, the candidate's own account of a technical decision and the reason for it in their application materials. A stated communication skill is not evidence.",
      jobRelatedJustification:
        "The output of this role is an explanation a recruiter has to be able to trust and a hiring manager has to be able to challenge, so the person building it has to be able to write one. Weighted 1 because the resume-stage signal is thin and easily confounded by professional resume writing or editing help, which is a confound this rubric cannot detect and should not pretend to. Not required, for the same reason. The interview loop is where this dimension is actually assessed; the rubric's job here is only to notice when the evidence is unusually strong.",
      levelAnchors: {
        none: "No located span speaks to producing technical explanation for other people. Not required, so this records an EvidenceGap and contributes 0.",
        weak: "Communication appears only as a self-assessment, as an implied duty of a job title, or as an artifact named without an audience or a purpose.",
        partial:
          "The candidate names a specific artifact they wrote or delivered for an identified audience (a design document, a postmortem, documentation, a talk, teaching), but the text does not carry any of the reasoning that artifact contained.",
        strong:
          "The text carries reasoning the candidate authored, in which a technical decision is stated together with the reason for it and what it was chosen over, whether that appears inside a named artifact or in the candidate's own account of their work."
      }
    }
  ]
} as const;

export const RUBRIC_V1: LockedRubric = Object.freeze(LockedRubricSchema.parse(RUBRIC_V1_INPUT));

const lockedSnapshot = mustRubricCanonicalSnapshot(RUBRIC_V1);

export const RUBRIC_V1_CANONICAL_BYTES: string = lockedSnapshot.canonicalBytes;
export const RUBRIC_V1_HASH = lockedSnapshot.hash;
