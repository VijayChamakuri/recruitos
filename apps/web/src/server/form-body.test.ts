import { describe, expect, it } from "vitest";
import {
  CORRECTION_DISABLED_MESSAGE,
  FIXTURE_CORRECTION_SOURCE_KEY,
  HUMAN_OPERATOR_ACTOR_ID,
  SYSTEM_ACTOR_ID,
  forbiddenFactField,
  rejectPostedActor,
  requiredInteger,
  requiredText
} from "./form-body.js";

describe("correction form body", () => {
  it("rejects extracted fact fields", () => {
    expect(forbiddenFactField(new URLSearchParams("evidenceText=secret"))).toBe("evidenceText");
    expect(forbiddenFactField(new URLSearchParams("assignedLevel=strong"))).toBe("assignedLevel");
    expect(forbiddenFactField(new URLSearchParams("rationale=ok"))).toBeUndefined();
  });

  it("rejects a posted system actor and unknown actors", () => {
    expect(rejectPostedActor(new URLSearchParams(`actorId=${SYSTEM_ACTOR_ID}`))).toContain(
      "system actor"
    );
    expect(rejectPostedActor(new URLSearchParams("actorId=human:other"))).toContain("human:operator");
    expect(rejectPostedActor(new URLSearchParams(`actorId=${HUMAN_OPERATOR_ACTOR_ID}`))).toBeUndefined();
    expect(rejectPostedActor(new URLSearchParams())).toBeUndefined();
  });

  it("parses required text and integers", () => {
    expect(requiredText(new URLSearchParams("rationale=  need overlay  "), "rationale")).toBe(
      "need overlay"
    );
    expect(requiredText(new URLSearchParams("rationale=   "), "rationale")).toBeUndefined();
    expect(requiredInteger(new URLSearchParams("expectedTaskHeadVersion=2"), "expectedTaskHeadVersion")).toBe(
      2
    );
    expect(requiredInteger(new URLSearchParams("expectedTaskHeadVersion=01"), "expectedTaskHeadVersion")).toBeUndefined();
    expect(requiredInteger(new URLSearchParams("expectedTaskHeadVersion=x"), "expectedTaskHeadVersion")).toBeUndefined();
  });

  it("names the fixture source key and disabled copy", () => {
    expect(FIXTURE_CORRECTION_SOURCE_KEY).toBe("demo/route-4-reviewable-failure");
    expect(CORRECTION_DISABLED_MESSAGE).toContain("make demo-web-correction");
  });
});
