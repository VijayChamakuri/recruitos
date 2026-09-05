# RecruitOS Candidate Triage Control Plane: Build-Ready Implementation Plan

Status: Engineering architecture approved, implementation not started

Reviewed source: `51acb79:docs/designs/recruitos-candidate-triage-control-plane.md`

Review date: 2026-09-05

Target branch: `main`

## Executive outcome

Build the approved candidate-triage packet as two internal TypeScript packages plus two applications:

- `@recruitos/core` is a pure decision engine.
- `@recruitos/runtime` owns effects, persistence, adapters, orchestration, and reads.
- `@recruitos/cli` is a thin runtime client.
- The Next.js app is a thin runtime client and recruiter review surface.

The system imports only committed synthetic candidates, extracts reviewable evidence proposals, calculates scores and confidence deterministically, routes uncertainty into resolution tasks, and records immutable history. It never owns ATS candidate state and performs no outbound action in v1.

The implementation may begin with rubric-independent infrastructure. Product-specific fixture expectations, extraction recordings, screenshots, and acceptance baselines must wait until rubric v1 is frozen.

Current product-test coverage is zero. Current product-performance evidence is zero. Both remain zero until application code exists and the planned suites and benchmarks have executed.

## Locked product invariants

- The product wedge is the candidate triage packet, end to end.
- The LLM never emits a numeric score or confidence value.
- Model output is a reviewable proposal containing evidence, gaps, contradictions, facts, and one closed ordinal level per requested document and dimension.
- Scoring, confidence, status, routing, shortlist order, dedupe, and corrections are deterministic.
- RecruitOS is a system of engagement above the ATS, not the system of record.
- ATS stage changes, follow-ups, rejection messages, and other outbound actions are immutable proposals only.
- Approval records a RecruitOS review decision and causes no external effect.
- Escalation opens resolution work. It is not a terminal workflow state.
- Official runs are immutable and contain no partial operational work.
- Operational progress belongs to resumable attempts and work items.
- Fixture mode is the default and cannot initialize or fall through to live extraction.
- The complete demo runs with no provider credential.
- Candidate and source-document text is untrusted from import through rendering.
- All candidate data is synthetic.
- Audit history is database-enforced append-only, not cryptographically tamper-proof.

## What already exists

The approved design exists in commit `51acb79` on branch `recruiting-pipeline-automation`. It establishes the product wedge, core formulas, recruiter flow, packet surfaces, fixture strategy, Trust Center intent, and the binding rubric-first sequence.

The current worktree contains vendored gstack review tooling only. It has no RecruitOS package scaffold, application source, migrations, fixture corpus, eval implementation, product tests, CI pipeline, package manifest, or backlog. There is no existing application code to reuse or preserve.

The local environment currently has Node 24 available. The implementation must still pin Node 24 LTS and the exact package-manager version in repository configuration so local state is not treated as the contract.

## Package boundaries

```text
packages/core/                 @recruitos/core
  src/domain/                  canonical Zod schemas and inferred types
  src/rubric/                  rubric model and rubric-bound schema factories
  src/canonical/               canonical JSON, hashes, ordered values
  src/matching/                normalization and quote location
  src/scoring/                 exact arithmetic, score, confidence, shortlist
  src/pipeline/                pure consolidation and decision stages
  src/evaluation/              pure Class 1 and Class 2 metric functions
  src/errors/                  DomainError and Result

packages/runtime/              @recruitos/runtime
  src/db/                      connection factory, schema, mappers, migrations
  src/commands/                D4 transaction executor and command handlers
  src/use-cases/               named mutation and orchestration use cases
  src/read-models/             named bounded query use cases
  src/scheduler/               work claims, retry policy, worker pool
  src/adapters/                fixture, live extraction, mock ATS source
  src/composition/             one shared composition root
  src/errors/                  RuntimeError mapping and safe diagnostics

apps/cli/                      private @recruitos/cli executable
apps/web/                      Next.js recruiter review application
fixtures/                      committed synthetic inputs and recorded outputs
tests/integration/             cross-package and real-SQLite tests
tests/e2e/                     six required Playwright workflows
docs/                          assumptions, architecture, operator reference
```

There is no third internal library package. Evals, benchmark entry points, CLI commands, and the web application consume runtime use cases. Pure metric calculations live in core when they require no effects.

### Dependency rule

```text
                       +--------------------+
                       | @recruitos/core    |
                       | pure values only   |
                       +----------^---------+
                                  |
                       validated values and Results
                                  |
             +--------------------+--------------------+
             | @recruitos/runtime                      |
             | DB, adapters, scheduler, use cases      |
             +----------^-------------------^----------+
                        |                   |
                 +------+-----+       +-----+------+
                 | apps/cli   |       | apps/web  |
                 +------------+       +------------+
                        ^                   ^
                        +---------+---------+
                                  |
                         eval and E2E runners
```

Enforce these boundaries:

- Core imports Zod and standard pure utilities only.
- Core never imports runtime, Drizzle, SQLite, filesystem, networking, provider SDKs, Next.js, React, clocks, or random ID APIs.
- Runtime is the only package that imports Drizzle or `better-sqlite3`.
- CLI handlers never import database tables, Drizzle, the driver, or provider SDKs.
- Web client components never import runtime or server-only modules.
- Next.js treats `better-sqlite3` as a server external package.
- Outbound SDK imports are allowed only in runtime adapters.
- Architecture tests reject duplicate exported domain declarations outside core and unused exported interfaces.

## End-to-end data flow

```text
synthetic corpus
      |
      v
CandidateSourceAdapter -> validate -> normalize -> persist source facts
      |
      v
create TriageAttempt
  pin runSnapshotHash + corpusManifestHash + manifestHash
  create ordered AttemptWorkItems
      |
      v
bounded runtime scheduler
  reuse artifact by extractionSpecHash if present
  otherwise claim item in short BEGIN IMMEDIATE transaction
      |
      v
FixtureExtractionAdapter or explicit LiveExtractionAdapter
  no database transaction held
  no tools, browsing, memory, files, URLs, or side effects
      |
      v
D7 strict validator and D10 quote locator
      |                         |
      | valid                   | reviewable failure
      v                         v
ExtractionArtifact       ExtractionFailure
      |                         |
      +------------+------------+
                   |
                   v
all items succeeded or reviewable_failure
                   |
                   v
pure core finalization intents
  consolidate dimensions and facts
  resolve hard requirements
  score and calculate confidence when available
  derive status, reasons, tasks, shortlist, proposals
                   |
                   v
short BEGIN IMMEDIATE finalization transaction
  immutable facts and associations
  publication seals
  head pointer updates
  audit events
  command receipt
                   |
                   v
bounded runtime read models -> CLI and Next.js
```

No provider call, file read, normalization, hashing, dedupe, fuzzy matching, or other expensive computation occurs inside a SQLite transaction.

## Pure core contract

### Domain source of truth

- Every domain type has one canonical Zod schema in core.
- TypeScript domain types use `z.infer`.
- IDs are branded ASCII string schemas.
- Closed discriminated unions cover proposals, review decisions, resolution actions, extraction outcomes, audit events, reasons, results, and errors.
- Rubric-bound schemas construct a closed dimension enum from the pinned rubric snapshot.
- Boundary inputs reject unknown fields.
- Internal constructors return validated values and avoid unchecked assertions.
- Every union switch uses an exhaustiveness helper.
- Reason codes are structural `{ kind, subjectId? }` values. `formatReasonCode()` produces strings only for display and fixtures.

### Pure pipeline

```text
parse
  -> dedupe
  -> consolidate document extraction outcomes
  -> consolidate structured facts
  -> resolve hard requirements
  -> calculate score when six assessments are available
  -> calculate confidence when score is available
  -> derive status and ordered reasons
  -> shortlist eligible scored candidates
  -> create proposal and resolution-task intents
```

Core functions accept an explicit determinism context and already ordered inputs. They return validated values and ordered write intents. Core never reads time, generates persistence IDs, queries a database, reads files, invokes adapters, or writes audit events.

### Exact decision arithmetic

- The basis-point scale is `10000`.
- Levels are `none = 0`, `weak = 3300`, `partial = 6700`, and `strong = 10000`.
- Rubric weights are positive integers.
- Aggregate score uses round-half-up on the exact weighted rational.
- Confidence uses exact rational terms and integer coefficients `4500`, `2500`, `-2000`, and `-1000`, with threshold `5500` basis points.
- Dedupe uses exact trigram Jaccard comparison against `8200` basis points.
- Fuzzy quote matching uses exact scalar-array edit similarity against `9000` basis points.
- Span eligibility uses exact character IoU of at least `1/2`.
- Bias rates and impact ratios retain exact numerator and denominator values.
- Decision-bearing SQLite columns never use `REAL`.
- Large exact intermediates are stored as canonical decimal strings and mapped to `bigint`.
- No decision path uses decimal threshold literals, `Math.round()`, `toFixed()`, or locale-sensitive comparison.

### Evidence offsets and matching

- Offsets are zero-based, end-exclusive UTF-16 code-unit positions into `SourceDocument.normalizedText`.
- `normalizedText.slice(start, end)` is authoritative.
- Every located span stores extracted `quotedText` and source `matchedText`.
- UI highlighting always uses `matchedText`.
- Exact matching requires an exact UTF-16 substring match.
- Normalized matching uses only a committed one-to-one fold table for supported ASCII case, quotes, and dashes.
- Expanding or contracting folds fall through to fuzzy matching.
- Fuzzy tokenization is Unicode-aware and retains UTF-16 token offsets.
- Levenshtein comparison operates on Unicode scalar arrays.
- Match ties resolve by lowest start then lowest end.
- Invalid bounds or source-slice mismatches return `span_integrity_failed` and prevent highlight rendering.

### Multi-document consolidation

- Each work item covers one candidate, one document, and one dimension.
- A successful document proposal emits one level in `none < weak < partial < strong`.
- Every non-`none` proposal requires a located supporting span.
- Candidate-level assessment selects the highest grounded non-`none` level across successful documents.
- All-`none` successful proposals select `none`.
- Distinct non-`none` levels create `document_level_disagreement`, escalate, and preserve the selected proposal.
- A failed document never becomes `none`.
- If every document for a dimension fails reviewably, the dimension is unavailable.
- A complete score exists only when all six dimensions have a valid assessment, including valid `none`.
- An unavailable result is escalated, has no score or headline confidence, is excluded from shortlist and score-based proposals, and remains resolvable.
- `derive_level()` is a visible calibration diagnostic and has no scoring authority.

### Structured facts and hard requirements

V1 fact kinds are:

- `employment_interval`
- `work_authorization_statement`
- `current_title`
- `employer_history_entry`
- `claimed_experience`

Facts are grounded, deduplicated with type-specific semantic keys, and retain all provenance. Conflicting grounded facts remain visible and resolve affected requirements to `unknown`. Neither parser output nor model output silently overrides the other.

Employment ranges use half-open month intervals. Explicit ending months are included by converting to the following exclusive month. `present` uses the frozen snapshot date. Overlaps are unioned, concurrent work is not double-counted, and a tenure contradiction occurs only when the highest grounded claim exceeds derived tenure by more than 12 months.

Hard requirements use three-valued predicates:

- `pass` requires conclusive grounded satisfaction.
- `fail` requires conclusive grounded violation.
- `unknown` covers absence, conflict, unavailable extraction, incomplete parsing, or an inconclusive predicate.

Only `fail` derives `rejected_hard_requirement`. `unknown` escalates. Hard-requirement outcomes do not alter rubric dimension levels.

## Runtime contract

Runtime owns:

- the only database connection factory
- Drizzle schema and migrations
- transactions and command receipts
- audit-event writing
- `Clock` and `IdGenerator`
- fixture and live extraction adapters
- mock ATS candidate-source adapter
- bounded worker scheduler
- named mutation use cases
- named read use cases
- the shared composition root used by CLI, web, and evals

Runtime exposes only ports exercised by v1:

- `ExtractionAdapter`
- `CandidateSourceAdapter`
- `Clock`
- `IdGenerator`

There is no v1 execution port for email, calendar, Slack, sourcing, ATS stage mutation, or candidate rejection delivery.

### Shared Result and error contract

Core functions return `Result<T, DomainError>`. Runtime use cases return `Result<T, RuntimeError>`.

Core error codes:

- `invalid_input`
- `invalid_rubric`
- `invalid_evidence`
- `invalid_transition`
- `unsupported_resolution`
- `score_invariant_failed`
- `span_integrity_failed`

Runtime error codes:

- `not_found`
- `conflict`
- `busy`
- `fixture_miss`
- `extraction_failed`
- `artifact_validation_failed`
- `persistence_failed`
- `demo_session_active`
- `migration_required`
- `data_integrity_failed`
- `internal_error`

Every error includes stable code, safe message, retryability, optional structured details, and available command or attempt correlation. Expected failures return typed results. Impossible states may throw and are converted at the outer boundary into a safe `internal_error`. Stack traces, secrets, raw provider errors, and private causes never enter CLI JSON or web responses.

### Transactional command protocol

Every mutation uses:

```ts
type Command<TPayload> = {
  commandId: CommandId;
  actorId: ActorId;
  expectedVersion: number;
  payload: TPayload;
};
```

Multi-head payloads add sorted `headPreconditions` containing head type, aggregate ID, expected version, and expected pointer where applicable. The primary head never appears in the secondary vector.

```text
BEGIN IMMEDIATE
  1. Read command receipt.
  2. Return stored result if request hash matches a replayable receipt.
  3. Reject command-ID reuse with different input.
  4. Check primary expectedVersion.
  5. Check secondary heads in canonical order.
  6. Run pure core decision function.
  7. Insert immutable rows and associations.
  8. Insert required publication seals.
  9. Update heads with version-qualified WHERE clauses.
 10. Require one affected row for every head update.
 11. Append audit events in eventOrdinal order.
 12. Store successful command receipt.
COMMIT, or roll back every step
```

Nonretryable failure receipts and failure audit events are written in a separate short transaction after the intended mutation rolls back. Retryable SQLite busy failures do not create terminal receipts. Retryable extraction failures remain on work items. Failure-audit persistence failure is itself blocking and visible.

### Attempt and work-item state

Attempt kinds are `main_run`, `variant_run`, and `candidate_correction`.

Work-item states are:

```text
pending -> claimed -> succeeded
                 \-> reviewable_failure
                 \-> retryable_failure -> claimed
                 \-> blocked_failure
```

- `succeeded` references one validated immutable artifact.
- `reviewable_failure` references one immutable failure and counts as ready for finalization.
- `blocked_failure` references one immutable failure and prevents finalization.
- Nonterminal states reference no terminal fact.
- Terminal work items never return to a nonterminal state.
- A main or variant run finalizes only when every item is succeeded or reviewable failure.
- A candidate correction creates no run or run member.

Reviewable failures create unavailable assessments, explicit gaps, escalation reasons, and recruiter tasks. They never fabricate a level, fact, evidence span, score, or rejection. Fixture misses and integrity failures are blocked operational failures and do not become candidate decisions.

### Worker scheduler

- One internal scheduler serves CLI, web, and evals.
- It consumes manifest items in committed order.
- Each claim and completion uses a short transaction.
- Extraction occurs after claim commit.
- Completed content-addressed artifacts are reused before claim or adapter call.
- Claims record claim ID, timestamps, expiry, attempt count, and work-item version.
- Expired claims can be reclaimed.
- Provider calls are at least once, not exactly once.
- Duplicate valid responses converge on the same artifact hash.
- Fixture concurrency defaults to `8`.
- Live concurrency defaults to `2` and may be reduced by the adapter.
- User concurrency is bounded from `1` through `16`.
- Fixture misses and schema-validation failures are not retried.
- Live timeout, HTTP 429, and retryable 5xx failures receive at most two retries.
- Valid `Retry-After` is capped at 60 seconds. Otherwise delays are one and two seconds.
- `SIGINT` stops new claims and gives active artifact writes a bounded grace period.
- Finalization always sorts by manifest order.

### Candidate correction and re-extraction

```text
open task
   |
   | human request_re_extraction
   v
candidate_correction attempt + task head at request action
   |
   +-> retryable work remains reextracting
   +-> blocked work projects blocked
   |
   v
system reextraction_completed action
   +-> superseding CandidateTriageResult
   +-> candidate head moves
   +-> task projects review_required
   |
   v
human confirm, correct, supply evidence, block, dismiss, or request again
```

Re-extraction completion never closes the human task automatically. It creates no new official run and never changes original membership. Unscoped facts and assessments are reused through immutable associations; only scoped derived values are replaced.

## Persistence architecture

Pin these exact persistence dependencies:

- `drizzle-orm@0.45.2`
- `drizzle-kit@0.31.10`
- `better-sqlite3@13.0.3`
- the matching exact `@types/better-sqlite3` version chosen during scaffolding

Commit `pnpm-lock.yaml` and use no dependency ranges for these packages.

### Connection factory

Every runtime, migration, CLI, web, eval, benchmark, and test connection passes through one runtime factory. The factory:

- rejects production `:memory:` databases
- rejects unsupported network or cloud-synced filesystem locations
- verifies embedded SQLite is at least `3.51.3`
- enables and verifies `journal_mode = WAL`
- enables and verifies `foreign_keys = ON`
- enables and verifies `busy_timeout = 5000`
- enables and verifies `synchronous = FULL`
- enables and verifies `wal_autocheckpoint = 1000`
- validates the migration-set hash and schema version
- returns typed `migration_required` or `persistence_failed` errors

V1 supports one host and a local filesystem only. NFS, SMB, network volumes, cloud-synced folders, and multi-host database access are unsupported. The `.db`, `.db-wal`, and `.db-shm` files form one state set. Runtime never replaces only one of them.

Controlled shutdown may issue `PRAGMA wal_checkpoint(PASSIVE)`. An incomplete passive checkpoint does not turn an otherwise clean shutdown into failure.

### SQL conventions

- Tables and columns use `snake_case`.
- Drizzle mappers are the only SQL-to-domain naming boundary.
- Every table is `STRICT`.
- IDs are `TEXT PRIMARY KEY COLLATE BINARY` and application-generated.
- No table uses `AUTOINCREMENT`.
- Hashes are lowercase 64-character SHA-256 hexadecimal strings.
- Booleans are checked integer values `0` or `1`.
- Ordinals and counts are nonnegative checked integers.
- Created versions begin at `1`; expected version `0` means absent.
- Instants are UTC RFC 3339 strings with milliseconds.
- Dates are strict `YYYY-MM-DD`; year-month values are strict `YYYY-MM`.
- Foreign keys, database constraints requiring referenced rows to exist, use `ON DELETE RESTRICT`.
- Historical rows never use cascade deletion.
- JSON text columns use `json_valid()` where available and strict boundary schemas.
- Decision-bearing values never use SQLite `REAL`.

### Immutable entity and fact tables

Every row below has a stable ID and command-captured `created_at`. Every table receives `BEFORE UPDATE` and `BEFORE DELETE` abort triggers.

| Table | Required identity and purpose | Key constraints |
|---|---|---|
| `actor` | Seeded human-demo actors and `system:runtime` | Closed actor kind; callers cannot claim system actor |
| `candidate` | Immutable synthetic candidate identity | Unique source system and source key; synthetic marker must be true |
| `source_document` | Globally content-addressed raw and normalized text | Unique raw hash; indexed normalized hash; count and text invariants |
| `candidate_document` | Candidate ownership, kind, label, and document order | Unique candidate and ordinal; one to four per corpus member |
| `corpus_manifest` | Canonical corpus snapshot | Unique content hash; main or variant kind; deferred seal required |
| `corpus_member` | Candidate membership and import ordinal | Unique candidate and ordinal within manifest |
| `corpus_manifest_seal` | Commit-time corpus completeness proof | One per manifest; validates relational rows against canonical bytes |
| `run_input_snapshot` | Exact decision configuration | Unique hash and canonical bytes; immutable frozen date and versions |
| `extraction_spec` | Exact model and validation contract for one work item | Unique hash and canonical bytes; weights excluded, definitions included |
| `extraction_artifact` | Validated candidate-neutral extraction proposal | Unique content hash; bounded accepted output and rejected claims |
| `extraction_failure` | Safe immutable failure diagnostic | Unique failure content hash; no unsafe raw provider body |
| `triage_run` | Official immutable main or variant run | Snapshot and manifest references; no mutable completion status; seal required |
| `triage_run_member` | Fixed initial result membership | Unique run and candidate, run and ordinal, and initial result |
| `triage_run_seal` | Commit-time official-run completeness proof | One per run; validates attempt manifest and all members |
| `candidate_triage_result` | Immutable initial or correction decision | Candidate lineage, availability, status, optional score, seal required |
| `candidate_result_seal` | Commit-time result completeness proof | One per result; validates all facts, associations, reasons, tasks, and proposals |
| `score_result` | Exact six-dimension score and confidence calculation | One result owner; checked basis points and exact terms |
| `evidence_span` | Candidate-scoped grounded source interval | Candidate, document, source, offset, polarity, match, and provenance integrity |
| `evidence_gap` | Candidate and dimension with absent usable evidence | At most one per result and dimension through association constraints |
| `dimension_assessment` | Candidate-scoped selected level and provenance | Closed level; one current association per result and dimension |
| `structured_fact` | Consolidated grounded fact | Closed fact union; candidate ownership; evidence requirements |
| `fact_conflict` | Explicit incompatible fact set | At least two canonically ordered members |
| `hard_requirement_assessment` | Three-valued deterministic requirement outcome | Pass or fail requires linked facts; unknown may be evidenceless |
| `candidate_result_reason` | Structural routing or diagnostic reason | Partial unique indexes handle nullable subject; deterministic precedence |
| `proposal` | Immutable typed outbound suggestion | Strict discriminated payload; direct result reference; no status column |
| `review_decision` | Immutable approve, edit, or reject action | Strict discriminated payload; original proposal retained |
| `resolution_task` | Immutable task opened by a routing reason | Exactly one per task-opening reason |
| `resolution_action` | Immutable human or authorized system action | Strict discriminated payload plus scalar integrity references |
| `audit_event` | Closed event-specific audit fact | Unique command and event ordinal; actor display snapshot |
| `candidate_demographics` | Synthetic audit-only attributes | Unique candidate; isolated from scoring imports |

Candidate result status is one of `scored`, `escalated`, or `rejected_hard_requirement`. Decision availability is `complete` or `unavailable`. A complete result has one exact score and six assessments. An unavailable result has no score, is escalated, and has an `assessment_unavailable` reason. `possible_duplicate` is a reason, not a status.

### Immutable association tables

| Table | Purpose and integrity rule |
|---|---|
| `corpus_member_document` | Ordered one-to-four candidate documents for a member |
| `candidate_result_evidence_span` | Exact evidence set used by one result |
| `candidate_result_evidence_gap` | Exact gap set used by one result |
| `candidate_result_dimension_assessment` | Exactly one assessment per available rubric dimension |
| `candidate_result_structured_fact` | Exact consolidated fact set used by one result |
| `candidate_result_fact_conflict` | Exact conflicts visible on one result |
| `candidate_result_hard_requirement_assessment` | Exact requirement outcomes used by one result |
| `dimension_assessment_evidence_span` | Ordered evidence supporting one assessment |
| `structured_fact_evidence_span` | Grounding evidence for one fact |
| `structured_fact_provenance` | Parsed, extracted, or human proposals consolidated into a fact |
| `fact_conflict_member` | Canonically ordered facts in a conflict |
| `hard_requirement_assessment_fact` | Supporting and contradicting facts for a requirement outcome |
| `proposal_evidence_span` | Ordered candidate-owned evidence for a proposal |

Each association has a stable ID and creation timestamp and receives immutable update and delete triggers. Corrections reuse unchanged associations and create new associations only for changed scope. Original result membership never moves.

### Mutable heads and operational tables

| Table | Mutable fields | Pinned fields and rules |
|---|---|---|
| `candidate_head` | Current result pointer and version | Candidate ID is fixed; pointer update requires expected version |
| `proposal_head` | Current review-decision pointer and version | Proposal ID is fixed; status is derived |
| `resolution_task_head` | Current action pointer and version | Task ID is fixed; task status is derived |
| `triage_attempt` | Operational state, progress, and version | Kind, snapshot, manifests, origin run, base result, request action, and scope are fixed |
| `attempt_work_item` | State, claim data, attempt count, failure state, and version | Attempt, key, ordinal, candidate, document, dimension, and extraction spec are fixed |
| `command_receipt` | Committed receipt state and result | Command ID, request hash, actor, type, and primary aggregate are fixed |
| `demo_session` | Version, generation, web owner, heartbeat, expiry, and seed hash | Singleton identity and synthetic-demo purpose are fixed |

Runtime exposes named updates only. It exposes no general historical-delete or generic mutable-table update use case.

### Publication seals

SQLite cannot defer arbitrary cross-row checks, so three typed seals enforce aggregate completeness at commit. Each parent has a non-null unique `seal_id` with a `DEFERRABLE INITIALLY DEFERRED` foreign key. Handwritten migration SQL creates the cyclic parent and seal references plus deterministic validation triggers.

`candidate_result_seal` validates result lineage, six-dimension completeness, score availability, candidate ownership, fact provenance, conflict cardinality, requirement support, reason uniqueness, task creation, proposal eligibility, and contiguous ordered associations.

`corpus_manifest_seal` validates unique contiguous candidate and document ordinals, one-to-four documents per member, main and variant rules, exactly 140 members for the main demo corpus, and equality between relational rows and canonical manifest bytes.

`triage_run_seal` validates snapshot alignment, attempt readiness, exact run membership, sealed initial results, candidate head movements, and exclusion of correction results.

Normal nullable uniqueness is insufficient in SQLite. Result reasons use two partial unique indexes:

- `(candidate_result_id, reason_kind)` where `subject_id IS NULL`
- `(candidate_result_id, reason_kind, subject_id)` where `subject_id IS NOT NULL`

### Required access-path indexes

Indexes must preserve these access paths even if final column names change:

- run member by run, candidate, import ordinal, and result
- candidate result by candidate, creation time, and ID
- candidate document by candidate and manifest ordinal
- result associations by result and domain order
- evidence by candidate, dimension, document, start, end, polarity, and ID
- resolution task and action by candidate result or task plus creation order
- proposal and decision by candidate result or proposal plus creation order
- audit event uniquely by command and event ordinal
- audit event by candidate or aggregate plus timestamp and stable tie keys
- work item uniquely by attempt and key
- work item by attempt, state, manifest ordinal, and key
- active claims by expiry
- demographics uniquely by candidate
- every content hash and mutable head pointer used by a named read or command

Do not add speculative indexes. Integration tests on realistically sized data must prove intended high-growth queries use the named access paths.

### Demo reset

`demo:reset` is the only destructive runtime use case and works only on a database marked `synthetic_demo`. It prepares migration and seed plans outside the transaction, refuses an active web marker, then drops and rebuilds application schema and synthetic content inside one guarded transaction. Rollback restores the prior generation.

It never unlinks, renames, copies, or replaces SQLite files. It does not preserve the removed synthetic generation’s audit history and reports that fact explicitly. Architecture checks reject destructive runtime SQL outside reviewed migrations, the reset executor, and isolated test teardown.

The demo web process refreshes its marker every five seconds with a 15-second expiry. Reset returns immediately when the marker is active and never acts as a global application lease.

## Untrusted-document boundary

### Input and model capability

- Preserve original source text and create normalized text once.
- Heuristic injection scanning adds review diagnostics only.
- Suspicious phrases are never deleted or rewritten.
- Candidate text is separately delimited untrusted document content.
- Candidate text is never interpolated into trusted system instructions.
- Extraction runs one dimension at a time with bounded requests.
- The model receives no tools, browsing, files, URLs, retrieval, memory, outbound actions, candidate mutation, or scoring authority.

### Output validation

- Reject unknown fields and unknown enum values.
- Enforce exact requested document and dimension identity.
- Cap response bytes, collection cardinalities, and quotes.
- Ignore returned offsets and relocate all quotes against stored normalized text.
- Reject unlocated quotes and fabricated references as bounded rejected claims where the surrounding response remains valid.
- Promote structurally invalid output to a typed reviewable extraction failure.
- Pass fixture and live responses through the same validator.
- Preserve only safe bounded diagnostics and hashes for invalid or oversized provider output.

### UI rendering

- Render all source text and model output through escaped React text nodes.
- Build highlights with validated text slicing and React elements.
- Never use raw HTML insertion for candidate text, source documents, model output, labels, filenames, or metadata.
- Refuse an invalid highlight and show a typed data-integrity state.

## Named read models

Runtime owns exactly these initial read use cases:

- `getTriageQueue`
- `getCandidatePacket`
- `getResolutionQueue`
- `getProposalQueue`
- `getAuditTimeline`
- `getTrustCenterReport`
- six saved-query answers from the approved design

Do not add a generic repository abstraction or expose query builders or rows. Select columns explicitly and never use `SELECT *`.

Candidate packet reads first capture `CandidateHead.currentResultId` and version. All remaining queries anchor to that immutable result ID, producing one internally consistent packet without a long read transaction. The response includes the captured head version for the next mutation. Missing references fail the entire read with `data_integrity_failed`; partial packets are forbidden.

Triage, resolution, proposal, and audit lists use opaque versioned keyset cursors. Default page size is 50 and maximum is 100. Fetch `limit + 1`. Cursor fields exactly match all query sort fields and use SQLite `BINARY` ordering for ASCII IDs.

Required orders:

- triage queue: score descending, import ordinal ascending, candidate ID ascending
- resolution queue: reason precedence, opened timestamp, task ID
- proposal queue: creation timestamp, proposal ID
- default audit page: event timestamp descending, command ID descending, event ordinal descending, event ID descending
- candidate audit trace: the same audit keys ascending

Every SQL query feeding a user-visible list or canonical serialization has an explicit `ORDER BY`.

## CLI contract

`apps/cli` exposes the `recruitos` executable and uses `node:util.parseArgs` unless implementation proves a dedicated parser necessary.

```text
recruitos db:migrate              recruitos db:check
recruitos corpus:import           recruitos corpus:show
recruitos triage:start            recruitos triage:resume
recruitos triage:status           recruitos triage:finalize
recruitos triage:run
recruitos resolution:list         recruitos resolution:act
recruitos proposal:list           recruitos proposal:decide
recruitos audit:show              recruitos trust:report
recruitos fixtures:record         recruitos fixtures:verify
recruitos eval:class1             recruitos measure:live
recruitos benchmark:demo          recruitos benchmark:queries
recruitos demo:prepare            recruitos demo:reset
recruitos demo:status
```

Every direct mutation accepts `--command-id`, `--actor-id`, and `--expected-version`. If command ID is omitted, CLI generates and prints it before mutation begins and includes it in the result. Safe retry requires reuse of that ID. Typed input may use flags, `--input <path>`, or `--input -` for one strict JSON value.

`triage:run` accepts one root command ID and derives child IDs from fixed-position canonical arrays containing root ID, operation kind, attempt ID, and work-item key. Retrying the root resumes the same attempt and reuses successful receipts and artifacts.

Fixture mode is default and disables provider transport even when credentials exist. Live mode requires `--mode live`, explicit provider configuration, and credentials. Fixture miss never falls back.

Human output is the interactive default. `--format json` emits exactly one versioned JSON result on standard output, with progress and diagnostics on standard error. JSON contains exact integer and rational values and no ANSI output.

Exit codes are:

- `0`: success
- `2`: invalid input or transition
- `3`: conflict or stale version
- `4`: not found, fixture miss, or required artifact missing
- `5`: extraction or artifact-validation failure
- `6`: persistence unavailable, busy, demo session active, or migration required
- `70`: invariant failure or unexpected defect

`fixtures:record` requires live mode, exact hashes, committed synthetic members, and a new output directory. It cannot overwrite fixtures or edit expected outcomes. `measure:live` reports poor metrics as a completed measurement with exit zero; operational failures remain nonzero.

`make demo` verifies pinned tools, installs from the lockfile only when needed, calls `demo:prepare` in fixture mode, migrates, imports exactly 140 candidates, runs or resumes fixture extraction, finalizes, runs Class 1 evals, builds Next.js, starts the production server, and holds the demo marker. It never resets compatible populated state and performs zero provider calls.

Required script aliases are `pnpm test`, `pnpm test:coverage`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:types`, `pnpm eval:class1`, `pnpm measure:live`, `pnpm check`, `pnpm benchmark`, `pnpm benchmark:demo`, `pnpm benchmark:queries`, `pnpm benchmark:matching`, and `make demo`.

## Capacity and performance contract

Deterministic limits are part of `ExtractionSpec` and therefore part of artifact identity:

| Limit | Value |
|---|---:|
| Candidates per attempt | 200 |
| Documents per candidate | 4 |
| Work items per attempt | 4,800 |
| Raw document bytes | 262,144 UTF-8 bytes |
| Normalized document length | 50,000 UTF-16 code units |
| Normalized document bytes | 131,072 UTF-8 bytes |
| Normalized document tokens | 8,000 |
| Serialized model request | 163,840 UTF-8 bytes |
| Provider response | 65,536 UTF-8 bytes |
| Evidence items per work item | 12 |
| Structured facts per work item | 16 |
| Missing-evidence or validation details | 8 |
| Quote length | 240 UTF-16 code units |
| Fuzzy windows per quote | 500,000 |
| Fuzzy windows per work item | 1,000,000 |
| Dedupe comparisons at maximum corpus | 19,900 |

Oversized input is rejected, never truncated, summarized, split, or silently omitted. Fuzzy budgets use deterministic operation counts, never elapsed time.

CI gates operation counts, adapter call counts, query counts, index plans, transaction boundaries, network isolation, and canonical output. Wall-clock budgets are recorded on the reference profile and do not affect normal CI.

Reference-profile acceptance:

- median of three empty-database `make demo` runs at or below 120 seconds
- no individual demo run above 180 seconds
- prepared fixture finalization plus Class 1 evals at or below 45 seconds
- warm replay at or below 20 seconds with zero adapter calls
- prepared production-server readiness at or below 5 seconds
- read p95 of 100 ms for triage, resolution, proposal, and one audit page
- candidate packet p95 at or below 150 ms
- Trust Center p95 at or below 250 ms
- each saved query p95 at or below 150 ms
- short D4 mutation p95 at or below 150 ms, excluding external calls
- browser primary content p95 at or below 750 ms after readiness
- non-build fixture triage peak resident memory below 1 GiB
- full demo including build peak resident memory below 2 GiB
- closed database plus WAL and shared-memory files below 150 MiB

Benchmark artifacts are immutable timestamped outputs. They record code and dependency revisions, machine profile, corpus and snapshot hashes, iteration statistics, memory, and database size. No benchmark command updates committed history automatically.

## Test and eval strategy

Use Vitest, V8 coverage, fast-check, real temporary SQLite databases, and Playwright against a production Next.js build. Pin Node 24 LTS in `.nvmrc`, `package.json#engines`, and CI.

### Test projects and commands

One root `vitest.config.ts` defines named projects:

- `core`: examples, boundaries, failures, properties, and type-level claims
- `runtime`: migrations, triggers, commands, adapters, scheduling, and read models
- `cli`: parsing, output, exit codes, and runtime delegation
- `web`: presenters, action-result mapping, and state components
- `class1-evals`: deterministic committed-fixture invariants

Use these commands:

- `pnpm test`
- `pnpm test:coverage`
- `pnpm test:integration`
- `pnpm test:e2e`
- `pnpm test:types`
- `pnpm eval:class1`
- `pnpm measure:live`
- `pnpm check`

Require 100 percent statement, branch, function, and line coverage for handwritten core, runtime, and CLI source. Apply the same target to web presenters, server actions, and state components. Exclude only generated migrations, generated coverage output, type-only declarations, and configuration, with an explanatory comment for every exclusion.

Keep unit tests beside source. Put cross-package tests under `tests/integration/`. Give each integration suite a unique temporary directory and real SQLite file, then migrate from empty. Do not mock Drizzle. Stub provider transport only at the HTTP boundary. Run architecture checks and `tsc --noEmit` separately from coverage.

Use committed fast-check seeds in CI and print the seed plus minimized counterexample on failure. No test command may update snapshots, fixtures, expectations, or baselines.

### Coverage map

```text
[synthetic input]
   |
   +-> invalid schema or capacity --------------------------> typed invalid_input [UNIT]
   |
   +-> import and normalization ----------------------------> hashes and UTF-16 invariants [UNIT+INT]
   |
   +-> attempt creation
   |     +-> command replay --------------------------------> stored result, zero mutation [INT]
   |     +-> stale candidate precondition ------------------> conflict, no partial attempt [INT]
   |
   +-> scheduler
   |     +-> cached artifact -------------------------------> zero adapter calls [INT+EVAL]
   |     +-> fixture hit -----------------------------------> shared validator [CONTRACT]
   |     +-> fixture miss ----------------------------------> blocked, no live fallback [INT]
   |     +-> retryable live failure ------------------------> bounded retry and resume [CONTRACT+INT]
   |     +-> schema or quote failure -----------------------> reviewable failure [UNIT+INT]
   |     +-> interrupted or expired claim ------------------> reclaim safely [INT]
   |
   +-> finalization
   |     +-> all terminal-ready ----------------------------> sealed immutable run [INT+EVAL]
   |     +-> one unavailable dimension ---------------------> escalated, no score [UNIT+INT]
   |     +-> one stale head --------------------------------> full rollback [INT+E2E]
   |     +-> invalid aggregate -----------------------------> seal blocks commit [INT]
   |
   +-> recruiter packet ------------------------------------> grounded visible arithmetic [E2E]
   |     +-> invalid stored highlight ----------------------> blocking integrity state [WEB+E2E]
   |     +-> markup or injection text ----------------------> escaped text and review task [E2E]
   |
   +-> resolution
   |     +-> supply evidence and level ---------------------> superseding result [INT+E2E]
   |     +-> request re-extraction -------------------------> correction attempt [INT]
   |     +-> stale screen ----------------------------------> refresh required [E2E]
   |
   +-> proposal review -------------------------------------> immutable decision, no outbound effect [E2E]
   |
   +-> audit and Trust Center ------------------------------> lineage and visible limitations [E2E+EVAL]
   |
   +-> make demo -------------------------------------------> offline production path [E2E+BENCH]
```

Every branch above has a named unit, integration, eval, or browser owner. There is no intentional untested user-visible branch.

### Required property tests

- score monotonicity under higher levels with fixed positive weights
- score and confidence bounds
- rational reduction, comparison transitivity, and formatting round trips
- comparator antisymmetry, transitivity, and totality
- canonical hashing under shuffled input order
- deterministic result ordering under tied and repeated values
- exact UTF-16 slice invariants for every located span
- quote matching across ASCII, curly quotes, supported dashes, ligatures, nonbreaking spaces, combining marks, emoji, astral characters, Turkish dotted I, repeated quotes, and mixed line endings
- deterministic fuzzy and duplicate ties
- exact threshold behavior immediately below, at, and above score, confidence, dedupe, fuzzy, and IoU boundaries
- stable Class 2 micro and macro aggregation under shuffled inputs

### Real SQLite integration coverage

- connection pragma verification and startup failures
- complete migrations from an empty file
- schema-object equality after migration and demo reset
- update and delete rejection for every immutable table and association
- pinned-column rejection for every mutable table
- foreign-key enforcement and no cascade deletion
- all publication-seal commit failures and valid arbitrary insert order
- command success, replay, request-hash mismatch, stale primary and secondary heads, busy handling, and rollback
- one stale candidate among 140 aborting finalization
- failure receipt behavior and audit-write failure
- attempt claims, expiry, concurrent resume, interrupt, and artifact convergence
- no database transaction around extraction or expensive computation
- fixture and live adapter shared contract
- candidate correction lineage and system-only completion action
- named read query counts, ordering, cursors, and index plans
- insertion-order shuffling with identical user-visible output
- guarded demo reset and active-session refusal

### Required browser workflows

Run Chromium with one worker and zero CI retries until database and port isolation support more workers. Build Next.js once before the suite. Each test gets a unique temporary directory, database, and port, starts a production server, and tears it down without a hidden reset endpoint.

1. `tests/e2e/demo-start.e2e.ts`
   - invoke the real `make demo`
   - assert migrations, exactly 140 main candidates, fixture finalization, Class 1 completion, and production UI readiness
   - assert zero live extraction requests
2. `tests/e2e/candidate-packet.e2e.ts`
   - open the pinned tier-one candidate
   - assert normalized source text, supporting and contradicting spans, gaps, score arithmetic, confidence terms, and named routing reasons
   - verify every highlight matches its stored UTF-16 slice
   - verify markup payloads render as text
3. `tests/e2e/resolution-rescore.e2e.ts`
   - supply evidence and level for a pinned missing-evidence task
   - assert score and confidence change in a superseding result
   - keep the original result and evidence inspectable
   - assert zero live calls
4. `tests/e2e/stale-conflict.e2e.ts`
   - open one task or proposal in two browser contexts
   - commit in the first and submit the stale second action
   - assert no second mutation and require refresh
5. `tests/e2e/proposal-review.e2e.ts`
   - approve, edit, and reject separate follow-up proposals
   - assert immutable decisions, head movements, retained originals, and zero outbound effects
6. `tests/e2e/audit-trust-center.e2e.ts`
   - trace extraction through score, route, resolution, supersession, proposal, and human decision
   - assert event ordering, actor names, at least three visible limitations, proposed and approved bias cuts, synthetic label, and insufficient-sample statement

Retain Playwright traces and screenshots only on failure.

### Eval classes

Class 1 is a deterministic CI gate over committed fixtures and expectations. It validates all fixture inputs, exact tier-one candidate outcomes, formulas, ordering, supersession, idempotency, meaning safe repetition without duplicating a mutation, conflicts, audit completeness, and database immutability. It requires at least 70 percent located-span coverage across tier-one dimensions, a validated gap for every remaining dimension, and no silently absent dimension. At least three initial known limitations remain visible and assertion-classified.

Class 2 is explicit live measurement and never runs under normal tests or CI. It records complete provenance, produces measurement artifacts without overwriting history, and reports quality failures without a gating exit code. Operational inability to complete measurement remains nonzero.

Live span matching requires the same candidate, document, dimension, and polarity. Eligible interval pairs have character IoU at least `1/2`. Select the one-to-one assignment with maximum exact total IoU, with deterministic expected-span then predicted-span ties. Report:

- micro precision, recall, and F1 where computable
- macro averages by candidate-dimension cell
- exact-boundary match rate
- mean and median matched IoU
- numerator, denominator, exclusions, and noncomputable cells
- breakdowns by dimension, polarity, match quality, tier-one candidate, and known limitation
- unlocated quotes and fabricated references as unmatched predictions

Zero predictions with nonzero expectations yields noncomputable precision and zero recall. Empty prediction and expectation sets are noncomputable, never perfect.

Class 3 produces a `Synthetic Bias Audit Demonstration`. It shows proposed and human-approved cuts side by side, counts with every rate, exact ratios, the highest-rate reference group, excluded variants, and noncomputable values for empty or zero-denominator cells. Its first screen states that synthetic data and insufficient sample size prevent real fairness conclusions. It never claims to be an independent audit or compliance certification.

### Hallucination Resistance panel

The Trust Center must show traceable counts for:

- rejected unsupported claims
- unlocated quotes
- fabricated document references
- evidence gaps by reason and dimension
- prompt-injection attempts, routed attempts, and decision-field delta against controls
- grounded-capability refusals for unsupported saved-query requests
- extractor and deterministic level mismatch

Known limitations remain in main totals and are also shown separately.

## Edge-case decisions

| Edge | Locked behavior |
|---|---|
| Model returns a numeric score | Strict schema rejects it; model has no scoring authority |
| Model returns unknown keys or enum values | Nonretryable reviewable failure through shared validator |
| Quote text exists twice | Deterministic lowest valid start, then end; Class 2 matching uses position |
| Returned offsets are plausible but wrong | Ignore them and relocate quote from stored text |
| Fabricated document reference | Reject claim, count it, preserve bounded diagnostic, potentially route review |
| Unsupported claim beside valid output | Persist valid artifact plus bounded rejected claim |
| Whole response invalid or oversized | Store safe failure metadata and response hash, not body |
| Injection phrase appears in resume | Continue extraction under capability boundary and open human review task |
| All documents for one dimension fail | Assessment unavailable, escalated result, no score or score-based proposal |
| One document fails and another succeeds | Consolidate success, preserve failure, escalate with named reason |
| Documents propose different non-none levels | Select grounded maximum, preserve disagreement, escalate |
| Parser and extraction disagree | Preserve both facts, create conflict, resolve affected hard requirement to unknown |
| Evidence is absent | Unknown or evidence gap, never conclusive hard-requirement failure |
| Candidate conclusively fails hard requirement | Internal rejected status; no candidate-facing action without reviewed proposal |
| Duplicate similarity ties | Lowest prior import ordinal, then ASCII candidate ID |
| Shortlist scores tie | Import ordinal, then ASCII candidate ID |
| Async work completes in different order | Finalization sorts by manifest order; canonical output is identical |
| Provider succeeds but process dies before persist | Call may repeat; content-addressed artifact converges |
| Two workers resume same attempt | Transactional claims permit one current claim per version; expired claims reclaim |
| Human acts on stale packet | Typed conflict, no rebase, refresh required |
| One of 140 heads changes before finalization | Whole finalization rolls back; create a new attempt from current heads |
| Re-extraction produces identical output | Still create superseding result and show zero delta |
| Re-extraction completes | Task becomes review-required, not resolved |
| Fixture key is missing | Block attempt and exit; never invoke live adapter |
| SQLite remains busy for five seconds | Retryable busy error; no terminal command receipt |
| Read races with pointer update | Packet remains anchored to captured immutable result and exposes captured version |
| Highlight row is corrupt | Refuse highlight and show data-integrity error |
| Bias denominator is zero | Render not computable, never zero or perfect |
| Demo server is running during reset | Return demo-session-active immediately; do not wait or modify data |
| Process crashes during reset | Transaction rolls back to prior database generation |
| Administrator replaces database files | Outside product guarantees; documentation disclaims cryptographic tamper proofing |

## Production failure-mode matrix

| Code path | Realistic failure | Test owner | Error handling | User outcome |
|---|---|---|---|---|
| Corpus import | Oversized or nonsynthetic document | Core and runtime integration | Typed `invalid_input`, no truncation | CLI names candidate, document, value, and limit |
| Attempt creation | Snapshot bytes disagree with existing hash | Runtime integration | Roll back and return integrity failure | Blocking error with correlation ID |
| Work claim | Concurrent claimant wins version race | Scheduler integration | Treat as coordination conflict and claim another item | Progress continues without duplicate current claim |
| Fixture extraction | Exact spec hash absent | Adapter contract and E2E | Blocked failure, no fallback | Missing fixture key is visible |
| Live extraction | Timeout or 429 | Adapter contract | At most two retries, then resumable | Attempt shows retryable failed items |
| Output validation | Schema smuggling or oversized body | Core and adapter contract | Safe immutable failure, raw body discarded | Candidate routes to review where finalizable |
| Quote matching | Deterministic operation budget exhausted | Core boundary test | Reviewable validation failure | Named parse or matching task, no fake evidence |
| Finalization | Candidate head changed | Runtime integration and E2E | Full rollback and typed conflict | Recruiter refreshes or restarts attempt |
| Seal insertion | Multi-row aggregate incomplete | Migration integration | Commit abort with stable constraint mapping | Blocking data-integrity error |
| Audit append | Constraint or persistence failure | Runtime integration | Roll back business mutation | No apparent success; correlation ID shown |
| Packet read | Historical reference missing | Read-model integration | Reject whole packet | Unsafe sections do not render |
| Proposal review | Second browser uses stale version | Runtime and E2E | No automatic retry or overwrite | Refresh-required conflict |
| Resolution correction | Base result is no longer current | Runtime and E2E | Full rollback, no rebase | New evidence must be reviewed before resubmission |
| Demo reset | Active or recently heartbeating web process | Runtime and E2E | Immediate refusal | Stop server or wait for marker expiry |
| Trust report | Candidate demographics missing | Eval and read integration | Report generation fails | Report states incomplete synthetic audit input |
| Browser rendering | Candidate text contains markup or scripts | Component and E2E | Escaped text nodes only | Payload appears as inert text |
| Process interrupt | SIGINT during extraction | Scheduler integration | Stop claims, bounded artifact-write grace | Resume later without losing completed work |

All listed failures have explicit tests, typed handling, and a visible safe outcome. There are no known silent critical gaps in the plan.

## Gated build sequence

### Gate 0: Accept this architecture plan

No product implementation starts until this document, dependency graph, acceptance matrix, schema inventory, command inventory, and rubric blockers are accepted. Later architectural change requires an explicit decision record.

### Gate 1: Obtain hiring-process input

Conduct one structured session with a recruiter, hiring manager, recruiting operator, or current triage practitioner if possible. Use a realistic synthetic role and capture strong evidence, weak evidence, missing evidence, contradictions, conclusive requirement failure, escalation, shortlist behavior, terminology, and trust requirements. Use no real candidate data.

If access remains unavailable after three documented outreach attempts over five business days, the product owner may sign a `RubricAssumptionRecord`. The Trust Center must then label rubric v1 as product-authored rather than recruiter-validated and show the unvalidated assumptions.

### Pre-rubric implementation lane

Allowed before rubric freeze:

- workspace, package, TypeScript, test, CI, and Make scaffolding
- core branded schemas, structural rubric model, unions, errors, exact arithmetic, canonicalization, hashing, comparators, normalization, quote matching, dedupe, and parameterized decision functions
- runtime connection factory, schema, migrations, seals, triggers, command executor, scheduler, repositories, adapter contracts, composition root, and mock import plumbing
- CLI parser, help, output envelopes, exit mapping, and command shells
- web route and state shells, server-only composition, safe text and highlight components
- test database, provider stub, Playwright, eval, and benchmark harnesses

Pre-rubric examples use an obviously nonproduct rubric confined to test helpers. They cannot enter demo seeds, screenshots, expectations, fixtures, or hashes. No product expectation or model recording is created.

### Gate 2: Freeze rubric v1

Rubric v1 fixes the target role, role description, six dimension IDs and definitions, job-related justifications, levels and evidence requirements, hard requirements and executable predicates, weights, exact scoring and confidence inputs, routing thresholds and precedence, shortlist and dedupe settings, normalization and matching policy versions, extraction validation and prompt versions, and corpus date.

Parse, validate, canonicalize, hash, approve, and then prohibit mutation. Later changes create new definitions and snapshots.

### Gate 3: Author tier-one corpus and expectations

Create 20 to 25 adversarial synthetic candidates with committed IDs, import ordinals, documents, controls, variants, Unicode cases, repeated spans, injection text, markup, duplicates, contradictions, hard-requirement ambiguity, and threshold boundaries.

Before viewing extraction recordings, independently author expected spans, facts, conflicts, gaps, levels, unavailable cases, requirement outcomes, arithmetic, reasons, proposals, assertion classes, and known limitations. Require a second reviewer. Keep at least three visible known limitations.

### Gate 4: Record and verify tier-one extraction fixtures

Freeze calibration hashes, create exact extraction specifications, run live recording into a new content-addressed directory, validate through the production boundary, review the diff, and promote it separately. Fixture recording cannot edit expectations.

### Gate 5: Complete the product-specific vertical slice

In order:

1. Bind rubric v1 to core schemas.
2. Complete dimension and fact consolidation.
3. Complete hard-requirement resolution.
4. Complete deterministic scoring and confidence.
5. Complete status, reason, task, shortlist, and proposal derivation.
6. Complete audit intents and attempt finalization.
7. Complete correction and supersession.
8. Complete named read models and CLI handlers.
9. Complete recruiter UI and Trust Center.
10. Complete Class 1 assertions and six Playwright workflows.

### Gate 6: Add tier-two volume corpus

Generate approximately 115 additional synthetic candidates for exactly 140 main members. Keep variant attempts separate. Run twice on fresh databases and once with shuffled completion timing. Canonical results must match byte for byte.

### Gate 7: Verify the product

All unit, property, type, architecture, integration, Class 1, coverage, and browser gates pass. Fixture mode produces zero network calls. Immutable history, stale conflicts, correction lineage, audit trace, known limitations, synthetic bias labels, and absence of outbound effects are verified.

### Gate 8: Record performance and accept the demo

Record D23 reference-profile benchmarks and meet every stated budget. Run `make demo` without credentials, verify exactly 140 candidates, fixture finalization, Class 1 completion, production UI readiness, session protection, and zero live calls.

## Acceptance criteria matrix

| Product claim | Acceptance evidence |
|---|---|
| Pure decision engine | Import checks plus absence of I/O, time, randomness, runtime, or persistence imports in core |
| One shared composition | CLI, web, and eval integration tests reach the same runtime use-case factories |
| Reproducibility | Pinned snapshots and specs, canonical bytes, two fresh-database runs, shuffled completion run |
| Deterministic score | Exact worked examples, properties, threshold tests, six-term persisted calculation |
| Deterministic confidence | Exact term audit, bounds and clamp properties, no model confidence field |
| Grounded evidence | Shared strict validator, quote relocation, source-slice invariant, candidate packet E2E |
| Untrusted input safety | Injection, markup, schema smuggling, fabricated reference, and oversized-response tests |
| No partial official run | Attempt readiness checks, deferred seals, blocked-finalization integration tests |
| Immutable history | Update and delete trigger test for every fact and association |
| Safe retries | Stored receipts, request-hash conflicts, zero-repeat mutation and adapter-call assertions |
| Stale human safety | Multi-context browser conflict with refresh-required result |
| Conservative requirements | Absence and conflict resolve unknown; only conclusive fail rejects |
| Human-controlled correction | Superseding result, retained original, task review-required after re-extraction |
| Proposal-only external actions | Approve, edit, reject E2E plus zero transport or outbound SDK invocation |
| Bounded reads | Named read models, keyset cursors, constant query counts, index-plan tests |
| Offline demo | Real `make demo` E2E with no credential and zero provider requests |
| Honest Trust Center | At least three visible limitations and traceable hallucination-resistance counts |
| Honest bias artifact | Synthetic and insufficient-sample labels, counts, exact ratios, noncomputable cells |
| Performance claim | Recorded reference-profile artifact meeting D23 budgets |

## Worktree parallelization strategy

### Dependency table

| Step | Modules touched | Depends on |
|---|---|---|
| Workspace scaffold | repository root, package manifests, CI | Architecture plan |
| Core foundations | `packages/core/domain`, `canonical`, `matching`, `scoring` | Workspace scaffold |
| Persistence foundations | `packages/runtime/db`, migrations | Workspace scaffold and structural core schemas |
| Runtime command engine | `packages/runtime/commands`, `scheduler`, `adapters` | Persistence foundations and core Results |
| UI and CLI shells | `apps/cli`, `apps/web` | Workspace scaffold and runtime composition interfaces |
| Test harnesses | root test config, `tests/integration`, `tests/e2e` | Workspace scaffold |
| Recruiter input and rubric | `docs`, rubric inputs | Architecture plan |
| Tier-one corpus and expectations | `fixtures/corpus`, `fixtures/expected` | Rubric freeze |
| Fixture recording | `fixtures/extractions` | Tier-one expectations and live credential |
| Product decision pipeline | `packages/core/pipeline` | Rubric and tier-one fixtures |
| Product runtime flows | `packages/runtime/use-cases`, `read-models` | Product decision pipeline and command engine |
| Product UI and CLI | `apps/web`, `apps/cli` | Product runtime flows |
| Tier-two corpus | `fixtures/corpus` | Stable tier-one behavior |
| Verification and benchmark | tests, evals, benchmark output | Complete vertical slice and full corpus |

### Parallel lanes

- Lane A: workspace scaffold, then core foundations, then product decision pipeline
- Lane B: persistence foundations, then runtime command engine, then product runtime flows
- Lane C: UI and CLI shells, then product UI and CLI
- Lane D: test harnesses, then integration and browser verification
- Lane E: recruiter input, rubric freeze, tier-one authoring, fixture recording, then tier-two generation

Execution order:

1. Land the workspace scaffold centrally.
2. Launch core foundations, persistence foundations, UI and CLI shells, test harnesses, and recruiter outreach in parallel worktrees.
3. Merge structural core schemas before persistence and app shells bind their interfaces.
4. Freeze rubric, author expectations, and record fixtures sequentially in Lane E.
5. Complete the product pipeline before runtime finalization and read models.
6. Complete app flows and verification after runtime contracts land.
7. Add tier two, then run full verification and benchmarks.

Conflict flags:

- Lanes A and B both consume core schemas. Land schema contracts before both proceed deeply.
- Lanes C and D both touch app test configuration. Assign root configuration ownership to Lane D.
- Product-specific fixture work is intentionally sequential because rubric, expectations, and recordings must not race.
- Migrations have one owner at a time because generated and handwritten SQL order is global.

## Implementation Tasks

Synthesized from this review. Checkbox each task only after its verification command passes.

- [ ] **T1 (P1, human: ~6h / agent: ~2h)**: Repository: scaffold the pinned TypeScript workspace
  - Surfaced by: Package boundaries and D14 test architecture
  - Modules: repository root, `packages`, `apps`, test configuration, CI
  - Verify: `corepack pnpm install --frozen-lockfile`, `pnpm test:types`, and architecture import checks
- [ ] **T2 (P1, human: ~14h / agent: ~5h)**: Core: implement canonical domain schemas and deterministic primitives
  - Surfaced by: D6, D9, D10, D12, and D32
  - Modules: `packages/core/domain`, `canonical`, `matching`, `scoring`, `errors`
  - Verify: `pnpm --filter @recruitos/core test` and `pnpm test:types`
- [ ] **T3 (P1, human: ~18h / agent: ~7h)**: Persistence: implement strict schema, migrations, triggers, seals, and connection factory
  - Surfaced by: D8, D20, D30, D33, and D36
  - Modules: `packages/runtime/db`, migration SQL, integration fixtures
  - Verify: `pnpm test:integration -- migrations` and immutable-integrity matrix
- [ ] **T4 (P1, human: ~14h / agent: ~5h)**: Runtime: implement transactional commands, receipts, conflicts, audit writes, and reset guard
  - Surfaced by: D4, D11, D26, and D27
  - Modules: `packages/runtime/commands`, `use-cases`, `errors`
  - Verify: `pnpm test:integration -- commands reset`
- [ ] **T5 (P1, human: ~14h / agent: ~5h)**: Runtime: implement content-addressed adapters and bounded resumable scheduler
  - Surfaced by: D5, D7, D19, D22, and D25
  - Modules: `packages/runtime/adapters`, `scheduler`, artifact repositories
  - Verify: shared adapter contract and scheduler integration suites
- [ ] **T6 (P1, human: ~5h / agent: ~2h)**: Product: obtain hiring-process input and freeze rubric v1
  - Surfaced by: Binding sequence and D35
  - Modules: `docs`, rubric input, workflow assumptions
  - Verify: validated canonical rubric, approval record, and hashes; no fixture recording predates freeze
- [ ] **T7 (P1, human: ~28h / agent: ~8h)**: Fixtures: author and independently review tier-one corpus and expectations
  - Surfaced by: D15 anti-self-agreement and D35 Gate 3
  - Modules: `fixtures/corpus`, `fixtures/expected`
  - Verify: coverage matrix, second-review record, at least three known limitations, no real data
- [ ] **T8 (P1, human: ~8h / agent: ~3h)**: Fixtures: record and verify tier-one extraction artifacts
  - Surfaced by: D6, D7, D15, and D34 fixture safety
  - Modules: `fixtures/extractions`, calibration freeze
  - Verify: `recruitos fixtures:verify`; expected-outcome diff remains empty
- [ ] **T9 (P1, human: ~20h / agent: ~7h)**: Core: complete consolidation, facts, requirements, score, confidence, routing, shortlist, and proposals
  - Surfaced by: D28, D29, and deterministic product claims
  - Modules: `packages/core/pipeline`, `evaluation`
  - Verify: core examples, properties, exact arithmetic, and Class 1 candidate expectations
- [ ] **T10 (P1, human: ~18h / agent: ~7h)**: Runtime: finalize runs and implement correction, re-extraction, and read models
  - Surfaced by: D5, D21, D25, D26, D31, and D36
  - Modules: `packages/runtime/use-cases`, `read-models`, `composition`
  - Verify: runtime integration suite, query-count suite, and shuffled-order reproducibility
- [ ] **T11 (P1, human: ~10h / agent: ~4h)**: CLI: implement the locked command surface and one-command demo
  - Surfaced by: D11, D23, D27, and D34
  - Modules: `apps/cli`, root scripts, Makefile
  - Verify: CLI project tests and `tests/e2e/demo-start.e2e.ts`
- [ ] **T12 (P1, human: ~32h / agent: ~11h)**: Web: implement recruiter packet, queues, resolution, proposal, audit, and Trust Center flows
  - Surfaced by: D7, D16, D21, D25, and D31
  - Modules: `apps/web`
  - Verify: web presenter tests plus all six Playwright workflows
- [ ] **T13 (P1, human: ~10h / agent: ~3h)**: Corpus: generate tier two and seal the 140-candidate main manifest
  - Surfaced by: Two-tier corpus and D30
  - Modules: `fixtures/corpus`, manifest generation
  - Verify: corpus seal, synthetic-data scan, two fresh-database replays, shuffled completion replay
- [ ] **T14 (P1, human: ~18h / agent: ~6h)**: Verification: complete Class 1, Class 2 measurement, bias report, and coverage gates
  - Surfaced by: D14, D15, D17, and D18
  - Modules: `packages/core/evaluation`, CLI eval commands, tests
  - Verify: `pnpm check`, `pnpm eval:class1`, and explicit non-gating live measurement dry run
- [ ] **T15 (P1, human: ~8h / agent: ~3h)**: Demo readiness: record reference benchmarks and operator documentation
  - Surfaced by: D23, D24, D34, and D35 Gate 8
  - Modules: benchmark commands, `docs`, committed reviewed performance history
  - Verify: D23 benchmark artifact and credential-free `make demo`

## Inline diagrams required during implementation

Keep short ASCII state diagrams beside these complex implementations:

- D4 command executor transaction and receipt branches
- attempt work-item state machine and claim recovery
- finalization write order and seal insertion
- candidate correction and task projection state machine
- packet read anchoring against immutable result ID
- demo reset preparation versus transactional work

Update a diagram in the same change whenever its state or transaction flow changes.

## NOT in scope

- Real candidate data: prohibited because the demo and audit claims are synthetic-only.
- Real ATS integration: mock import only; provider requirements have not been observed.
- ATS stage mutation: stage changes remain reviewable proposals.
- Email or rejection delivery: approval records a decision but sends nothing.
- Calendar, Slack, and sourcing integrations: no exercised v1 use case or adapter.
- Generic outbound-action port: it would weaken the typed proposal model.
- Hosted multi-user service: v1 is a single-host local SQLite application.
- NFS, SMB, cloud-synced, remote, or multi-host database use: incompatible with the supported SQLite deployment.
- Global database lease or queue: item claims and expected-version commands provide the needed coordination.
- Full event sourcing and replay: immutable facts and append-only audit provide the required history without replay machinery.
- Cryptographic audit tamper proofing: an administrator controlling database files can replace history.
- Chunked document extraction: oversized documents are rejected in v1.
- Automatic fixture, snapshot, expected-outcome, or benchmark-baseline updates: all require explicit reviewed file changes.
- Live model quality as a CI gate: provider quality is measured separately and never makes deterministic tests flaky.
- Legal compliance certification or independent bias audit: the Trust Center is a synthetic demonstration and states its limits.
- Rubric-dependent fixture authoring before recruiter input and rubric freeze: prohibited by the binding build sequence.

No follow-up TODO is proposed for these items. They are explicit product exclusions that require new acceptance examples and authorization, not deferred implementation debt. Future integrations must add acceptance examples, one provider-neutral port, one real adapter, one fake adapter, and contract tests in the same change.

## Decision register

- D1: Use proactive engineering review.
- D2: Preserve the full approved candidate-triage scope.
- D3: Split pure core from effectful runtime; CLI and web share runtime use cases.
- D4: Use transactional idempotent commands with expected versions.
- D5: Keep operational attempts separate from immutable finalized runs.
- D6: Pin content-addressed run snapshots and extraction specifications.
- D7: Enforce an untrusted-document boundary through rendering.
- D8: Protect immutable fact tables in SQLite and move explicit mutable heads.
- D9: Make core Zod schemas the single domain source of truth.
- D10: Use zero-based end-exclusive UTF-16 offsets.
- D11: Use typed Result unions and stable recovery metadata.
- D12: Make time, identity, and every ordering rule explicit.
- D13: Define only ports exercised in v1.
- D14: Use Vitest, V8 coverage, fast-check, real SQLite, and Playwright.
- D15: Separate deterministic evals, live measurement, and synthetic bias reporting.
- D16: Require six focused browser workflows.
- D17: Evaluate spans with one-to-one exact-rational character IoU.
- D18: Approve the test architecture; current coverage remains zero until built.
- D19: Use a bounded resumable worker pool with transactional claims.
- D20: Pin stable Drizzle and `better-sqlite3` behind one connection factory.
- D21: Use named bounded read models and keyset pagination.
- D22: Hash the complete validation policy and enforce deterministic capacity limits.
- D23: Gate deterministic performance properties and benchmark wall-clock budgets separately.
- D24: Approve performance architecture; current evidence remains zero until measured.
- D25: Persist reviewable extraction failures without leaking partial runs.
- D26: Keep one primary expected version plus typed secondary head preconditions.
- D27: Rebuild the guarded synthetic database in place transactionally.
- D28: Consolidate multi-document levels without averaging or fabricating availability.
- D29: Deduplicate grounded facts semantically and resolve conflict conservatively.
- D30: Separate candidate identity, content-addressed documents, ownership, and corpus membership.
- D31: Model re-extraction as a candidate-correction attempt followed by human review.
- D32: Use integer configuration and exact rational decision arithmetic.
- D33: Normalize immutable relationships and limit JSON to typed bounded payloads.
- D34: Expose a thin namespaced CLI over runtime use cases.
- D35: Use rubric-gated pre-rubric and post-rubric build lanes.
- D36: Use deferred typed publication seals for multi-row aggregate integrity.

## Open prerequisites

These are execution prerequisites, not unresolved architecture decisions:

- Complete recruiter or hiring-process outreach, or sign the D35 assumption record after the defined fallback period.
- Freeze and approve rubric v1 before authoring tier-one expected outcomes.
- Supply a live provider credential once for fixture recording. The credential is never required for demo, normal tests, Class 1 evals, or fixture replay.

No architecture or product decision remains open.

## GSTACK REVIEW REPORT

### Completion summary

- Step 0, Scope Challenge: approved scope accepted as-is
- Architecture Review: 11 issues identified and resolved
- Code Quality Review: 4 issues identified and resolved
- Test Review: execution diagram produced, 4 strategy gaps identified and resolved
- Performance Review: 5 issues identified and resolved
- Cross-decision reconciliation: 12 issues identified and resolved
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 0 items proposed because explicit exclusions are not deferred debt
- Failure modes: 0 critical gaps flagged
- Outside voice: nested pass skipped because this session already runs under Codex
- Parallelization: 5 lanes, parallel after the central scaffold, with gated sequential joins
- Lake Score: 36 of 36 decisions selected the complete recommended option
- Current product-test coverage: zero until implementation and test execution
- Current product-performance evidence: zero until D23 benchmarks execute

### Review readiness dashboard

| Review | Scope | Status | Findings |
|---|---|---|---:|
| Approved office-hours design | Product and wedge | APPROVED at `51acb79` | Applied in full |
| Engineering plan review | Architecture and execution | CLEAR (PLAN) | 36 decisions locked |
| Outside voice | Independent plan challenge | SKIPPED under Codex host | 0 incorporated |
| Design plan review | Visual and interaction design | Not logged for this plan | Follow-up only if UI design changes |
| Developer-experience plan review | CLI and contributor experience | Not run | Optional before implementation |

- **VERDICT:** ENGINEERING PLAN CLEARED. The architecture, tests, edge cases, schema, CLI, performance controls, build gates, and acceptance evidence are locked and ready for implementation after the stated prerequisites.

NO UNRESOLVED DECISIONS
