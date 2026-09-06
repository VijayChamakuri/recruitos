import { z } from "zod";

import type { DomainError } from "../errors/domain-error.js";
import { createDomainError } from "../errors/domain-error.js";
import { err, ok, type Result } from "../errors/result.js";

const offsetSchema = z.number().int().safe().nonnegative();

export const Utf16IntervalSchema = z
  .object({ start: offsetSchema, end: offsetSchema })
  .strict()
  .superRefine((value, context) => {
    if (value.end < value.start) {
      context.addIssue({ code: "custom", message: "End must not precede start", path: ["end"] });
    }
  });
export type Utf16Interval = z.infer<typeof Utf16IntervalSchema>;

export const Utf16SliceSchema = z
  .object({
    start: offsetSchema,
    end: offsetSchema,
    matchedText: z.string().min(1)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.end <= value.start) {
      context.addIssue({ code: "custom", message: "A matched slice must not be empty", path: ["end"] });
    }
  });
export type Utf16Slice = z.infer<typeof Utf16SliceSchema>;

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

export function isUtf16CodePointBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) {
    return true;
  }
  return !(
    isHighSurrogate(text.charCodeAt(offset - 1)) &&
    isLowSurrogate(text.charCodeAt(offset))
  );
}

function integrityFailure(message: string, start?: number, end?: number): DomainError {
  return createDomainError("span_integrity_failed", message, {
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end })
  });
}

export function validateUtf16Interval(
  text: string,
  input: unknown
): Result<Utf16Interval, DomainError> {
  const parsed = Utf16IntervalSchema.safeParse(input);
  if (!parsed.success) {
    return err(integrityFailure("UTF-16 interval is invalid"));
  }
  const { start, end } = parsed.data;
  if (end > text.length) {
    return err(integrityFailure("UTF-16 interval exceeds source bounds", start, end));
  }
  if (!isUtf16CodePointBoundary(text, start) || !isUtf16CodePointBoundary(text, end)) {
    return err(integrityFailure("UTF-16 interval splits a surrogate pair", start, end));
  }
  return ok(parsed.data);
}

export function validateUtf16Slice(
  text: string,
  input: unknown
): Result<Utf16Slice, DomainError> {
  const parsed = Utf16SliceSchema.safeParse(input);
  if (!parsed.success) {
    return err(integrityFailure("UTF-16 slice is invalid"));
  }
  const interval = validateUtf16Interval(text, {
    start: parsed.data.start,
    end: parsed.data.end
  });
  if (!interval.ok) {
    return interval;
  }
  if (text.slice(interval.value.start, interval.value.end) !== parsed.data.matchedText) {
    return err(
      integrityFailure(
        "UTF-16 source slice does not match stored text",
        interval.value.start,
        interval.value.end
      )
    );
  }
  return ok(parsed.data);
}
