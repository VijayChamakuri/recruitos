import { z } from "zod";

const ErrorDetailValueSchema = z.union([
  z.string(),
  z.number().int().safe(),
  z.boolean(),
  z.null()
]);

export const DomainErrorDetailsSchema = z.record(z.string(), ErrorDetailValueSchema);
export type DomainErrorDetails = z.infer<typeof DomainErrorDetailsSchema>;

const domainErrorShape = {
  message: z.string().min(1).max(500),
  retryable: z.literal(false),
  details: DomainErrorDetailsSchema.optional()
};

export const DomainErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("invalid_input"), ...domainErrorShape }).strict(),
  z.object({ code: z.literal("invalid_rubric"), ...domainErrorShape }).strict(),
  z.object({ code: z.literal("invalid_evidence"), ...domainErrorShape }).strict(),
  z.object({ code: z.literal("invalid_transition"), ...domainErrorShape }).strict(),
  z.object({ code: z.literal("unsupported_resolution"), ...domainErrorShape }).strict(),
  z.object({ code: z.literal("score_invariant_failed"), ...domainErrorShape }).strict(),
  z.object({ code: z.literal("span_integrity_failed"), ...domainErrorShape }).strict()
]);

export type DomainError = z.infer<typeof DomainErrorSchema>;
export type DomainErrorCode = DomainError["code"];

export function createDomainError(
  code: DomainErrorCode,
  message: string,
  details?: DomainErrorDetails
): DomainError {
  return DomainErrorSchema.parse({
    code,
    message,
    retryable: false,
    ...(details === undefined ? {} : { details })
  });
}
