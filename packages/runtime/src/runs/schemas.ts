import {
  CandidateIdSchema,
  CandidateTriageResultIdSchema,
  CorpusManifestIdSchema,
  NonnegativeIntegerSchema,
  RunInputSnapshotIdSchema,
  TriageRunIdSchema,
  TriageRunMemberIdSchema,
  TriageRunSealIdSchema
} from "@recruitos/core";
import { z } from "zod";

/** Plan capacity: candidates per attempt, therefore members per official run. */
export const MAXIMUM_TRIAGE_RUN_MEMBERS = 200;

export const TriageRunKindSchema = z.enum(["main", "variant"]);
export type TriageRunKind = z.infer<typeof TriageRunKindSchema>;

const triageRunShape = {
  triageRunId: TriageRunIdSchema,
  kind: TriageRunKindSchema,
  snapshotId: RunInputSnapshotIdSchema,
  corpusManifestId: CorpusManifestIdSchema,
  sealId: TriageRunSealIdSchema,
  createdAt: NonnegativeIntegerSchema
};

export const TriageRunDraftSchema = z.object(triageRunShape).strict();
export type TriageRunDraft = z.infer<typeof TriageRunDraftSchema>;

export const TriageRunSchema = z.object(triageRunShape).strict();
export type TriageRun = z.infer<typeof TriageRunSchema>;

const triageRunMemberShape = {
  triageRunMemberId: TriageRunMemberIdSchema,
  triageRunId: TriageRunIdSchema,
  candidateId: CandidateIdSchema,
  importOrdinal: NonnegativeIntegerSchema,
  initialResultId: CandidateTriageResultIdSchema,
  createdAt: NonnegativeIntegerSchema
};

export const TriageRunMemberDraftSchema = z.object(triageRunMemberShape).strict();
export type TriageRunMemberDraft = z.infer<typeof TriageRunMemberDraftSchema>;

export const TriageRunMemberSchema = z.object(triageRunMemberShape).strict();
export type TriageRunMember = z.infer<typeof TriageRunMemberSchema>;

const triageRunSealShape = {
  triageRunSealId: TriageRunSealIdSchema,
  triageRunId: TriageRunIdSchema,
  createdAt: NonnegativeIntegerSchema
};

export const TriageRunSealDraftSchema = z.object(triageRunSealShape).strict();
export type TriageRunSealDraft = z.infer<typeof TriageRunSealDraftSchema>;

export const TriageRunSealSchema = z.object(triageRunSealShape).strict();
export type TriageRunSeal = z.infer<typeof TriageRunSealSchema>;
