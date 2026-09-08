import { describe, expect, it } from "vitest";

import { FixtureExtractionAdapter, SyntheticCandidateSourceAdapter } from "../adapters/index.js";
import { DEMO_CANDIDATE_SOURCE_KEY, DEMO_CLOCK_MS } from "../corpus/index.js";
import { demoCompositionOptions } from "./demo.js";

describe("demoCompositionOptions", () => {
  it("wires the fixed clock, deterministic ids, seeded source, and fixture adapter", () => {
    const options = demoCompositionOptions({ database: { filename: ":memory:" } });

    expect(options.database).toEqual({ filename: ":memory:" });
    expect(options.migrate).toBe(true);
    expect(options.clock?.now()).toBe(DEMO_CLOCK_MS);
    expect(options.idGenerator?.next()).toMatch(/^demo-/);
    expect(options.extraction).toBeInstanceOf(FixtureExtractionAdapter);
    expect(options.candidateSource).toBeInstanceOf(SyntheticCandidateSourceAdapter);
    expect(
      (options.candidateSource as SyntheticCandidateSourceAdapter).hasCandidate(
        DEMO_CANDIDATE_SOURCE_KEY
      )
    ).toBe(true);
  });

  it("lets the caller override any default", () => {
    const clock = { now: (): number => 42 };
    const options = demoCompositionOptions({
      database: { filename: ":memory:" },
      clock,
      migrate: false
    });
    expect(options.clock).toBe(clock);
    expect(options.migrate).toBe(false);
  });
});
