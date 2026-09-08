import {
  CandidateDocumentIdSchema,
  CandidateIdSchema,
  compareCodeUnits,
  computeAggregateScore,
  computeConfidence,
  consolidateStructuredFacts,
  createDomainError,
  deriveDimensionAssessments,
  deriveShortlistProposals,
  EvidenceSpanIdSchema,
  PositiveIntegerSchema,
  relocateQuote,
  REQUIRED_FIELD_IDS,
  resolveHardRequirements,
  routeCandidateResult,
  RubricDimensionIdSchema,
  type CandidateRouting,
  type CandidateTriageStatus,
  type ConfidenceInput,
  type DimensionAssessmentDerivation,
  type DimensionEvidence,
  type DimensionLevel,
  type DimensionLevelProposal,
  type DimensionSpan,
  type DomainError,
  type EvidencePolarity,
  type EvidenceSpanId,
  type FactConsolidation,
  type FactProvenanceSource,
  type HardRequirementPolicy,
  type HardRequirementResolution,
  type ProposalDerivation,
  type Rational,
  type Result,
  type RoutingPolicy,
  type RoutingSignals,
  type Rubric,
  type ScoreComputation,
  type StructuredFactPayload,
  type StructuredFactProposal,
  type WorkAuthorizationClassification
} from "@recruitos/core";
import { z } from "zod";

import type { CandidateApplicationAnswer } from "../application-answers/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import type { DroppedQuote } from "../evidence/index.js";
import type { ExtractionArtifact, ExtractionFailure } from "../extraction/index.js";

/**
 * Extraction-to-pipeline bridge.
 *
 * Translates candidate documents, extraction scheduler artifacts, failures,
 * and candidate application answers into inputs consumed by pure core pipeline
 * functions:
 * 1. Structured fact proposals for consolidateStructuredFacts, with quotes
 *    relocated against stored normalized text via core relocateQuote.
 * 2. Per-dimension evidence for deriveDimensionAssessments across all rubric dimensions.
 * 3. End-to-end execution through scoring, confidence, routing, and proposals.
 */

export const MAXIMUM_CANDIDATE_DOCUMENTS = 4;

export type CandidateDocumentBridgeInput = Readonly<{
  candidateDocumentId: string;
  documentKind: string;
  sourceDocumentId: string;
  normalizedText: string;
}>;

export type CandidateExtractionResultInput = Readonly<{
  candidateDocumentId: string;
  dimensionId: string;
  artifact?: ExtractionArtifact | undefined;
  failure?: ExtractionFailure | undefined;
  reviewableFailure?: boolean | undefined;
  humanLevel?: DimensionLevel | undefined;
}>;

export type RawFactGroundingQuote = Readonly<{
  quotedText: string;
  polarity?: EvidencePolarity | undefined;
}>;

export type RawFactProposalInput = Readonly<{
  documentId: string;
  provenance: FactProvenanceSource;
  payload: StructuredFactPayload;
  groundingQuotes?: readonly RawFactGroundingQuote[] | undefined;
  evidenceSpanIds?: readonly string[] | undefined;
}>;

export type CandidateBridgeInput = Readonly<{
  candidateId: string;
  documents: readonly CandidateDocumentBridgeInput[];
  extractions: readonly CandidateExtractionResultInput[];
  applicationAnswers?: {
    workAuthorization?: CandidateApplicationAnswer | undefined;
  } | undefined;
  rawFactProposals?: readonly RawFactProposalInput[] | undefined;
  rubric: Rubric;
}>;

export type LocatedBridgeSpan = Readonly<{
  evidenceSpanId: string;
  documentId: string;
  start: number;
  end: number;
  quotedText: string;
  polarity: EvidencePolarity;
  matchQuality: string;
}>;

export type CandidateTriageInputs = Readonly<{
  candidateId: string;
  structuredFactProposals: readonly StructuredFactProposal[];
  dimensionEvidence: readonly DimensionEvidence[];
  locatedSpans: readonly LocatedBridgeSpan[];
  droppedQuotes: readonly DroppedQuote[];
}>;

export type DeriveCandidateDecisionInput = CandidateBridgeInput &
  Readonly<{
    hardRequirementPolicy: HardRequirementPolicy;
    routingSignals?: Partial<RoutingSignals> | undefined;
    routingPolicy?: RoutingPolicy | undefined;
    isVariant?: boolean | undefined;
    duplicateSuppressed?: boolean | undefined;
  }>;

export type CandidateDecisionOutput = Readonly<{
  candidateId: string;
  triageInputs: CandidateTriageInputs;
  consolidation: FactConsolidation;
  dimensionDerivation: DimensionAssessmentDerivation;
  hardRequirements: HardRequirementResolution;
  score: ScoreComputation | null;
  confidence: Rational | null;
  confidenceInput: ConfidenceInput | null;
  routing: CandidateRouting;
  proposals: ProposalDerivation;
}>;

function bridgeFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

/**
 * Maps a candidate application answer selected option key to a work authorization
 * classification per OQ-7.
 */
export function mapWorkAuthorizationOptionKey(
  optionKey: string
): WorkAuthorizationClassification {
  const normalized = optionKey.trim().toLowerCase();
  if (
    normalized.includes("authorized_no_sponsorship") ||
    normalized.includes("authorized_us") ||
    normalized === "authorized" ||
    normalized.includes("citizen") ||
    normalized.includes("permanent_resident")
  ) {
    return "authorized";
  }
  if (
    normalized.includes("requires_sponsorship") ||
    normalized.includes("needs_sponsorship") ||
    normalized.includes("sponsorship")
  ) {
    return "requires_sponsorship";
  }
  return "not_authorized";
}

/**
 * Assembles structured-fact proposals and dimension evidence from candidate
 * extraction artifacts, application answers, and document text.
 */
export function deriveCandidateTriageInputs(
  input: CandidateBridgeInput
): Result<CandidateTriageInputs, RuntimeError> {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.candidateId !== "string" ||
    input.candidateId.trim().length === 0
  ) {
    return { ok: false, error: bridgeFailure("Invalid candidate id") };
  }

  if (!Array.isArray(input.documents) || input.documents.length === 0) {
    return { ok: false, error: bridgeFailure("Candidate must carry at least one document") };
  }

  if (input.documents.length > MAXIMUM_CANDIDATE_DOCUMENTS) {
    return {
      ok: false,
      error: bridgeFailure(`A candidate carries at most ${MAXIMUM_CANDIDATE_DOCUMENTS} documents`)
    };
  }

  if (typeof input.rubric !== "object" || input.rubric === null || !Array.isArray(input.rubric.dimensions)) {
    return { ok: false, error: bridgeFailure("Invalid rubric for bridge input") };
  }

  const documentMap = new Map<string, CandidateDocumentBridgeInput>();
  for (const doc of input.documents) {
    documentMap.set(doc.candidateDocumentId, doc);
  }

  const structuredFactProposals: StructuredFactProposal[] = [];
  const locatedSpans: LocatedBridgeSpan[] = [];
  const droppedQuotes: DroppedQuote[] = [];

  // 1. Process candidate application answers (OQ-7: work_authorization only)
  const workAuthAnswer = input.applicationAnswers?.workAuthorization;
  if (
    workAuthAnswer !== undefined &&
    workAuthAnswer.questionKey === "work_authorization" &&
    input.documents.length > 0
  ) {
    const classification = mapWorkAuthorizationOptionKey(workAuthAnswer.selectedOptionKey);
    const statementText =
      workAuthAnswer.freeText ?? `Application answer: ${workAuthAnswer.selectedOptionKey}`;
    const primaryDoc = input.documents[0]!;
    const relocation = relocateQuote(primaryDoc.normalizedText, statementText);
    if (relocation.ok) {
      const primaryDocId = CandidateDocumentIdSchema.parse(primaryDoc.candidateDocumentId);
      const spanId = EvidenceSpanIdSchema.parse(
        `span_app_ans_${input.candidateId}_${workAuthAnswer.candidateApplicationAnswerId}`
      );
      locatedSpans.push(
        Object.freeze({
          evidenceSpanId: spanId,
          documentId: primaryDoc.candidateDocumentId,
          start: relocation.value.start,
          end: relocation.value.end,
          quotedText: relocation.value.quotedText,
          polarity: "supporting" as const,
          matchQuality: relocation.value.matchQuality
        })
      );
      structuredFactProposals.push({
        documentId: primaryDocId,
        provenance: "parsed",
        payload: {
          kind: "work_authorization_statement" as const,
          classification,
          statementText
        },
        evidenceSpanIds: [spanId]
      });
    } else {
      droppedQuotes.push(
        Object.freeze({
          quotedText: statementText,
          dimensionId: input.rubric.dimensions[0]!.dimensionId,
          reason: "unlocated"
        })
      );
    }
  }

  // 2. Process raw fact proposals and relocate grounding quotes
  if (Array.isArray(input.rawFactProposals)) {
    let quoteOrdinal = 0;
    for (const rawProposal of input.rawFactProposals) {
      const doc = documentMap.get(rawProposal.documentId);
      if (doc === undefined) {
        continue;
      }

      const evidenceSpanIds: EvidenceSpanId[] = [];
      if (Array.isArray(rawProposal.evidenceSpanIds)) {
        for (const id of rawProposal.evidenceSpanIds) {
          evidenceSpanIds.push(EvidenceSpanIdSchema.parse(id));
        }
      }

      if (Array.isArray(rawProposal.groundingQuotes)) {
        for (const quote of rawProposal.groundingQuotes) {
          quoteOrdinal += 1;
          const relocation = relocateQuote(doc.normalizedText, quote.quotedText);
          if (relocation.ok) {
            const rawSpanId = `span_fact_${input.candidateId}_${doc.candidateDocumentId}_${quoteOrdinal}`;
            const spanId = EvidenceSpanIdSchema.parse(rawSpanId);
            evidenceSpanIds.push(spanId);
            locatedSpans.push(
              Object.freeze({
                evidenceSpanId: spanId,
                documentId: doc.candidateDocumentId,
                start: relocation.value.start,
                end: relocation.value.end,
                quotedText: relocation.value.quotedText,
                polarity: quote.polarity ?? "supporting",
                matchQuality: relocation.value.matchQuality
              })
            );
          } else {
            const fallbackDim = input.rubric.dimensions[0]!.dimensionId;
            droppedQuotes.push(
              Object.freeze({
                quotedText: quote.quotedText,
                dimensionId: fallbackDim,
                reason: "unlocated"
              })
            );
          }
        }
      }

      // Only emit grounded proposals (must have at least one located span)
      if (evidenceSpanIds.length > 0) {
        structuredFactProposals.push({
          documentId: CandidateDocumentIdSchema.parse(rawProposal.documentId),
          provenance: rawProposal.provenance,
          payload: rawProposal.payload,
          evidenceSpanIds
        });
      }
    }
  }

  // 3. Process extraction results per dimension across documents
  const extractionsByDimDoc = new Map<string, CandidateExtractionResultInput>();
  if (Array.isArray(input.extractions)) {
    for (const item of input.extractions) {
      extractionsByDimDoc.set(`${item.dimensionId}:${item.candidateDocumentId}`, item);
    }
  }

  const dimensionEvidence: DimensionEvidence[] = [];
  for (const rubricDimension of input.rubric.dimensions) {
    const dimId = rubricDimension.dimensionId;
    const proposals: DimensionLevelProposal[] = [];
    const spans: DimensionSpan[] = [];

    for (const doc of input.documents) {
      const docId = CandidateDocumentIdSchema.parse(doc.candidateDocumentId);
      const ext = extractionsByDimDoc.get(`${dimId}:${doc.candidateDocumentId}`);
      if (ext !== undefined && ext.artifact !== undefined) {
        const artifact = ext.artifact;
        proposals.push({
          kind: "document_level" as const,
          documentId: docId,
          level: artifact.acceptedOutput.proposedLevel
        });

        artifact.acceptedOutput.spans.forEach((span, spanIdx) => {
          const rawSpanId = `span_${input.candidateId}_${artifact.extractionArtifactId}_${spanIdx}`;
          spans.push({
            evidenceSpanId: EvidenceSpanIdSchema.parse(rawSpanId),
            documentId: docId,
            polarity: span.polarity,
            source: "extracted" as const
          });
        });
      } else if (
        ext !== undefined &&
        (ext.failure !== undefined || ext.reviewableFailure === true)
      ) {
        proposals.push({
          kind: "document_failure" as const,
          documentId: docId
        });
      } else {
        // Document searched without explicit artifact or failure is treated as document_failure
        proposals.push({
          kind: "document_failure" as const,
          documentId: docId
        });
      }

      if (ext !== undefined && ext.humanLevel !== undefined) {
        proposals.push({
          kind: "human_level" as const,
          level: ext.humanLevel
        });
      }
    }

    dimensionEvidence.push({
      dimensionId: dimId,
      proposals,
      spans
    });
  }

  return {
    ok: true,
    value: Object.freeze({
      candidateId: input.candidateId,
      structuredFactProposals: Object.freeze(structuredFactProposals),
      dimensionEvidence: Object.freeze(dimensionEvidence),
      locatedSpans: Object.freeze(locatedSpans),
      droppedQuotes: Object.freeze(droppedQuotes)
    })
  };
}

/**
 * End-to-end derivation executing pure core functions over the bridged candidate inputs.
 */
export function deriveCandidateDecision(
  input: DeriveCandidateDecisionInput
): Result<CandidateDecisionOutput, RuntimeError> {
  const bridged = deriveCandidateTriageInputs(input);
  if (!bridged.ok) {
    return bridged;
  }
  const triageInputs = bridged.value;

  // 1. Fact consolidation
  let consolidation: FactConsolidation;
  if (triageInputs.structuredFactProposals.length > 0) {
    const consolidationResult = consolidateStructuredFacts(triageInputs.structuredFactProposals);
    /* v8 ignore next 3 */
    if (!consolidationResult.ok) {
      return { ok: false, error: bridgeFailure(consolidationResult.error.message) };
    }
    consolidation = consolidationResult.value;
  } else {
    consolidation = Object.freeze({
      facts: Object.freeze([]),
      conflicts: Object.freeze([]),
      documentIds: Object.freeze(input.documents.map((d) => d.candidateDocumentId).sort(compareCodeUnits))
    });
  }

  // 2. Dimension assessments derivation
  const derivationResult = deriveDimensionAssessments(triageInputs.dimensionEvidence, input.rubric);
  /* v8 ignore next 3 */
  if (!derivationResult.ok) {
    return { ok: false, error: bridgeFailure(derivationResult.error.message) };
  }
  const dimensionDerivation = derivationResult.value;

  // 3. Hard requirements resolution
  const reqResult = resolveHardRequirements(consolidation, input.hardRequirementPolicy);
  /* v8 ignore next 3 */
  if (!reqResult.ok) {
    return { ok: false, error: bridgeFailure(reqResult.error.message) };
  }
  const hardRequirements = reqResult.value;

  // 4. Scoring and confidence computation
  let score: ScoreComputation | null = null;
  let confidence: Rational | null = null;
  let confidenceInput: ConfidenceInput | null = null;

  if (dimensionDerivation.availability === "complete") {
    const levelAssessments = dimensionDerivation.assessments.map((a) => ({
      dimensionId: a.dimensionId,
      level: a.level
    }));
    const scoreResult = computeAggregateScore(levelAssessments, input.rubric);
    /* v8 ignore next 3 */
    if (!scoreResult.ok) {
      return { ok: false, error: bridgeFailure(scoreResult.error.message) };
    }
    score = scoreResult.value;

    const dimensionsWithLocatedSpan = dimensionDerivation.assessments.filter(
      (a) => a.supportingSpanIds.length > 0
    ).length;

    let spansLocated = 0;
    for (const a of dimensionDerivation.assessments) {
      spansLocated += a.supportingSpanIds.length + a.contradictingSpanIds.length;
    }

    confidenceInput = {
      dimensionsWithLocatedSpan,
      totalDimensions: input.rubric.dimensions.length,
      spansLocated,
      spansReturned: spansLocated,
      contradictionCount: dimensionDerivation.assessments.reduce(
        (sum, a) => sum + a.contradictingSpanIds.length,
        0
      ),
      requiredFieldsMissing: hardRequirements.unknownCount,
      totalRequiredFields: REQUIRED_FIELD_IDS.length
    };

    const confidenceResult = computeConfidence(confidenceInput);

    /* v8 ignore next 3 */
    if (!confidenceResult.ok) {
      return { ok: false, error: bridgeFailure(confidenceResult.error.message) };
    }
    confidence = confidenceResult.value;
  }

  // 5. Routing candidate result
  const routingSignals: RoutingSignals = {
    parseFailure: input.routingSignals?.parseFailure ?? false,
    possibleDuplicate: input.routingSignals?.possibleDuplicate ?? false,
    promptInjectionFlagged: input.routingSignals?.promptInjectionFlagged ?? false,
    ambiguousSubjectIds: input.routingSignals?.ambiguousSubjectIds ?? []
  };

  const routingResult = routeCandidateResult(
    {
      consolidation,
      derivation: dimensionDerivation,
      requirements: hardRequirements,
      confidence
    },
    input.rubric,
    routingSignals,
    input.routingPolicy
  );

  /* v8 ignore next 3 */
  if (!routingResult.ok) {
    return { ok: false, error: bridgeFailure(routingResult.error.message) };
  }
  const routing = routingResult.value;

  // 6. Derive shortlist proposals
  const candidateId = CandidateIdSchema.parse(input.candidateId);
  const evidenceSpanIds: EvidenceSpanId[] = [];
  for (const assessment of dimensionDerivation.assessments) {
    for (const spanId of assessment.supportingSpanIds) {
      if (evidenceSpanIds.length < 24) {
        evidenceSpanIds.push(EvidenceSpanIdSchema.parse(spanId));
      }
    }
  }

  const proposalCandidate = {
    candidateId,
    corpusTag: input.isVariant ? ("variant" as const) : ("main" as const),
    status: routing.status,
    availability: routing.availability,
    aggregate: score?.aggregate ?? null,
    evidenceSpanIds
  };

  const duplicateCandidateIds = input.duplicateSuppressed ? [candidateId] : [];
  const proposalResult = deriveShortlistProposals([proposalCandidate], {
    shortlistLimit: PositiveIntegerSchema.parse(10),
    duplicateCandidateIds
  });
  /* v8 ignore next 3 */
  if (!proposalResult.ok) {
    return { ok: false, error: bridgeFailure(proposalResult.error.message) };
  }
  const proposals = proposalResult.value;

  return {
    ok: true,
    value: Object.freeze({
      candidateId: input.candidateId,
      triageInputs,
      consolidation,
      dimensionDerivation,
      hardRequirements,
      score,
      confidence,
      confidenceInput,
      routing,
      proposals
    })
  };
}
