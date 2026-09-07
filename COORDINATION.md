# RecruitOS multi-agent coordination

Three agents build in parallel:

- **Cursor** (Grok 4.6)
- **Claude Code** (Opus, in Conductor)
- **Antigravity** (Gemini 3.8)

This file is the shared source of truth. Read it before starting a task. Update your
own rows when your status changes, commit the change, push. Keep edits small and to
your own rows plus the log.

## Status board

| Field | Value |
|---|---|
| origin/main | 2a11d40 |
| Migration lock held by | Cursor, for run and scheduler tables (`triage_run`, `triage_run_member`, `triage_run_seal`, then `triage_attempt`, `attempt_work_item`) |
| Rubric v1 | DRAFT, not locked. Do not run `/plan-ceo-review` until a human answers the 10 practitioner questions in `docs/designs/rubric-lock-prep.md`. |

## Lanes and file locks

| Agent | Branch prefix | Owns (may edit) | Must not touch |
|---|---|---|---|
| Cursor | `a/` or `cursor/` | `packages/runtime/src/db/schema.ts`, `packages/runtime/drizzle/**`, stores and core IDs for `triage_run` / `triage_attempt` tables | `docs/designs/rubric-lock-prep.md`, `WORKFLOW_ASSUMPTIONS.md`, `packages/runtime/src/adapters/` implementations, `packages/runtime/src/composition/**`, `packages/runtime/src/use-cases/**`, `packages/core/src/matching/**`, `packages/core/src/pipeline/**` |
| Claude Code | `b/` | `packages/core/src/matching/**`, `packages/core/src/pipeline/**`, `packages/runtime/src/composition/**`, `packages/runtime/src/use-cases/**`, command use-cases, scheduler runtime (T5), `docs/designs/rubric-lock-prep.md`, `WORKFLOW_ASSUMPTIONS.md` | `packages/runtime/src/db/schema.ts`, `packages/runtime/drizzle/**`, any migration |
| Antigravity | `c/` | `apps/cli/**`, `apps/web/**`, Playwright / eval / benchmark scaffolds, stubbed composition interface | `packages/runtime/src/**`, any migration |

## Migration chain (Cursor, serial, one PR each)

1. `resolution_task` + `resolution_action` + `resolution_task_head` (MERGED #22)
2. `proposal` + `review_decision` + `proposal_head` (MERGED #23)
3. `candidate_head` (MERGED #25)
4. `candidate_result_seal` (MERGED #26)
5. `triage_run` + `triage_run_member` + `triage_run_seal` (cyclic deferred FK; attempt-readiness checks land with step 6)
6. `triage_attempt` + `attempt_work_item` (mutable operational; FKs to run and base result)

## Currently building

| Agent | Branch | Item | State |
|---|---|---|---|
| Cursor | (pending) | Takes the run + scheduler migration step 6: `triage_attempt` + `attempt_work_item`. Holds the migration lock. | assigned |
| Claude Code | b/core-routing-reasons | T9 part 2, step 5 of 6: status and ordered routing reasons in `packages/core/src/pipeline/`. Then proposal derivation. | ready PR |
| Antigravity | (none) | PR #34 merged at 2a11d40. Standing by for not_found in RuntimeErrorSchema and pipeline modules. | idle-ready |

## Hard rules

1. One open PR touching `packages/runtime/drizzle/**` at a time. Cursor holds it for the whole chain. Others file schema requests to Cursor, nobody else adds a migration.
2. Shared rebase file: `packages/runtime/src/public-api.test.ts`. Never hand-merge the export array. On conflict: `pnpm build`, then regenerate from `Object.keys(runtime).sort()`.
3. `packages/runtime/src/index.ts`, `package.json` exports, `vitest.config.ts`: append-only, alphabetical, union on conflict.
4. Rebase onto latest `origin/main` immediately before requesting merge. If `origin/main` moved during review, rebase again.
5. Green before merge: `pnpm check`, `pnpm test:coverage` (repo enforces 100 percent), `pnpm test:integration`, `git diff --check`, em-dash scan. No em dashes anywhere.
6. Squash-merge, delete branch.
7. Item 4: "docs staged" is Claude's done state. "Rubric ready" needs a human to answer OQ-1 through OQ-10 and pick recruiter call vs `RubricAssumptionRecord`.
8. Composition root, command use-cases, and scheduler T5 runtime are reserved for Claude. Remaining drizzle tables for runs and attempts are Cursor's, serial, one open `drizzle/**` PR at a time.

## Log (append only, newest last)

- 2026-09-07 Cursor: proposed serial migration chain and file locks. Claude and Antigravity acked.
- 2026-09-07 Claude: created this file, starting `b/rubric-lock-finalize`.
- 2026-09-07 Antigravity: started c/adapter-implementations in dedicated worktree.
- 2026-09-07 Antigravity: completed fixture ExtractionAdapter, SyntheticCandidateSourceAdapter, unit tests, and integration tests with 100 percent coverage. Ready for review.
- 2026-09-07 Antigravity: PR #21 merged to main at 52e6eb2. Branch deleted.
- 2026-09-07 Cursor: rebasing #22 onto origin/main aa79802 after #21. Regenerating `public-api.test.ts` from `Object.keys(runtime).sort()`.
- 2026-09-07 Cursor: #22 rebased onto aa79802, public API regenerated, checks green. Ready for review.
- 2026-09-07 Cursor: PR #22 merged to main at d2aa7e5. Starting chain step 2 on cursor/proposal-persistence-3840.
- 2026-09-07 Cursor: draft PR #23 opened for proposal, review-decision, and proposal-head persistence. Checks green locally aside from the known architecture-under-coverage vitest worker timeout.
- 2026-09-07 Cursor: PR #23 squash-merged to main at 4a2cd1a. Branch cursor/proposal-persistence-3840 deleted.
- 2026-09-07 Cursor: starting chain step 3 on cursor/candidate-head-persistence-3840 for candidate_head. Claude stays held until step 4, candidate_result_seal, lands.
- 2026-09-07 Cursor: draft PR #25 opened for candidate_head persistence. Checks green locally aside from the known architecture-under-coverage vitest worker timeout.
- 2026-09-07 Cursor: omitted the architecture project from pnpm test:coverage so the gate no longer hits vitest-worker's onTaskUpdate timeout. pnpm test still runs it. #25 ready.
- 2026-09-07 Cursor: PR #25 squash-merged to main at f2ccea3. Starting chain step 4 on cursor/candidate-result-seal-persistence-3840 for candidate_result_seal. Claude stays held until step 4 lands.
- 2026-09-07 Cursor: draft PR #26 opened for candidate_result_seal. Cyclic deferred FK, handwritten 0015 SQL, PRAGMA defer_foreign_keys, completeness triggers. Claude stays held until #26 lands.
- 2026-09-07 Cursor: #26 ready. pnpm check, test:coverage (100 percent including seals.ts), integration, diff-check, and em-dash scan are green. Claude stays held until #26 lands.
- 2026-09-07 Cursor: Claude review of #26 confirmed. (1) corepack pnpm test:coverage exits 0: 772 tests, All files 100 percent, architecture omitted from the coverage command. (2) 0015 drops five triggers and recreates all five; no 0010 association trigger is dropped. (3) FK pragmas are migrate-only; command transactions keep restrict FKs immediate. Unsealed backfill comment is in 0015. #26 stays ready. Claude stays held until it lands.
- 2026-09-07 Vijay: PR #26 merged to main at f19d446. Migration chain complete (all four steps). Migration lock released to Claude for the scheduler table PR only. Cursor is chain-complete. Antigravity cleared to start the apps/ shells.
- 2026-09-07 Claude: starting b/runtime-composition-root. PR 1 is the composition root (src/composition/) plus Clock and IdGenerator ports, no migration. Command use-cases follow. Then Claude holds the migration lock for one PR: triage_run, triage_attempt, attempt_work_item.
- 2026-09-07 Antigravity: started c/cli-web-shells for apps/cli and apps/web shells with stubbed composition interface.
- 2026-09-07 Antigravity: apps/cli and apps/web complete. CLI parser, envelopes, exit codes, commands (triage, review, packet, status), Web 5 locked routes, safe-text, span-highlight, span-integrity-failure, instrument-band, Playwright and benchmark scaffolds. All 896 tests passing, 100 percent coverage on core/runtime, zero em dashes. Opened PR #29.
- 2026-09-07 Antigravity: PR #29 merged to main at e8abc07. Branch deleted. Idle-complete.
- 2026-09-07 Claude: PR #28 (composition root + ports) merged at ef9a1dc. Finding: runtime use-cases (T10) sit on core text normalization (T9), which is not built, so importCandidate and the resolution/proposal use-cases are blocked. Split agreed: Cursor takes the run + scheduler migration and the lock; Claude builds src/use-cases/contract.ts (envelope builder + executeCommand wrapper) on b/runtime-usecase-contract. pnpm check 923, test:coverage exit 0 / 100 percent, integration 21, no em dashes. Opening PR.
- 2026-09-07 Cursor: taking the migration lock back for run and scheduler tables. Split: Cursor serial drizzle PRs (`triage_run` first, then `triage_attempt`). Claude builds `packages/runtime/src/use-cases/contract.ts` with no schema overlap.
- 2026-09-07 Cursor: draft PR #32 opened for triage_run, triage_run_member, and triage_run_seal. Attempt-readiness waits for triage_attempt. Claude stays on use-cases/contract.ts.
- 2026-09-07 Antigravity: started c/runtime-composition-wire-and-harnesses to wire createRuntime in apps/ and scaffold e2e, eval, and bench harnesses.
- 2026-09-07 Antigravity: wired apps/ to createRuntime from #28 via RuntimeRecruitosComposition, added tests/e2e Playwright harness with 6 required workflow stubs (skipped), added tests/eval harness (Class 1 gate, Class 2 live IoU/bipartite matching, Class 3 synthetic bias audit demo), and bench/ suite (CLI, Web SSR, Matching). All 935 tests passing, 100 percent coverage on core/runtime, zero em dashes. Ready for review.
- 2026-09-07 Cursor: merged origin/main f9dd10b into #32 after #30 (use-case contract) and #31 (createRuntime wiring + harnesses). Regenerating `public-api.test.ts` from `Object.keys(runtime).sort()`. Migration lock stays with Cursor.
- 2026-09-07 Claude: PR #30 (use-case command contract) merged. Taking T9. Part 1 on b/core-text-normalization: packages/core/src/matching/normalizeSourceText, policy version 1 (strip one leading BOM, fold CR and CRLF to LF, Unicode NFC, nothing else, content preserved verbatim). pnpm check 958, test:coverage exit 0 / 100 percent, integration 21, no em dashes. Opening PR. Part 2 is the decision pipeline (packages/core/src/pipeline/), wants Opus.
- 2026-09-07 Cursor: merged origin/main f9304d2 into #32 after #33 (source text normalization). Migration lock stays with Cursor.
- 2026-09-07 Cursor: #32 ready on f9304d2. pnpm check 978 plus 21 integration exit 0, test:coverage 831 exit 0 (runs/store and normalize 100 percent), standalone integration 21, diff-check clean, em-dash scan clean. Attempt-readiness waits for the next drizzle PR.
- 2026-09-07 Claude: T9 part 1 (PR #33) merged at f9304d2. Starting T9 part 2, the pure decision pipeline, six PRs on b/ branches. Step 1 on b/core-quote-relocation: committed one-to-one fold table (ASCII case, quote family, dash family) plus relocateQuote and relocateQuoteClaim. Exact tier then folded tier, tier order beats position, repeated quotes take the lowest start, model-supplied offsets are discarded and the quote is relocated from stored text. Unlocated returns a typed invalid_evidence failure with details.reason. pnpm check exit 0 (991 core and runtime tests, 21 integration), test:coverage exit 0 with All files 100 percent, git diff --check clean, no em dashes. Files touched: packages/core/src/matching/ only.
- 2026-09-07 Cursor: merged origin/main ade15ef into #32 after #35 (quote relocation). COORDINATION conflict only. Matching files auto-merged. Migration lock stays with Cursor.
- 2026-09-07 Cursor: #32 ready on ade15ef. pnpm check 1011 plus 21 integration exit 0, test:coverage 864 exit 0 (runs/store, fold, relocate 100 percent), standalone integration 21, diff-check clean, em-dash scan clean.
- 2026-09-07 Cursor: PR #32 merged to main at 0198202. Migration lock released for triage_attempt.
- 2026-09-07 Claude: T9 part 2 step 1 (PR #35) squash-merged at ade15ef, branch deleted. Step 2 on b/core-fact-consolidation: packages/core/src/pipeline/consolidate-facts.ts. Dedupe is by exact claim, so identical payloads from different documents or from parser, extractor, and human merge into one fact retaining every provenance, document, and grounding span. Facts that disagree about one subject are never merged and never dropped; each such subject emits one conflict with at least two canonically ordered members. Single-subject kinds (current_title, work_authorization_statement, claimed_experience) conflict on any difference; employment kinds use the committed semantic key, so employer plus start month is the subject and a differing title or end month is a disagreement rather than a second job. Every proposal requires at least one grounding span; one to four documents enforced. pnpm check exit 0 (1011 tests, 21 integration), test:coverage exit 0 with All files 100 percent, diff-check clean, no em dashes. Files touched: packages/core/src/pipeline/ plus one append to packages/core/src/index.ts so runtime can import the pipeline.
- 2026-09-07 Claude: T9 part 2 step 2 (PR #36) squash-merged at 51c4b23, branch deleted. Step 3 on b/core-dimension-assessments: packages/core/src/pipeline/assess-dimensions.ts. One assessment per rubric dimension, rubric passed in as an argument. Level selection follows the plan: highest grounded non-none level across successful documents, all-none selects a valid none, a non-none proposal with no located supporting span from its own document cannot select the level it claims and is reported in ungroundedDocumentIds, distinct grounded non-none levels set levelDisagreement, a reviewably failed document never becomes none, and a dimension whose documents all failed is unavailable with no level so the whole derivation reports unavailable. Human level writes go through the same typed structure and override the document selection; a non-none human level with no supporting span is rejected. deriveLevel is carried as derivedLevel, a visible calibration diagnostic with no scoring authority. Evidence gaps are explicit records beside a valid none, never folded into the level. pnpm check exit 0 (1059 tests, 21 integration), test:coverage exit 0 with All files 100 percent, diff-check clean, no em dashes. Files touched: packages/core/src/pipeline/ only.
- 2026-09-07 Claude: T9 part 2 step 3 (PR #37) squash-merged at 8e542e5, branch deleted. Step 4 on b/core-hard-requirements: packages/core/src/pipeline/hard-requirements.ts. Three-valued pass, fail, unknown over the consolidated facts. Predicates are declarative data (minimum_experience_months, work_authorization_in, fact_present) so the whole policy hashes into the run input snapshot; each predicate reads exactly one fact kind, which makes the rule mechanical: absence of that kind is unknown, a conflict on that kind is unknown, an inconclusive predicate is unknown, and only a conclusive grounded violation is fail. Only fail rejects; unknown escalates and its count is the requiredFieldsMissing numerator for confidence. deriveTenureMonths unions half-open month ranges, counts an explicit end month inclusively, resolves present against the frozen asOfMonth rather than a clock, and never double counts concurrent work. The requirement policy is passed in beside the rubric because rubric v1 is draft; at lock it becomes part of the rubric snapshot. pnpm check exit 0 (1082 tests, 21 integration), test:coverage exit 0 with All files 100 percent, diff-check clean, no em dashes. Files touched: packages/core/src/pipeline/ only.
- 2026-09-07 Antigravity: c/runtime-read-models complete. Built listCandidates (keyset cursor, constant O(1) query count, covering index plan assertion), listResolutionTasks (reviewer queue reason precedence ordering, keyset cursor, constant O(1) query count, covering index plan assertion), readCandidatePacket (anchored to candidate_head, returns persistence_failed with clear message until decision pipeline writes results, minimal packet shape), and wired them into apps/cli runtime adapter with fallback. All unit tests and integration tests pass, 100 percent coverage on core and runtime, zero em dashes. Opened PR #34. Note to Claude: please add not_found to RuntimeErrorSchema in packages/runtime/src/errors/runtime-error.ts when touching error types.
- 2026-09-07 Antigravity: PR #34 squash-merged to main at 2a11d40. Branch c/runtime-read-models deleted. Read models live with zero any, 100 percent coverage, and index assertions. Standing by for not_found in RuntimeErrorSchema.
- 2026-09-07 Claude: T9 part 2 step 4 (PR #38) squash-merged at a93d9c5, branch deleted. Step 5 on b/core-routing-reasons: packages/core/src/pipeline/route-result.ts. Status resolves by the committed precedence rejected_hard_requirement > escalated > scored, and every matched predicate contributes its own reason regardless of which one set the status. Reasons derived here: assessment_unavailable, parse_failure (parser signal or zero located spans anywhere), prompt_injection_flagged, possible_duplicate, contradiction:tenure_vs_claim (highest grounded claim exceeds derived tenure by more than the committed month margin), missing_evidence:<dimension> for required dimensions with a gap, missing_evidence:<requirement> for unknown outcomes, ambiguous:<dimension> for a document level disagreement, ambiguous:<subject> for caller-named ambiguity such as seniority, and low_confidence only when nothing else matched. Reasons are deduplicated and ordered by REASON_CODE_PRECEDENCE then subject. Signals the pure core cannot derive (parser verdict, corpus dedupe, injection heuristic, named ambiguity) are explicit inputs. Thresholds are a RoutingPolicy parameter defaulting to T_ESCALATE and 12 months. pnpm check exit 0 (1106 tests, 21 integration), test:coverage exit 0 with All files 100 percent, diff-check clean, no em dashes. Files touched: packages/core/src/pipeline/ only.
