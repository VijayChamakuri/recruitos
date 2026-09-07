import { describe, expect, it } from "vitest";

import {
  deriveResolutionTaskStatus,
  HUMAN_RESOLUTION_ACTION_KINDS,
  isHumanResolutionActionKind,
  MAXIMUM_RESOLUTION_RATIONALE_LENGTH,
  RESOLUTION_ACTION_KINDS,
  RESOLUTION_TASK_STATUSES,
  ResolutionActionKindSchema,
  ResolutionActionPayloadSchema,
  ResolutionTaskStatusSchema,
  SYSTEM_RESOLUTION_ACTION_KINDS,
  type ResolutionActionKind
} from "./resolution.js";

describe("resolution task vocabulary", () => {
  it("closes task status over open, review_required, resolved, and dismissed", () => {
    expect(RESOLUTION_TASK_STATUSES).toEqual([
      "open",
      "review_required",
      "resolved",
      "dismissed"
    ]);
    for (const status of RESOLUTION_TASK_STATUSES) {
      expect(ResolutionTaskStatusSchema.parse(status)).toBe(status);
    }
    expect(ResolutionTaskStatusSchema.safeParse("reextracting").success).toBe(false);
  });

  it("partitions action kinds into human and system sets", () => {
    expect(RESOLUTION_ACTION_KINDS).toEqual([
      ...HUMAN_RESOLUTION_ACTION_KINDS,
      ...SYSTEM_RESOLUTION_ACTION_KINDS
    ]);
    for (const kind of HUMAN_RESOLUTION_ACTION_KINDS) {
      expect(isHumanResolutionActionKind(kind)).toBe(true);
    }
    expect(isHumanResolutionActionKind("reextraction_completed")).toBe(false);
    expect(ResolutionActionKindSchema.safeParse("approve").success).toBe(false);
  });

  it("derives status from the current action kind or its absence", () => {
    expect(deriveResolutionTaskStatus(null)).toBe("open");
    expect(deriveResolutionTaskStatus("request_re_extraction")).toBe("open");
    expect(deriveResolutionTaskStatus("reextraction_completed")).toBe("review_required");
    expect(deriveResolutionTaskStatus("dismiss")).toBe("dismissed");
    expect(deriveResolutionTaskStatus("supply_evidence_and_set_level")).toBe("resolved");
    expect(deriveResolutionTaskStatus("confirm_judgment")).toBe("resolved");
    expect(deriveResolutionTaskStatus("correct_parse")).toBe("resolved");
    expect(deriveResolutionTaskStatus("block")).toBe("resolved");
  });

  it("covers every closed action kind in the status projection", () => {
    const seen = new Set<string>();
    for (const kind of RESOLUTION_ACTION_KINDS) {
      seen.add(deriveResolutionTaskStatus(kind as ResolutionActionKind));
    }
    expect(seen.has("open")).toBe(true);
    expect(seen.has("review_required")).toBe(true);
    expect(seen.has("resolved")).toBe(true);
    expect(seen.has("dismissed")).toBe(true);
  });
});

describe("resolution action payloads", () => {
  it("requires evidence and an assessment for supply_evidence_and_set_level", () => {
    expect(
      ResolutionActionPayloadSchema.parse({
        kind: "supply_evidence_and_set_level",
        evidenceSpanId: "evidence-span-1",
        dimensionAssessmentId: "dimension-assessment-1"
      })
    ).toEqual({
      kind: "supply_evidence_and_set_level",
      evidenceSpanId: "evidence-span-1",
      dimensionAssessmentId: "dimension-assessment-1"
    });
    expect(
      ResolutionActionPayloadSchema.safeParse({
        kind: "supply_evidence_and_set_level",
        evidenceSpanId: "evidence-span-1"
      }).success
    ).toBe(false);
  });

  it("requires a non-empty rationale for block and dismiss", () => {
    expect(
      ResolutionActionPayloadSchema.parse({ kind: "dismiss", rationale: "Duplicate of 0002" })
    ).toEqual({ kind: "dismiss", rationale: "Duplicate of 0002" });
    expect(ResolutionActionPayloadSchema.safeParse({ kind: "dismiss" }).success).toBe(false);
    expect(ResolutionActionPayloadSchema.safeParse({ kind: "block", rationale: "" }).success).toBe(
      false
    );
    expect(
      ResolutionActionPayloadSchema.safeParse({
        kind: "block",
        rationale: "x".repeat(MAXIMUM_RESOLUTION_RATIONALE_LENGTH + 1)
      }).success
    ).toBe(false);
  });

  it("accepts empty payloads for request_re_extraction and optional parse rationale", () => {
    expect(ResolutionActionPayloadSchema.parse({ kind: "request_re_extraction" })).toEqual({
      kind: "request_re_extraction"
    });
    expect(ResolutionActionPayloadSchema.parse({ kind: "correct_parse" })).toEqual({
      kind: "correct_parse"
    });
    expect(
      ResolutionActionPayloadSchema.parse({
        kind: "correct_parse",
        rationale: "Dates were swapped"
      })
    ).toEqual({ kind: "correct_parse", rationale: "Dates were swapped" });
  });

  it("requires a resulting result on reextraction_completed", () => {
    expect(
      ResolutionActionPayloadSchema.parse({
        kind: "reextraction_completed",
        resultingResultId: "candidate-result-2"
      })
    ).toEqual({
      kind: "reextraction_completed",
      resultingResultId: "candidate-result-2"
    });
    expect(
      ResolutionActionPayloadSchema.safeParse({ kind: "reextraction_completed" }).success
    ).toBe(false);
  });
});
