import { describe, expect, it } from "vitest";

import {
  CANDIDATE_RESULT_KINDS,
  CANDIDATE_TRIAGE_STATUSES,
  CandidateResultKindSchema,
  CandidateTriageStatusSchema,
  DECISION_AVAILABILITIES,
  DecisionAvailabilitySchema
} from "./status.js";

describe("candidate result status vocabulary", () => {
  it("accepts exactly the closed triage statuses", () => {
    expect(CANDIDATE_TRIAGE_STATUSES).toEqual([
      "scored",
      "rejected_hard_requirement",
      "escalated"
    ]);
    for (const status of CANDIDATE_TRIAGE_STATUSES) {
      expect(CandidateTriageStatusSchema.parse(status)).toBe(status);
    }
    expect(CandidateTriageStatusSchema.safeParse("shortlisted").success).toBe(false);
  });

  it("accepts complete and unavailable decision availability", () => {
    expect(DECISION_AVAILABILITIES).toEqual(["complete", "unavailable"]);
    for (const availability of DECISION_AVAILABILITIES) {
      expect(DecisionAvailabilitySchema.parse(availability)).toBe(availability);
    }
    expect(DecisionAvailabilitySchema.safeParse("partial").success).toBe(false);
  });

  it("accepts initial and correction result kinds", () => {
    expect(CANDIDATE_RESULT_KINDS).toEqual(["initial", "correction"]);
    for (const kind of CANDIDATE_RESULT_KINDS) {
      expect(CandidateResultKindSchema.parse(kind)).toBe(kind);
    }
    expect(CandidateResultKindSchema.safeParse("rerun").success).toBe(false);
  });
});
