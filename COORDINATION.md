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
| origin/main | 329fd93 |
| Migration lock held by | Cursor, for the full chain below |
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
| Cursor | cursor/resolution-task-persistence-3840 | chain step 1 | starting |
| Claude Code | (none) | Item 4 verified already complete on main via #11 and #12. Idle, reserved for composition root, command use-cases, scheduler T5, deferred until Cursor's migration chain lands. | idle-reserved |
| Antigravity | c/adapter-implementations | fixture `ExtractionAdapter` + `CandidateSourceAdapter`, integration tests | ready for review |

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
