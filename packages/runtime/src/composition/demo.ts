import {
  createFixtureExtractionAdapter,
  createSyntheticCandidateSourceAdapter
} from "../adapters/index.js";
import {
  DEMO_CLOCK_MS,
  demoCandidateSourceRecords
} from "../corpus/demo/demo-corpus.js";
import { createIncrementingIdGenerator, fixedClock } from "./ports.js";
import type { CreateRuntimeOptions } from "./runtime.js";

/**
 * The `createRuntime` options for the local demo spine. The synthetic candidate
 * source is pre-seeded with the one-candidate proving corpus and the extraction
 * adapter starts empty; `demoPrepare` registers the fixture bodies once
 * `startTriageRun` has minted the extraction specs. The clock is fixed and the
 * id generator is deterministic, so a clean checkout produces a byte-identical
 * sealed result.
 *
 * The caller supplies `database`. Any field it passes overrides the demo
 * default, so a test can swap in its own clock or adapters.
 */
export function demoCompositionOptions(
  base: Pick<CreateRuntimeOptions, "database"> & Partial<CreateRuntimeOptions>
): CreateRuntimeOptions {
  return {
    migrate: true,
    clock: fixedClock(DEMO_CLOCK_MS),
    idGenerator: createIncrementingIdGenerator("demo"),
    candidateSource: createSyntheticCandidateSourceAdapter({
      records: demoCandidateSourceRecords()
    }),
    extraction: createFixtureExtractionAdapter(),
    ...base
  };
}
