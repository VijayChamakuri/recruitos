## T10 plan: runtime use-cases and the end-to-end triage path

**Status: DRAFT, 2026-09-07. Author: Claude Code (`b/` lane).**

Binding parents: `docs/plans/recruitos-candidate-triage-implementation-plan.md` (T10, plus
the command transaction sequence and attempt/work-item state machine), and
`docs/designs/recruitos-candidate-triage-control-plane.md`.

### Goal

Turn the pure decision pipeline into a running wedge. Today `packages/core/src/pipeline`
holds five deterministic functions and every persistence store exists, but nothing calls
them end to end. After T10 a caller can import synthetic candidates, run fixture
extraction, finalize a run, and read a candidate triage packet with real score
arithmetic, confidence terms, routing reasons, evidence gaps, and resolution tasks, all
recorded as immutable history.

### What already exists (do not rebuild)

- All persistence stores under `packages/runtime/src/*/store.ts`, including
  `attempts/store.ts` with `claimAttemptWorkItem`, `completeAttemptWorkItem`,
  `failAttemptWorkItem`.
- The transactional command wrapper: `packages/runtime/src/use-cases/contract.ts`
  (`runUseCaseCommand`) over `packages/runtime/src/commands/executor.ts`.
- Composition root with adapters wired: `packages/runtime/src/composition/runtime.ts`
  (`createRuntime`), ports `Clock` and `IdGenerator`.
- Adapters: `ExtractionAdapter` (fixture variant), `CandidateSourceAdapter` (synthetic
  variant), interfaces in `packages/runtime/src/adapters/`.
- Core pipeline exports: `consolidateStructuredFacts`, `deriveDimensionAssessments`,
  `resolveHardRequirements`, `routeCandidateResult`, `deriveShortlistProposals`, plus
  `computeAggregateScore` and `computeConfidence` from `scoring/`, `normalizeSourceText`
  and `relocateQuote` from `matching/`, `RUBRIC_V1` from `rubric/`.
- Read models (Antigravity, merged): `listCandidates`, `listResolutionTasks`,
  `readCandidatePacket`.

### What does not exist yet

- Any file in `packages/runtime/src/use-cases/` other than `contract.ts`.
- Any scheduler or worker loop. There is no `packages/runtime/src/scheduler/`.
- The bridge from a validated extraction artifact to the core pipeline's evidence and
  fact inputs.
- The hard-requirement policy object that carries the OQ-7 decisions.
- A `make demo` target or `Makefile`.

### Dependency on Cursor (one migration, in parallel)

Cursor takes the migration lock for one PR covering two additions.

**1. Persist the full locked rubric.** T10.5 (finalize) writes a `CandidateTriageResult`
whose seal must reference the real locked rubric: `RUBRIC_V1_HASH`, integer `version`,
`provenance` (`product-authored`, `restsOn` list), and the twenty-four level anchors. The
runtime role store currently persists only `{ rubricId, version, dimensions[dimensionId,
weight, required, definition, jobRelatedJustification] }` and forces `version: "draft-v1"`.

- add `provenance_authorship` and a `rubric_provenance_assumption` child table (or a
  canonical JSON column) to the `rubric` header, and `level_anchor_none` / `_weak` /
  `_partial` / `_strong` to `rubric_dimension` (or a canonical JSON `level_anchors`
  column),
- store `version` as a positive integer,
- update `roles/store.ts` (`prepareRubricDimension`, `insertRubric*`, `readCoreRubric`)
  and `roles/schemas.ts` so `readCoreRubric` reconstructs a rubric that
  `toEqual(RUBRIC_V1)`,
- update `roles.test.ts`, and the `rubricVersion: "draft-v1"` literals in
  `attempts.test.ts`, `runs.test.ts`, `snapshots.test.ts`,
- delete `packages/core/src/rubric/draft-v1.ts`, drop its `rubric/index.ts` export,
  point `roles.test.ts` at `RUBRIC_V1`, and add an architecture rule forbidding any
  `draft-v1` or `DRAFT_RUBRIC_V1` import.

**2. A `candidate_application_answer` table.** OQ-7 makes work authorization a hard
requirement resolved only from a structured application answer, never document text. The
candidate-source adapter yields that answer (`CandidateApplicationAnswers.workAuthorization`,
a `StructuredApplicationAnswer` with `ApplicationAnswerProvenance`), but nothing persists
it. Without the table the work-auth predicate resolves `unknown` for every candidate.

- one row per candidate per answered question:
  `candidate_application_answer_id`, `candidate_id` (FK, `onDelete: "restrict"`),
  `question_key`, `selected_option_key`, `free_text` (nullable), `collected_by`,
  `form_id`, `question_id`, `collected_at`, `created_at`,
- unique on `(candidate_id, question_key)`, index on `candidate_id`,
- a store module `packages/runtime/src/application-answers/` with `prepare` / `insert` /
  `read` following the entities store pattern, plus core ids
  (`CandidateApplicationAnswerIdSchema`),
- no association to a run or attempt; the answer is candidate-scoped and set at import.

T10.1 imports candidates and documents and can merge before this lands; the answer write
in T10.1 is a small follow-up gated on the table. T10.4 reads the table. It must land
before T10.4 and T10.5 merge.

### PR sequence (all on `b/` branches, one coherent change each)

Each PR: `pnpm check` green, `pnpm test:coverage` exit 0 at 100 percent,
`pnpm test:integration`, `git diff --check`, no em dashes. Export every new use-case
through `packages/runtime/src/index.ts` append-only and regenerate
`packages/runtime/src/public-api.test.ts` from `Object.keys(runtime).sort()`. No schema
changes in any T10 PR; if one is needed it is filed to Cursor.

**T10.1  Candidate import use-case**
`packages/runtime/src/use-cases/import-candidates.ts`.
Pull pages from `composition.candidateSource.listCandidates`. Per record: normalize each
document with `normalizeSourceText` (policy version 1), then in one command transaction
(`expectedVersion: 0`, `readVersion` returns 0) insert the candidate entity, its source
documents (reuse an existing `source_document` by `raw_hash` rather than colliding on the
unique index; add `readSourceDocumentByRawHash` to the entities store), the
`candidate_document` links, and `candidate_demographics` when the source carries them.
`candidate_head` is not written here: it is `NOT NULL` on `current_result_id` and is born
at finalize (T10.5). Idempotent per record: a candidate whose `(source_system, source_key)`
already exists is skipped, not reinserted. Returns imported and skipped counts and the
candidate id list. `corpusTag` (`main` / `variant`) and the `channel` mapping to
`inbound` / `sourced` are use-case parameters. Integration test against the synthetic
adapter for a fixed page.

The `workAuthorization` answer write is a small follow-up gated on Cursor's
`candidate_application_answer` table: when the record carries an answer, insert one row
with its `ApplicationAnswerProvenance`.

**T10.2a  Provider output contract**  (precursor, lands first)
`packages/runtime/src/extraction/response.ts`. The raw `body` an `ExtractionAdapter`
returns is opaque to the adapter; this file is where meaning is assigned. Per work item
(one dimension, one document) the body is strict JSON:

```
{
  "dimensionId": "<rubric dimension id>",
  "proposedLevel": "none" | "weak" | "partial" | "strong",
  "spans": [ { "quotedText": "<verbatim, 1..240 chars>", "polarity": "supporting" | "contradicting" } ],
  "rejectedClaims": [ { "kind": "unlocated_quote" | "fabricated_reference" | "unsupported_claim",
                        "quotedText": "<verbatim>", "reason": "<short>" } ]
}
```

No offsets from the model. The tier-1 corpus fixtures are authored against this shape and
its SHA-256 is what `ExtractionSpecContent.schemaHash` commits to.
`parseExtractionResponseBody` does JSON parse plus schema check and tags the failure
(`malformed_json`, `schema_violation`, `unusable_quote`). `locateResponseSpans` relocates
every quote against the stored normalized text with core `relocateQuote` (exact then folded
tier; fuzzy deferred), returning the located `ExtractionAcceptedOutput`, pass-through
`rejectedClaims`, the `droppedQuotes` for the extraction run, and the returned/located span
counts. Structured facts (employment intervals, titles, work-authorization statements) are
candidate-scoped, not dimension-scoped, so they are not in this body; T10.4 handles them.

**T10.2  Extraction scheduler**
`packages/runtime/src/scheduler/`.
A single loop that serves one attempt's work items in manifest order. Per item: claim in a
short transaction (`claimAttemptWorkItem`), then outside the transaction call
`composition.extraction.extract` with the `extractionSpecHash` and normalized documents,
then in a second short transaction parse and locate the response
(`parseExtractionResponseBody`, `locateResponseSpans` from T10.2a), write the
content-addressed artifact or a typed failure and the `extraction_run` row, and move the
item to `succeeded`, `reviewable_failure` (non-none level with no located supporting span),
or `blocked_failure` (fixture miss, malformed body, schema violation). Reuse a completed
artifact by hash before any adapter call. Fixture miss and schema-validation failure are
terminal and not retried. Serial for now; fixture concurrency 8, `SIGINT` grace, and live
retry and backoff are out of scope for T10 and left as documented stubs.

**T10.3  Start triage run use-case**
`packages/runtime/src/use-cases/start-triage-run.ts`.
Given candidate ids, the role, and `RUBRIC_V1`: in one command transaction create a
`triage_attempt` of kind `main_run`, one `attempt_work_item` per candidate in manifest
order, the `triage_run` and its members, and the input seal covering the rubric hash, the
hard-requirement policy hash (T10.4), the normalization and matching policy versions, and
the corpus manifest hash when a manifest is supplied. Returns the run id and attempt id. It
does not drive extraction; the caller runs the scheduler next.

**T10.4  Extraction-to-pipeline bridge and hard-requirement policy**
`packages/runtime/src/results/derive-candidate-result.ts` and
`packages/runtime/src/policy/hard-requirements-v1.ts`.
The bridge takes a validated extraction artifact for one candidate and produces the inputs
the core pipeline consumes: the structured-fact proposals for `consolidateStructuredFacts`
(each with at least one grounding span, quotes relocated against stored normalized text
with `relocateQuote`), and the per-dimension evidence for `deriveDimensionAssessments`.
The policy file is the OQ-7 decision from the signed RubricAssumptionRecord, as declarative
predicate data:

- `work_authorization`: `work_authorization_in` over the `candidate_application_answer`
  row for the work-auth `question_key` only, never document text. No stored answer
  resolves `unknown` and never fails.
- `years_of_experience`: `minimum_experience_months` with a floor of 24, over
  `deriveTenureMonths` on employment ranges. Absence or ambiguity is `unknown`, only a
  conclusive grounded shortfall is `fail`.
- `location`: conservative third requirement. `fail` only on a conclusive stated conflict
  (the candidate states a location the role explicitly excludes). Remote-eligible role or
  silent resume resolves `unknown` and never rejects.

**T10.5  Finalize triage run use-case**  (needs Cursor's migration merged)
`packages/runtime/src/use-cases/finalize-triage-run.ts`.
Precondition: every work item is `succeeded` or `reviewable_failure`; a `blocked_failure`
refuses finalization. Per candidate, in manifest order, inside one command transaction with
the run head and candidate heads as version-qualified preconditions: run the bridge
(T10.4), then `consolidateStructuredFacts`, `deriveDimensionAssessments`,
`resolveHardRequirements` with the v1 policy, `computeAggregateScore`, `computeConfidence`,
`routeCandidateResult`, and `deriveShortlistProposals`. Assemble the `CandidateTriageResult`
content, insert the immutable result with its dimension assessments, evidence gaps, routing
reasons, and publication seal, move the `candidate_head`, and project one resolution task
per escalation reason. A reviewable failure yields an unavailable assessment, explicit
gaps, an `assessment_unavailable` reason, and a recruiter task; it never fabricates a
level, fact, span, score, or rejection. Append audit events in `eventOrdinal` order. Store
the command receipt. Integration test: a small fixed candidate set through import, run,
schedule, finalize, then `readCandidatePacket` asserts the score arithmetic, confidence
terms, and reasons.

**T10.6  Correction and re-extraction use-case**
`packages/runtime/src/use-cases/request-re-extraction.ts`.
From an open resolution task, a human `request_re_extraction` action opens a
`candidate_correction` attempt and moves the task head to the request action. Retryable
work re-extracts; blocked work projects blocked. A system `reextraction_completed` action
writes a superseding `CandidateTriageResult`, moves the candidate head, and projects the
task to `review_required`. The original result and its evidence stay inspectable. Not on
the demo happy path; lands last.

### Out of scope for T10

Live extraction retry and backoff beyond a documented stub. The Trust Center and packet
UI. The tier-one corpus content (separate task, unblocked now that the rubric is locked).
`demo:reset` beyond what the plan already reserves. The six Playwright workflow bodies
(Antigravity).

### Risks

- The bridge in T10.4 is the least specified seam. Keep the artifact-to-evidence mapping in
  one file with its own unit tests so a corpus-authoring surprise is a local change.
- Finalize is one large transaction. Follow the plan's twelve-step sequence exactly;
  version-qualify every head update and require one affected row.
- Confidence and score inputs come from the locked rubric and policy hashes. If Cursor's
  migration changes the stored rubric shape, re-pin `RUBRIC_V1_HASH` in the seal assertions
  before merging T10.5.
