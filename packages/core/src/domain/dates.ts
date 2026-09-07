import { z } from "zod";

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Calendar check for the plan's strict `YYYY-MM-DD` dates. Implemented with
 * integer arithmetic so core never constructs a Date.
 */
export function isIsoCalendarDate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) {
    return false;
  }
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month]!;
  return day >= 1 && day <= maxDay;
}

export const IsoDateSchema = z
  .string()
  .refine(isIsoCalendarDate, { message: "Expected a calendar date in YYYY-MM-DD form" })
  .brand<"IsoDate">();
export type IsoDate = z.infer<typeof IsoDateSchema>;
