# RecruitOS

Explainable, auditable agentic recruiting automation.

RecruitOS replaces black-box resume screening with a transparent, evidence-grounded candidate triage control plane. It imports candidate resumes, extracts reviewable evidence claims with verbatim source citations, computes scores deterministically from a locked rubric, routes uncertainty into explicit human resolution tasks, and records an immutable audit history.

---

## The Core Thesis

Modern AI recruiting tools suffer from the **black-box score crisis**: language models output arbitrary match percentages (such as "84% match") without verifiable citations, hallucinate qualifications, silently discard non-traditional candidates, and fail compliance and adverse impact audits.

RecruitOS flips this paradigm with one foundational architectural rule:

> **Language models extract and ground evidence; deterministic code evaluates and scores.**

The LLM is strictly prohibited from emitting numerical scores, ratings, letter grades, or candidate hiring decisions. Its only job is to find verbatim text quotes in candidate documents and map them to locked rubric anchors. Everything else is computed by pure, deterministic functions and recorded in an append-only audit ledger.

---

## Key Architectural Principles

### 1. Verbatim Evidence Grounding (`EvidenceBracket`)
Every dimension assessment must cite a verbatim contiguous text span from the candidate's source documents. If an extractor returns a quote that cannot be relocated in the source text, the claim is rejected as ungrounded, confidence drops, and the candidate is escalated for review.

### 2. Visible Arithmetic & Exact Rational Scoring
Candidate scores are never arbitrary numbers or badges. The aggregate score appears exclusively as the output of **visible arithmetic**:
- Scores are evaluated using exact rational arithmetic (fractions such as `467/6`, approximately `77.83/100`) rather than lossy floating-point math.
- The 5-column decomposition table (`Dimension`, `Weight`, `Level`, `Points`, `Score`) makes every point mathematically auditable.

### 3. Ordinal, Not Categorical (`LevelChip`)
Assessment levels (`none`, `weak`, `partial`, `strong`) are ordinal measurements. They are rendered using a 4-segment neutral foreground grey `LevelChip` (empty outlines for `none`, 1 filled for `weak`, 2 for `partial`, 4 for `strong`). Levels never receive categorical color hues (such as green or red), ensuring ordinal data looks ordinal.

### 4. Human-in-the-Loop Escalation
RecruitOS does not make silent assumptions. When an evaluation hits missing required evidence, ungrounded quotes, or confidence below threshold, the candidate status becomes `escalated` and an explicit `resolution_task` is opened for a human recruiter.

### 5. Preserved Lineage and Supersession
When a human operator resolves a task or completes a re-extraction, the previous result is not overwritten. The original result is preserved immutably, and the new result supersedes it via active head version pointers. Both current and historical packets remain inspectable with symmetric navigation.

### 6. Section 01 Known Limitations
Trust begins with transparency. Section 01 of the System Trust Center leads with what the system cannot do or gets wrong, supported by persistent counters in the global bar.

---

## The Five Workspaces

RecruitOS organizes candidate review into five dedicated destinations:

| Destination | Route | Purpose |
|---|---|---|
| **Triage Queue** | `/triage` | Ranked candidate list organized into Scored, Escalated, and Rejected groups with shortlist cut rules and evidence-coverage strips. |
| **Candidate Packet** | `/packet/:id` | Three-pane deep review layout: Visible Arithmetic (Pane A), Evidence Ledger (Pane B), and Source Resume with interactive span highlights (Pane C). |
| **Resolution Queue** | `/review` | Recruiter task workspace to inspect escalations, review proposed levels, and trigger fixture re-extractions. |
| **Audit Timeline** | `/runs` | Immutable, append-only event ledger tracking every ingestion, extraction run, scoring seal, and human mutation. |
| **Trust Center** | `/status` | System health, Section 01 known limitations, bias audit summaries, and synthetic data disclosures. |

---

## The 7-Route Proving Corpus

RecruitOS includes a hermetic, reproducible 7-candidate proving corpus demonstrating every pipeline path without external network calls:

1. **`demo/route-1-scored`**: Strong candidate with full evidence coverage across all 6 rubric dimensions, achieving a deterministic score of `467/6` (approx. `77.83/100`).
2. **`demo/route-2-rejected`**: Candidate failing the mandatory professional experience floor, producing a conclusive hard-requirement rejection without silent drops.
3. **`demo/route-3-work-authorization`**: Missing work authorization documentation, triggering automatic escalation to a human task.
4. **`demo/route-4-reviewable-failure`**: Upstream extraction failure creating an open recruiter task, which can be re-extracted and superseded via fixture correction.
5. **`demo/route-5-missing-evidence`**: Missing evidence for a required dimension, displaying an explicit `EvidenceGapCard` with reason codes.
6. **`demo/route-6-work-authorization`**: Candidate whose work authorization is verified through structured application answers.
7. **`demo/route-7-quote-grounding`**: Model hallucination test: one extractor quote fails document relocation, visibly reducing candidate confidence and highlighting grounding failure.

---

## Quickstart

### Prerequisites
- Node.js `>= 24.19.0`
- pnpm `>= 10.17.1` (managed via `corepack`)

RecruitOS runs completely hermetic in demo mode: **no external API keys (OpenAI, Anthropic, Gemini) are required**.

### Installation

```bash
# Enable corepack and install dependencies
corepack enable
corepack pnpm install

# Build all workspace packages
corepack pnpm build
```

### Running the Demos

#### 1. Offline Proving Run (`make demo`)
Prepares an ephemeral SQLite database, imports the 7-candidate corpus, extracts evidence, executes deterministic scoring, prints the route-1 candidate packet, and runs Class 1 consistency evaluations:
```bash
make demo
```

#### 2. Stakeholder Verification (`make demo-stakeholder`)
Executes the end-to-end demonstration of both core promises: Promise 1 (deterministic scoring) and Promise 2 (escalation to human resolution and re-extraction):
```bash
make demo-stakeholder
```

#### 3. Web User Interface (`make demo-web`)
Launches the RecruitOS web interface on port 3000 in read-only triage mode:
```bash
make demo-web
# Open http://127.0.0.1:3000/triage in your browser
```

#### 4. Web Interface with Human Correction Flow (`make demo-web-correction`)
Launches the web interface with interactive re-extraction and correction flows enabled:
```bash
make demo-web-correction
# Open http://127.0.0.1:3000/review to inspect open tasks and complete corrections
```

---

## Repository Architecture

The project is structured as a pnpm monorepo with strict package boundary enforcement:

```text
recruitos/
├── packages/
│   ├── core/         # Pure domain types, locked rubric v1, exact rational math, zero side-effects
│   └── runtime/      # SQLite persistence, command execution, use-cases, and audit logging
├── apps/
│   ├── cli/          # Command-line interface and composition adapter
│   └── web/          # SSR web server, CSS tokens, and Variant B Bench UI components
├── tests/
│   ├── e2e/          # Playwright browser workflows for all primary user journeys
│   └── integration/  # Multi-package transaction and trigger integration tests
├── scripts/          # Architecture boundaries, browser bundling, and demo orchestration
└── docs/             # Product specifications, rubric locks, and design system definitions
```

---

## Quality & Verification Gates

RecruitOS enforces strict verification gates before any code lands:

- **Type Safety**: Strict TypeScript across all packages (`corepack pnpm test:types`).
- **Architecture Boundaries**: Structural linter ensuring pure packages never import runtime or IO (`corepack pnpm check:architecture`).
- **Dynamic Code Denial**: Automated scan ensuring `eval` and dynamic code generation remain banned (`corepack pnpm check:dynamic-code`).
- **Client Bundle Safety**: Validates that browser code never leaks Node or SQLite dependencies (`corepack pnpm check:browser`).
- **Full Test Suite**: Comprehensive unit, property, and integration tests (`corepack pnpm check`).
- **Browser Automation**: End-to-end Playwright tests covering all candidate triage workflows (`corepack pnpm test:e2e`).
- **House Style**: Zero em dashes across all code, comments, documentation, and commit messages.
