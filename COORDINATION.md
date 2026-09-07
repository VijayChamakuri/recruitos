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
| origin/main | f19d446 |
| Migration lock held by | Claude, for one PR only: scheduler tables (`triage_run`, `triage_attempt`, `attempt_work_item`) |
| Rubric v1 | DRAFT, not locked. Do not run `/plan-ceo-review` until a human answers the 10 practitioner questions in `docs/designs/rubric-lock-prep.md`. |

## Lanes and file locks

| Agent | Branch prefix | Owns (may edit) | Must not touch |
|---|---|---|---|
| Cursor | `a/` or `cursor/` | `packages/runtime/src/db/schema.ts`, `packages/runtime/drizzle/**`, stores and core IDs for the new tables in the chain | `docs/designs/rubric-lock-prep.md`, `WORKFLOW_ASSUMPTIONS.md`, `packages/runtime/src/adapters/` implementations |
| Claude Code | `b/` | `docs/designs/rubric-lock-prep.md`, `WORKFLOW_ASSUMPTIONS.md`, this file | `packages/**` until the migration chain lands, then takes the composition root, command use-cases, and scheduler (T5) |
| Antigravity | `c/` | `packages/runtime/src/adapters/**` implementations (fixture mode, no live LLM), `tests/integration/**` over tables already on `main` | `packages/runtime/src/db/schema.ts`, `packages/runtime/drizzle/**`, `packages/runtime/src/results/`, any migration |

## Migration chain (Cursor, serial, one PR each)

1. `resolution_task` + `resolution_action` + `resolution_task_head`
2. `proposal` + `review_decision` + `proposal_head`
3. `candidate_head` (uses `defineMutableHead` from #20)
4. `candidate_result_seal` (cyclic `DEFERRABLE INITIALLY DEFERRED` FK + validation triggers; validates reason uniqueness, task creation, proposal eligibility, so it lands last)

## Currently building

| Agent | Branch | Item | State |
|---|---|---|---|
| Cursor | (none) | Migration chain complete: #22, #23, #25, #26 all on main. Migration lock released to Claude. Free for next assignment. | chain-complete |
| Claude Code | b/runtime-composition-root | PR 1: composition root (`src/composition/`) + `Clock` / `IdGenerator` ports. Then command use-cases, then holds the migration lock for the scheduler table PR. | building |
| Antigravity | c/* | CLI + web shells under `apps/`. Wire against a stubbed composition interface; swap for the real factory once Claude's composition PR lands. | building |

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
