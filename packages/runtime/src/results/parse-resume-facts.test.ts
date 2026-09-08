import { describe, expect, it } from "vitest";

import { parseResumeFacts, type ResumeFactDocument } from "./parse-resume-facts.js";

function resume(overrides: Partial<ResumeFactDocument> = {}): ResumeFactDocument {
  return {
    candidateDocumentId: "cdoc_1",
    documentKind: "resume",
    normalizedText: [
      "Summary line",
      "",
      "EXPERIENCE",
      "Senior Machine Learning Engineer | TechCorp | 2021-03 | present",
      "Machine Learning Engineer | DataCo | 2019-06 | 2021-02"
    ].join("\n"),
    ...overrides
  };
}

describe("parseResumeFacts", () => {
  it("emits parsed employment, history, and current-title proposals per role", () => {
    const proposals = parseResumeFacts([resume()]);

    expect(proposals.map((proposal) => proposal.payload.kind)).toEqual([
      "employment_interval",
      "employer_history_entry",
      "employment_interval",
      "employer_history_entry",
      "current_title"
    ]);
    for (const proposal of proposals) {
      expect(proposal.provenance).toBe("parsed");
      expect(proposal.documentId).toBe("cdoc_1");
      expect(proposal.groundingQuotes).toBeUndefined();
      expect(proposal.evidenceSpanIds).toBeUndefined();
    }
  });

  it("takes the current title from the most recent role, keyed by present then start month", () => {
    const [, , , , currentTitle] = parseResumeFacts([resume()]);
    expect(currentTitle?.payload).toEqual({
      kind: "current_title",
      title: "Senior Machine Learning Engineer"
    });
  });

  it("picks the latest start month when no role is still present", () => {
    const proposals = parseResumeFacts([
      resume({
        normalizedText: [
          "EXPERIENCE",
          "Engineer | EarlyCo | 2018-01 | 2021-12",
          "Staff Engineer | LateCo | 2022-01 | 2023-06"
        ].join("\n")
      })
    ]);
    const currentTitle = proposals.at(-1);
    expect(currentTitle?.payload).toMatchObject({ kind: "current_title", title: "Staff Engineer" });
  });

  it("prefers a later role that is still present over an earlier closed one", () => {
    const proposals = parseResumeFacts([
      resume({
        normalizedText: [
          "EXPERIENCE",
          "Engineer | EarlyCo | 2018-01 | 2019-01",
          "Staff Engineer | NowCo | 2022-01 | present"
        ].join("\n")
      })
    ]);
    expect(proposals.at(-1)?.payload).toMatchObject({
      kind: "current_title",
      title: "Staff Engineer"
    });
  });

  it("parses a closed interval into an iso year-month end", () => {
    const proposals = parseResumeFacts([
      resume({
        normalizedText: ["EXPERIENCE", "Engineer | OnlyCo | 2020-01 | 2021-02"].join("\n")
      })
    ]);
    expect(proposals[0]?.payload).toEqual({
      kind: "employment_interval",
      employer: "OnlyCo",
      title: "Engineer",
      startMonth: "2020-01",
      endMonth: "2021-02"
    });
  });

  it("ignores non-resume documents", () => {
    expect(parseResumeFacts([resume({ documentKind: "cover_letter" })])).toEqual([]);
  });

  it("contributes nothing when there is no EXPERIENCE block", () => {
    expect(
      parseResumeFacts([resume({ normalizedText: "Summary only\nNo experience header here" })])
    ).toEqual([]);
  });

  it("stops at the first blank line after the header", () => {
    const proposals = parseResumeFacts([
      resume({
        normalizedText: [
          "EXPERIENCE",
          "Engineer | OnlyCo | 2020-01 | present",
          "",
          "Engineer | AfterBlankCo | 2010-01 | 2011-01"
        ].join("\n")
      })
    ]);
    const employers = proposals
      .filter((proposal) => proposal.payload.kind === "employer_history_entry")
      .map((proposal) => ("employer" in proposal.payload ? proposal.payload.employer : ""));
    expect(employers).toEqual(["OnlyCo"]);
  });

  it("stops at the first line it cannot parse", () => {
    const cases = [
      "Engineer | OnlyCo | 2020-01 | present | extra field",
      " | OnlyCo | 2020-01 | present",
      "Engineer |  | 2020-01 | present",
      "Engineer | OnlyCo | not-a-month | present",
      "Engineer | OnlyCo | 2020-01 | not-a-month",
      "Engineer | OnlyCo | 2021-06 | 2020-01"
    ];
    for (const bad of cases) {
      const proposals = parseResumeFacts([
        resume({ normalizedText: ["EXPERIENCE", bad].join("\n") })
      ]);
      expect(proposals).toEqual([]);
    }
  });

  it("keeps roles authored before an unparsable line", () => {
    const proposals = parseResumeFacts([
      resume({
        normalizedText: [
          "EXPERIENCE",
          "Engineer | GoodCo | 2020-01 | present",
          "garbage line"
        ].join("\n")
      })
    ]);
    expect(proposals).toHaveLength(3);
    expect(proposals[0]?.payload).toMatchObject({ employer: "GoodCo" });
  });
});
