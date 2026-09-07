import { z } from "zod";

import { compareCodeUnits } from "../canonical/comparator.js";
import { EvidencePolaritySchema, EvidenceSourceSchema } from "../domain/evidence.js";
import { MAXIMUM_EVIDENCE_ITEMS_PER_WORK_ITEM } from "../domain/extraction.js";
import {
  CandidateDocumentIdSchema,
  EvidenceSpanIdSchema,
  RubricDimensionIdSchema
} from "../domain/ids.js";
import { createDomainError, type DomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";
import { DIMENSION_LEVELS, DimensionLevelSchema, type DimensionLevel } from "../rubric/levels.js";
import type { Rubric } from "../rubric/rubric.js";
import { deriveLevel } from "../scoring/derive-level.js";
import { MAXIMUM_CANDIDATE_DOCUMENTS } from "./consolidate-facts.js";

/** Evidence items per work item across the maximum document count. */
export const MAXIMUM_DIMENSION_SPANS =
  MAXIMUM_EVIDENCE_ITEMS_PER_WORK_ITEM * MAXIMUM_CANDIDATE_DOCUMENTS;

/** One level proposal per document, plus the human write, is the ceiling. */
export const MAXIMUM_DIMENSION_PROPOSALS = MAXIMUM_CANDIDATE_DOCUMENTS + 1;

const DimensionSpanSchema = z
  .object({
    evidenceSpanId: EvidenceSpanIdSchema,
    documentId: CandidateDocumentIdSchema,
    polarity: EvidencePolaritySchema,
    source: EvidenceSourceSchema
  })
  .strict();

export type DimensionSpan = z.infer<typeof DimensionSpanSchema>;

/**
 * The closed set of level proposals for one dimension. A successful document
 * proposes exactly one level; a reviewably failed document proposes nothing and
 * never becomes `none`; a human writes the same typed level through the same
 * validation, which is what makes the score a pure function of the structure
 * regardless of who wrote it.
 */
export const DimensionLevelProposalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("document_level"),
      documentId: CandidateDocumentIdSchema,
      level: DimensionLevelSchema
    })
    .strict(),
  z
    .object({ kind: z.literal("document_failure"), documentId: CandidateDocumentIdSchema })
    .strict(),
  z.object({ kind: z.literal("human_level"), level: DimensionLevelSchema }).strict()
]);

export type DimensionLevelProposal = z.infer<typeof DimensionLevelProposalSchema>;

const DimensionEvidenceSchema = z
  .object({
    dimensionId: RubricDimensionIdSchema,
    proposals: z.array(DimensionLevelProposalSchema).min(1).max(MAXIMUM_DIMENSION_PROPOSALS),
    spans: z.array(DimensionSpanSchema).max(MAXIMUM_DIMENSION_SPANS)
  })
  .strict();

export type DimensionEvidence = z.infer<typeof DimensionEvidenceSchema>;

const DimensionEvidenceListSchema = z.array(DimensionEvidenceSchema);

/**
 * One assessment for one rubric dimension.
 *
 * `level` is authoritative and is selected from the proposals, never invented
 * from span counts. `derivedLevel` is `deriveLevel` over the consolidated span
 * counts and is a visible calibration diagnostic with no scoring authority, so
 * a caller can show where the selected level and the mechanical one disagree.
 */
export type DimensionAssessment = Readonly<{
  dimensionId: string;
  level: DimensionLevel;
  source: "extracted" | "human";
  derivedLevel: DimensionLevel;
  levelDisagreement: boolean;
  supportingSpanIds: readonly string[];
  contradictingSpanIds: readonly string[];
  documentIds: readonly string[];
  failedDocumentIds: readonly string[];
  ungroundedDocumentIds: readonly string[];
}>;

/**
 * A dimension with no usable evidence of any polarity. Gaps stay explicit and
 * are never folded into the level: the dimension still carries a valid `none`
 * assessment, and the gap is what a required dimension escalates on.
 */
export type EvidenceGap = Readonly<{
  dimensionId: string;
  documentsSearched: readonly string[];
}>;

/** A dimension whose documents all failed reviewably. It has no level at all. */
export type UnavailableDimension = Readonly<{
  dimensionId: string;
  failedDocumentIds: readonly string[];
}>;

export type DimensionAssessmentDerivation = Readonly<{
  availability: "complete" | "unavailable";
  assessments: readonly DimensionAssessment[];
  gaps: readonly EvidenceGap[];
  unavailable: readonly UnavailableDimension[];
}>;

function invalidEvidence(message: string): DomainError {
  return createDomainError("invalid_evidence", message);
}

function levelRank(level: DimensionLevel): number {
  return DIMENSION_LEVELS.indexOf(level);
}

function higherLevel(left: DimensionLevel, right: DimensionLevel): DimensionLevel {
  return levelRank(right) > levelRank(left) ? right : left;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareCodeUnits));
}

/**
 * `deriveLevel` rejects only counts that are not nonnegative safe integers.
 * Both arguments here are lengths of arrays bounded by the schema above, so the
 * failure branch cannot be reached from this call site.
 */
function derivedLevelFor(supportingCount: number, contradictingCount: number): DimensionLevel {
  const derived = deriveLevel({
    supportingSpanCount: supportingCount,
    contradictingSpanCount: contradictingCount
  });
  /* v8 ignore next 3 */
  if (!derived.ok) {
    throw new Error("Unexpected invalid span counts in dimension assessment");
  }
  return derived.value;
}

type DimensionParts = {
  readonly documentLevels: { documentId: string; level: DimensionLevel }[];
  readonly failedDocumentIds: string[];
  readonly humanLevels: DimensionLevel[];
};

function splitProposals(proposals: readonly DimensionLevelProposal[]): DimensionParts {
  const parts: DimensionParts = { documentLevels: [], failedDocumentIds: [], humanLevels: [] };
  for (const proposal of proposals) {
    if (proposal.kind === "document_level") {
      parts.documentLevels.push({ documentId: proposal.documentId, level: proposal.level });
    } else if (proposal.kind === "document_failure") {
      parts.failedDocumentIds.push(proposal.documentId);
    } else {
      parts.humanLevels.push(proposal.level);
    }
  }
  return parts;
}

type GroundedSelection = {
  readonly level: DimensionLevel;
  readonly disagreement: boolean;
  readonly ungroundedDocumentIds: readonly string[];
};

/**
 * Selects the candidate-level extracted proposal: the highest non-`none` level
 * that a supporting span from its own document actually grounds. A non-`none`
 * proposal with no located supporting span cannot select the level it claims,
 * so it contributes `none` and its document is reported as ungrounded rather
 * than silently dropped. All-`none` proposals select a valid `none`.
 */
function selectDocumentLevel(
  documentLevels: readonly { documentId: string; level: DimensionLevel }[],
  supportingDocumentIds: ReadonlySet<string>
): GroundedSelection {
  let level: DimensionLevel = "none";
  const groundedLevels = new Set<DimensionLevel>();
  const ungroundedDocumentIds: string[] = [];
  for (const proposal of documentLevels) {
    if (proposal.level !== "none" && !supportingDocumentIds.has(proposal.documentId)) {
      ungroundedDocumentIds.push(proposal.documentId);
      continue;
    }
    if (proposal.level !== "none") {
      groundedLevels.add(proposal.level);
    }
    level = higherLevel(level, proposal.level);
  }
  return {
    level,
    disagreement: groundedLevels.size >= 2,
    ungroundedDocumentIds: sortedUnique(ungroundedDocumentIds)
  };
}

/**
 * Either one dimension's assessment or the statement that it has none. Tagged
 * explicitly rather than inferred, because an unavailable dimension carries a
 * strict subset of an assessment's fields.
 */
type DimensionOutcome =
  | Readonly<{ available: true; assessment: DimensionAssessment }>
  | Readonly<{ available: false; unavailable: UnavailableDimension }>;

function assessDimension(dimension: DimensionEvidence): Result<DimensionOutcome, DomainError> {
  const parts = splitProposals(dimension.proposals);
  if (parts.documentLevels.length + parts.failedDocumentIds.length === 0) {
    return err(
      invalidEvidence("A dimension must carry at least one document proposal or failure")
    );
  }

  const documentIds = new Set([
    ...parts.documentLevels.map((proposal) => proposal.documentId),
    ...parts.failedDocumentIds
  ]);
  if (documentIds.size > MAXIMUM_CANDIDATE_DOCUMENTS) {
    return err(invalidEvidence("A dimension covers at most four documents"));
  }

  const supportingSpanIds: string[] = [];
  const contradictingSpanIds: string[] = [];
  const supportingDocumentIds = new Set<string>();
  for (const span of dimension.spans) {
    if (!documentIds.has(span.documentId)) {
      return err(invalidEvidence("An evidence span references a document the dimension lacks"));
    }
    if (span.polarity === "supporting") {
      supportingSpanIds.push(span.evidenceSpanId);
      supportingDocumentIds.add(span.documentId);
    } else {
      contradictingSpanIds.push(span.evidenceSpanId);
    }
  }

  const selection = selectDocumentLevel(parts.documentLevels, supportingDocumentIds);
  const humanLevel = parts.humanLevels.reduce<DimensionLevel | undefined>(
    (highest, level) => (highest === undefined ? level : higherLevel(highest, level)),
    undefined
  );

  if (humanLevel === undefined && parts.documentLevels.length === 0) {
    return ok({
      available: false,
      unavailable: Object.freeze({
        dimensionId: dimension.dimensionId,
        failedDocumentIds: sortedUnique(parts.failedDocumentIds)
      })
    });
  }

  if (humanLevel !== undefined && humanLevel !== "none" && supportingSpanIds.length === 0) {
    return err(invalidEvidence("A non-none human level requires a located supporting span"));
  }

  return ok({
    available: true,
    assessment: Object.freeze({
      dimensionId: dimension.dimensionId,
      level: humanLevel ?? selection.level,
      source: humanLevel === undefined ? "extracted" : "human",
      derivedLevel: derivedLevelFor(supportingSpanIds.length, contradictingSpanIds.length),
      levelDisagreement: selection.disagreement,
      supportingSpanIds: sortedUnique(supportingSpanIds),
      contradictingSpanIds: sortedUnique(contradictingSpanIds),
      documentIds: sortedUnique(parts.documentLevels.map((proposal) => proposal.documentId)),
      failedDocumentIds: sortedUnique(parts.failedDocumentIds),
      ungroundedDocumentIds: selection.ungroundedDocumentIds
    })
  });
}

/**
 * Produces one assessment per rubric dimension from the evidence and level
 * proposals gathered across a candidate's documents.
 *
 * Every rubric dimension must appear exactly once, so the result covers the
 * whole rubric or fails. A dimension whose documents all failed reviewably is
 * unavailable: it has no level, it is not scored, and the whole derivation
 * reports `unavailable`, which is what keeps an incomplete packet out of the
 * score rather than fabricating a `none`. A dimension with no located evidence
 * of any polarity still carries a valid `none` assessment and records an
 * explicit gap beside it; gaps are never folded into the level.
 */
export function deriveDimensionAssessments(
  dimensionsInput: unknown,
  rubric: Rubric
): Result<DimensionAssessmentDerivation, DomainError> {
  const parsed = DimensionEvidenceListSchema.safeParse(dimensionsInput);
  if (!parsed.success) {
    return err(createDomainError("invalid_input", "Invalid dimension evidence"));
  }

  const byDimension = new Map<string, DimensionEvidence>();
  for (const dimension of parsed.data) {
    if (byDimension.has(dimension.dimensionId)) {
      return err(invalidEvidence("Duplicate evidence for a rubric dimension"));
    }
    byDimension.set(dimension.dimensionId, dimension);
  }
  if (byDimension.size !== rubric.dimensions.length) {
    return err(
      invalidEvidence("Evidence must cover every rubric dimension exactly once")
    );
  }

  const assessments: DimensionAssessment[] = [];
  const gaps: EvidenceGap[] = [];
  const unavailable: UnavailableDimension[] = [];
  for (const rubricDimension of rubric.dimensions) {
    const dimension = byDimension.get(rubricDimension.dimensionId);
    if (dimension === undefined) {
      return err(invalidEvidence("Evidence does not match the rubric dimensions"));
    }
    const assessed = assessDimension(dimension);
    if (!assessed.ok) {
      return assessed;
    }
    if (!assessed.value.available) {
      unavailable.push(assessed.value.unavailable);
      continue;
    }
    const assessment = assessed.value.assessment;
    assessments.push(assessment);
    if (assessment.supportingSpanIds.length === 0 && assessment.contradictingSpanIds.length === 0) {
      gaps.push(
        Object.freeze({
          dimensionId: assessment.dimensionId,
          documentsSearched: sortedUnique([
            ...assessment.documentIds,
            ...assessment.failedDocumentIds
          ])
        })
      );
    }
  }

  return ok(
    Object.freeze({
      availability: unavailable.length === 0 ? "complete" : "unavailable",
      assessments: Object.freeze(assessments),
      gaps: Object.freeze(gaps),
      unavailable: Object.freeze(unavailable)
    })
  );
}
