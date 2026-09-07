import {
  CandidateIdSchema,
  FactConflictIdSchema,
  HardRequirementAssessmentIdSchema,
  Sha256HexSchema,
  StructuredFactIdSchema,
  StructuredFactPayloadSchema,
  canonicalJsonStringify,
  err,
  ok,
  sha256Hex,
  structuredFactSemanticKey,
  type Result,
  type StructuredFactPayload
} from "@recruitos/core";

import type { ImmediateTransactionContext } from "../commands/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  FactConflictContentSchema,
  FactConflictDraftSchema,
  FactConflictSchema,
  HardRequirementAssessmentContentSchema,
  HardRequirementAssessmentDraftSchema,
  HardRequirementAssessmentSchema,
  StructuredFactContentSchema,
  StructuredFactDraftSchema,
  StructuredFactSchema,
  type FactConflict,
  type FactConflictContent,
  type HardRequirementAssessment,
  type HardRequirementAssessmentContent,
  type StructuredFact,
  type StructuredFactContent
} from "./schemas.js";

const preparedStructuredFacts = new WeakSet<object>();
const preparedFactConflicts = new WeakSet<object>();
const preparedHardRequirementAssessments = new WeakSet<object>();

const TRANSACTION_REQUIRED = "Structured fact rows require an active command transaction";

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

function orderedPayload(payload: StructuredFactPayload): StructuredFactPayload {
  switch (payload.kind) {
    case "claimed_experience":
      return {
        claimedMonths: payload.claimedMonths,
        kind: payload.kind
      };
    case "current_title":
      return {
        kind: payload.kind,
        title: payload.title
      };
    case "employer_history_entry":
      return {
        employer: payload.employer,
        endMonth: payload.endMonth,
        kind: payload.kind,
        startMonth: payload.startMonth
      };
    case "employment_interval":
      return {
        employer: payload.employer,
        endMonth: payload.endMonth,
        kind: payload.kind,
        startMonth: payload.startMonth,
        title: payload.title
      };
    case "work_authorization_statement":
      return {
        classification: payload.classification,
        kind: payload.kind,
        statementText: payload.statementText
      };
  }
}

function orderedFactContent(content: StructuredFactContent): StructuredFactContent {
  return {
    candidateId: content.candidateId,
    payload: orderedPayload(content.payload),
    semanticKey: content.semanticKey
  };
}

function orderedConflictContent(content: FactConflictContent): FactConflictContent {
  return {
    memberIds: [...content.memberIds].sort(compareIds)
  };
}

function orderedAssessmentContent(
  content: HardRequirementAssessmentContent
): HardRequirementAssessmentContent {
  return {
    candidateId: content.candidateId,
    facts: [...content.facts]
      .map((fact) => ({
        polarity: fact.polarity,
        structuredFactId: fact.structuredFactId
      }))
      .sort((left, right) => compareIds(left.structuredFactId, right.structuredFactId)),
    outcome: content.outcome,
    requirementFieldId: content.requirementFieldId
  };
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
  return (
    context.nativeDatabase.prepare(sql).get(id) !== undefined
  );
}

export function validateStructuredFactContent(
  contentInput: unknown
): Result<StructuredFactContent, RuntimeError> {
  const content = StructuredFactContentSchema.safeParse(contentInput);
  if (!content.success) {
    return err(persistenceFailure("Invalid structured fact content"));
  }
  if (content.data.semanticKey !== structuredFactSemanticKey(content.data.payload)) {
    return err(persistenceFailure("Structured fact semantic key does not match payload"));
  }
  return ok(orderedFactContent(content.data));
}

function canonicalizeStructuredFactContent(
  candidateId: string,
  payloadInput: unknown
): Result<{ content: StructuredFactContent; json: string; hash: string }, RuntimeError> {
  const payload = StructuredFactPayloadSchema.safeParse(payloadInput);
  if (!payload.success) {
    return err(persistenceFailure("Invalid structured fact content"));
  }
  const ordered = orderedFactContent({
    candidateId,
    payload: payload.data,
    semanticKey: structuredFactSemanticKey(payload.data)
  });
  const hashed = hashOrdered(ordered);
  return ok({ content: ordered, json: hashed.json, hash: hashed.hash });
}

export function hashStructuredFactContent(
  candidateIdInput: unknown,
  payloadInput: unknown
): Result<string, RuntimeError> {
  const candidateId = CandidateIdSchema.safeParse(candidateIdInput);
  if (!candidateId.success) {
    return err(persistenceFailure("Invalid structured fact content"));
  }
  const canonicalized = canonicalizeStructuredFactContent(candidateId.data, payloadInput);
  if (!canonicalized.ok) {
    return canonicalized;
  }
  return ok(canonicalized.value.hash);
}

export function prepareStructuredFact(
  draftInput: unknown
): Result<StructuredFact, RuntimeError> {
  try {
    const draft = StructuredFactDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid structured fact input"));
    }
    const spanIds = draft.data.evidenceSpans.map((span) => span.evidenceSpanId);
    const spanRecordIds = draft.data.evidenceSpans.map(
      (span) => span.structuredFactEvidenceSpanId
    );
    const provenanceIds = draft.data.provenances.map(
      (provenance) => provenance.structuredFactProvenanceId
    );
    const uniqueSpans = uniqueIds(spanIds, "Structured fact evidence spans must be unique");
    if (!uniqueSpans.ok) {
      return uniqueSpans;
    }
    const uniqueSpanRecords = uniqueIds(
      spanRecordIds,
      "Structured fact evidence span IDs must be unique"
    );
    if (!uniqueSpanRecords.ok) {
      return uniqueSpanRecords;
    }
    const uniqueProvenances = uniqueIds(
      provenanceIds,
      "Structured fact provenance IDs must be unique"
    );
    if (!uniqueProvenances.ok) {
      return uniqueProvenances;
    }
    for (const provenance of draft.data.provenances) {
      if ((provenance.source === "human") !== (provenance.actorId !== null)) {
        return err(
          persistenceFailure(
            "Structured fact provenance actor is required for human source and forbidden otherwise"
          )
        );
      }
    }

    const canonicalized = canonicalizeStructuredFactContent(
      draft.data.candidateId,
      draft.data.payload
    );
    if (!canonicalized.ok) {
      return canonicalized;
    }

    const fact = StructuredFactSchema.parse({
      structuredFactId: draft.data.structuredFactId,
      candidateId: draft.data.candidateId,
      kind: canonicalized.value.content.payload.kind,
      semanticKey: canonicalized.value.content.semanticKey,
      payload: canonicalized.value.content.payload,
      contentJson: canonicalized.value.json,
      contentHash: canonicalized.value.hash,
      evidenceSpans: draft.data.evidenceSpans.map((span, index) => ({
        structuredFactEvidenceSpanId: span.structuredFactEvidenceSpanId,
        evidenceSpanId: span.evidenceSpanId,
        spanOrdinal: index,
        createdAt: draft.data.createdAt
      })),
      provenances: draft.data.provenances.map((provenance) => ({
        structuredFactProvenanceId: provenance.structuredFactProvenanceId,
        source: provenance.source,
        actorId: provenance.actorId,
        createdAt: draft.data.createdAt
      })),
      createdAt: draft.data.createdAt
    });
    return ok(register(preparedStructuredFacts, fact));
  } catch {
    return err(persistenceFailure("Structured fact preparation failed"));
  }
}

export function insertStructuredFact(
  contextInput: unknown,
  preparedInput: unknown
): Result<StructuredFact, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<StructuredFact>(
      preparedStructuredFacts,
      preparedInput,
      "Invalid prepared structured fact"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const fact = prepared.value;
    if (
      !rowExists(
        context.value,
        "SELECT 1 AS present FROM candidate WHERE candidate_id = ?",
        fact.candidateId
      )
    ) {
      return err(persistenceFailure("Structured fact requires a stored candidate"));
    }
    for (const span of fact.evidenceSpans) {
      if (
        !rowExists(
          context.value,
          "SELECT 1 AS present FROM evidence_span WHERE evidence_span_id = ?",
          span.evidenceSpanId
        )
      ) {
        return err(persistenceFailure("Structured fact requires stored evidence spans"));
      }
    }
    for (const provenance of fact.provenances) {
      if (
        provenance.actorId !== null &&
        !rowExists(
          context.value,
          "SELECT 1 AS present FROM actor WHERE actor_id = ?",
          provenance.actorId
        )
      ) {
        return err(persistenceFailure("Structured fact human provenance requires a stored actor"));
      }
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO structured_fact (
          structured_fact_id,
          candidate_id,
          kind,
          semantic_key,
          payload_json,
          content_json,
          content_hash,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        fact.structuredFactId,
        fact.candidateId,
        fact.kind,
        fact.semanticKey,
        JSON.stringify(fact.payload),
        fact.contentJson,
        fact.contentHash,
        fact.createdAt
      );
    const insertSpan = context.value.nativeDatabase.prepare(
      `INSERT INTO structured_fact_evidence_span (
        structured_fact_evidence_span_id,
        structured_fact_id,
        evidence_span_id,
        span_ordinal,
        created_at
      ) VALUES (?, ?, ?, ?, ?)`
    );
    for (const span of fact.evidenceSpans) {
      insertSpan.run(
        span.structuredFactEvidenceSpanId,
        fact.structuredFactId,
        span.evidenceSpanId,
        span.spanOrdinal,
        span.createdAt
      );
    }
    const insertProvenance = context.value.nativeDatabase.prepare(
      `INSERT INTO structured_fact_provenance (
        structured_fact_provenance_id,
        structured_fact_id,
        source,
        actor_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?)`
    );
    for (const provenance of fact.provenances) {
      insertProvenance.run(
        provenance.structuredFactProvenanceId,
        fact.structuredFactId,
        provenance.source,
        provenance.actorId,
        provenance.createdAt
      );
    }
    return ok(fact);
  } catch {
    return err(persistenceFailure("Structured fact insert failed"));
  }
}

export function hashFactConflictContent(
  memberIdsInput: unknown
): Result<string, RuntimeError> {
  const content = FactConflictContentSchema.safeParse({ memberIds: memberIdsInput });
  if (!content.success) {
    return err(persistenceFailure("Invalid fact conflict content"));
  }
  return ok(hashOrdered(orderedConflictContent(content.data)).hash);
}

export function prepareFactConflict(
  draftInput: unknown
): Result<FactConflict, RuntimeError> {
  try {
    const draft = FactConflictDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid fact conflict input"));
    }
    const memberFactIds = draft.data.members.map((member) => member.structuredFactId);
    const memberRecordIds = draft.data.members.map((member) => member.factConflictMemberId);
    const uniqueFacts = uniqueIds(memberFactIds, "Fact conflict members must be unique");
    if (!uniqueFacts.ok) {
      return uniqueFacts;
    }
    const uniqueRecords = uniqueIds(
      memberRecordIds,
      "Fact conflict member IDs must be unique"
    );
    if (!uniqueRecords.ok) {
      return uniqueRecords;
    }
    const orderedIds = [...memberFactIds].sort(compareIds);
    const hashed = hashOrdered({ memberIds: orderedIds });
    const membersByFactId = new Map(
      draft.data.members.map((member) => [member.structuredFactId, member])
    );
    const conflict = FactConflictSchema.parse({
      factConflictId: draft.data.factConflictId,
      content: { memberIds: orderedIds },
      contentJson: hashed.json,
      contentHash: hashed.hash,
      members: orderedIds.map((structuredFactId, index) => ({
        factConflictMemberId: membersByFactId.get(structuredFactId)!.factConflictMemberId,
        structuredFactId,
        memberOrdinal: index,
        createdAt: draft.data.createdAt
      })),
      createdAt: draft.data.createdAt
    });
    return ok(register(preparedFactConflicts, conflict));
  } catch {
    return err(persistenceFailure("Fact conflict preparation failed"));
  }
}

export function insertFactConflict(
  contextInput: unknown,
  preparedInput: unknown
): Result<FactConflict, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<FactConflict>(
      preparedFactConflicts,
      preparedInput,
      "Invalid prepared fact conflict"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const conflict = prepared.value;
    const candidateIds = new Set<string>();
    for (const member of conflict.members) {
      const row = context.value.nativeDatabase
        .prepare("SELECT candidate_id AS candidateId FROM structured_fact WHERE structured_fact_id = ?")
        .get(member.structuredFactId) as { candidateId: string } | undefined;
      if (row === undefined) {
        return err(persistenceFailure("Fact conflict requires stored member facts"));
      }
      candidateIds.add(row.candidateId);
    }
    if (candidateIds.size !== 1) {
      return err(persistenceFailure("Fact conflict members must belong to one candidate"));
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO fact_conflict (
          fact_conflict_id,
          content_json,
          content_hash,
          created_at
        ) VALUES (?, ?, ?, ?)`
      )
      .run(
        conflict.factConflictId,
        conflict.contentJson,
        conflict.contentHash,
        conflict.createdAt
      );
    const insertMember = context.value.nativeDatabase.prepare(
      `INSERT INTO fact_conflict_member (
        fact_conflict_member_id,
        fact_conflict_id,
        structured_fact_id,
        member_ordinal,
        created_at
      ) VALUES (?, ?, ?, ?, ?)`
    );
    for (const member of conflict.members) {
      insertMember.run(
        member.factConflictMemberId,
        conflict.factConflictId,
        member.structuredFactId,
        member.memberOrdinal,
        member.createdAt
      );
    }
    return ok(conflict);
  } catch {
    return err(persistenceFailure("Fact conflict insert failed"));
  }
}

export function hashHardRequirementAssessmentContent(
  contentInput: unknown
): Result<string, RuntimeError> {
  const content = HardRequirementAssessmentContentSchema.safeParse(contentInput);
  if (!content.success) {
    return err(persistenceFailure("Invalid hard requirement assessment content"));
  }
  return ok(hashOrdered(orderedAssessmentContent(content.data)).hash);
}

export function prepareHardRequirementAssessment(
  draftInput: unknown
): Result<HardRequirementAssessment, RuntimeError> {
  try {
    const draft = HardRequirementAssessmentDraftSchema.safeParse(draftInput);
    if (!draft.success) {
      return err(persistenceFailure("Invalid hard requirement assessment input"));
    }
    const factIds = draft.data.facts.map((fact) => fact.structuredFactId);
    const recordIds = draft.data.facts.map((fact) => fact.hardRequirementAssessmentFactId);
    const uniqueFacts = uniqueIds(
      factIds,
      "Hard requirement assessment facts must be unique"
    );
    if (!uniqueFacts.ok) {
      return uniqueFacts;
    }
    const uniqueRecords = uniqueIds(
      recordIds,
      "Hard requirement assessment fact IDs must be unique"
    );
    if (!uniqueRecords.ok) {
      return uniqueRecords;
    }
    const supporting = draft.data.facts.filter((fact) => fact.polarity === "supporting").length;
    const contradicting = draft.data.facts.filter(
      (fact) => fact.polarity === "contradicting"
    ).length;
    if (draft.data.outcome === "pass" && (supporting < 1 || contradicting > 0)) {
      return err(
        persistenceFailure("Pass assessments require supporting facts and no contradicting facts")
      );
    }
    if (draft.data.outcome === "fail" && (contradicting < 1 || supporting > 0)) {
      return err(
        persistenceFailure("Fail assessments require contradicting facts and no supporting facts")
      );
    }

    const orderedFacts = [...draft.data.facts].sort((left, right) =>
      compareIds(left.structuredFactId, right.structuredFactId)
    );
    const content = orderedAssessmentContent({
      candidateId: draft.data.candidateId,
      facts: orderedFacts.map((fact) => ({
        polarity: fact.polarity,
        structuredFactId: fact.structuredFactId
      })),
      outcome: draft.data.outcome,
      requirementFieldId: draft.data.requirementFieldId
    });
    const hashed = hashOrdered(content);
    const assessment = HardRequirementAssessmentSchema.parse({
      hardRequirementAssessmentId: draft.data.hardRequirementAssessmentId,
      candidateId: draft.data.candidateId,
      requirementFieldId: draft.data.requirementFieldId,
      outcome: draft.data.outcome,
      content,
      contentJson: hashed.json,
      contentHash: hashed.hash,
      facts: orderedFacts.map((fact, index) => ({
        hardRequirementAssessmentFactId: fact.hardRequirementAssessmentFactId,
        structuredFactId: fact.structuredFactId,
        polarity: fact.polarity,
        factOrdinal: index,
        createdAt: draft.data.createdAt
      })),
      createdAt: draft.data.createdAt
    });
    return ok(register(preparedHardRequirementAssessments, assessment));
  } catch {
    return err(persistenceFailure("Hard requirement assessment preparation failed"));
  }
}

export function insertHardRequirementAssessment(
  contextInput: unknown,
  preparedInput: unknown
): Result<HardRequirementAssessment, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const prepared = requirePrepared<HardRequirementAssessment>(
      preparedHardRequirementAssessments,
      preparedInput,
      "Invalid prepared hard requirement assessment"
    );
    if (!prepared.ok) {
      return prepared;
    }
    const assessment = prepared.value;
    if (
      !rowExists(
        context.value,
        "SELECT 1 AS present FROM candidate WHERE candidate_id = ?",
        assessment.candidateId
      )
    ) {
      return err(persistenceFailure("Hard requirement assessment requires a stored candidate"));
    }
    for (const fact of assessment.facts) {
      const row = context.value.nativeDatabase
        .prepare("SELECT candidate_id AS candidateId FROM structured_fact WHERE structured_fact_id = ?")
        .get(fact.structuredFactId) as { candidateId: string } | undefined;
      if (row === undefined) {
        return err(persistenceFailure("Hard requirement assessment requires stored facts"));
      }
      if (row.candidateId !== assessment.candidateId) {
        return err(
          persistenceFailure("Hard requirement assessment facts must belong to the candidate")
        );
      }
    }

    context.value.nativeDatabase
      .prepare(
        `INSERT INTO hard_requirement_assessment (
          hard_requirement_assessment_id,
          candidate_id,
          requirement_field_id,
          outcome,
          content_json,
          content_hash,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        assessment.hardRequirementAssessmentId,
        assessment.candidateId,
        assessment.requirementFieldId,
        assessment.outcome,
        assessment.contentJson,
        assessment.contentHash,
        assessment.createdAt
      );
    const insertFact = context.value.nativeDatabase.prepare(
      `INSERT INTO hard_requirement_assessment_fact (
        hard_requirement_assessment_fact_id,
        hard_requirement_assessment_id,
        structured_fact_id,
        polarity,
        fact_ordinal,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const fact of assessment.facts) {
      insertFact.run(
        fact.hardRequirementAssessmentFactId,
        assessment.hardRequirementAssessmentId,
        fact.structuredFactId,
        fact.polarity,
        fact.factOrdinal,
        fact.createdAt
      );
    }
    return ok(assessment);
  } catch {
    return err(persistenceFailure("Hard requirement assessment insert failed"));
  }
}

function hydrateStructuredFact(row: {
  structuredFactId: string;
  candidateId: string;
  kind: string;
  semanticKey: string;
  payloadJson: string;
  contentJson: string;
  contentHash: string;
  createdAt: number;
  evidenceSpans: StructuredFact["evidenceSpans"];
  provenances: StructuredFact["provenances"];
}): Result<StructuredFact, RuntimeError> {
  const decoded = decodeCanonicalJson(
    row.contentJson,
    row.contentHash,
    "Stored structured fact content is not valid JSON",
    "Stored structured fact failed integrity validation"
  );
  if (!decoded.ok) {
    return decoded;
  }
  const content = StructuredFactContentSchema.safeParse(decoded.value);
  if (!content.success) {
    return err(persistenceFailure("Stored structured fact is invalid"));
  }
  let payload: unknown;
  try {
    payload = JSON.parse(row.payloadJson);
  } catch {
    return err(persistenceFailure("Stored structured fact payload is not valid JSON"));
  }
  const fact = StructuredFactSchema.safeParse({
    structuredFactId: row.structuredFactId,
    candidateId: row.candidateId,
    kind: row.kind,
    semanticKey: row.semanticKey,
    payload,
    contentJson: row.contentJson,
    contentHash: row.contentHash,
    evidenceSpans: row.evidenceSpans,
    provenances: row.provenances,
    createdAt: row.createdAt
  });
  if (!fact.success) {
    return err(persistenceFailure("Stored structured fact is invalid"));
  }
  if (
    fact.data.candidateId !== content.data.candidateId ||
    fact.data.semanticKey !== content.data.semanticKey ||
    fact.data.kind !== content.data.payload.kind ||
    JSON.stringify(orderedPayload(fact.data.payload)) !==
      JSON.stringify(orderedPayload(content.data.payload))
  ) {
    return err(persistenceFailure("Stored structured fact failed integrity validation"));
  }
  return ok(Object.freeze(fact.data));
}

export function readStructuredFact(
  contextInput: unknown,
  structuredFactIdInput: unknown
): Result<StructuredFact | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const structuredFactId = StructuredFactIdSchema.safeParse(structuredFactIdInput);
    if (!structuredFactId.success) {
      return err(persistenceFailure("Invalid structured fact ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          structured_fact_id AS structuredFactId,
          candidate_id AS candidateId,
          kind,
          semantic_key AS semanticKey,
          payload_json AS payloadJson,
          content_json AS contentJson,
          content_hash AS contentHash,
          created_at AS createdAt
        FROM structured_fact
        WHERE structured_fact_id = ?`
      )
      .get(structuredFactId.data) as
      | {
          structuredFactId: string;
          candidateId: string;
          kind: string;
          semanticKey: string;
          payloadJson: string;
          contentJson: string;
          contentHash: string;
          createdAt: number;
        }
      | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    const evidenceSpans = context.value.nativeDatabase
      .prepare(
        `SELECT
          structured_fact_evidence_span_id AS structuredFactEvidenceSpanId,
          evidence_span_id AS evidenceSpanId,
          span_ordinal AS spanOrdinal,
          created_at AS createdAt
        FROM structured_fact_evidence_span
        WHERE structured_fact_id = ?
        ORDER BY span_ordinal`
      )
      .all(structuredFactId.data) as StructuredFact["evidenceSpans"];
    const provenances = context.value.nativeDatabase
      .prepare(
        `SELECT
          structured_fact_provenance_id AS structuredFactProvenanceId,
          source,
          actor_id AS actorId,
          created_at AS createdAt
        FROM structured_fact_provenance
        WHERE structured_fact_id = ?`
      )
      .all(structuredFactId.data) as StructuredFact["provenances"];
    return hydrateStructuredFact({ ...row, evidenceSpans, provenances });
  } catch {
    return err(persistenceFailure("Structured fact read failed"));
  }
}

export function readStructuredFactByContentHash(
  contextInput: unknown,
  contentHashInput: unknown
): Result<StructuredFact | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const contentHash = Sha256HexSchema.safeParse(contentHashInput);
    if (!contentHash.success) {
      return err(persistenceFailure("Invalid structured fact content hash"));
    }
    const row = context.value.nativeDatabase
      .prepare("SELECT structured_fact_id AS structuredFactId FROM structured_fact WHERE content_hash = ?")
      .get(contentHash.data) as { structuredFactId: string } | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    return readStructuredFact(context.value, row.structuredFactId);
  } catch {
    return err(persistenceFailure("Structured fact read failed"));
  }
}

export function readFactConflict(
  contextInput: unknown,
  factConflictIdInput: unknown
): Result<FactConflict | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const factConflictId = FactConflictIdSchema.safeParse(factConflictIdInput);
    if (!factConflictId.success) {
      return err(persistenceFailure("Invalid fact conflict ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          fact_conflict_id AS factConflictId,
          content_json AS contentJson,
          content_hash AS contentHash,
          created_at AS createdAt
        FROM fact_conflict
        WHERE fact_conflict_id = ?`
      )
      .get(factConflictId.data) as
      | {
          factConflictId: string;
          contentJson: string;
          contentHash: string;
          createdAt: number;
        }
      | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    const decoded = decodeCanonicalJson(
      row.contentJson,
      row.contentHash,
      "Stored fact conflict content is not valid JSON",
      "Stored fact conflict failed integrity validation"
    );
    if (!decoded.ok) {
      return decoded;
    }
    const members = context.value.nativeDatabase
      .prepare(
        `SELECT
          fact_conflict_member_id AS factConflictMemberId,
          structured_fact_id AS structuredFactId,
          member_ordinal AS memberOrdinal,
          created_at AS createdAt
        FROM fact_conflict_member
        WHERE fact_conflict_id = ?
        ORDER BY member_ordinal`
      )
      .all(factConflictId.data) as FactConflict["members"];
    const conflict = FactConflictSchema.safeParse({
      ...row,
      content: decoded.value,
      members
    });
    if (!conflict.success) {
      return err(persistenceFailure("Stored fact conflict is invalid"));
    }
    if (
      JSON.stringify(conflict.data.content.memberIds) !==
      JSON.stringify(conflict.data.members.map((member) => member.structuredFactId))
    ) {
      return err(persistenceFailure("Stored fact conflict failed integrity validation"));
    }
    return ok(Object.freeze(conflict.data));
  } catch {
    return err(persistenceFailure("Fact conflict read failed"));
  }
}

export function readHardRequirementAssessment(
  contextInput: unknown,
  hardRequirementAssessmentIdInput: unknown
): Result<HardRequirementAssessment | undefined, RuntimeError> {
  try {
    const context = validateContext(contextInput);
    if (!context.ok) {
      return context;
    }
    const assessmentId = HardRequirementAssessmentIdSchema.safeParse(
      hardRequirementAssessmentIdInput
    );
    if (!assessmentId.success) {
      return err(persistenceFailure("Invalid hard requirement assessment ID"));
    }
    const row = context.value.nativeDatabase
      .prepare(
        `SELECT
          hard_requirement_assessment_id AS hardRequirementAssessmentId,
          candidate_id AS candidateId,
          requirement_field_id AS requirementFieldId,
          outcome,
          content_json AS contentJson,
          content_hash AS contentHash,
          created_at AS createdAt
        FROM hard_requirement_assessment
        WHERE hard_requirement_assessment_id = ?`
      )
      .get(assessmentId.data) as
      | {
          hardRequirementAssessmentId: string;
          candidateId: string;
          requirementFieldId: string;
          outcome: string;
          contentJson: string;
          contentHash: string;
          createdAt: number;
        }
      | undefined;
    if (row === undefined) {
      return ok(undefined);
    }
    const decoded = decodeCanonicalJson(
      row.contentJson,
      row.contentHash,
      "Stored hard requirement assessment content is not valid JSON",
      "Stored hard requirement assessment failed integrity validation"
    );
    if (!decoded.ok) {
      return decoded;
    }
    const facts = context.value.nativeDatabase
      .prepare(
        `SELECT
          hard_requirement_assessment_fact_id AS hardRequirementAssessmentFactId,
          structured_fact_id AS structuredFactId,
          polarity,
          fact_ordinal AS factOrdinal,
          created_at AS createdAt
        FROM hard_requirement_assessment_fact
        WHERE hard_requirement_assessment_id = ?
        ORDER BY fact_ordinal`
      )
      .all(assessmentId.data) as HardRequirementAssessment["facts"];
    const assessment = HardRequirementAssessmentSchema.safeParse({
      ...row,
      content: decoded.value,
      facts
    });
    if (!assessment.success) {
      return err(persistenceFailure("Stored hard requirement assessment is invalid"));
    }
    if (
      assessment.data.candidateId !== assessment.data.content.candidateId ||
      assessment.data.outcome !== assessment.data.content.outcome ||
      assessment.data.requirementFieldId !== assessment.data.content.requirementFieldId ||
      JSON.stringify(
        assessment.data.facts.map((fact) => ({
          polarity: fact.polarity,
          structuredFactId: fact.structuredFactId
        }))
      ) !== JSON.stringify(assessment.data.content.facts)
    ) {
      return err(
        persistenceFailure("Stored hard requirement assessment failed integrity validation")
      );
    }
    return ok(Object.freeze(assessment.data));
  } catch {
    return err(persistenceFailure("Hard requirement assessment read failed"));
  }
}
