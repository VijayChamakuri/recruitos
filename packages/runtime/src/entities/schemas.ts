import {
  ActorIdSchema,
  CandidateDocumentIdSchema,
  CandidateIdSchema,
  NonnegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256HexSchema,
  SourceDocumentIdSchema
} from "@recruitos/core";
import { z } from "zod";

/**
 * The one actor the runtime itself acts as. Seeded by migration
 * `0003_immutable_entity_foundation`, never insertable through this module.
 */
export const SYSTEM_ACTOR_ID = "system:runtime";

/**
 * Persistence bounds from the capacity and performance contract. Oversized
 * input is rejected here, never truncated, summarized, or split.
 */
export const MAXIMUM_RAW_DOCUMENT_BYTES = 262_144;
export const MAXIMUM_NORMALIZED_DOCUMENT_BYTES = 131_072;
export const MAXIMUM_NORMALIZED_DOCUMENT_LENGTH = 50_000;
export const MAXIMUM_DOCUMENTS_PER_CANDIDATE = 4;

export const ActorKindSchema = z.enum(["human", "system"]);
export type ActorKind = z.infer<typeof ActorKindSchema>;

export const CandidateChannelSchema = z.enum(["inbound", "sourced"]);
export type CandidateChannel = z.infer<typeof CandidateChannelSchema>;

export const CorpusTagSchema = z.enum(["main", "variant"]);
export type CorpusTag = z.infer<typeof CorpusTagSchema>;

export const DocumentKindSchema = z.enum([
  "resume",
  "cover_letter",
  "profile",
  "recruiter_note"
]);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

const displayName = z.string().min(1).max(200);

export const ActorDraftSchema = z
  .object({
    actorId: ActorIdSchema,
    displayName,
    createdAt: NonnegativeIntegerSchema
  })
  .strict()
  .refine((actor) => actor.actorId !== SYSTEM_ACTOR_ID, {
    message: "Callers cannot claim the system actor",
    path: ["actorId"]
  });

export type ActorDraft = z.infer<typeof ActorDraftSchema>;

export const ActorSchema = z
  .object({
    actorId: ActorIdSchema,
    actorKind: ActorKindSchema,
    displayName,
    createdAt: NonnegativeIntegerSchema
  })
  .strict()
  .refine(
    (actor) => (actor.actorKind === "system") === (actor.actorId === SYSTEM_ACTOR_ID),
    {
      message: "Only the system actor ID may carry the system actor kind",
      path: ["actorKind"]
    }
  );

export type Actor = z.infer<typeof ActorSchema>;

const candidateShape = {
  candidateId: CandidateIdSchema,
  sourceSystem: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u),
  sourceKey: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\x21-\x7e]+$/u, "Source key must be printable ASCII without spaces"),
  channel: CandidateChannelSchema,
  corpusTag: CorpusTagSchema,
  createdAt: NonnegativeIntegerSchema
};

export const CandidateDraftSchema = z.object(candidateShape).strict();
export type CandidateDraft = z.infer<typeof CandidateDraftSchema>;

export const CandidateSchema = z
  .object({ ...candidateShape, isSynthetic: z.literal(true) })
  .strict();

export type Candidate = z.infer<typeof CandidateSchema>;

export const SourceDocumentDraftSchema = z
  .object({
    sourceDocumentId: SourceDocumentIdSchema,
    rawText: z.string().min(1),
    normalizedText: z.string().min(1),
    createdAt: NonnegativeIntegerSchema
  })
  .strict();

export type SourceDocumentDraft = z.infer<typeof SourceDocumentDraftSchema>;

export const SourceDocumentSchema = z
  .object({
    sourceDocumentId: SourceDocumentIdSchema,
    rawText: z.string().min(1),
    rawHash: Sha256HexSchema,
    rawByteLength: PositiveIntegerSchema.max(MAXIMUM_RAW_DOCUMENT_BYTES),
    normalizedText: z.string().min(1),
    normalizedHash: Sha256HexSchema,
    normalizedLength: PositiveIntegerSchema.max(MAXIMUM_NORMALIZED_DOCUMENT_LENGTH),
    normalizedByteLength: PositiveIntegerSchema.max(MAXIMUM_NORMALIZED_DOCUMENT_BYTES),
    createdAt: NonnegativeIntegerSchema
  })
  .strict()
  .refine((document) => document.normalizedLength === document.normalizedText.length, {
    message: "Normalized length must equal the normalized text UTF-16 length",
    path: ["normalizedLength"]
  });

export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

const candidateDocumentShape = {
  candidateDocumentId: CandidateDocumentIdSchema,
  candidateId: CandidateIdSchema,
  sourceDocumentId: SourceDocumentIdSchema,
  documentKind: DocumentKindSchema,
  label: displayName,
  documentOrdinal: NonnegativeIntegerSchema.max(MAXIMUM_DOCUMENTS_PER_CANDIDATE - 1),
  createdAt: NonnegativeIntegerSchema
};

export const CandidateDocumentDraftSchema = z.object(candidateDocumentShape).strict();
export type CandidateDocumentDraft = z.infer<typeof CandidateDocumentDraftSchema>;

export const CandidateDocumentSchema = z.object(candidateDocumentShape).strict();
export type CandidateDocument = z.infer<typeof CandidateDocumentSchema>;
