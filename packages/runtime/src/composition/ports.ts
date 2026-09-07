import { NonnegativeIntegerSchema } from "@recruitos/core";

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/u;

/** A source of the current time in epoch milliseconds, UTC. */
export type Clock = Readonly<{
  now: () => number;
}>;

/** Wall-clock time from the host process. */
export const systemClock: Clock = Object.freeze({
  now: (): number => Date.now()
});

/**
 * A clock fixed to one instant, for tests and deterministic replay. Rejects any
 * value that is not a nonnegative integer millisecond count.
 */
export function fixedClock(epochMilliseconds: number): Clock {
  const parsed = NonnegativeIntegerSchema.safeParse(epochMilliseconds);
  if (!parsed.success) {
    throw new TypeError(
      "fixedClock requires a nonnegative integer millisecond value"
    );
  }
  const instant: number = parsed.data;
  return Object.freeze({ now: (): number => instant });
}

/** A source of fresh, process-unique identifier strings, printable ASCII. */
export type IdGenerator = Readonly<{
  next: () => string;
}>;

/**
 * A deterministic generator yielding `${prefix}-0000000001`, `${prefix}-0000000002`,
 * and so on. Unique within one process. Suitable for tests, fixtures, and
 * single-run reproducibility. Inject a different implementation when identifiers
 * must be unique across processes.
 */
export function createIncrementingIdGenerator(prefix: string): IdGenerator {
  if (
    typeof prefix !== "string" ||
    prefix.length === 0 ||
    !PRINTABLE_ASCII.test(prefix)
  ) {
    throw new TypeError(
      "createIncrementingIdGenerator requires a non-empty printable ASCII prefix"
    );
  }
  let counter = 0;
  return Object.freeze({
    next: (): string => {
      counter += 1;
      return `${prefix}-${counter.toString().padStart(10, "0")}`;
    }
  });
}
