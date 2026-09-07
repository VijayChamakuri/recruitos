import { RubricSchema, type Rubric } from "./rubric.js";

/**
 * Draft rubric v1 for the Applied AI Engineer role, committed per the binding
 * build sequence so schema, scoring, and pipeline work is unblocked. Dimension
 * ids, weights, and required flags match the approved design; the definition
 * and justification prose is a DRAFT v1 placeholder pending the rubric lock
 * (see "The Assignment" in the product design). Weights live here as config and
 * are never part of any extraction prompt, so weight tuning never invalidates
 * fixtures. Do not record fixtures or author tier-1 expected outcomes against
 * this draft: the dimension definitions must be locked first.
 */
const DRAFT_RUBRIC_V1_INPUT = {
  rubricId: "rubric_applied_ai_engineer_draft_v1",
  version: "draft-v1",
  dimensions: [
    {
      dimensionId: "applied_ml_llm_systems",
      weight: 3,
      required: true,
      definition:
        "Draft v1 placeholder pending rubric lock. Evidence of building applied machine learning and LLM-backed systems in production settings.",
      jobRelatedJustification:
        "Draft v1 placeholder pending rubric lock. The role builds LLM-backed product systems, so applied ML and LLM systems experience is directly job related."
    },
    {
      dimensionId: "production_software_engineering",
      weight: 3,
      required: true,
      definition:
        "Draft v1 placeholder pending rubric lock. Evidence of shipping and operating production software with tests, review, and reliability practices.",
      jobRelatedJustification:
        "Draft v1 placeholder pending rubric lock. The role owns internal tooling in production, so production software engineering is directly job related."
    },
    {
      dimensionId: "evaluation_and_measurement",
      weight: 2,
      required: true,
      definition:
        "Draft v1 placeholder pending rubric lock. Evidence of designing evaluations, metrics, and measurement practice for automated systems.",
      jobRelatedJustification:
        "Draft v1 placeholder pending rubric lock. The role must measure automated decisions, so evaluation and measurement practice is directly job related."
    },
    {
      dimensionId: "data_and_pipeline_work",
      weight: 2,
      required: false,
      definition:
        "Draft v1 placeholder pending rubric lock. Evidence of building data ingestion, transformation, and pipeline work at meaningful scale.",
      jobRelatedJustification:
        "Draft v1 placeholder pending rubric lock. The role handles candidate data pipelines, so data and pipeline work is job related."
    },
    {
      dimensionId: "ambiguity_and_ownership",
      weight: 1,
      required: false,
      definition:
        "Draft v1 placeholder pending rubric lock. Evidence of taking ownership and making progress under ambiguity without full specification.",
      jobRelatedJustification:
        "Draft v1 placeholder pending rubric lock. The role is an early internal build with ambiguity, so ownership signals are job related."
    },
    {
      dimensionId: "communication_of_reasoning",
      weight: 1,
      required: false,
      definition:
        "Draft v1 placeholder pending rubric lock. Evidence of communicating technical reasoning clearly to engineers and non-engineers.",
      jobRelatedJustification:
        "Draft v1 placeholder pending rubric lock. The role explains automated recommendations to recruiters, so communication of reasoning is job related."
    }
  ]
} as const;

export const DRAFT_RUBRIC_V1: Rubric = RubricSchema.parse(DRAFT_RUBRIC_V1_INPUT);
