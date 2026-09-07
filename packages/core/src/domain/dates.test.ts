import { describe, expect, it } from "vitest";

import { IsoDateSchema, IsoYearMonthSchema, isIsoCalendarDate, isIsoYearMonth } from "./dates.js";

describe("ISO calendar dates", () => {
  it.each(["2026-09-07", "2024-02-29", "2000-02-29", "1999-12-31", "0001-01-01"])(
    "accepts valid date %j",
    (value) => {
      expect(isIsoCalendarDate(value)).toBe(true);
      expect(IsoDateSchema.parse(value)).toBe(value);
    }
  );

  it.each([
    "",
    "2026-9-7",
    "2026/09/07",
    "2026-09-07T00:00:00Z",
    "2026-13-01",
    "2026-00-01",
    "2026-02-30",
    "2023-02-29",
    "1900-02-29",
    "2026-04-31",
    "2026-09-32"
  ])("rejects invalid date %j", (value) => {
    expect(isIsoCalendarDate(value)).toBe(false);
    expect(IsoDateSchema.safeParse(value).success).toBe(false);
  });
});

describe("ISO year-month values", () => {
  it.each(["2026-09", "2024-02", "0001-01", "9999-12"])("accepts valid year-month %j", (value) => {
    expect(isIsoYearMonth(value)).toBe(true);
    expect(IsoYearMonthSchema.parse(value)).toBe(value);
  });

  it.each(["", "2026-9", "2026/09", "2026-13", "2026-00", "2026-09-07", "present"])(
    "rejects invalid year-month %j",
    (value) => {
      expect(isIsoYearMonth(value)).toBe(false);
      expect(IsoYearMonthSchema.safeParse(value).success).toBe(false);
    }
  );
});
