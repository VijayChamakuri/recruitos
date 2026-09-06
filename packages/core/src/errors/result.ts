import { z } from "zod";

export type Result<T, E> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

export function createResultSchema<T extends z.ZodType, E extends z.ZodType>(
  valueSchema: T,
  errorSchema: E
) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: valueSchema }).strict(),
    z.object({ ok: z.literal(false), error: errorSchema }).strict()
  ]);
}

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function mapResult<T, U, E>(
  result: Result<T, E>,
  transform: (value: T) => U
): Result<U, E> {
  return result.ok ? ok(transform(result.value)) : result;
}

export function flatMapResult<T, U, E>(
  result: Result<T, E>,
  transform: (value: T) => Result<U, E>
): Result<U, E> {
  return result.ok ? transform(result.value) : result;
}

export function matchResult<T, E, U>(
  result: Result<T, E>,
  handlers: Readonly<{ ok: (value: T) => U; err: (error: E) => U }>
): U {
  return result.ok ? handlers.ok(result.value) : handlers.err(result.error);
}
