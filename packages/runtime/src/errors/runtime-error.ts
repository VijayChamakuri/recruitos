import { z } from "zod";

const RuntimeErrorDetailsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number().int().safe(), z.boolean(), z.null()])
);

const runtimeErrorShape = {
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
  details: RuntimeErrorDetailsSchema.optional()
};

export const RuntimeErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("persistence_failed"), ...runtimeErrorShape }).strict(),
  z.object({ code: z.literal("migration_required"), ...runtimeErrorShape }).strict(),
  z.object({ code: z.literal("command_conflict"), ...runtimeErrorShape }).strict(),
  z.object({ code: z.literal("version_conflict"), ...runtimeErrorShape }).strict()
]);

export type RuntimeError = z.infer<typeof RuntimeErrorSchema>;
export type RuntimeErrorCode = RuntimeError["code"];
export type RuntimeErrorDetails = z.infer<typeof RuntimeErrorDetailsSchema>;

export function createRuntimeError(
  code: RuntimeErrorCode,
  message: string,
  retryable: boolean,
  details?: RuntimeErrorDetails
): RuntimeError {
  return RuntimeErrorSchema.parse({
    code,
    message,
    retryable,
    ...(details === undefined ? {} : { details })
  });
}
