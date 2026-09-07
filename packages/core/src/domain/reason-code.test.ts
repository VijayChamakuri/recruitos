import { describe, expect, it } from "vitest";

import {
  formatReasonCode,
  parseReasonCode,
  reasonCodePrecedence,
  reasonCodeSubject,
  REASON_CODE_KINDS,
  REASON_CODE_KINDS_WITH_SUBJECT,
  REASON_CODE_KINDS_WITHOUT_SUBJECT,
  REASON_CODE_PRECEDENCE,
  ReasonCodeKindSchema,
  ReasonCodeSchema,
  type ReasonCode
} from "./reason-code.js";

describe("reason code vocabulary", () => {
  it("closes the kind enum over exactly the subject and no-subject partitions", () => {
    expect(REASON_CODE_KINDS).toEqual([
      ...REASON_CODE_KINDS_WITH_SUBJECT,
      ...REASON_CODE_KINDS_WITHOUT_SUBJECT
    ]);
    for (const kind of REASON_CODE_KINDS) {
      expect(ReasonCodeKindSchema.parse(kind)).toBe(kind);
    }
    expect(ReasonCodeKindSchema.safeParse("unknown_kind").success).toBe(false);
  });

  it.each(REASON_CODE_KINDS_WITH_SUBJECT)(
    "requires a printable ASCII subject for parameterized kind %s",
    (kind) => {
      const reasonCode: ReasonCode = { kind, subjectId: "evaluation_practice" };
      expect(ReasonCodeSchema.parse(reasonCode)).toEqual(reasonCode);
      expect(formatReasonCode(reasonCode)).toBe(`${kind}:evaluation_practice`);
      expect(ReasonCodeSchema.safeParse({ kind }).success).toBe(false);
      expect(ReasonCodeSchema.safeParse({ kind, subjectId: "" }).success).toBe(false);
      expect(ReasonCodeSchema.safeParse({ kind, subjectId: "has space" }).success).toBe(
        false
      );
      expect(ReasonCodeSchema.safeParse({ kind, subjectId: "a".repeat(129) }).success).toBe(
        false
      );
    }
  );

  it.each(REASON_CODE_KINDS_WITHOUT_SUBJECT)(
    "forbids a subject on the unparameterized kind %s",
    (kind) => {
      const reasonCode: ReasonCode = { kind };
      expect(ReasonCodeSchema.parse(reasonCode)).toEqual(reasonCode);
      expect(formatReasonCode(reasonCode)).toBe(kind);
      expect(ReasonCodeSchema.safeParse({ kind, subjectId: "extra" }).success).toBe(false);
    }
  );

  it("ranks every closed kind exactly once in committed precedence order", () => {
    expect([...REASON_CODE_PRECEDENCE].sort()).toEqual([...REASON_CODE_KINDS].sort());
    expect(new Set(REASON_CODE_PRECEDENCE).size).toBe(REASON_CODE_PRECEDENCE.length);
    expect(REASON_CODE_PRECEDENCE[0]).toBe("assessment_unavailable");
    expect(REASON_CODE_PRECEDENCE.at(-1)).toBe("low_confidence");
    expect(reasonCodePrecedence("assessment_unavailable")).toBeLessThan(
      reasonCodePrecedence("missing_evidence")
    );
    expect(reasonCodePrecedence("missing_evidence")).toBeLessThan(
      reasonCodePrecedence("low_confidence")
    );
  });

  it("round-trips every design invariant P5 reason code string", () => {
    const strings = [
      "assessment_unavailable",
      "missing_evidence:evaluation_practice",
      "missing_evidence:work_authorization",
      "contradiction:tenure_vs_claim",
      "parse_failure",
      "ambiguous:seniority",
      "possible_duplicate",
      "prompt_injection_flagged",
      "low_confidence"
    ];
    for (const text of strings) {
      const parsed = parseReasonCode(text);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        throw new Error(parsed.error.message);
      }
      expect(formatReasonCode(parsed.value)).toBe(text);
      expect(reasonCodeSubject(parsed.value)).toBe(
        "subjectId" in parsed.value ? parsed.value.subjectId : null
      );
    }
  });

  it("rejects text outside the closed vocabulary", () => {
    expect(parseReasonCode("unknown_kind")).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Reason code is not in the closed vocabulary"
      })
    });
    expect(parseReasonCode("missing_evidence")).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Reason code is not in the closed vocabulary"
      })
    });
    expect(parseReasonCode("parse_failure:extra")).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Reason code is not in the closed vocabulary"
      })
    });
    expect(parseReasonCode("missing_evidence:has space")).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Reason code is not in the closed vocabulary"
      })
    });
  });

  it("rejects malformed reason code text before checking the vocabulary", () => {
    expect(parseReasonCode(42)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid reason code text" })
    });
    expect(parseReasonCode(null)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid reason code text" })
    });
    expect(parseReasonCode("")).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid reason code text" })
    });
    expect(parseReasonCode(`missing_evidence:${"a".repeat(300)}`)).toEqual({
      ok: false,
      error: expect.objectContaining({ message: "Invalid reason code text" })
    });
  });
});
