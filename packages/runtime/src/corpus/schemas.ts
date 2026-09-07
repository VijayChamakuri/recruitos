import {
  CandidateDocumentIdSchema,
  CandidateIdSchema,
  CorpusManifestIdSchema,
  CorpusManifestSealIdSchema,
  CorpusMemberDocumentIdSchema,
  CorpusMemberIdSchema,
  NonnegativeIntegerSchema,
  Sha256HexSchema
} from "@recruitos/core";
import { z } from "zod";

/**
 * Main demo corpus size from the capacity contract and publication-seal rules.
 * Variant manifests may be smaller; main manifests must seal at exactly this count.
 */
export const MAIN_DEMO_CORPUS_MEMBER_COUNT = 140;

/** Same four-document ceiling as candidate ownership. */
export const MAXIMUM_DOCUMENTS_PER_CORPUS_MEMBER = 4;

export const CorpusManifestKindSchema = z.enum(["main", "variant"]);
export type CorpusManifestKind = z.infer<typeof CorpusManifestKindSchema>;

/**
 * Canonical membership bytes hashed into `corpus_manifest.content_hash`.
 * Identity columns (member IDs, document association IDs, timestamps) are
 * excluded so two independently authored identical corpora collide on hash.
 */
export const CorpusManifestContentMemberDocumentSchema = z
  .object({
    candidateDocumentId: CandidateDocumentIdSchema,
    documentOrdinal: NonnegativeIntegerSchema.max(
      MAXIMUM_DOCUMENTS_PER_CORPUS_MEMBER - 1
    )
  })
  .strict();

export type CorpusManifestContentMemberDocument = z.infer<
  typeof CorpusManifestContentMemberDocumentSchema
>;

export const CorpusManifestContentMemberSchema = z
  .object({
    candidateId: CandidateIdSchema,
    importOrdinal: NonnegativeIntegerSchema,
    documents: z
      .array(CorpusManifestContentMemberDocumentSchema)
      .min(1)
      .max(MAXIMUM_DOCUMENTS_PER_CORPUS_MEMBER)
  })
  .strict();

export type CorpusManifestContentMember = z.infer<
  typeof CorpusManifestContentMemberSchema
>;

export const CorpusManifestContentSchema = z
  .object({
    kind: CorpusManifestKindSchema,
    members: z.array(CorpusManifestContentMemberSchema).min(1)
  })
  .strict();

export type CorpusManifestContent = z.infer<typeof CorpusManifestContentSchema>;

const corpusManifestShape = {
  corpusManifestId: CorpusManifestIdSchema,
  kind: CorpusManifestKindSchema,
  contentHash: Sha256HexSchema,
  sealId: CorpusManifestSealIdSchema,
  createdAt: NonnegativeIntegerSchema
};

export const CorpusManifestDraftSchema = z
  .object({
    corpusManifestId: CorpusManifestIdSchema,
    kind: CorpusManifestKindSchema,
    sealId: CorpusManifestSealIdSchema,
    createdAt: NonnegativeIntegerSchema,
    content: CorpusManifestContentSchema
  })
  .strict()
  .refine((draft) => draft.content.kind === draft.kind, {
    message: "Manifest kind must match hashed content kind",
    path: ["content", "kind"]
  });

export type CorpusManifestDraft = z.infer<typeof CorpusManifestDraftSchema>;

export const CorpusManifestSchema = z.object(corpusManifestShape).strict();
export type CorpusManifest = z.infer<typeof CorpusManifestSchema>;

const corpusMemberShape = {
  corpusMemberId: CorpusMemberIdSchema,
  manifestId: CorpusManifestIdSchema,
  candidateId: CandidateIdSchema,
  importOrdinal: NonnegativeIntegerSchema,
  createdAt: NonnegativeIntegerSchema
};

export const CorpusMemberDraftSchema = z.object(corpusMemberShape).strict();
export type CorpusMemberDraft = z.infer<typeof CorpusMemberDraftSchema>;

export const CorpusMemberSchema = z.object(corpusMemberShape).strict();
export type CorpusMember = z.infer<typeof CorpusMemberSchema>;

const corpusMemberDocumentShape = {
  corpusMemberDocumentId: CorpusMemberDocumentIdSchema,
  corpusMemberId: CorpusMemberIdSchema,
  candidateDocumentId: CandidateDocumentIdSchema,
  documentOrdinal: NonnegativeIntegerSchema.max(
    MAXIMUM_DOCUMENTS_PER_CORPUS_MEMBER - 1
  ),
  createdAt: NonnegativeIntegerSchema
};

export const CorpusMemberDocumentDraftSchema = z
  .object(corpusMemberDocumentShape)
  .strict();
export type CorpusMemberDocumentDraft = z.infer<
  typeof CorpusMemberDocumentDraftSchema
>;

export const CorpusMemberDocumentSchema = z
  .object(corpusMemberDocumentShape)
  .strict();
export type CorpusMemberDocument = z.infer<typeof CorpusMemberDocumentSchema>;

const corpusManifestSealShape = {
  corpusManifestSealId: CorpusManifestSealIdSchema,
  manifestId: CorpusManifestIdSchema,
  createdAt: NonnegativeIntegerSchema
};

export const CorpusManifestSealDraftSchema = z
  .object(corpusManifestSealShape)
  .strict();
export type CorpusManifestSealDraft = z.infer<typeof CorpusManifestSealDraftSchema>;

export const CorpusManifestSealSchema = z.object(corpusManifestSealShape).strict();
export type CorpusManifestSeal = z.infer<typeof CorpusManifestSealSchema>;
