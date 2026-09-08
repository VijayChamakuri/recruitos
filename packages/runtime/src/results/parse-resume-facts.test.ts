import { describe, expect, it } from "vitest";

import { parseResumeFacts, type ResumeFactDocument } from "./parse-resume-facts.js";

function resume(overrides: Partial<ResumeFactDocument> = {}): ResumeFactDocument {
  return {
    candidateDocumentId: "cdoc_1",
    documentKind: "resume",
    normalizedText: [
      "Summary line",
      "",
      "EXPERIENCE (STRUCTURED)",
      "Senior Machine Learning Engineer | TechCorp | 2021-03 | present",
      "Machine Learning Engineer | DataCo | 2019-06 | 2021-02"
    ].join("\n"),
    ...overrides
  };
}

function block(...roleLines: string[]): ResumeFactDocument {
  return resume({
    normalizedText: ["EXPERIENCE (STRUCTURED)", ...roleLines].join("\n")
  });
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
      expect(proposal.evidenceSpanIds).toBeUndefined();
      expect(proposal.groundingQuotes).toHaveLength(1);
      expect(proposal.groundingQuotes![0]!.polarity).toBe("supporting");
    }
    // The grounding quote for each employment role is the verbatim role line.
    expect(proposals[0]!.groundingQuotes![0]!.quotedText).toBe(
      "Senior Machine Learning Engineer | TechCorp | 2021-03 | present"
    );
  });

  it("takes the current title from the most recent still-present role", () => {
    const [, , , , currentTitle] = parseResumeFacts([resume()]);
    expect(currentTitle?.payload).toEqual({
      kind: "current_title",
      title: "Senior Machine Learning Engineer"
    });
  });

  it("picks the latest start month when no role is still present", () => {
    const proposals = parseResumeFacts([
      block(
        "Engineer | EarlyCo | 2018-01 | 2021-12",
        "Staff Engineer | LateCo | 2022-01 | 2023-06"
      )
    ]);
    expect(proposals.at(-1)?.payload).toMatchObject({
      kind: "current_title",
      title: "Staff Engineer"
    });
  });

  it("prefers a later role that is still present over an earlier closed one", () => {
    const proposals = parseResumeFacts([
      block(
        "Engineer | EarlyCo | 2018-01 | 2019-01",
        "Staff Engineer | NowCo | 2022-01 | present"
      )
    ]);
    expect(proposals.at(-1)?.payload).toMatchObject({
      kind: "current_title",
      title: "Staff Engineer"
    });
  });

  it("parses a closed interval into an iso year-month end", () => {
    const proposals = parseResumeFacts([block("Engineer | OnlyCo | 2020-01 | 2021-02")]);
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

  it("contributes nothing when the sentinel is present but the block is empty", () => {
    expect(
      parseResumeFacts([resume({ normalizedText: "EXPERIENCE (STRUCTURED)\n\nOther section" })])
    ).toEqual([]);
  });

  it("contributes nothing without the structured sentinel", () => {
    expect(
      parseResumeFacts([
        resume({
          normalizedText: [
            "EXPERIENCE",
            "Engineer | OnlyCo | 2020-01 | present"
          ].join("\n")
        })
      ])
    ).toEqual([]);
  });

  it("ends the block at the first blank line", () => {
    const proposals = parseResumeFacts([
      resume({
        normalizedText: [
          "EXPERIENCE (STRUCTURED)",
          "Engineer | OnlyCo | 2020-01 | present",
          "",
          "Older roles omitted for brevity"
        ].join("\n")
      })
    ]);
    const employers = proposals
      .filter((proposal) => proposal.payload.kind === "employer_history_entry")
      .map((proposal) => ("employer" in proposal.payload ? proposal.payload.employer : ""));
    expect(employers).toEqual(["OnlyCo"]);
  });

  it("contributes nothing when any line in the block is malformed", () => {
    const cases = [
      ["Engineer | OnlyCo | 2020-01 | present | extra field"],
      [" | OnlyCo | 2020-01 | present"],
      ["Engineer |  | 2020-01 | present"],
      ["Engineer | OnlyCo | not-a-month | present"],
      ["Engineer | OnlyCo | 2020-01 | not-a-month"],
      ["Engineer | OnlyCo | 2021-06 | 2020-01"],
      // one good role then unsupported older history on the very next line
      ["Engineer | GoodCo | 2022-01 | present", "Senior Dev, OldCo, 2015 to 2018"]
    ];
    for (const roleLines of cases) {
      expect(parseResumeFacts([block(...roleLines)])).toEqual([]);
    }
  });
});
