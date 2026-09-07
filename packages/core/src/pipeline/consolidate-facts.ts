import { z } from "zod";

import { compareCodeUnits } from "../canonical/comparator.js";
import { MAXIMUM_STRUCTURED_FACTS_PER_WORK_ITEM } from "../domain/extraction.js";
import {
  FACT_PROVENANCE_SOURCES,
  FactProvenanceSourceSchema,
  StructuredFactPayloadSchema,
  structuredFactSemanticKey,
  type FactProvenanceSource,
  type StructuredFactKind,
  type StructuredFactPayload
} from "../domain/facts.js";
import { CandidateDocumentIdSchema, EvidenceSpanIdSchema } from "../domain/ids.js";
import { createDomainError, type DomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";

/** A corpus member carries one to four documents. */
export const MAXIMUM_CANDIDATE_DOCUMENTS = 4;

/**
 * Candidate-level bound on fact proposals: the per-work-item extraction limit
 * across the maximum document count. Consolidation is candidate scoped, so the
 * bound has to be stated here rather than inherited from one work item.
 */
export const MAXIMUM_FACT_PROPOSALS =
  MAXIMUM_STRUCTURED_FACTS_PER_WORK_ITEM * MAXIMUM_CANDIDATE_DOCUMENTS;

const FIELD_SEPARATOR = "\u001f";

/**
 * Kinds a candidate can only hold one of. Two different current titles, two
 * different authorization classifications, or two different claimed experience
 * figures are claims about the same subject, so they conflict rather than
 * coexist. The remaining kinds are per employment, and two entries about
 * different employers are ordinary concurrent history.
 */
const SINGLE_SUBJECT_FACT_KINDS = [
  "work_authorization_statement",
  "current_title",
  "claimed_experience"
] as const satisfies readonly StructuredFactKind[];

export const StructuredFactProposalSchema = z
  .object({
    documentId: CandidateDocumentIdSchema,
    provenance: FactProvenanceSourceSchema,
    payload: StructuredFactPayloadSchema,
    evidenceSpanIds: z.array(EvidenceSpanIdSchema).min(1)
  })
  .strict();

export type StructuredFactProposal = z.infer<typeof StructuredFactProposalSchema>;

const StructuredFactProposalsSchema = z
  .array(StructuredFactProposalSchema)
  .min(1)
  .max(MAXIMUM_FACT_PROPOSALS);

/**
 * One grounded fact after consolidation. `factKey` identifies the exact claim
 * and is what a conflict lists as a member; `subjectKey` names what the claim
 * is about and is what groups conflicts. Provenance is retained in full:
 * parser output never silently overrides model output or the reverse.
 */
export type ConsolidatedFact = Readonly<{
  factKey: string;
  subjectKey: string;
  payload: StructuredFactPayload;
  provenance: readonly FactProvenanceSource[];
  documentIds: readonly string[];
  evidenceSpanIds: readonly string[];
}>;

/**
 * Two or more incompatible grounded facts about one subject. Members stay
 * visible and are listed in canonical order, which is what the immutable
 * `fact_conflict_member` rows record.
 */
export type FactConflict = Readonly<{
  subjectKey: string;
  kind: StructuredFactKind;
  memberFactKeys: readonly string[];
}>;

export type FactConsolidation = Readonly<{
  facts: readonly ConsolidatedFact[];
  conflicts: readonly FactConflict[];
  documentIds: readonly string[];
}>;

function invalidInput(message: string): DomainError {
  return createDomainError("invalid_input", message);
}

/**
 * Identity of one exact grounded claim. Every field of the payload takes part,
 * so two proposals merge only when they assert precisely the same thing.
 */
export function structuredFactIdentityKey(payload: StructuredFactPayload): string {
  switch (payload.kind) {
    case "employment_interval":
      return [
        payload.kind,
        payload.employer,
        payload.title,
        payload.startMonth,
        payload.endMonth
      ].join(FIELD_SEPARATOR);
    case "work_authorization_statement":
      return [payload.kind, payload.classification, payload.statementText].join(FIELD_SEPARATOR);
    case "current_title":
      return [payload.kind, payload.title].join(FIELD_SEPARATOR);
    case "employer_history_entry":
      return [payload.kind, payload.employer, payload.startMonth, payload.endMonth].join(
        FIELD_SEPARATOR
      );
    case "claimed_experience":
      return [payload.kind, payload.claimedMonths.toString(10)].join(FIELD_SEPARATOR);
  }
}

/**
 * The subject a claim is about. Single-subject kinds collapse to the kind
 * itself; the employment kinds reuse the committed type-specific semantic key,
 * so an employer and start month pair is one subject and a differing title or
 * ending month on it is a disagreement rather than a second job.
 */
export function structuredFactSubjectKey(payload: StructuredFactPayload): string {
  return (SINGLE_SUBJECT_FACT_KINDS as readonly string[]).includes(payload.kind)
    ? payload.kind
    : [payload.kind, structuredFactSemanticKey(payload)].join(FIELD_SEPARATOR);
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareCodeUnits));
}

function orderedProvenance(
  values: ReadonlySet<FactProvenanceSource>
): readonly FactProvenanceSource[] {
  return Object.freeze(FACT_PROVENANCE_SOURCES.filter((source) => values.has(source)));
}

type FactAccumulator = {
  readonly payload: StructuredFactPayload;
  readonly subjectKey: string;
  readonly provenance: Set<FactProvenanceSource>;
  readonly documentIds: string[];
  readonly evidenceSpanIds: string[];
};

/**
 * Merges the structured facts proposed across a candidate's one to four
 * documents into a deduplicated, canonically ordered set, and names the
 * conflicts between them.
 *
 * Deduplication is by exact claim: identical payloads from different
 * documents, or from the parser and the extractor and a human, become one fact
 * that retains every provenance, document, and grounding span. Facts that
 * disagree about the same subject are never merged and never dropped. Each
 * such subject produces one conflict with at least two canonically ordered
 * members, which is the input that resolves the affected hard requirements to
 * `unknown` later in the pipeline.
 *
 * Every proposal must carry at least one grounding evidence span, so an
 * ungrounded claim cannot enter the consolidated set at all.
 */
export function consolidateStructuredFacts(
  proposalsInput: unknown
): Result<FactConsolidation, DomainError> {
  const parsed = StructuredFactProposalsSchema.safeParse(proposalsInput);
  if (!parsed.success) {
    return err(invalidInput("Invalid structured fact proposals"));
  }

  const documentIds = new Set<string>();
  const accumulators = new Map<string, FactAccumulator>();
  for (const proposal of parsed.data) {
    documentIds.add(proposal.documentId);
    const factKey = structuredFactIdentityKey(proposal.payload);
    const existing = accumulators.get(factKey);
    const accumulator = existing ?? {
      payload: proposal.payload,
      subjectKey: structuredFactSubjectKey(proposal.payload),
      provenance: new Set<FactProvenanceSource>(),
      documentIds: [],
      evidenceSpanIds: []
    };
    accumulator.provenance.add(proposal.provenance);
    accumulator.documentIds.push(proposal.documentId);
    accumulator.evidenceSpanIds.push(...proposal.evidenceSpanIds);
    accumulators.set(factKey, accumulator);
  }

  if (documentIds.size > MAXIMUM_CANDIDATE_DOCUMENTS) {
    return err(invalidInput("A candidate carries at most four documents"));
  }

  const facts: ConsolidatedFact[] = [];
  const membersBySubject = new Map<string, { kind: StructuredFactKind; factKeys: string[] }>();
  for (const [factKey, accumulator] of accumulators) {
    facts.push(
      Object.freeze({
        factKey,
        subjectKey: accumulator.subjectKey,
        payload: accumulator.payload,
        provenance: orderedProvenance(accumulator.provenance),
        documentIds: sortedUnique(accumulator.documentIds),
        evidenceSpanIds: sortedUnique(accumulator.evidenceSpanIds)
      })
    );
    const subject = membersBySubject.get(accumulator.subjectKey) ?? {
      kind: accumulator.payload.kind,
      factKeys: []
    };
    subject.factKeys.push(factKey);
    membersBySubject.set(accumulator.subjectKey, subject);
  }
  facts.sort((left, right) => compareCodeUnits(left.factKey, right.factKey));

  const conflicts: FactConflict[] = [];
  for (const [subjectKey, subject] of membersBySubject) {
    if (subject.factKeys.length < 2) {
      continue;
    }
    conflicts.push(
      Object.freeze({
        subjectKey,
        kind: subject.kind,
        memberFactKeys: sortedUnique(subject.factKeys)
      })
    );
  }
  conflicts.sort((left, right) => compareCodeUnits(left.subjectKey, right.subjectKey));

  return ok(
    Object.freeze({
      facts: Object.freeze(facts),
      conflicts: Object.freeze(conflicts),
      documentIds: sortedUnique([...documentIds])
    })
  );
}
