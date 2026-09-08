# RecruitOS Demo Spine Phase: Context, Roadmap, Tasks, Skills

Status: ACTIVE. Supersedes the "Currently building" rows in `COORDINATION.md` for
this phase. Read before picking up any task.

## 1. Where the project stands

The runtime pipeline is complete end to end through finalization. Merged to `main`:

| Piece | PR |
|---|---|
| Rubric v1 lock plus full persistence (provenance, anchors, integer version) | #47, #53 |
| `DRAFT_RUBRIC_V1` shim removed plus architecture rule | #49, #53 |
| Candidate import use-case | #54 |
| Extraction provider output contract (`ExtractionResponseBody`) | #55 |
| Serial extraction scheduler | #57 |
| `candidate_application_answer` table plus store (OQ-7 work authorization) | #53 |
| Start triage run use-case | #59 |
| Extraction-to-pipeline bridge plus OQ-7 hard-requirement policy v1 | #60 |
| `extraction_run` persistence plus `attempt_work_item.extraction_run_id` | #58 |
| Finalize triage run use-case (results, seals, head moves, resolution tasks) | #61 |

In review: PR #62. The serial scheduler now writes one `extraction_run` row per
processed work item and links it on complete and fail; `finalizeTriageRun`
aggregates those rows so the confidence resolution term is real (an unlocated
extractor quote lowers confidence) rather than hardcoded to 1. No schema change.

What does not exist yet:

- Any way to run the pipeline. `apps/cli` commands are shells over a stub.
- Any synthetic corpus with expected outcomes.
- The human correction and re-extraction loop (T10.6).
- The demo path (`make demo`).
- The product UI (T12).

## 2. The milestone

First real demo spine. From a clean checkout, one command: migrate a local
SQLite database, import synthetic candidates, run deterministic fixture
extraction, finalize, and print a sealed triage packet as text. Plus a second
command sequence proving the human correction loop end to end.

This is what `/plan-ceo-review` evaluates: working software for the two core
promises (explainable deterministic triage, and human oversight that can correct
a decision), not planned work. A corpus alone is not the milestone. A CLI over
stubs is not the milestone.

## 3. Hard constraints for this phase

- No live LLM or provider credentials. Fixture extraction only, deterministic,
  offline. `/cso` is the gate before any credential ever enters the picture.
- No T12 UI. No web serving. `make demo` stops at print-packet.
- No full 20 to 25 adversarial corpus. Minimal 7-route slice only. The full
  corpus is for measuring the system (Class 2 evals, calibration) and is
  post-review work.
- 100 percent test coverage enforced by `pnpm test:coverage`. No em dashes
  anywhere: code, comments, docs, commit messages, product copy.
- One open `packages/runtime/drizzle/**` PR at a time. Schema changes go to
  Cursor only; everyone else files a request in `COORDINATION.md`.
- `COORDINATION.md` is the source of truth. Read it before starting a task. Edit
  only your own rows plus the append-only log. Commit, push. Each agent works in
  its own worktree; no branch operations in another agent's tree.
- `public-api.test.ts` is never hand-merged; on conflict run `pnpm build` then
  regenerate from `Object.keys(runtime).sort()`.
- Green before merge: `pnpm check`, `pnpm test:coverage` (100 percent),
  `pnpm test:integration`, `git diff --check`, em-dash scan. Squash-merge,
  delete branch. Rebase onto latest `origin/main` right before requesting merge.

## 4. Sequence (9 steps)

| # | Step | Owner |
|---|---|---|
| 1 | Review and merge PR #62 | Cursor (persistence lens) plus Codex (`/review`) |
| 2 | `/context-save`, push `main` | Codex |
| 3 | `demo:prepare` orchestration use-case plus 1-candidate proving corpus (contract, fixture-hash keying, expected-outcome file) | Claude |
| 4 | CLI wired to real use-cases plus `make demo` (print packet only) | Codex |
| 5 | Connect existing `tests/eval` Class 1 harness to a real finalized run | Codex |
| 6 | Expand to the 7-route corpus | Claude authors, Codex validates outcomes |
| 7 | T10.6 narrow correction and re-extraction slice (CLI-only, fixture-only) | Claude |
| 8 | CEO review: Codex runs clean-checkout `make demo` verification and readiness call, then `/plan-ceo-review` | Codex |
| 9 | Larger corpus plus product surfaces | later |

Steps 3 and 4 overlap: Claude ships `demo:prepare` and the proving corpus, which
unblocks Codex's CLI wiring. Step 7 waits until 3 through 6 are green.

## 5. Task ownership

| Task | Owner | Lane |
|---|---|---|
| PR #62 (Step 0) | Claude | `b/`, ready |
| Review #62 | Cursor plus Codex | |
| `demo:prepare` orchestration use-case (migrate, import, drive scheduler, finalize) | Claude | `packages/runtime/src/use-cases/` |
| Corpus contract plus 1-candidate proving corpus, keyed to `startTriageRun`'s `extractionSpecHash` | Claude | corpus fixtures plus expected-outcome format |
| CLI commands to real use-cases: open and migrate db, `import`, `triage:run`, `triage:extract`, `triage:finalize`, `packet` (text), `eval:class1` | Codex | `apps/cli/**` (held this phase) |
| `make demo` Makefile chaining the CLI, print-packet only | Codex | `apps/`, root |
| Class 1 harness against a real finalized run | Codex | `tests/eval` (held this phase) |
| Expand corpus to 7-route slice | Claude authors, Codex validates | |
| T10.6 correction and re-extraction slice | Claude | `packages/runtime/src/use-cases/` |
| Merge-gate `/review` on every PR; clean-checkout verification; `/plan-ceo-review` readiness call | Codex | |
| Corpus expectation-format arbiter (`/spec` if it turns subjective) | Codex | |
| `synthetic_demo` db marker if missing; any corpus schema table | Cursor | `drizzle/**` |
| `demo:reset` executor | Claude | deferred, not needed for the spine |

Antigravity is out of usage; its `apps/cli/**` plus `tests/eval` plus `make demo`
lane is held by Codex for this phase. Branch prefixes: Cursor `a/` or `cursor/`,
Claude `b/`, Codex `c/`.

## 6. T10.6 slice: completion contract

Reuse the missing-evidence candidate from the 7-route corpus. CLI-only,
fixture-only, offline, deterministic. It must prove:

- An unresolved resolution task accepts a human correction with an
  `expectedVersion`.
- The correction creates a `candidate_correction` attempt.
- Only the affected candidate and the required extraction work are re-processed.
- Fixture extraction stays offline and deterministic.
- Finalization produces a superseding `CandidateTriageResult`.
- The original result stays immutable and inspectable.
- The candidate head advances to the new result.
- Score, confidence, reasons, and evidence change as expected.
- Resolution action, lineage, and audit history are retained.
- A stale correction (wrong `expectedVersion`) is rejected with no second
  mutation.

Demonstrated via a second CLI command sequence plus an integration test, so the
default `make demo` stays a simple happy path.

## 7. Skills: what we use, when, and who

Active this phase:

| Skill | When | Who |
|---|---|---|
| `/review` (`/code-review`) | Every merge gate. Scope to the PR diff plus named risk areas: corpus schema correctness, expected-outcome validation, fixture-contract compatibility, no product hallucination, no hidden T12, no live keys, CLI calls real use-cases, demo reproducible from clean checkout, no em dashes. | Codex; Cursor co-reviews persistence PRs |
| `/context-save` | After every safe merge, then push `main`. | Codex |
| `/context-restore` | On session resume. | Anyone |
| `/cso` | Before any live LLM key, provider credential, or real fixture recording. Not triggered this phase, but it is the gate. | Whoever proposes it |
| `/spec` | Only if the corpus expected-outcome format turns subjective. If it is the rubric level judgments that get debatable, record a practitioner-calibration note per OQ-6 instead; `/spec` locks format, it cannot replace calibration. | Codex |
| `/investigate` | Any real bug needing root-cause work during CLI wiring, corpus, or T10.6. | Whoever hits it |
| `/plan-ceo-review` | Step 8, after the 7-route spine plus T10.6 are green and clean-checkout `make demo` verification passes. | Codex |
| `/simplify` | Optional, if a diff needs a quality-only cleanup pass (no bug hunt). | PR author |

Deferred, do not invoke early:

| Skill | Unlocks when |
|---|---|
| `/qa`, `/qa-only` | Browser workflows exist (post-T12). Owns the six Playwright workflows plus offline demo path verification. |
| `/design-review`, `/plan-design-review` | Real UI code exists. |
| `/devex-review` | Before a public portfolio push. |
| `/benchmark` | Once the offline demo exists; candidate to run right after step 8. |
| `/ship` | Final release gate only. |
| `/autoplan` | Full auto-review pipeline (CEO plus design plus eng plus DX). Heavier than needed now; step 8 uses `/plan-ceo-review` alone. |
| `/office-hours`, `/plan-eng-review` | Already produced their binding docs. Re-run only to revise. |

## 8. Not now (explicitly deferred)

T12 UI, Playwright workflow bodies going live, `make demo` serving the web app,
scheduler concurrency and SIGINT grace and claim-expiry reclaim and live retry
and backoff, the full 20 to 25 corpus, `demo:reset`, and every skill in the
deferred table above.
