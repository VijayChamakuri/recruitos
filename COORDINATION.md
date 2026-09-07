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
| origin/main | e8abc07 |
| Migration lock held by | Cursor, for the run + scheduler tables (`triage_run`, `triage_run_member`, `triage_run_seal`, `triage_attempt`, `attempt_work_item`) |
| Rubric v1 | DRAFT, not locked. Do not run `/plan-ceo-review` until a human answers the 10 practitioner questions in `docs/designs/rubric-lock-prep.md`. |

## Lanes and file locks

| Agent | Branch prefix | Owns (may edit) | Must not touch |
|---|---|---|---|
| Cursor | `a/` or `cursor/` | (none) | idle-complete |
| Claude Code | `b/` | scheduler tables migration, `packages/runtime/src/composition/**`, command use-cases, scheduler (T5), `docs/designs/rubric-lock-prep.md`, `WORKFLOW_ASSUMPTIONS.md` | `apps/**` |
| Antigravity | `c/` | `apps/cli/**`, `apps/web/**`, Playwright / eval / benchmark scaffolds, stubbed composition interface | `packages/runtime/src/**`, any migration |

## Migration chain (Cursor, serial, one PR each)

1. `resolution_task` + `resolution_action` + `resolution_task_head` (MERGED #22)
2. `proposal` + `review_decision` + `proposal_head` (MERGED #23)
3. `candidate_head` (MERGED #25)
4. `candidate_result_seal` (MERGED #26)

## Currently building

| Agent | Branch | Item | State |
|---|---|---|---|
| Cursor | (pending) | Takes the run + scheduler migration: `triage_run` + `triage_run_member` + `triage_run_seal`, then `triage_attempt` + `attempt_work_item`. Holds the migration lock. | assigned |
| Claude Code | b/runtime-usecase-contract | PR 2: `src/use-cases/contract.ts` (envelope builder + `executeCommand` wrapper). No migration. Real use-cases wait on core text normalization (T9, not built). | building |
| Antigravity | (none) | CLI and Web shells complete. Merged #29. Idle-complete. | idle-complete |

## Hard rules

1. One open PR touching `packages/runtime/drizzle/**` at a time. Cursor holds it for the whole chain. Others file schema requests to Cursor, nobody else adds a migration.
2. Shared rebase file: `packages/runtime/src/public-api.test.ts`. Never hand-merge the export array. On conflict: `pnpm build`, then regenerate from `Object.keys(runtime).sort()`.
3. `packages/runtime/src/index.ts`, `package.json` exports, `vitest.config.ts`: append-only, alphabetical, union on conflict.
4. Rebase onto latest `origin/main` immediately before requesting merge. If `origin/main` moved during review, rebase again.
5. Green before merge: `pnpm check`, `pnpm test:coverage` (repo enforces 100 percent), `pnpm test:integration`, `git diff --check`, em-dash scan. No em dashes anywhere.
6. Squash-merge, delete branch.
7. Item 4: "docs staged" is Claude's done state. "Rubric ready" needs a human to answer OQ-1 through OQ-10 and pick recruiter call vs `RubricAssumptionRecord`.
8. Scheduler (T5), composition root, and command use-cases are reserved for Claude, deferred until the migration chain is on `main`.

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
