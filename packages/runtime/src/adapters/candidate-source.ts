import type { Result } from "@recruitos/core";

import type { RuntimeError } from "../errors/index.js";

/**
 * The candidate-source port. A source hands over the documents a candidate
 * submitted and, separately, the structured answers the application form
 * collected.
 *
 * The separation is load-bearing rather than cosmetic. Readiness item T4 in
 * `docs/designs/rubric-lock-prep.md` records that work authorization is not a
 * resume field: real resumes omit it, US guidance says to omit it, and the ATS
 * collects it as an application question. Resolving it from document text would
 * make the requirement resolve determinately mostly for candidates who need
 * sponsorship, which correlates an escalation with national origin. So work
 * authorization arrives here as an application answer with its own provenance,
 * and `documents` is never a source for it. An absent answer stays absent; it is
 * a genuine unknown, not something to infer from prose.
 *
 * This file declares types only. It performs no I/O and imports no provider SDK.
 */

export type CandidateSourceDescriptor = Readonly<{
  adapterId: string;
  /** Matches the persisted `source_system` for candidates this source yields. */
  sourceSystem: string;
  contractVersion: number;
}>;

export type CandidateSourceDocument = Readonly<{
  documentKind: string;
  label: string;
  documentOrdinal: number;
  rawText: string;
}>;

/**
 * Where a structured answer came from. Distinct from document provenance on
 * purpose: an answer is still a citable record, just not a resume span.
 */
export type ApplicationAnswerProvenance = Readonly<{
  /** The system that collected the answer, which need not be the ATS itself. */
  collectedBy: string;
  formId: string;
  questionId: string;
  collectedAt: number;
}>;

/**
 * One application answer. The option key stays opaque here: which options exist,
 * and what any of them implies about a requirement, is a product decision that
 * this contract deliberately does not encode.
 */
export type StructuredApplicationAnswer = Readonly<{
  questionKey: string;
  selectedOptionKey: string;
  /** Free text the form allowed alongside the selection, when present. */
  freeText: string | undefined;
  provenance: ApplicationAnswerProvenance;
}>;

export type CandidateApplicationAnswers = Readonly<{
  /**
   * `undefined` means the source collected no answer. Callers must treat that
   * as unknown and must not fall back to reading `documents`.
   */
  workAuthorization: StructuredApplicationAnswer | undefined;
}>;

export type CandidateSourceRecord = Readonly<{
  sourceKey: string;
  channel: string;
  documents: readonly CandidateSourceDocument[];
  applicationAnswers: CandidateApplicationAnswers;
}>;

export type CandidateSourceRequest = Readonly<{
  /** Opaque cursor from a previous page, or `undefined` for the first page. */
  cursor: string | undefined;
  limit: number;
}>;

export type CandidateSourcePage = Readonly<{
  descriptor: CandidateSourceDescriptor;
  records: readonly CandidateSourceRecord[];
  /** `undefined` when the source has no further pages. */
  nextCursor: string | undefined;
}>;

export interface CandidateSourceAdapter {
  readonly descriptor: CandidateSourceDescriptor;
  listCandidates(
    request: CandidateSourceRequest
  ): Promise<Result<CandidateSourcePage, RuntimeError>>;
}
