import {
  EXTRACTION_LIMITS,
  RUBRIC_V1,
  SCORING_POLICY_V1,
  err,
  ok,
  sha256Hex,
  type LockedRubric,
  type Result
} from "@recruitos/core";
import { z } from "zod";

import {
  insertAttemptWorkItem,
  insertTriageAttempt,
  prepareAttemptWorkItem,
  prepareTriageAttempt,
  type TriageAttemptKind
} from "../attempts/index.js";
import {
  MAIN_DEMO_CORPUS_MEMBER_COUNT,
  hashCorpusManifestContent,
  insertCorpusManifest,
  insertCorpusManifestSeal,
  insertCorpusMember,
  insertCorpusMemberDocument,
  prepareCorpusManifest,
  prepareCorpusManifestSeal,
  prepareCorpusMember,
  prepareCorpusMemberDocument,
  type CorpusManifestKind
} from "../corpus/index.js";
import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import {
  hashExtractionSpecContent,
  insertExtractionSpec,
  prepareExtractionSpec,
  type ExtractionSpecContent
} from "../extraction/index.js";
import {
  hashRunInputSnapshotContent,
  insertRunInputSnapshot,
  prepareRunInputSnapshot
} from "../snapshots/index.js";
import {
  runUseCaseCommand,
  type UseCaseComposition,
  type UseCaseResult
} from "./contract.js";

/**
 * Starts a new triage attempt for a set of candidates against a role and rubric.
 *
 * In a single atomic command transaction (`expectedVersion: 0`):
 * 1. Validates the role, candidate entities, and candidate documents.
 * 2. Resolves or prepares and seals the corpus manifest (reusing by content hash if identical).
 * 3. Resolves or prepares and stores the run input snapshot (reusing by content hash if identical).
 * 4. Resolves or prepares and stores extraction specs for all rubric dimensions (reusing by content hash).
 * 5. Asserts no official attempt already exists for this (kind, snapshot, manifest) combination.
 * 6. Creates the triage attempt in "in_progress" state.
 * 7. Creates attempt work items in deterministic manifest order across all candidate documents and dimensions.
 * 8. Returns { triageRunId, triageAttemptId, workItemCount } in the command receipt.
 */

export const START_TRIAGE_RUN_COMMAND_NAME = "triage_run.start";

export const StartTriageRunPayloadSchema = z
  .object({
    roleId: z.string().min(1),
    candidateIds: z.array(z.string().min(1)).optional(),
    corpusManifestId: z.string().min(1).optional(),
    kind: z.enum(["main_run", "variant_run"]).optional()
  })
  .strict();

export const StartTriageRunResultSchema = z
  .object({
    triageRunId: z.string().min(1),
    triageAttemptId: z.string().min(1),
    workItemCount: z.number().int().nonnegative()
  })
  .strict();

export type StartTriageRunPayload = z.infer<typeof StartTriageRunPayloadSchema>;
export type StartTriageRunResult = z.infer<typeof StartTriageRunResultSchema>;

export type StartTriageRunInput = Readonly<{
  actorId: string;
  roleId: string;
  candidateIds?: readonly string[];
  corpusManifestId?: string;
  kind?: "main_run" | "variant_run";
  rubric?: LockedRubric;
  frozenDate?: string;
  modelId?: string;
  extractorVersion?: string;
  promptTemplateVersion?: string;
}>;

const MAXIMUM_ATTEMPT_CANDIDATE_LIMIT = 200;

function startFailure(message: string): RuntimeError {
  return createRuntimeError("persistence_failed", message, false);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type CandidateDocumentRef = Readonly<{
  candidateDocumentId: string;
  documentOrdinal: number;
}>;

export function startTriageRun(
  composition: UseCaseComposition,
  input: StartTriageRunInput
): UseCaseResult<StartTriageRunResult> {
  if (!isObject(composition)) {
    return err(startFailure("Invalid runtime composition"));
  }
  if (!isObject(composition.connection)) {
    return err(startFailure("Invalid runtime composition"));
  }
  if (!isObject(composition.clock) || typeof composition.clock.now !== "function") {
    return err(startFailure("Invalid runtime clock"));
  }
  if (!isObject(composition.idGenerator) || typeof composition.idGenerator.next !== "function") {
    return err(startFailure("Invalid runtime id generator"));
  }
  if (!isObject(input)) {
    return err(startFailure("Invalid start triage run input"));
  }
  if (typeof input.actorId !== "string" || input.actorId.trim().length === 0) {
    return err(startFailure("Start triage run requires an actor id"));
  }
  if (typeof input.roleId !== "string" || input.roleId.trim().length === 0) {
    return err(startFailure("Start triage run requires a role id"));
  }
  if (
    (input.corpusManifestId === undefined || input.corpusManifestId.trim().length === 0) &&
    (input.candidateIds === undefined || input.candidateIds.length === 0)
  ) {
    return err(startFailure("Start triage run requires candidate IDs or a corpus manifest ID"));
  }

  if (input.candidateIds !== undefined) {
    if (input.candidateIds.length === 0) {
      return err(startFailure("Start triage run requires candidate IDs or a corpus manifest ID"));
    }
    for (const candidateId of input.candidateIds) {
      if (typeof candidateId !== "string" || candidateId.trim().length === 0) {
        return err(startFailure("Candidate IDs must be non-empty strings"));
      }
    }
    const uniqueIds = new Set(input.candidateIds);
    if (uniqueIds.size !== input.candidateIds.length) {
      return err(startFailure("Input contains duplicate candidate IDs"));
    }
    if (input.candidateIds.length > MAXIMUM_ATTEMPT_CANDIDATE_LIMIT) {
      return err(
        startFailure(
          `Attempt candidate count cannot exceed ${MAXIMUM_ATTEMPT_CANDIDATE_LIMIT} (received ${input.candidateIds.length})`
        )
      );
    }
  }

  const rubric = input.rubric ?? RUBRIC_V1;
  const frozenDate = input.frozenDate ?? "2026-09-07";
  const modelId = input.modelId ?? "test-extractor";
  const extractorVersion = input.extractorVersion ?? "extractor-v1";
  const promptTemplateVersion = input.promptTemplateVersion ?? "prompt-v1";
  const createdAt = composition.clock.now();

  const payload: StartTriageRunPayload = {
    roleId: input.roleId,
    ...(input.candidateIds !== undefined ? { candidateIds: [...input.candidateIds] } : {}),
    ...(input.corpusManifestId !== undefined ? { corpusManifestId: input.corpusManifestId } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {})
  };

  return runUseCaseCommand(composition, {
    actorId: input.actorId,
    commandName: START_TRIAGE_RUN_COMMAND_NAME,
    expectedVersion: 0,
    payload,
    payloadSchema: StartTriageRunPayloadSchema,
    resultSchema: StartTriageRunResultSchema,
    readVersion: () => ok(0),
    mutate: (context) => {
      // 1. Verify role exists
      const roleRow = context.nativeDatabase
        .prepare("SELECT role_id AS roleId FROM role WHERE role_id = ? LIMIT 1")
        .get(input.roleId) as { roleId: string } | undefined;
      if (roleRow === undefined) {
        return err(createRuntimeError("not_found", `Role "${input.roleId}" not found`, false));
      }

      let corpusManifestId: string;
      let manifestKind: CorpusManifestKind;
      let attemptKind: TriageAttemptKind;
      let orderedCandidateIds: readonly string[];
      const candidateDocsMap = new Map<string, readonly CandidateDocumentRef[]>();

      // 2. Resolve or build corpus manifest
      if (input.corpusManifestId !== undefined) {
        corpusManifestId = input.corpusManifestId;
        const manifestRow = context.nativeDatabase
          .prepare(
            `SELECT
              corpus_manifest_id AS corpusManifestId,
              kind,
              seal_id AS sealId
            FROM corpus_manifest
            WHERE corpus_manifest_id = ?
            LIMIT 1`
          )
          .get(corpusManifestId) as
          | {
              corpusManifestId: string;
              kind: CorpusManifestKind;
              sealId: string;
            }
          | undefined;
        if (manifestRow === undefined) {
          return err(
            createRuntimeError("not_found", `Corpus manifest "${corpusManifestId}" not found`, false)
          );
        }

        const sealRow = context.nativeDatabase
          .prepare(
            `SELECT corpus_manifest_seal_id AS id
             FROM corpus_manifest_seal
             WHERE corpus_manifest_seal_id = ?
             LIMIT 1`
          )
          .get(manifestRow.sealId) as { id: string } | undefined;
        if (sealRow === undefined) {
          return err(startFailure(`Corpus manifest "${corpusManifestId}" is not sealed`));
        }

        const manifest = manifestRow;

        const memberRows = context.nativeDatabase
          .prepare(
            `SELECT
              m.candidate_id AS candidateId,
              m.import_ordinal AS importOrdinal,
              cmd.candidate_document_id AS candidateDocumentId,
              cmd.document_ordinal AS documentOrdinal
            FROM corpus_member m
            JOIN corpus_member_document cmd ON cmd.corpus_member_id = m.corpus_member_id
            WHERE m.manifest_id = ?
            ORDER BY m.import_ordinal ASC, cmd.document_ordinal ASC`
          )
          .all(corpusManifestId) as Array<{
            candidateId: string;
            importOrdinal: number;
            candidateDocumentId: string;
            documentOrdinal: number;
          }>;

        const candidateOrder: string[] = [];
        const seenCandidates = new Set<string>();
        for (const row of memberRows) {
          if (!seenCandidates.has(row.candidateId)) {
            seenCandidates.add(row.candidateId);
            candidateOrder.push(row.candidateId);
          }
          const existingDocs = candidateDocsMap.get(row.candidateId) ?? [];
          candidateDocsMap.set(row.candidateId, [
            ...existingDocs,
            { candidateDocumentId: row.candidateDocumentId, documentOrdinal: row.documentOrdinal }
          ]);
        }

        if (input.candidateIds !== undefined) {
          if (
            input.candidateIds.length !== candidateOrder.length ||
            input.candidateIds.some((id, index) => id !== candidateOrder[index])
          ) {
            return err(startFailure("Supplied candidate IDs do not match the corpus manifest"));
          }
        }
        orderedCandidateIds = candidateOrder;
        manifestKind = manifest.kind;
        attemptKind = manifest.kind === "main" ? "main_run" : "variant_run";

        if (input.kind !== undefined && input.kind !== attemptKind) {
          return err(
            startFailure(
              `Requested kind "${input.kind}" does not match manifest kind "${manifest.kind}"`
            )
          );
        }
      } else {
        const candidateIds = input.candidateIds!;
        // Verify all candidates exist in candidate table
        for (const candidateId of candidateIds) {
          const candidateRow = context.nativeDatabase
            .prepare("SELECT candidate_id AS candidateId FROM candidate WHERE candidate_id = ? LIMIT 1")
            .get(candidateId) as { candidateId: string } | undefined;
          if (candidateRow === undefined) {
            return err(
              createRuntimeError("not_found", `Candidate "${candidateId}" not found`, false)
            );
          }
        }

        // Fetch documents for each candidate
        for (const candidateId of candidateIds) {
          const docRows = context.nativeDatabase
            .prepare(
              `SELECT candidate_document_id AS candidateDocumentId, document_ordinal AS documentOrdinal
               FROM candidate_document
               WHERE candidate_id = ?
               ORDER BY document_ordinal ASC`
            )
            .all(candidateId) as CandidateDocumentRef[];
          if (docRows.length === 0) {
            return err(startFailure(`Candidate "${candidateId}" has no documents`));
          }
          candidateDocsMap.set(candidateId, docRows);
        }

        if (input.kind !== undefined) {
          if (input.kind === "main_run") {
            if (candidateIds.length !== MAIN_DEMO_CORPUS_MEMBER_COUNT) {
              return err(
                startFailure(
                  `Main run requires exactly ${MAIN_DEMO_CORPUS_MEMBER_COUNT} candidates (received ${candidateIds.length})`
                )
              );
            }
            manifestKind = "main";
            attemptKind = "main_run";
          } else {
            manifestKind = "variant";
            attemptKind = "variant_run";
          }
        } else {
          if (candidateIds.length === MAIN_DEMO_CORPUS_MEMBER_COUNT) {
            manifestKind = "main";
            attemptKind = "main_run";
          } else {
            manifestKind = "variant";
            attemptKind = "variant_run";
          }
        }

        const manifestContent = {
          kind: manifestKind,
          members: candidateIds.map((candidateId, importOrdinal) => ({
            candidateId,
            importOrdinal,
            documents: candidateDocsMap.get(candidateId)!.map((doc) => ({
              candidateDocumentId: doc.candidateDocumentId,
              documentOrdinal: doc.documentOrdinal
            }))
          }))
        };

        const manifestHashResult = hashCorpusManifestContent(manifestContent);
        if (!manifestHashResult.ok) {
          return manifestHashResult;
        }
        const manifestHash = manifestHashResult.value;

        const existingManifestRow = context.nativeDatabase
          .prepare(
            `SELECT corpus_manifest_id AS id
             FROM corpus_manifest
             WHERE content_hash = ?
             LIMIT 1`
          )
          .get(manifestHash) as { id: string } | undefined;

        if (existingManifestRow !== undefined) {
          corpusManifestId = existingManifestRow.id;
        } else {
          corpusManifestId = composition.idGenerator.next();
          const sealId = composition.idGenerator.next();
          const preparedManifest = prepareCorpusManifest({
            corpusManifestId,
            kind: manifestKind,
            sealId,
            createdAt,
            content: manifestContent
          });
          if (!preparedManifest.ok) {
            return preparedManifest;
          }
          const insertedManifest = insertCorpusManifest(context, preparedManifest.value);
          if (!insertedManifest.ok) {
            return insertedManifest;
          }

          for (let ordinal = 0; ordinal < candidateIds.length; ordinal += 1) {
            const candidateId = candidateIds[ordinal]!;
            const corpusMemberId = composition.idGenerator.next();
            const preparedMember = prepareCorpusMember({
              corpusMemberId,
              manifestId: corpusManifestId,
              candidateId,
              importOrdinal: ordinal,
              createdAt
            });
            if (!preparedMember.ok) {
              return preparedMember;
            }
            const insertedMember = insertCorpusMember(context, preparedMember.value);
            if (!insertedMember.ok) {
              return insertedMember;
            }

            const docs = candidateDocsMap.get(candidateId)!;
            for (const doc of docs) {
              const preparedMemberDoc = prepareCorpusMemberDocument({
                corpusMemberDocumentId: composition.idGenerator.next(),
                corpusMemberId,
                candidateDocumentId: doc.candidateDocumentId,
                documentOrdinal: doc.documentOrdinal,
                createdAt
              });
              if (!preparedMemberDoc.ok) {
                return preparedMemberDoc;
              }
              const insertedMemberDoc = insertCorpusMemberDocument(
                context,
                preparedMemberDoc.value
              );
              if (!insertedMemberDoc.ok) {
                return insertedMemberDoc;
              }
            }
          }

          const preparedSeal = prepareCorpusManifestSeal({
            corpusManifestSealId: sealId,
            manifestId: corpusManifestId,
            createdAt
          });
          /* v8 ignore next 3 */
          if (!preparedSeal.ok) {
            return preparedSeal;
          }
          const insertedSeal = insertCorpusManifestSeal(context, preparedSeal.value);
          /* v8 ignore next 3 */
          if (!insertedSeal.ok) {
            return insertedSeal;
          }
        }

        orderedCandidateIds = candidateIds;
      }

      // 3. Resolve or insert run input snapshot
      const snapshotContent = {
        frozenDate,
        roleId: input.roleId,
        rubricVersion: String(rubric.version),
        dimensions: rubric.dimensions.map((dim, ordinal) => ({
          dimensionId: dim.dimensionId,
          weight: dim.weight,
          required: dim.required,
          definition: dim.definition,
          jobRelatedJustification: dim.jobRelatedJustification,
          ordinal
        })),
        scoringPolicy: {
          levelValues: { ...SCORING_POLICY_V1.levelValues },
          confidenceWeights: { ...SCORING_POLICY_V1.confidenceWeights },
          escalateThreshold: SCORING_POLICY_V1.escalateThreshold,
          shortlistN: SCORING_POLICY_V1.shortlistN,
          requiredFieldIds: [...SCORING_POLICY_V1.requiredFieldIds]
        },
        extractorVersion,
        promptTemplateVersion,
        limits: { ...EXTRACTION_LIMITS }
      };

      const snapshotHashResult = hashRunInputSnapshotContent(snapshotContent);
      if (!snapshotHashResult.ok) {
        return snapshotHashResult;
      }
      const snapshotHash = snapshotHashResult.value;

      let snapshotId: string;
      const existingSnapshotRow = context.nativeDatabase
        .prepare(
          `SELECT run_input_snapshot_id AS id
           FROM run_input_snapshot
           WHERE content_hash = ?
           LIMIT 1`
        )
        .get(snapshotHash) as { id: string } | undefined;
      if (existingSnapshotRow !== undefined) {
        snapshotId = existingSnapshotRow.id;
      } else {
        snapshotId = composition.idGenerator.next();
        const preparedSnapshot = prepareRunInputSnapshot({
          runInputSnapshotId: snapshotId,
          content: snapshotContent,
          createdAt
        });
        if (!preparedSnapshot.ok) {
          return preparedSnapshot;
        }
        const insertedSnapshot = insertRunInputSnapshot(context, preparedSnapshot.value);
        if (!insertedSnapshot.ok) {
          return insertedSnapshot;
        }
      }

      // 4. Resolve or insert extraction spec per rubric dimension
      const specIdByDimension = new Map<string, string>();
      for (const dim of rubric.dimensions) {
        const specContent: ExtractionSpecContent = {
          modelId,
          extractorVersion,
          promptTemplateVersion,
          promptHash: sha256Hex(promptTemplateVersion),
          schemaHash: sha256Hex("extraction-output-schema-v1"),
          dimensionId: dim.dimensionId,
          dimensionDefinition: dim.definition,
          jobRelatedJustification: dim.jobRelatedJustification,
          limits: { ...EXTRACTION_LIMITS }
        };

        const specHashResult = hashExtractionSpecContent(specContent);
        if (!specHashResult.ok) {
          return specHashResult;
        }
        const specHash = specHashResult.value;

        const existingSpecRow = context.nativeDatabase
          .prepare(
            `SELECT extraction_spec_id AS id
             FROM extraction_spec
             WHERE content_hash = ?
             LIMIT 1`
          )
          .get(specHash) as { id: string } | undefined;
        if (existingSpecRow !== undefined) {
          specIdByDimension.set(dim.dimensionId, existingSpecRow.id);
        } else {
          const extractionSpecId = composition.idGenerator.next();
          const preparedSpec = prepareExtractionSpec({
            extractionSpecId,
            content: specContent,
            createdAt
          });
          if (!preparedSpec.ok) {
            return preparedSpec;
          }
          const insertedSpec = insertExtractionSpec(context, preparedSpec.value);
          if (!insertedSpec.ok) {
            return insertedSpec;
          }
          specIdByDimension.set(dim.dimensionId, extractionSpecId);
        }
      }

      // 5. Check if official attempt already exists
      const existingAttemptRow = context.nativeDatabase
        .prepare(
          `SELECT triage_attempt_id AS id
           FROM triage_attempt
           WHERE kind = ? AND snapshot_id = ? AND corpus_manifest_id = ?
           LIMIT 1`
        )
        .get(attemptKind, snapshotId, corpusManifestId) as { id: string } | undefined;
      if (existingAttemptRow !== undefined) {
        return err(
          createRuntimeError(
            "command_conflict",
            `A triage attempt for this snapshot and manifest already exists (${existingAttemptRow.id})`,
            false
          )
        );
      }

      // 6. Create triage attempt
      const triageAttemptId = composition.idGenerator.next();
      const preparedAttempt = prepareTriageAttempt({
        triageAttemptId,
        kind: attemptKind,
        snapshotId,
        corpusManifestId,
        originRunId: null,
        baseResultId: null,
        requestActionId: null,
        scopeCandidateId: null,
        status: "in_progress",
        version: 1,
        createdAt,
        updatedAt: createdAt
      });
      if (!preparedAttempt.ok) {
        return preparedAttempt;
      }
      const insertedAttempt = insertTriageAttempt(context, preparedAttempt.value);
      if (!insertedAttempt.ok) {
        return insertedAttempt;
      }

      // 7. Create attempt work items in deterministic manifest order
      let manifestOrdinal = 0;
      for (const candidateId of orderedCandidateIds) {
        const docs = candidateDocsMap.get(candidateId)!;
        for (const doc of docs) {
          for (const dim of rubric.dimensions) {
            const workItemKey = `${candidateId}:${doc.candidateDocumentId}:${dim.dimensionId}`;
            if (workItemKey.length > 200) {
              return err(startFailure(`Work item key exceeds maximum length: "${workItemKey}"`));
            }
            const extractionSpecId = specIdByDimension.get(dim.dimensionId)!;
            const preparedWorkItem = prepareAttemptWorkItem({
              attemptWorkItemId: composition.idGenerator.next(),
              triageAttemptId,
              workItemKey,
              manifestOrdinal,
              candidateId,
              candidateDocumentId: doc.candidateDocumentId,
              dimensionId: dim.dimensionId,
              extractionSpecId,
              createdAt
            });
            if (!preparedWorkItem.ok) {
              return preparedWorkItem;
            }
            const insertedWorkItem = insertAttemptWorkItem(context, preparedWorkItem.value);
            if (!insertedWorkItem.ok) {
              return insertedWorkItem;
            }
            manifestOrdinal += 1;
          }
        }
      }

      const triageRunId = composition.idGenerator.next();
      return ok({
        triageRunId,
        triageAttemptId,
        workItemCount: manifestOrdinal
      });
    }
  });
}
