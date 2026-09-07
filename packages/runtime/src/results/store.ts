import {
  BasisPointsSchema,
  CandidateTriageResultIdSchema,
  Sha256HexSchema,
  canonicalJsonStringify,
  err,
  formatRational,
  multiplyRationals,
  ok,
  parseRational,
  rationalFromInteger,
  roundHalfUp,
  sha256Hex,
  type CandidateTriageResultId,
  type Result
} from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  CandidateTriageResultContentSchema,
  CandidateTriageResultDraftSchema,
  CandidateTriageResultSchema,
  ScoreResultContentSchema,
  ScoreResultSchema,
  type CandidateTriageResult,
  type CandidateTriageResultContent,
  type ScoreResult,
  type ScoreResultContent,
  type ScoreResultDraft
} from "./schemas.js";

const preparedResults = new WeakSet<object>();

const TRANSACTION_REQUIRED = "Candidate result rows require an active command transaction";

function persistenceFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function validateContext(
  contextInput: unknown
): Result<ImmediateTransactionContext, RuntimeError> {
  if (typeof contextInput !== "object" || contextInput === null) {
    return err(persistenceFailure(TRANSACTION_REQUIRED));
  }
  const context = contextInput as Partial<ImmediateTransactionContext>;
  if (
    typeof context.nativeDatabase !== "object" ||
    context.nativeDatabase === null ||
    context.nativeDatabase.inTransaction !== true
  ) {
    return err(persistenceFailure(TRANSACTION_REQUIRED));
  }
  return ok(context as ImmediateTransactionContext);
}

function requirePrepared<TRecord>(
  registry: WeakSet<object>,
  preparedInput: unknown,
  message: string
): Result<TRecord, RuntimeError> {
  if (
    typeof preparedInput !== "object" ||
    preparedInput === null ||
    !registry.has(preparedInput)
  ) {
    return err(persistenceFailure(message));
  }
  return ok(preparedInput as TRecord);
}

function register<TRecord extends object>(
  registry: WeakSet<object>,
  record: TRecord
): TRecord {
  const frozen = Object.freeze(record);
  registry.add(frozen);
  return frozen;
}

function decodeCanonicalJson(
  json: string,
  hash: string,
  invalidJsonMessage: string,
  integrityMessage: string
): Result<unknown, RuntimeError> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    return err(persistenceFailure(invalidJsonMessage));
  }
  const canonical = canonicalJsonStringify(decoded);
  if (!canonical.ok || canonical.value !== json || sha256Hex(json) !== hash) {
    return err(persistenceFailure(integrityMessage));
  }
  return ok(decoded);
}

function compareIds(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function uniqueIds(ids: readonly string[], message: string): Result<void, RuntimeError> {
  if (new Set(ids).size !== ids.length) {
    return err(persistenceFailure(message));
  }
  return ok(undefined);
}

function hashOrdered(value: unknown): { json: string; hash: string } {
  const json = JSON.stringify(value);
  return { json, hash: sha256Hex(json) };
}

function rowExists(
  context: ImmediateTransactionContext,
  sql: string,
  id: string
): boolean {
  return context.nativeDatabase.prepare(sql).get(id) !== undefined;
}

function orderedIdList<TId extends string>(ids: readonly TId[]): TId[] {
  return [...ids].sort(compareIds);
}

function orderedResultContent(
  content: CandidateTriageResultContent
): CandidateTriageResultContent {
  return {
    availability: content.availability,
    candidateId: content.candidateId,
    dimensionAssessmentIds: orderedIdList(content.dimensionAssessmentIds),
    evidenceGapIds: orderedIdList(content.evidenceGapIds),
    evidenceSpanIds: orderedIdList(content.evidenceSpanIds),
    factConflictIds: orderedIdList(content.factConflictIds),
    hardRequirementAssessmentIds: orderedIdList(content.hardRequirementAssessmentIds),
    kind: content.kind,
    status: content.status,
    structuredFactIds: orderedIdList(content.structuredFactIds),
    supersedesResultId: content.supersedesResultId
  };
}

function orderedScoreContent(content: ScoreResultContent): ScoreResultContent {
  return {
    aggregate: content.aggregate,
    candidateTriageResultId: content.candidateTriageResultId,
    confidence: content.confidence,
    confidenceInput: {
      contradictionCount: content.confidenceInput.contradictionCount,
      dimensionsWithLocatedSpan: content.confidenceInput.dimensionsWithLocatedSpan,
      requiredFieldsMissing: content.confidenceInput.requiredFieldsMissing,
      spansLocated: content.confidenceInput.spansLocated,
      spansReturned: content.confidenceInput.spansReturned,
      totalDimensions: content.confidenceInput.totalDimensions,
      totalRequiredFields: content.confidenceInput.totalRequiredFields
    },
    contributions: [...content.contributions]
      .map((contribution) => ({
        dimensionId: contribution.dimensionId,
        level: contribution.level,
        levelValue: contribution.levelValue,
        weight: contribution.weight,
        weightedValue: contribution.weightedValue
      }))
      .sort((left, right) => compareIds(left.dimensionId, right.dimensionId))
  };
}

function basisPointsFromRational(
  text: string,
  scale: bigint
): Result<number, RuntimeError> {
  const parsed = parseRational(text);
  if (!parsed.ok || formatRational(parsed.value) !== text) {
    return err(persistenceFailure("Invalid score result content"));
  }
  const scaled = multiplyRationals(parsed.value, rationalFromInteger(scale));
  const rounded = roundHalfUp(scaled);
  const basisPoints = BasisPointsSchema.safeParse(Number(rounded));
  if (!basisPoints.success) {
    return err(persistenceFailure("Invalid score result content"));
  }
  return ok(basisPoints.data);
}

export function validateCandidateTriageResultContent(
  contentInput: unknown
): Result<CandidateTriageResultContent, RuntimeError> {
  const content = CandidateTriageResultContentSchema.safeParse(contentInput);
  if (!content.success) {
    return err(persistenceFailure("Invalid candidate result content"));
  }
  return ok(orderedResultContent(content.data));
}

export function hashCandidateTriageResultContent(
  contentInput: unknown
): Result<string, RuntimeError> {
  const content = validateCandidateTriageResultContent(contentInput);
  if (!content.ok) {
    return content;
  }
  return ok(hashOrdered(content.value).hash);
}

export function hashScoreResultContent(
  contentInput: unknown
): Result<string, RuntimeError> {
  const content = ScoreResultContentSchema.safeParse(contentInput);
  if (!content.success) {
    return err(persistenceFailure("Invalid score result content"));
  }
  return ok(hashOrdered(orderedScoreContent(content.data)).hash);
}

function canonicalizeScore(
  candidateTriageResultId: CandidateTriageResultId,
  draft: ScoreResultDraft,
  createdAt: number
): Result<ScoreResult, RuntimeError> {
  const contributionIds = draft.contributions.map((contribution) => contribution.dimensionId);
  const uniqueDimensions = uniqueIds(
    contributionIds,
    "Score contributions must cover six unique dimensions"
  );
  if (!uniqueDimensions.ok) {
    return uniqueDimensions;
  }
  const aggregatePoints = basisPointsFromRational(draft.aggregate, 100n);
  if (!aggregatePoints.ok) {
    return aggregatePoints;
  }
  const confidencePoints = basisPointsFromRational(draft.confidence, 10_000n);
  if (!confidencePoints.ok) {
    return confidencePoints;
  }
  const content = orderedScoreContent({
    aggregate: draft.aggregate,
    candidateTriageResultId,
    confidence: draft.confidence,
    confidenceInput: draft.confidenceInput,
    contributions: draft.contributions
  });
  const hashed = hashOrdered(content);
  return ok(
    ScoreResultSchema.parse({
      scoreResultId: draft.scoreResultId,
      candidateResultId: candidateTriageResultId,
      aggregateText: content.aggregate,
      confidenceText: content.confidence,
      aggregateBasisPoints: aggregatePoints.value,
      confidenceBasisPoints: confidencePoints.value,
      content,
      contentJson: hashed.json,
      contentHash: hashed.hash,
      createdAt
    })
  );
}

export function prepareCandidateTriageResult(
  draftInput: unknown
): Result<CandidateTriageResult, RuntimeError> {
  try {
    const draft = CandidateTriageResultDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid candidate result input"));
    }
    if ((draft.data.kind === "correction") !== (draft.data.supersedesResultId !== null)) {
      return err(
        persistenceFailure("Correction results require a superseded result and initial results forbid one")
      );
    }
    if (draft.data.availability === "unavailable" && draft.data.status !== "escalated") {
      return err(persistenceFailure("Unavailable results must be escalated"));
    }
    if (draft.data.availability === "unavailable" && draft.data.score !== null) {
      return err(persistenceFailure("Unavailable results must not include a score"));
    }
    if (draft.data.availability === "complete" && draft.data.score === null) {
      return err(persistenceFailure("Complete results require a score"));
    }
    if (
      draft.data.availability === "complete" &&
      draft.data.dimensionAssessments.length !== 6
    ) {
      return err(persistenceFailure("Complete results require six dimension assessments"));
    }

    const uniqueChecks = [
      uniqueIds(
        draft.data.evidenceSpans.map((span) => span.evidenceSpanId),
        "Candidate result evidence spans must be unique"
      ),
      uniqueIds(
        draft.data.evidenceSpans.map((span) => span.candidateResultEvidenceSpanId),
        "Candidate result evidence span IDs must be unique"
      ),
      uniqueIds(
        draft.data.evidenceGaps.map((gap) => gap.evidenceGapId),
        "Candidate result evidence gaps must be unique"
      ),
      uniqueIds(
        draft.data.evidenceGaps.map((gap) => gap.candidateResultEvidenceGapId),
        "Candidate result evidence gap IDs must be unique"
      ),
      uniqueIds(
        draft.data.evidenceGaps.map((gap) => gap.dimensionId),
        "Candidate result evidence gaps must be unique by dimension"
      ),
      uniqueIds(
        draft.data.dimensionAssessments.map((assessment) => assessment.dimensionAssessmentId),
        "Candidate result dimension assessments must be unique"
      ),
      uniqueIds(
        draft.data.dimensionAssessments.map(
          (assessment) => assessment.candidateResultDimensionAssessmentId
        ),
        "Candidate result dimension assessment IDs must be unique"
      ),
      uniqueIds(
        draft.data.dimensionAssessments.map((assessment) => assessment.dimensionId),
        "Candidate result dimension assessments must be unique by dimension"
      ),
      uniqueIds(
        draft.data.structuredFacts.map((fact) => fact.structuredFactId),
        "Candidate result structured facts must be unique"
      ),
      uniqueIds(
        draft.data.structuredFacts.map((fact) => fact.candidateResultStructuredFactId),
        "Candidate result structured fact IDs must be unique"
      ),
      uniqueIds(
        draft.data.factConflicts.map((conflict) => conflict.factConflictId),
        "Candidate result fact conflicts must be unique"
      ),
      uniqueIds(
        draft.data.factConflicts.map((conflict) => conflict.candidateResultFactConflictId),
        "Candidate result fact conflict IDs must be unique"
      ),
      uniqueIds(
        draft.data.hardRequirementAssessments.map(
          (assessment) => assessment.hardRequirementAssessmentId
        ),
        "Candidate result hard requirement assessments must be unique"
      ),
      uniqueIds(
        draft.data.hardRequirementAssessments.map(
          (assessment) => assessment.candidateResultHardRequirementAssessmentId
        ),
        "Candidate result hard requirement assessment IDs must be unique"
      )
    ];
    for (const check of uniqueChecks) {
      if (!check.ok) {
        return check;
      }
    }

    const sortedSpans = [...draft.data.evidenceSpans].sort((left, right) =>
      compareIds(left.evidenceSpanId, right.evidenceSpanId)
    );
    const sortedGaps = [...draft.data.evidenceGaps].sort((left, right) =>
      compareIds(left.evidenceGapId, right.evidenceGapId)
    );
    const sortedAssessments = [...draft.data.dimensionAssessments].sort((left, right) =>
      compareIds(left.dimensionAssessmentId, right.dimensionAssessmentId)
    );
    const sortedFacts = [...draft.data.structuredFacts].sort((left, right) =>
      compareIds(left.structuredFactId, right.structuredFactId)
    );
    const sortedConflicts = [...draft.data.factConflicts].sort((left, right) =>
      compareIds(left.factConflictId, right.factConflictId)
    );
    const sortedRequirements = [...draft.data.hardRequirementAssessments].sort((left, right) =>
      compareIds(left.hardRequirementAssessmentId, right.hardRequirementAssessmentId)
    );

    let score: ScoreResult | null = null;
    if (draft.data.score !== null) {
      const canonicalScore = canonicalizeScore(
        draft.data.candidateTriageResultId,
        draft.data.score,
        draft.data.createdAt
      );
      if (!canonicalScore.ok) {
        return canonicalScore;
      }
      const contributionIds = canonicalScore.value.content.contributions.map(
        (contribution) => contribution.dimensionId
      );
      const assessmentDimensionIds = orderedIdList(
        sortedAssessments.map((assessment) => assessment.dimensionId)
      );
      if (JSON.stringify(contributionIds) !== JSON.stringify(assessmentDimensionIds)) {
        return err(
          persistenceFailure("Score contributions must match the result dimension assessments")
        );
      }
      score = canonicalScore.value;
    }

    const content = orderedResultContent({
      availability: draft.data.availability,
      candidateId: draft.data.candidateId,
      dimensionAssessmentIds: sortedAssessments.map(
        (assessment) => assessment.dimensionAssessmentId
      ),
      evidenceGapIds: sortedGaps.map((gap) => gap.evidenceGapId),
      evidenceSpanIds: sortedSpans.map((span) => span.evidenceSpanId),
      factConflictIds: sortedConflicts.map((conflict) => conflict.factConflictId),
      hardRequirementAssessmentIds: sortedRequirements.map(
        (assessment) => assessment.hardRequirementAssessmentId
      ),
      kind: draft.data.kind,
      status: draft.data.status,
      structuredFactIds: sortedFacts.map((fact) => fact.structuredFactId),
      supersedesResultId: draft.data.supersedesResultId
    });
    const hashed = hashOrdered(content);
    const result = CandidateTriageResultSchema.parse({
      candidateTriageResultId: draft.data.candidateTriageResultId,
      candidateId: draft.data.candidateId,
      kind: draft.data.kind,
      availability: draft.data.availability,
      status: draft.data.status,
      supersedesResultId: draft.data.supersedesResultId,
      contentJson: hashed.json,
      contentHash: hashed.hash,
      evidenceSpans: sortedSpans.map((span, index) => ({
        candidateResultEvidenceSpanId: span.candidateResultEvidenceSpanId,
        evidenceSpanId: span.evidenceSpanId,
        spanOrdinal: index,
        createdAt: draft.data.createdAt
      })),
      evidenceGaps: sortedGaps.map((gap, index) => ({
        candidateResultEvidenceGapId: gap.candidateResultEvidenceGapId,
        evidenceGapId: gap.evidenceGapId,
        dimensionId: gap.dimensionId,
        gapOrdinal: index,
        createdAt: draft.data.createdAt
      })),
      dimensionAssessments: sortedAssessments.map((assessment, index) => ({
        candidateResultDimensionAssessmentId: assessment.candidateResultDimensionAssessmentId,
        dimensionAssessmentId: assessment.dimensionAssessmentId,
        dimensionId: assessment.dimensionId,
        assessmentOrdinal: index,
        createdAt: draft.data.createdAt
      })),
      structuredFacts: sortedFacts.map((fact, index) => ({
        candidateResultStructuredFactId: fact.candidateResultStructuredFactId,
        structuredFactId: fact.structuredFactId,
        factOrdinal: index,
        createdAt: draft.data.createdAt
      })),
      factConflicts: sortedConflicts.map((conflict, index) => ({
        candidateResultFactConflictId: conflict.candidateResultFactConflictId,
        factConflictId: conflict.factConflictId,
        conflictOrdinal: index,
        createdAt: draft.data.createdAt
      })),
      hardRequirementAssessments: sortedRequirements.map((assessment, index) => ({
        candidateResultHardRequirementAssessmentId:
          assessment.candidateResultHardRequirementAssessmentId,
        hardRequirementAssessmentId: assessment.hardRequirementAssessmentId,
        requirementOrdinal: index,
        createdAt: draft.data.createdAt
      })),
      score,
      sealId: draft.data.sealId,
      createdAt: draft.data.createdAt
    });
    return ok(register(preparedResults, result));
  } catch {
    return err(persistenceFailure("Candidate result preparation failed"));
  }
}

export function insertCandidateTriageResult(
  contextInput: unknown,
  preparedInput: unknown
): Result<CandidateTriageResult, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<CandidateTriageResult>(
      preparedResults,
      preparedInput,
      "Invalid prepared candidate result"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const result = prepared.value;
    if (
      !rowExists(
        context.value,
        "SELECT 1 AS present FROM candidate WHERE candidate_id = ?",
        result.candidateId
      )
    ) {
      return err(persistenceFailure("Candidate result requires a stored candidate"));
    }
    if (result.supersedesResultId !== null) {
      if (result.supersedesResultId === result.candidateTriageResultId) {
        return err(persistenceFailure("Candidate result cannot supersede itself"));
      }
      const prior = context.value.nativeDatabase
        .prepare(
          "SELECT candidate_id AS candidateId FROM candidate_triage_result WHERE candidate_triage_result_id = ?"
        )
        .get(result.supersedesResultId) as { candidateId: string } | undefined;
      if (prior === undefined) {
        return err(persistenceFailure("Correction results require a stored superseded result"));
      }
      if (prior.candidateId !== result.candidateId) {
        return err(persistenceFailure("Superseded results must belong to the same candidate"));
      }
    }
    for (const span of result.evidenceSpans) {
      if (
        !rowExists(
          context.value,
          "SELECT 1 AS present FROM evidence_span WHERE evidence_span_id = ?",
          span.evidenceSpanId
        )
      ) {
        return err(persistenceFailure("Candidate result requires stored evidence spans"));
      }
    }
    for (const gap of result.evidenceGaps) {
      const row = context.value.nativeDatabase
        .prepare("SELECT dimension_id AS dimensionId FROM evidence_gap WHERE evidence_gap_id = ?")
        .get(gap.evidenceGapId) as { dimensionId: string } | undefined;
      if (row === undefined) {
        return err(persistenceFailure("Candidate result requires stored evidence gaps"));
      }
      if (row.dimensionId !== gap.dimensionId) {
        return err(persistenceFailure("Candidate result gap dimension does not match the stored gap"));
      }
    }
    for (const assessment of result.dimensionAssessments) {
      const row = context.value.nativeDatabase
        .prepare(
          "SELECT dimension_id AS dimensionId FROM dimension_assessment WHERE dimension_assessment_id = ?"
        )
        .get(assessment.dimensionAssessmentId) as { dimensionId: string } | undefined;
      if (row === undefined) {
        return err(persistenceFailure("Candidate result requires stored dimension assessments"));
      }
      if (row.dimensionId !== assessment.dimensionId) {
        return err(
          persistenceFailure(
            "Candidate result assessment dimension does not match the stored assessment"
          )
        );
      }
    }
    for (const fact of result.structuredFacts) {
      const row = context.value.nativeDatabase
        .prepare("SELECT candidate_id AS candidateId FROM structured_fact WHERE structured_fact_id = ?")
        .get(fact.structuredFactId) as { candidateId: string } | undefined;
      if (row === undefined) {
        return err(persistenceFailure("Candidate result requires stored structured facts"));
      }
      if (row.candidateId !== result.candidateId) {
        return err(persistenceFailure("Candidate result facts must belong to the candidate"));
      }
    }
    for (const conflict of result.factConflicts) {
      const members = context.value.nativeDatabase
        .prepare(
          `SELECT structured_fact.candidate_id AS candidateId
           FROM fact_conflict_member
           JOIN structured_fact ON structured_fact.structured_fact_id = fact_conflict_member.structured_fact_id
           WHERE fact_conflict_member.fact_conflict_id = ?`
        )
        .all(conflict.factConflictId) as Array<{ candidateId: string }>;
      if (members.length < 2) {
        return err(persistenceFailure("Candidate result requires stored fact conflicts"));
      }
      if (members.some((member) => member.candidateId !== result.candidateId)) {
        return err(persistenceFailure("Candidate result conflicts must belong to the candidate"));
      }
    }
    for (const assessment of result.hardRequirementAssessments) {
      const row = context.value.nativeDatabase
        .prepare(
          "SELECT candidate_id AS candidateId FROM hard_requirement_assessment WHERE hard_requirement_assessment_id = ?"
        )
        .get(assessment.hardRequirementAssessmentId) as { candidateId: string } | undefined;
      if (row === undefined) {
        return err(
          persistenceFailure("Candidate result requires stored hard requirement assessments")
        );
      }
      if (row.candidateId !== result.candidateId) {
        return err(
          persistenceFailure("Candidate result requirement assessments must belong to the candidate")
        );
      }
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO candidate_triage_result (
          candidate_triage_result_id,
          candidate_id,
          kind,
          availability,
          status,
          supersedes_result_id,
          content_json,
          content_hash,
          seal_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        result.candidateTriageResultId,
        result.candidateId,
        result.kind,
        result.availability,
        result.status,
        result.supersedesResultId,
        result.contentJson,
        result.contentHash,
        result.sealId,
        result.createdAt
      );
    const insertSpan = context.value.nativeDatabase.prepare(
      `INSERT INTO candidate_result_evidence_span (
        candidate_result_evidence_span_id, candidate_result_id, evidence_span_id, span_ordinal, created_at
      ) VALUES (?, ?, ?, ?, ?)`
    );
    for (const span of result.evidenceSpans) {
      insertSpan.run(
        span.candidateResultEvidenceSpanId,
        result.candidateTriageResultId,
        span.evidenceSpanId,
        span.spanOrdinal,
        span.createdAt
      );
    }
    const insertGap = context.value.nativeDatabase.prepare(
      `INSERT INTO candidate_result_evidence_gap (
        candidate_result_evidence_gap_id, candidate_result_id, evidence_gap_id, dimension_id, gap_ordinal, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const gap of result.evidenceGaps) {
      insertGap.run(
        gap.candidateResultEvidenceGapId,
        result.candidateTriageResultId,
        gap.evidenceGapId,
        gap.dimensionId,
        gap.gapOrdinal,
        gap.createdAt
      );
    }
    const insertAssessment = context.value.nativeDatabase.prepare(
      `INSERT INTO candidate_result_dimension_assessment (
        candidate_result_dimension_assessment_id, candidate_result_id, dimension_assessment_id,
        dimension_id, assessment_ordinal, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const assessment of result.dimensionAssessments) {
      insertAssessment.run(
        assessment.candidateResultDimensionAssessmentId,
        result.candidateTriageResultId,
        assessment.dimensionAssessmentId,
        assessment.dimensionId,
        assessment.assessmentOrdinal,
        assessment.createdAt
      );
    }
    const insertFact = context.value.nativeDatabase.prepare(
      `INSERT INTO candidate_result_structured_fact (
        candidate_result_structured_fact_id, candidate_result_id, structured_fact_id, fact_ordinal, created_at
      ) VALUES (?, ?, ?, ?, ?)`
    );
    for (const fact of result.structuredFacts) {
      insertFact.run(
        fact.candidateResultStructuredFactId,
        result.candidateTriageResultId,
        fact.structuredFactId,
        fact.factOrdinal,
        fact.createdAt
      );
    }
    const insertConflict = context.value.nativeDatabase.prepare(
      `INSERT INTO candidate_result_fact_conflict (
        candidate_result_fact_conflict_id, candidate_result_id, fact_conflict_id, conflict_ordinal, created_at
      ) VALUES (?, ?, ?, ?, ?)`
    );
    for (const conflict of result.factConflicts) {
      insertConflict.run(
        conflict.candidateResultFactConflictId,
        result.candidateTriageResultId,
        conflict.factConflictId,
        conflict.conflictOrdinal,
        conflict.createdAt
      );
    }
    const insertRequirement = context.value.nativeDatabase.prepare(
      `INSERT INTO candidate_result_hard_requirement_assessment (
        candidate_result_hard_requirement_assessment_id, candidate_result_id,
        hard_requirement_assessment_id, requirement_ordinal, created_at
      ) VALUES (?, ?, ?, ?, ?)`
    );
    for (const assessment of result.hardRequirementAssessments) {
      insertRequirement.run(
        assessment.candidateResultHardRequirementAssessmentId,
        result.candidateTriageResultId,
        assessment.hardRequirementAssessmentId,
        assessment.requirementOrdinal,
        assessment.createdAt
      );
    }
    if (result.score !== null) {
      const score = result.score;
      context.value.nativeDatabase
        .prepare(
          `INSERT INTO score_result (
            score_result_id, candidate_result_id, aggregate_text, confidence_text,
            aggregate_basis_points, confidence_basis_points, content_json, content_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          score.scoreResultId,
          score.candidateResultId,
          score.aggregateText,
          score.confidenceText,
          score.aggregateBasisPoints,
          score.confidenceBasisPoints,
          score.contentJson,
          score.contentHash,
          score.createdAt
        );
    }
    return ok(result);
  } catch {
    return err(persistenceFailure("Candidate result insert failed"));
  }
}

function hydrateScore(row: {
  scoreResultId: string;
  candidateResultId: string;
  aggregateText: string;
  confidenceText: string;
  aggregateBasisPoints: number;
  confidenceBasisPoints: number;
  contentJson: string;
  contentHash: string;
  createdAt: number;
}): Result<ScoreResult, RuntimeError> {
  const decoded = decodeCanonicalJson(
    row.contentJson,
    row.contentHash,
    "Stored score result content is not valid JSON",
    "Stored score result failed integrity validation"
  );
  if (!decoded.ok) {
    return decoded;
  }
  const score = ScoreResultSchema.safeParse({
    ...row,
    content: decoded.value
  });
  if (!score.success) {
    return err(persistenceFailure("Stored score result is invalid"));
  }
  if (
    score.data.candidateResultId !== score.data.content.candidateTriageResultId ||
    score.data.aggregateText !== score.data.content.aggregate ||
    score.data.confidenceText !== score.data.content.confidence
  ) {
    return err(persistenceFailure("Stored score result failed integrity validation"));
  }
  return ok(Object.freeze(score.data));
}

function hydrateResult(row: {
  candidateTriageResultId: string;
  candidateId: string;
  kind: string;
  availability: string;
  status: string;
  supersedesResultId: string | null;
  contentJson: string;
  contentHash: string;
  sealId: string;
  createdAt: number;
  evidenceSpans: CandidateTriageResult["evidenceSpans"];
  evidenceGaps: CandidateTriageResult["evidenceGaps"];
  dimensionAssessments: CandidateTriageResult["dimensionAssessments"];
  structuredFacts: CandidateTriageResult["structuredFacts"];
  factConflicts: CandidateTriageResult["factConflicts"];
  hardRequirementAssessments: CandidateTriageResult["hardRequirementAssessments"];
  score: ScoreResult | null;
}): Result<CandidateTriageResult, RuntimeError> {
  const decoded = decodeCanonicalJson(
    row.contentJson,
    row.contentHash,
    "Stored candidate result content is not valid JSON",
    "Stored candidate result failed integrity validation"
  );
  if (!decoded.ok) {
    return decoded;
  }
  const content = CandidateTriageResultContentSchema.safeParse(decoded.value);
  if (!content.success) {
    return err(persistenceFailure("Stored candidate result is invalid"));
  }
  const result = CandidateTriageResultSchema.safeParse(row);
  if (!result.success) {
    return err(persistenceFailure("Stored candidate result is invalid"));
  }
  if (
    result.data.candidateId !== content.data.candidateId ||
    result.data.kind !== content.data.kind ||
    result.data.availability !== content.data.availability ||
    result.data.status !== content.data.status ||
    result.data.supersedesResultId !== content.data.supersedesResultId ||
    JSON.stringify(result.data.evidenceSpans.map((span) => span.evidenceSpanId)) !==
      JSON.stringify(content.data.evidenceSpanIds) ||
    JSON.stringify(result.data.evidenceGaps.map((gap) => gap.evidenceGapId)) !==
      JSON.stringify(content.data.evidenceGapIds) ||
    JSON.stringify(
      result.data.dimensionAssessments.map((assessment) => assessment.dimensionAssessmentId)
    ) !== JSON.stringify(content.data.dimensionAssessmentIds) ||
    JSON.stringify(result.data.structuredFacts.map((fact) => fact.structuredFactId)) !==
      JSON.stringify(content.data.structuredFactIds) ||
    JSON.stringify(result.data.factConflicts.map((conflict) => conflict.factConflictId)) !==
      JSON.stringify(content.data.factConflictIds) ||
    JSON.stringify(
      result.data.hardRequirementAssessments.map(
        (assessment) => assessment.hardRequirementAssessmentId
      )
    ) !== JSON.stringify(content.data.hardRequirementAssessmentIds)
  ) {
    return err(persistenceFailure("Stored candidate result failed integrity validation"));
  }
  if (
    (result.data.score === null) !== (result.data.availability === "unavailable") ||
    (result.data.score !== null &&
      result.data.score.candidateResultId !== result.data.candidateTriageResultId)
  ) {
    return err(persistenceFailure("Stored candidate result failed integrity validation"));
  }
  return ok(Object.freeze(result.data));
}

export function readCandidateTriageResult(
  contextInput: unknown,
  candidateTriageResultIdInput: unknown
): Result<CandidateTriageResult | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const resultId = CandidateTriageResultIdSchema.safeParse(candidateTriageResultIdInput);
    if (!resultId.success) {
      return err(persistenceFailure("Invalid candidate result ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          candidate_triage_result_id AS candidateTriageResultId,
          candidate_id AS candidateId,
          kind,
          availability,
          status,
          supersedes_result_id AS supersedesResultId,
          content_json AS contentJson,
          content_hash AS contentHash,
          seal_id AS sealId,
          created_at AS createdAt
        FROM candidate_triage_result
        WHERE candidate_triage_result_id = ?`
      )
      .get(resultId.data) as
      | {
          candidateTriageResultId: string;
          candidateId: string;
          kind: string;
          availability: string;
          status: string;
          supersedesResultId: string | null;
          contentJson: string;
          contentHash: string;
          sealId: string;
          createdAt: number;
        }
      | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    const evidenceSpans = context.value.nativeDatabase
      .prepare(
        `SELECT
          candidate_result_evidence_span_id AS candidateResultEvidenceSpanId,
          evidence_span_id AS evidenceSpanId,
          span_ordinal AS spanOrdinal,
          created_at AS createdAt
        FROM candidate_result_evidence_span
        WHERE candidate_result_id = ?
        ORDER BY span_ordinal`
      )
      .all(resultId.data) as CandidateTriageResult["evidenceSpans"];
    const evidenceGaps = context.value.nativeDatabase
      .prepare(
        `SELECT
          candidate_result_evidence_gap_id AS candidateResultEvidenceGapId,
          evidence_gap_id AS evidenceGapId,
          dimension_id AS dimensionId,
          gap_ordinal AS gapOrdinal,
          created_at AS createdAt
        FROM candidate_result_evidence_gap
        WHERE candidate_result_id = ?
        ORDER BY gap_ordinal`
      )
      .all(resultId.data) as CandidateTriageResult["evidenceGaps"];
    const dimensionAssessments = context.value.nativeDatabase
      .prepare(
        `SELECT
          candidate_result_dimension_assessment_id AS candidateResultDimensionAssessmentId,
          dimension_assessment_id AS dimensionAssessmentId,
          dimension_id AS dimensionId,
          assessment_ordinal AS assessmentOrdinal,
          created_at AS createdAt
        FROM candidate_result_dimension_assessment
        WHERE candidate_result_id = ?
        ORDER BY assessment_ordinal`
      )
      .all(resultId.data) as CandidateTriageResult["dimensionAssessments"];
    const structuredFacts = context.value.nativeDatabase
      .prepare(
        `SELECT
          candidate_result_structured_fact_id AS candidateResultStructuredFactId,
          structured_fact_id AS structuredFactId,
          fact_ordinal AS factOrdinal,
          created_at AS createdAt
        FROM candidate_result_structured_fact
        WHERE candidate_result_id = ?
        ORDER BY fact_ordinal`
      )
      .all(resultId.data) as CandidateTriageResult["structuredFacts"];
    const factConflicts = context.value.nativeDatabase
      .prepare(
        `SELECT
          candidate_result_fact_conflict_id AS candidateResultFactConflictId,
          fact_conflict_id AS factConflictId,
          conflict_ordinal AS conflictOrdinal,
          created_at AS createdAt
        FROM candidate_result_fact_conflict
        WHERE candidate_result_id = ?
        ORDER BY conflict_ordinal`
      )
      .all(resultId.data) as CandidateTriageResult["factConflicts"];
    const hardRequirementAssessments = context.value.nativeDatabase
      .prepare(
        `SELECT
          candidate_result_hard_requirement_assessment_id AS candidateResultHardRequirementAssessmentId,
          hard_requirement_assessment_id AS hardRequirementAssessmentId,
          requirement_ordinal AS requirementOrdinal,
          created_at AS createdAt
        FROM candidate_result_hard_requirement_assessment
        WHERE candidate_result_id = ?
        ORDER BY requirement_ordinal`
      )
      .all(resultId.data) as CandidateTriageResult["hardRequirementAssessments"];
    const scoreRow = context.value.nativeDatabase
      .prepare(
        `SELECT
          score_result_id AS scoreResultId,
          candidate_result_id AS candidateResultId,
          aggregate_text AS aggregateText,
          confidence_text AS confidenceText,
          aggregate_basis_points AS aggregateBasisPoints,
          confidence_basis_points AS confidenceBasisPoints,
          content_json AS contentJson,
          content_hash AS contentHash,
          created_at AS createdAt
        FROM score_result
        WHERE candidate_result_id = ?`
      )
      .get(resultId.data) as Parameters<typeof hydrateScore>[0] | undefined;
    let score: ScoreResult | null = null;
    if (scoreRow !== undefined) {
      const hydratedScore = hydrateScore(scoreRow);
      if (!hydratedScore.ok) {
        return hydratedScore;
      }
      score = hydratedScore.value;
    }
    return hydrateResult({
      ...row,
      evidenceSpans,
      evidenceGaps,
      dimensionAssessments,
      structuredFacts,
      factConflicts,
      hardRequirementAssessments,
      score
    });
  } catch {
    return err(persistenceFailure("Candidate result read failed"));
  }
}

export function readCandidateTriageResultByContentHash(
  contextInput: unknown,
  contentHashInput: unknown
): Result<CandidateTriageResult | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const contentHash = Sha256HexSchema.safeParse(contentHashInput);
    if (!contentHash.success) {
      return err(persistenceFailure("Invalid candidate result content hash"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        "SELECT candidate_triage_result_id AS candidateTriageResultId FROM candidate_triage_result WHERE content_hash = ?"
      )
      .get(contentHash.data) as { candidateTriageResultId: string } | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    return readCandidateTriageResult(context.value, row.candidateTriageResultId);
  } catch {
    return err(persistenceFailure("Candidate result read failed"));
  }
}
