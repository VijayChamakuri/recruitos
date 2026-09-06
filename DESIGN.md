# Design System and UX Direction: RecruitOS

Status: **APPROVED** 2026-09-05. All four deliberate risks accepted as written.
Created: 2026-09-05 by `/design-consultation`
Binds: `docs/designs/recruitos-candidate-triage-control-plane.md` (product, APPROVED)
Binds: `docs/plans/recruitos-candidate-triage-implementation-plan.md` (architecture, CLEARED)

This document is the source of truth for every visual and interaction decision in
`apps/web`. It does not reopen the engineering architecture. Where a UX requirement
implies an architectural clarification, it is called out in "Architecture notes raised
by UX" at the end, and nowhere else.

House rule for all product copy, docs, and commits in this repo: no em dashes.

---

## Locked at approval

Approved 2026-09-05. The four deliberate risks below were reviewed against the
alternative of cutting them and were kept. Changing any line in this section requires an
explicit decision record, not a judgment call during implementation.

**The four risks, all kept:**

1. The Trust Center opens with known limitations and never uses green as a success
   shortcut. See Part 13.
2. The score never renders as a badge, ring, gauge, or grade, and is never the primary
   truth object. See Part 8, rule 1.
3. Typography separates machine data, source documents, and human review prose into three
   distinct systems. See Part 3.
4. The queue's primary scan signal is the six-cell evidence coverage strip, not a plain
   match-score column. See Part 9.

The accepted tradeoff, stated so nobody relitigates it later: a hiring manager who wants
one number will need one sentence of explanation. That is worth paying, because the
explanation is the product. A score-first design would make RecruitOS look like the
pattern the project exists to challenge.

**Also locked:**

| Constraint | Where it is specified |
|---|---|
| Light mode primary, dark mode a complete peer | Part 2, Part 4 |
| Fonts self-hosted and committed, no CDN dependency for the demo | Part 3, Part 17.1 |
| Green never means passed, anywhere, in either theme | Part 4 |
| Hue encodes evidence polarity only | Part 4, Rule 1 |
| No raw status color shortcut. Status uses weight, rule, and typography | Part 4, Rule 2 |
| The evidence bracket is the signature component | Part 2, Part 15 |
| Known limitations visible in the first viewport and counted in the global bar | Part 6, Part 13 |
| No `Save anyway` on a stale conflict | Part 10 |
| Every Trust Center count is clickable through to its rows | Part 13.04 |
| The score is not in the packet header | Part 8, rule 1 |
| Three permanently visible evidence slots per dimension | Part 8, rule 5 |
| Theme and density URL-addressable with deterministic defaults | Part 5, Part 17.4 |
| Whole-packet `data_integrity_failed` and per-span slice failure are separate components | Part 8, rule 9, Part 17.3 |

---

## Part 1: Product Context

- **What this is:** an internal recruiting command center for one urgent req. It turns
  scattered candidate documents into inspectable evidence packets, computes score and
  confidence deterministically, routes uncertainty to a named human task, and proves its
  own AI workflow through trust and evaluation surfaces.
- **Who it is for:** the recruiter working the queue (primary), the hiring manager reading
  one packet (secondary), the talent lead looking for stuck work, the founder wanting
  status. A fifth reader is real and the approved design names them: an engineering
  evaluator assessing system judgment in one sitting, with no credentials.
- **Space:** an intelligence and trust layer above the ATS. Peers: Ashby, Greenhouse,
  Lever, Metaview. None of them expose the decomposition.
- **Project type:** data-dense internal tool. Single host, local SQLite, offline demo.
  Not a marketing site. There is no landing page and none will be designed.

### The memorable thing

> **RecruitOS is the recruiting tool that opens with what it got wrong.**

That is the sentence someone should be able to repeat after five minutes with the app.
Every decision in this document serves it. When two options are otherwise equal, pick
the one that makes the system's uncertainty and its failures more visible, not less.

### The claim the design must make obvious

RecruitOS does not just rank candidates. It creates inspectable evidence packets, routes
uncertainty to humans, and proves its AI workflow through trust and evaluation surfaces.

Three design consequences follow, and they are non-negotiable:

1. **The ranked list is a view over packets, so the packet gets the design budget.**
   The queue is a table, deliberately plain. The packet is the product.
2. **Uncertainty is a first-class object with its own queue, its own color, and a count
   in the global chrome.** It is never a filter you have to remember to apply.
3. **The Trust Center is a report that leads with failures.** Known limitations are
   section 01, not an appendix.

---

## Part 2: Aesthetic Direction

- **Direction:** Industrial and utilitarian chrome wrapped around an editorial document
  surface. Working name: **paper and graphite**.
- **Decoration level:** minimal. Typography, hairlines, and four rationed hues do all the
  work. One texture exists in the whole product: a 4px dotted measurement grid, used only
  behind Trust Center charts and the arithmetic panel.
- **Mood:** a case ledger crossed with an instrument panel. Calm, precise, slightly
  clinical. Software that can testify about what it did.
- **Reference points from research:** Linear's density discipline (36px rows,
  keyboard-first, almost no chrome); PaperTrail's claim-evidence three-panel grounding
  layout from CHI 2026; the 2026 AI citation vocabulary of deep-linked source passages
  with in-document highlighting.

### The one structural idea: the evidence bracket

A 3px colored left rule that threads a single claim through every surface it touches:
the evidence card, the highlighted span in the source document, the arithmetic term it
feeds, and the audit event that created it. Focusing any one of the four highlights the
other three. This is the product's signature component and the thing a reviewer should
remember visually.

### Light is primary

Dark mode is the convergence default for developer tooling in 2026 (Datadog, Grafana,
Sentry, Supabase, Vercel all ship dark-first). RecruitOS goes the other way. The core
act in this product is **reading a document and checking a quote against it**, and the
evidence surface should read as paper. Graphite chrome, paper-white evidence panes.

Dark theme is a complete peer, not an afterthought: it exists for long queue sessions
and it is fully specified below. Light is what ships as the default and what the README
screenshots use, because a bias-audit artifact should be printable and a GitHub reader
should not be handed eight dark rectangles.

### Deliberate departures from category norms

**Risk 1: the Trust Center opens with known limitations, and green appears nowhere in it.**
Every AI trust surface in this category is built to reassure. RecruitOS's governing risk
is that the corpus, fixtures, rubric, and evaluator all co-design to agree and the report
comes out all green. The approved design already commits at least three tier-1 cases as
permanent `known_limitation` fixtures so that cannot happen. The UI has to match: a
passing Class 1 check renders as a small mono `ok`, never a green circle. A failure
renders as `FAIL` in iron red with the diff, and it is treated as proof the system is
measuring itself.
*Gain:* the strongest available signal of rigor, and no competitor will copy it.
*Cost:* a stakeholder skimming for reassurance will read the product as unfinished. It
takes one caption to land.

**Risk 2: the score is never a badge.**
No ring gauge, no big colored percentage, no letter grade, no star rating. The aggregate
appears only as the output of visible arithmetic, and it does not appear in the packet
header at all. The demand evidence behind this product says a recruiter handed a bare
percentage opens the resume and reads it anyway, which means an unexplained score adds a
step instead of removing one. Putting the number in the header would make it the answer
before the reader sees the proof.
*Gain:* structurally prevents the failure mode the product exists to fix.
*Cost:* slower first-glance scanning, and harder to screenshot for a non-technical viewer.

**Risk 3: two type systems in one product.**
Machine-side data (queues, IDs, hashes, offsets, arithmetic, audit rows) is grotesque and
monospace, tight and tabular. Human-written source text (the normalized resume, quoted
evidence, Trust Center report prose) is a serif at reading size on a measured column. The
seam between "what the machine computed" and "what a person wrote" becomes legible
without a label. No ATS renders a resume as a document; they all render it at 13px in the
same UI font as the chrome, inside a scrollbox.
*Gain:* reading a resume finally feels like reading.
*Cost:* three families to self-host, and a reviewer could call it inconsistent.

**Risk 4: the queue's primary scan signal is an evidence-shape strip, not a match score.**
Each queue row carries a six-cell micro-strip, one cell per rubric dimension: filled when
a span is located, hatched when contradicted, hollow and dashed when there is a gap. You
can see the evidence shape of 140 candidates in one vertical scan, which is something a
single number cannot tell you.
*Gain:* the queue communicates coverage and disagreement, not just rank.
*Cost:* needs a legend the first time, and it is unfamiliar.

### Safe choices, and why they stay safe

1. **Left rail, master and detail, keyboard-first table.** Recruiters and engineers both
   already know this shape. Novelty here buys nothing and costs orientation.
2. **Compact tabular data with real tabular numerals.** Table stakes for 140 rows.
3. **Restrained near-monochrome with rationed semantic hue.** Standard for serious
   internal tooling, and it is what keeps four semantic colors legible at chip size.

---

## Part 3: Typography

Three families, all open-licensed, all **self-hosted and committed to the repo**. No CDN
`<link>` tags. `make demo` performs zero network calls, so a Google Fonts reference would
render fallback faces in the exact demo the product is judged on.

| Role | Family | Notes |
|---|---|---|
| UI chrome, labels, buttons, queue rows | **IBM Plex Sans** | institutional and engineering-document register, not a startup grotesque |
| Table column heads at 11px only | **IBM Plex Sans Condensed** | density where it actually pays, nowhere else |
| Source documents, quoted evidence, Trust Center prose, bias statement | **Source Serif 4** | the editorial layer, pairs natively with the Plex register |
| Arithmetic, IDs, hashes, offsets, reason codes, timestamps, audit rows, eval counts | **IBM Plex Mono** | `font-variant-numeric: tabular-nums lining-nums` always on |
| Code | **IBM Plex Mono** | same face, no separate code font |

There is no display face. A serious instrument does not need one. The largest text in the
product is the candidate name at 26px and the Trust Center report title at 26px. Authority
comes from precision, not scale.

Uppercase is reserved for short operational labels only (`CONTRADICTING`, `SYNTHETIC DATA`,
`REQUIRES HUMAN`, `ON THE RECORD`) at `letter-spacing: 0.04em`. Never wide-tracked.

### Scale

```css
--t-micro:  11px / 15px;  /* mono caps labels, column heads, reason codes  */
--t-xs:     12px / 16px;  /* metadata, timestamps, offsets, keyboard hints */
--t-sm:     13px / 18px;  /* dense table rows, chips, default table text   */
--t-base:   14px / 20px;  /* UI default, forms, buttons                    */
--t-md:     16px / 24px;  /* panel titles, packet section heads            */
--t-lg:     19px / 26px;  /* screen titles                                 */
--t-xl:     26px / 32px;  /* candidate name, Trust Center report title     */
--t-doc:    17px / 27px;  /* Source Serif 4, normalized document body      */
--t-doc-sm: 15px / 24px;  /* Source Serif 4, quoted evidence inside cards  */
```

Document column caps at **68ch**. Everything else is fluid.

---

## Part 4: Color

**Approach:** restrained. Two design rules govern the entire palette, and every future
color decision has to pass both.

> **Rule 1. Hue encodes evidence polarity and nothing else.**
> **Rule 2. Status is encoded by weight, rule, and typography, not by hue.**

Green is never used for status anywhere in the product, in either theme. Teal means
"evidence was located," not "this candidate passed." Iron red appears in exactly two
places in the whole application: `rejected_hard_requirement` status, and a Class 1 `FAIL`.
That scarcity is what makes red mean something when it shows up.

An evidence gap has **no hue at all**. It renders as a dashed hairline outline with muted
text and an empty fill. A gap is the absence of something, so it is the absence of color.

### Light theme (default)

```css
:root {
  color-scheme: light;

  --bg:               #ECEEEF;  /* graphite-tinted app background     */
  --surface:          #F7F8F8;  /* rail, chrome panels                */
  --surface-paper:    #FFFFFF;  /* evidence panes, source documents   */
  --surface-inset:    #E4E7E8;  /* table heads, wells, code blocks    */
  --hairline:         #CDD2D4;
  --hairline-strong:  #98A0A4;

  --text:             #14181B;
  --text-muted:       #5C666B;
  --text-faint:       #838C91;

  --accent:           #2F5FD0;  /* interaction, focus, selection, escalation rule */
  --accent-hover:     #24499F;
  --accent-wash:      #E6EDFB;

  --support:          #0F7A6A;  /* supporting evidence  */
  --support-wash:     #DFF0EC;
  --contradict:       #B07A16;  /* contradicting evidence */
  --contradict-wash:  #F7EEDA;
  --gap-outline:      #98A0A4;  /* dashed, no fill        */

  --danger:           #9E2B25;  /* rejected_hard_requirement, Class 1 FAIL ONLY */
  --danger-wash:      #F7E3E1;

  --grid-dot:         #D6DADC;  /* measurement grid, charts + arithmetic only */
}
```

### Dark theme (complete peer)

Saturation reduced 12 to 18 percent, surfaces redesigned rather than inverted.

```css
[data-theme="dark"] {
  color-scheme: dark;

  --bg:               #0E1114;
  --surface:          #161A1E;
  --surface-paper:    #1C2126;  /* still the lightest surface, still "paper" */
  --surface-inset:    #12161A;
  --hairline:         #2C333A;
  --hairline-strong:  #5E6871;

  --text:             #E9EDEF;
  --text-muted:       #99A3AA;
  --text-faint:       #77818A;

  --accent:           #7AA5F5;
  --accent-hover:     #9CBEFF;
  --accent-wash:      #17263F;

  --support:          #4FC0A8;
  --support-wash:     #102B27;
  --contradict:       #DFAE55;
  --contradict-wash:  #2E2513;
  --gap-outline:      #5E6871;

  --danger:           #E8827A;
  --danger-wash:      #331B19;

  --grid-dot:         #262C32;
}
```

### Semantic assignments, complete

| Meaning | Treatment |
|---|---|
| Supporting evidence | `--support` 3px left rule, `--support-wash` span highlight |
| Contradicting evidence | `--contradict` 3px left rule, `--contradict-wash` highlight **plus a 45-degree hatch underlay** so it is distinguishable without color |
| Evidence gap | dashed `--gap-outline` 1px, no fill, `--text-muted` body |
| Escalated, human required | `--accent` 3px left rule plus the reason code in mono. No fill |
| Scored | no color. Plain row |
| Rejected on hard requirement | `--danger` status token, row text at `--text-muted` |
| Known limitation | boxed `ON THE RECORD` chip, mono caps, 1px `--contradict` hairline |
| Class 1 pass | mono `ok` in `--text-muted`. No icon, no green |
| Class 1 fail | mono `FAIL` in `--danger` with the diff shown |
| Not computable | the literal words `not computable` in `--text-faint` mono. Never `0%`, never `100%` |
| Synthetic data | pill, mono caps, `--hairline-strong` outline, no fill |

Color is never the only carrier of meaning. Every semantic hue ships with a label, a rule
weight, or a fill pattern. Contrast targets: body text 7:1, all UI text and non-text
indicators at least 4.5:1 in both themes.

---

## Part 5: Spacing, Layout, Motion

### Spacing

Base unit **4px**. Density: **compact**.

```
2  4  8  12  16  24  32  48  64
```

- Cell padding: 8px horizontal, 6px vertical.
- 12px between related controls, 16px between panel sections, 24px between page regions.
- No card padding above 16px in any queue.
- Row striping is banned. Hairlines separate rows.
- Empty-state illustrations are banned. An empty state is one line of mono text.

### Density control

Three steps, a real preference and not a gimmick, because a recruiter working 140 rows and
a hiring manager reading 10 want different things:

| Mode | Row height | Table text |
|---|---:|---|
| compact | 28px | 12px / 16px |
| **default** | **36px** | **13px / 18px** |
| comfortable | 44px | 14px / 20px |

Density and theme are **URL-addressable** and default deterministically, so Playwright
runs and README captures pin them and never flake on a persisted preference.

### Radius

Square is the correct register.

```
--r-row:    2px   /* table rows, inline fields, chips     */
--r-panel:  4px   /* buttons, menus, panels, cards        */
--r-dialog: 6px   /* dialogs only                         */
--r-pill: 999px   /* small state tokens only, e.g. SYNTHETIC */
--r-mark:   0px   /* span highlights, never rounded       */
```

No drop shadows in the workspace. Elevation is a surface-value shift plus a hairline.
A single restrained shadow is allowed for menus and dialogs that must float.

### Layout

Grid-disciplined. Fixed **48px** global bar, fixed **216px** left rail, fluid work surface
to 1920px with 1440px as the comfortable target. The packet uses a 12-column grid.
Nothing in the application is centered.

### Motion

Minimal and functional. Four animations exist in the entire product. Adding a fifth
requires a decision record.

1. Evidence bracket highlight on cross-surface focus, 180ms ease-out, opacity and
   background only.
2. Source column scroll-to-span, 240ms ease-in-out.
3. Score and confidence delta on resolution commit, 400ms, tabular numerals so nothing
   reflows. This one is allowed to be slightly showy because it is the moment the product
   proves its claim.
4. Focus ring, 80ms.

No page transitions. No skeleton shimmer; loading is a static hairline placeholder. No
staggered entrances. `prefers-reduced-motion` disables 1, 2, and 3, and replaces 3 with an
instant value swap plus a static delta chip.

---

## Part 6: Information Architecture

Five destinations, mapping one to one onto the runtime's named read models. Nothing else
gets top-level navigation.

```
L0  APP SHELL
    global bar (48px)  ·  left rail (216px)  ·  ⌘K palette  ·  ⌘J Ask panel

L1  DESTINATIONS
    1  Triage Queue          getTriageQueue
    2  Resolution Queue      getResolutionQueue
    3  Proposal Review       getProposalQueue
    4  Audit Timeline        getAuditTimeline
    5  Trust Center          getTrustCenterReport

L2  DETAILS
    Candidate Packet         getCandidatePacket      (from 1, 2, 4)
    Resolution Inspector     right rail ON the packet, never a separate page
    Proposal Diff            expands in place in 3
    Trust Center sections    01 Known Limitations
                             02 Class 1 Invariants
                             03 Class 2 Live Measurement
                             04 Hallucination Resistance
                             05 Synthetic Bias Audit Demonstration
                             06 Calibration Freeze Delta
                             07 Workflow Assumptions

L3  OVERLAYS
    command palette · Ask panel (six saved queries) · actor picker
    stale conflict band · full-screen source reader · shortcut sheet
```

### The global bar carries the product claim

This is the most important single decision in the system. The global bar shows, on every
screen including the packet, and never inside a menu:

```
RecruitOS   Applied AI Engineer   run #7 sealed  │  SYNTHETIC DATA  │  41 open tasks  │  3 known limitations  │  V. Chen ▾
```

- `SYNTHETIC DATA` is a permanent provenance pill. It is in every README screenshot.
- `41 open tasks` is uncertainty routed to humans, counted in the chrome.
- `3 known limitations` links to Trust Center section 01.

"Known limitations visible in the UI" is implemented as permanent chrome, not as a page
you can avoid visiting.

---

## Part 7: Primary User Flows

### Flow A: recruiter works the queue (the daily loop)

```
Triage Queue
  scan evidence-coverage strips, not scores
  → open packet (Enter)
    → read arithmetic column, read evidence ledger, check a span against source
    → candidate is fine            → back to queue (Esc)
    → candidate is escalated       → Resolution Inspector opens on the packet
        → select text in the source column to create the span
        → set polarity, confirm or override the derive_level pre-fill
        → see the live delta preview: 61.7 → 72.9,  0.48 → 0.63
        → Record resolution (carries expectedVersion)
        → superseding result renders, original stays inspectable
  → Proposal Review
    → approve, edit, or reject each draft. No message is sent.
```

### Flow B: hiring manager reads one packet

Deep link to the packet, comfortable density, no queue context needed. Reads the
arithmetic column, expands the two dimensions they care about, follows one span into the
source. Leaves. Never touches the CLI, never sees the Trust Center unless they ask.

### Flow C: talent lead finds stuck work

Resolution Queue grouped by reason code, ordered by reason precedence then opened time.
Sees which reason codes dominate and which tasks are aging. Uses the Ask panel query
"which candidates were escalated and why" for a citation-backed summary.

### Flow D: founder gets status

Ask panel, two saved queries: "why this candidate ranks first" and "what changed since the
last run." Both answer with a citation block. Then the Trust Center front page.

### Flow E: engineering evaluator, one sitting, no credentials (the flagship)

```
git clone  →  make demo
  terminal prints the Class 1 eval summary INCLUDING its failures
  → Triage Queue: 140 candidates, three groups visible, shortlist cut drawn as a line
  → open the pinned tier-1 candidate carrying missing_evidence:<dimension>
  → the packet: levels, spans quoted against normalized source with resolvable offsets,
    supporting / contradicting / gaps as separate sections, f rendered term by term,
    confidence rendered term by term
  → resolve it: supply evidence and set level, no API key
  → both the aggregate AND confidence move, on a superseding result,
    with the original preserved beside it
  → audit trace: one vertical line, extraction through human decision
  → Trust Center: section 01 is Known Limitations
```

That is Success Criteria 1 through 9 walked in order, and it is also the README screenshot
sequence.

---

## Part 8: The Candidate Packet

The centerpiece. Arithmetic and evidence are equally first-class, on a 12-column grid:
**arithmetic 5 columns (sticky), evidence 7 columns, source as a resizable third pane**.
On narrow screens the source pane docks to a tab beside the evidence ledger. Neither the
arithmetic nor the evidence ever collapses into a drawer.

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Priya Raghavan                                             SYNTHETIC   result r_88c ▾    │
│ cand_0f3a · inbound · import #23 · run #7 · v18            ESCALATED · 2 open tasks       │
│ HARD REQ  work_auth ⟨unknown⟩   yoe ⟨pass⟩   location ⟨pass⟩      [audit trace] [source]  │
├───────────────────────────┬──────────────────────────────────┬───────────────────────────┤
│ A. ARITHMETIC   (sticky)  │ B. EVIDENCE LEDGER               │ C. SOURCE  resume.pdf ▾   │
│                           │                                  │  normalized · 4,218 chars │
│ SCORE            61.7     │ ① Applied ML / LLM systems   w3   │                           │
│  = 100 × 7.40 / 12.00     │   level  ▓▓▓░  partial            │  Led the evaluation       │
│                           │                                  │  harness for our RAG      │
│  dim        lvl   w   pts │   SUPPORTING (2)                  │  pipeline, shipping ...   │
│  applied   part   3  2.01 │   ┃ "shipped an eval harness for  │  ▔▔▔▔▔▔▔▔▔▔▔▔▔ [E12]     │
│  prodeng   strong 3  3.00 │   ┃  our RAG pipeline"            │                           │
│  evalprac  none   2  0.00 │   ┃  resume.pdf 1204–1249 · exact │  Reported 4 years of      │
│  data      part   2  1.34 │   ┃  extracted · not human-confirmed│ applied ML experience   │
│  ambig     weak   1  0.33 │                                  │  ▨▨▨▨▨▨▨▨▨▨▨▨ [E31]      │
│  comms     part   1  0.67 │   CONTRADICTING (1)               │                           │
│            ───────────    │   ┃ "4 years of applied ML"       │  Prior: 2019-06 to        │
│            7.40 / 12.00   │   ┃  contradicts derived tenure   │  2021-11, then 2022-03    │
│                           │   ┃  2y 7m · resume.pdf 402–428   │  to present ...           │
│ CONFIDENCE       0.48     │                                  │                           │
│  0.45 × cov 0.67 =  0.301 │   GAPS (0)                        │                           │
│  0.25 × res 0.91 =  0.228 │   No gap. All spans located.      │                           │
│ −0.20 × con 0.17 = −0.033 │                                  │                           │
│ −0.10 × mis 0.25 = −0.025 │ ② Production software eng    w3   │                           │
│            ───────────    │   level  ▓▓▓▓  strong             │                           │
│            0.471 → 0.48   │   ...                             │                           │
│  0.48 < 0.55  T_ESCALATE  │                                  │                           │
│                           │ ③ Evaluation and measurement w2   │                           │
│ calibration diagnostic:   │   level  ░░░░  none   REQUIRED    │                           │
│  derive_level → partial   │   ┌ EVIDENCE GAP ────────────────┐│                           │
│  extractor    → partial   │   ┆ No located span, any polarity ┆│                           │
│  agree                    │   ┆ searched: resume.pdf,        ┆│                           │
│  no scoring authority     │   ┆           notes.md            ┆│                           │
│                           │   ┆ reason: missing_evidence:     ┆│                           │
│ [ RECORD RESOLUTION (2) ] │   ┆         evaluation_practice   ┆│                           │
│                           │   ┆ [ SUPPLY EVIDENCE AND LEVEL ] ┆│                           │
│                           │   └───────────────────────────────┘│                           │
└───────────────────────────┴──────────────────────────────────┴───────────────────────────┘
```

### Packet rules, each one testable

1. **The score is not in the header.** It lives in column A as the output of visible terms.
2. **Column A is always expanded, never a modal.** Every term shows its input value and its
   product. Confidence shows all four terms with signs and the threshold comparison.
3. **Every term in column A is clickable.** Clicking a dimension row focuses its evidence
   block and its spans. Clicking the contradiction term opens the contradicting spans that
   produced it. This is the evidence bracket working in the arithmetic direction.
4. **`derive_level` is rendered as a labeled calibration diagnostic with the words
   "no scoring authority" on the surface.** When it disagrees with the extractor's level,
   the disagreement is shown, not hidden.
5. **Column B renders all six dimensions in committed rubric order, always, each with three
   permanently visible slots: supporting, contradicting, gaps.** Empty slots stay and say
   what happened in plain words ("No contradicting evidence found in the provided
   sources."). A silently absent dimension is a Class 1 failure, so the UI must make it
   impossible to produce one.
6. **Every evidence item carries:** verbatim quote, document and offsets, match quality
   (`exact` / `normalized` / `fuzzy`), source (`extracted` / `human`), polarity, and
   whether a human has confirmed it. A paraphrase may explain a span. It may never
   replace the verbatim text.
7. **Column C renders `normalizedText` as a document**, Source Serif 4 at 17/27, and draws
   highlights from `matchedText`. Multi-document candidates get a tab strip. A
   `View normalization log` link explains what normalization changed.
8. **Bidirectional linking.** Hovering or focusing an evidence card scrolls column C to the
   span and pulses it. Clicking a highlight selects its card and its arithmetic term.
9. **Span integrity failure is a designed state.** If a stored highlight fails the UTF-16
   slice check, column C draws a struck outline reading `span integrity failed, highlight
   refused` in place of the highlight. It does not silently render unhighlighted text.
   This is distinct from a whole-packet `data_integrity_failed`, which is a full-screen
   typed error. Two states, two components, never collapsed into one.
10. **Injection text renders as inert escaped text**, with an ochre margin flag reading
    `injection heuristic matched` and a link to the review task it opened. We show it. We
    never delete or rewrite it.
11. **Hard requirements** sit in a strip under the name: `pass` as a teal outline chip,
    `fail` as a solid `--danger` chip, `unknown` as a dashed no-fill chip carrying its
    escalation reason. Never a green check.
12. **Supersession lives in the header** as a lineage control: `result r_88c (current) ← r_41d`.
    Selecting a prior result puts the whole packet into a desaturated read-only historical
    state with a persistent banner. A side-by-side view marks exactly which terms moved.
13. **`LevelChip` is ordinal, not categorical.** Four quarter-segments filled to the level,
    in foreground grey. `none` is an empty four-segment outline. Ordinal data looks ordinal.
    Levels never get their own hue.

---

## Part 9: Triage Queue

A table. Deliberately plain, because the packet is where the design budget goes.

```
  #   CANDIDATE          CH   EVIDENCE      SCORE   CONF   STATUS      REASONS         TASKS  UPDATED
─────────────────────────────────────────────────────────────────────────────────────────────────────
 SCORED  (87)
  004  Marcus Oyelaran   in   ██▨█░█         84.2   0.81   scored      n/a                 0  12:04:11
  019  Dana Whitfield    src  ███████        81.7   0.77   scored      n/a                 0  12:04:11
  ...
 ─────────────────────────── SHORTLIST CUT  n=10 ───────────────────────────────────────────────────
  061  Ana Ferreira      in   ██░█░█         62.9   0.66   scored      n/a                 0  12:04:12
  ...
 PENDING RESOLUTION, MAY QUALIFY  (41)
┃ 023  Priya Raghavan    in   █▨░█░█         61.7   0.48   escalated   missing_evidence:   2  12:31:07
┃                                                                      evaluation_practice
┃ 088  Tomas Lindqvist   in   █░░░░░          n/a    n/a   escalated   assessment_         1  12:04:12
┃                                                                      unavailable
 REJECTED ON HARD REQUIREMENT  (12)
  111  Sam Achebe        in   ███░█░         71.4   0.72   rejected_hard_req  work_auth    0  12:04:12
```

- **Three groups, hard-ruled, all expanded by default.** Escalated candidates are excluded
  from the shortlist cut but never filtered out of sight. "AI screening quietly loses
  candidates" is the failure this product exists to refuse, so the queue has to show them.
- **The shortlist cut is drawn as a literal rule across the table**, labeled `SHORTLIST CUT n=10`.
  You can see who is just below the line. A threshold decision should look like a threshold.
- **Evidence coverage strip**: six cells, 7px each, one per rubric dimension in committed
  order. Filled `--support` when a span is located, `--contradict` hatched when
  contradicted, hollow dashed when there is a gap. Legend on first visit, dismissible.
- **Status is a mono text token, not a colored pill.** Colored pills everywhere is category
  slop and it makes escalation look like a defect. Escalated rows get a 3px `--accent`
  left rule instead.
- **Score and confidence are separate columns.** A candidate can be high-score and
  low-confidence without the UI implying a contradiction. Both in mono tabular numerals.
  An unavailable result prints `n/a`, never `0`.
- Sticky 34px header. Virtualized rows with stable positions during keyboard navigation.
  Keyset pagination, 50 per page.
- **Keyboard:** `j`/`k` move, `Enter` open, `x` select, `e` jump to evidence, `r` resolve,
  `p` proposals, `a` audit, `/` search, `⌘K` palette, `?` shortcut sheet. Row focus is a
  2px inset `--accent` ring, never a fill.
- No portraits. No candidate cards. No fit gauges.

---

## Part 10: Resolution Queue and Inspector

**Queue** grouped by reason code, ordered by reason precedence, then `opened_at`, then
`task_id`, matching the read model exactly. Each group header is mono caps with a count.
A row shows candidate, reason code, dimension, age, and the one action that resolves it.

**The inspector is a 420px right rail on the packet, not a separate page.** Resolving
requires reading the evidence, so the form must never replace the evidence.

Form for `supply evidence and set level`:

1. **Select text directly in column C to create the span.** The selection populates the
   offsets. This is better than a text box and it structurally guarantees the span is
   locatable, because it came out of the stored normalized text.
2. Polarity toggle: supporting or contradicting.
3. Level select, **pre-filled from `derive_level`** with the derivation shown inline
   (`sup 2, con 0, net 2 → partial`). The human confirms or overrides. An override is
   recorded as an override.
4. **Live delta preview before commit:** `score 61.7 → 72.9`, `confidence 0.48 → 0.63`,
   computed from the same pure core functions that will run on the server.
5. Required rationale field.
6. The button says **`Record resolution`**, never `Confirm AI`. The human is making a
   decision, not blessing a model.

The `request re-extraction` action is **labeled live-mode-only in the UI**, with the one
pre-scripted fixture-mode candidate marked so the path is demonstrable without a key.
When re-extraction completes, the task moves to `review required`, not `resolved`, and
the UI says so. Identical output still creates a superseding result and the UI shows a
zero delta rather than hiding the event.

### Stale conflict, a first-class visual

Not a toast. Toasts disappear, and silently losing a concurrency conflict is how people
learn to distrust software.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ▌ You reviewed v18. This packet is now v19.                                │
│ ▌ Changed by V. Chen at 12:44:02 · resolution recorded on evaluation_practice│
│ ▌ [ Compare changes ]   [ Refresh to v19 ]                                 │
└────────────────────────────────────────────────────────────────────────────┘
```

- Full-width band, `--contradict` hairline, mono text, pinned directly above the affected
  controls.
- Approve, reject, and submit freeze. **There is no `Save anyway`.**
- The user's unsaved values stay visible and are not destroyed.
- `Compare changes` shows only what moved: evidence, arithmetic terms, resolutions,
  proposal text.
- The rejected stale submission is itself recorded in the audit timeline.

---

## Part 11: Proposal Review

Its own destination, not an action column inside the queue. Each proposal is a diff card
rendering the actual artifact: a drafted follow-up renders as a message, a stage change
renders as `stage: Applied → Phone Screen` in mono.

Each card shows: proposed action, candidate and role, triggering evidence (bracketed back
to the packet), assumptions, open gaps, generated by, packet version, and a
`NO OUTBOUND EFFECT` label beside the title.

Actions: `Approve draft`, `Edit draft`, `Reject draft`. Edit opens an inline side-by-side;
the committed decision retains both the original and the edit.

**A fixed footer on every proposal surface, which is never removed:**

> Approval records an internal RecruitOS decision. No message is sent, no ATS record is
> changed, and no external system is contacted.

That sentence is the product's integrity, so it belongs in the chrome and not in a doc.

---

## Part 12: Audit Timeline

A ledger, not an activity feed. IBM Plex Mono throughout.

Two views. **Global**, reverse-chronological, keyset paginated at 50. **Candidate trace**,
ascending, filtered to one candidate, reachable from the packet header. The candidate
trace renders as one continuous vertical rule from extraction through score, route,
resolution, supersession, proposal, and human decision. It is the best screenshot in the
README.

Each event shows: timestamp with milliseconds, actor type and actor ID, event type, object
version before and after, input references, result, command ID, and an expandable
deterministic payload. Events are grouped by command, since one command emits ordered
events, and expand in `eventOrdinal` order with the receipt.

System and human actors are distinguished by a **glyph, not a color** (`◆ system:runtime`
vs `● V. Chen`), because color is spoken for.

Corrections appear as later events referencing earlier ones. Copy is
`Resolution superseded by event 00418`, never `Resolution updated`.

**Permanent footer, stating the limit rather than hiding it:**

> Append-only, enforced by database triggers. Not cryptographically tamper-proof. An
> administrator with file access can replace history.

---

## Part 13: Trust Center

A **report**, not a dashboard. Source Serif 4 title, a dateline, a provenance block. No
stat cards with big colored numbers. No gauges. No green.

```
TRUST CENTER
RecruitOS candidate triage · rubric v1 · run #7
Generated 2026-09-05T14:02:11.482Z · snapshot 9f2c… · corpus 140 synthetic

  last eval run          2026-09-05 14:02
  eval dataset version   tier1-v1 (25 cases)
  synthetic case count   140 main + 25 variant
  open known limitations 3

READ THIS FIRST
  All candidate data is synthetic. This is not an independent bias audit and not a
  compliance certification. Three known limitations are open. Class 2 numbers are
  dated one-shot measurements against a live model and are not gated in CI.

01  KNOWN LIMITATIONS                                    3 open
02  CLASS 1  Deterministic invariants, CI-gated          18 checks
      · evidence fidelity      · decision determinism    · human routing integrity
03  CLASS 2  Live measurement, dated, non-gating         measured 2026-09-05
04  HALLUCINATION RESISTANCE                             7 traceable counts
05  SYNTHETIC BIAS AUDIT DEMONSTRATION
06  CALIBRATION FREEZE DELTA
07  WORKFLOW ASSUMPTIONS
```

### 01 Known Limitations is the first section

That single ordering choice is the design thesis made visible. Each limitation is a card:
the tier-1 candidate ID, what the system currently produces, what it should produce, the
written explanation of why it is wrong, the assertion class, and a **link straight to the
packet so a reviewer can go look at the wrong answer themselves**. Owner, severity,
affected workflow, discovered date, and review date sit in the card footer. Closed
limitations stay in the audit history.

### 02 Class 1

A checklist where the visual weight is on the **assertion text**, not on the mark. Pass is
a small mono `ok` in muted grey. Fail is `FAIL` in `--danger` with the diff. Grouped into
three readable themes inside the class, because "Class 1" is an epistemic label and a
reader needs a topical one too: evidence fidelity, decision determinism, human routing
integrity. The class boundary is not renamed, because the distinction that matters is what
can be gated in CI, not what the check is about.

Every class block shows passed, failed, abstentions, not evaluated, dataset size, last
run, and regression from the previous run. `Inspect failures` is the strongest action on
the block. **A pass percentage never appears without its denominator and dataset version.**

### 03 Class 2

Each metric renders with numerator, denominator, exclusions, and noncomputable cells
adjacent. Any noncomputable metric prints the literal words `not computable`, never `0%`
and never `100%`. Every Class 2 block carries a persistent dateline chip:
`measured 2026-09-05 · <model id> · not gated in CI`. Zero predictions against nonzero
expectations prints `precision: not computable · recall: 0`.

### 04 Hallucination Resistance panel

A traceability ledger. Seven rows, each `count · what it is · where it came from · [inspect]`.

```
  428   claims generated                          from 25 tier-1 candidates
  391   claims linked to exact source spans       [inspect]
   21   claims routed as evidence gaps            correct behavior   [inspect]
   11   contradictions surfaced                   [inspect]
    5   unsupported claims rejected               [inspect]
   14   unlocated quotes                          [inspect]
    3   fabricated document references            [inspect]
    2   grounded-capability refusals              correct behavior   [inspect]
    6   extractor vs derive_level mismatch        [inspect]
```

**The panel's design rule: a count you cannot click is a claim, and a count you can click
is evidence.** Every number opens the rows that produced it. Evidence gaps also render as
a small dimension-by-reason matrix. Abstention counts (`routed as evidence gaps`,
`grounded-capability refusals`) are labeled `correct behavior` in words rather than being
given a reassuring color.

Known limitations stay in the main totals **and** are shown separately, and the panel says
so on the surface. The invariant sits at the bottom:

> A claim counts as traceable only when its source document, normalized span, packet
> version, and extraction event are all available.

### 05 Synthetic Bias Audit Demonstration

The first screen is a full-width statement block in Source Serif 4, no chrome, before any
table renders:

> This is a demonstration on synthetic data. The sample is too small to support a fairness
> conclusion. With 140 synthetic candidates and a shortlist of 10, per-group cells fall
> below the size at which an impact ratio is stable. Read the counts, not the ratios. This
> does not establish production fairness, does not detect every proxy, does not represent a
> real applicant population, and does not replace ongoing human review.

Then two tables side by side, `PROPOSED CUT` and `HUMAN-APPROVED CUT`, with **the delta
between them in its own column**, because that delta is the product's whole thesis. Every
rate prints as `k/n` with the derived ratio beside it in a lighter weight. The
highest-rate reference group carries a mono `ref` tag. Zero denominators print
`not computable`. Excluded variant corpora are listed by name below the table, never
silently dropped. Every chart, table, and export is labeled `SYNTHETIC DATA`.

Copy rule: never the phrase `bias passed`. Use `no threshold breach detected in this
synthetic run`.

### 06 Calibration Freeze Delta

Predicted versus actual escalation distribution as a small paired bar set on the dotted
measurement grid, with the note that constants were frozen against tier-1 expected
outcomes before the first end-to-end run and were not retuned afterward.

---

## Part 14: Ask Panel (six saved queries)

A right slide-over, `⌘J`, available from every destination. **Six buttons first, free text
second.** Buttons mean no intent-classification model call, which keeps the no-credential
promise intact.

Every answer renders as a citation block: the claim, then the rows, dimensions, spans, or
audit records it came from, each one clickable and bracketed back to its packet.

The free-text field maps through the committed keyword matcher. On no match it renders:

```
I can answer these six questions.
  · why this candidate ranks first
  · which candidates were escalated and why
  · which candidates meet all hard requirements
  · what evidence supports this score
  · which drafts await approval
  · what changed since the last run
```

**That refusal is a designed state styled exactly like an answer, not like an error.**
A grounded refusal is a correct response and it should not look like a bug. Its count
feeds row 8 of the Hallucination Resistance panel, which closes the loop: the UI's honest
"no" is itself a measured trust metric.

---

## Part 15: Component Inventory

A closed set. Adding a component outside this list requires a note in the decisions log.

**Evidence:** `EvidenceBracket` (the signature), `EvidenceCard` (supporting, contradicting),
`EvidenceGapCard`, `SpanHighlight`, `SpanIntegrityFailure`, `SourceDocument`,
`DocumentTabs`, `NormalizationLogLink`, `InjectionFlag`

**Decision:** `ArithmeticPanel`, `ScoreTerms`, `ConfidenceTerms`, `CalibrationDiagnostic`,
`DimensionBlock`, `LevelChip` (four ordinal segments), `HardRequirementChip`,
`EvidenceCoverageStrip`

**Queue and status:** `QueueTable`, `CutRule`, `GroupHeader`, `StatusToken`, `ReasonCode`,
`ActorTag`, `LineageControl`, `DensityControl`, `CommandBand` (destination 1 landing state
only, never a sixth destination)

**Work:** `TaskRow`, `ResolutionInspector`, `SpanSelector`, `DeltaPreview`, `ProposalCard`,
`DiffView`, `ConflictBand`, `NoOutboundEffectFooter`

**Audit and trust:** `AuditRow`, `AuditTrace`, `LimitationCard`, `MeasurementBlock`
(dateline plus non-gating chip), `CountRow` (clickable), `NotComputable`, `ProvenanceBar`,
`InsufficiencyStatement`

**Assistant:** `CitationBlock`, `GroundedRefusal`, `SavedQueryButton`

**Banned:** progress rings, radial gauges, letter grades, star ratings, sparkline scores,
candidate avatars, colored status pills, empty-state illustrations, skeleton shimmer,
toast notifications for anything consequential.

---

## Part 16: README Screenshots

The README is the first thing the engineering evaluator sees, so the sequence is an
argument in order. Eight UI captures plus one terminal capture. No more.

| File | Shows | Caption |
|---|---|---|
| `00-make-demo.png` | terminal after `make demo`, Class 1 summary **including its failures**, zero provider calls | One command, no API key, and the eval summary prints what failed. |
| `01-triage-queue.png` | queue with all three groups, the shortlist cut rule, evidence-coverage strips | The ranked list is a view over packets. Escalated candidates stay visible. |
| `02-candidate-packet.png` | full three-pane packet on an escalated candidate, arithmetic expanded, one teal and one hatched ochre span highlighted in the source | Score, confidence, evidence, and source in one frame. The score is not in the header. |
| `03-evidence-gap.png` | tight crop of one dimension block with the gap card, `documents_searched`, reason code | A dimension with no evidence says so, with a reason code, and is never silently absent. |
| `04-resolution-delta.png` | inspector open, span selected in the source, `derive_level` pre-fill, before and after values | A human supplies evidence and sets a level. Score and confidence both move. No API key. |
| `05-supersession.png` | original and superseding result side by side with moved terms marked | The original result is preserved and stays inspectable. |
| `06-audit-trace.png` | single-candidate trace, extraction through human decision | Every AI action and every human decision, append-only. |
| `07-trust-center-limitations.png` | Trust Center scrolled to section 01, three limitations with explanations | The report opens with what the system gets wrong. |
| `08-bias-demonstration.png` | insufficiency statement above the two cuts with the delta column | Proposed cut versus human-approved cut, counts beside every rate, sample-size limit stated first. |

Capture rules for all nine: **light theme, default density, both pinned by URL**; 1600×1000
at 2x; real data from the sealed demo run; the global bar visible in 01, 02, 07, 08 so
`SYNTHETIC DATA` and the limitations count are legible; no cursor, no browser chrome, no
annotation arrows, no drop shadows on the image frame.

An optional `demo.gif` is allowed only if it captures screenshot 04's delta in under six
seconds. If it takes longer, cut it.

---

## Part 17: Architecture Notes Raised by UX

These are clarifications the UX requires, not reopened decisions. Each one is consistent
with the cleared plan.

1. **Fonts must be self-hosted and committed** (`next/font/local`), not CDN-linked. `make demo`
   makes zero network calls and the reference profile budgets browser primary content at
   p95 750ms. A Google Fonts `<link>` would render fallback faces in the exact demo the
   product is judged on. Add to T12.

2. **`@recruitos/core` must be client-bundle-safe** so the resolution inspector can compute
   the delta preview in the browser using the same pure functions that run on the server
   commit. This is already implied by D3 and by core's purity rule (Zod and pure utilities
   only), but the plan's boundary list does not state it, and a later Node-only import into
   core would break the packet silently. Recommended: state it as an explicit boundary
   test. Fallback if the team prefers: a server action returning the preview, which fits
   inside the 150ms D4 mutation budget and costs one round trip.

3. **Two distinct integrity states, two distinct components.** A missing historical
   reference fails the whole packet read with `data_integrity_failed` and renders as a
   full-screen typed error, per the plan. A per-span slice-check failure renders as an
   inline refused highlight and the rest of the packet still renders. Both behaviors are
   already in the plan at different granularities; the UI must not collapse them into one
   generic error component.

4. **Theme and density must be URL-addressable with deterministic defaults**, so the six
   Playwright workflows and the nine README captures never depend on a persisted
   preference. Cheap now, a flaky suite later if skipped.

5. **Class 1 keeps its epistemic name and gains topical subgroups.** Codex's proposed
   renaming to evidence fidelity, decision determinism, and human routing integrity reads
   better as product language but would destroy the distinction that matters, which is
   what can be gated in CI versus what cannot. Resolution: keep Class 1, 2, 3 as the
   top-level structure and use the thematic names as groupings inside Class 1.

---

## Part 18: Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-09-05 | **Direction APPROVED. All four deliberate risks kept as written** | Reviewed against cutting risk 4 alone (option B) and risks 3 and 4 together (option C). Both were rejected: the product's claim is that it makes AI-assisted hiring inspectable and honest about failure, and each risk is that claim made visible in a different surface. The one-number tradeoff is accepted because the explanation is the product |
| 2026-09-05 | Initial design system and UX direction created | `/design-consultation`, informed by WebSearch research on 2026 evidence-provenance UI patterns, dense internal tool conventions, and AI trust surfaces, plus an independent Codex design direction |
| 2026-09-05 | Light theme is primary, dark is a complete peer | The core act is reading a document and checking a quote. Evidence should read as paper. Also anti-convergence: the whole dev-tool category is dark-first |
| 2026-09-05 | The score never appears as a badge and never in the packet header | The product's own demand evidence says a bare percentage makes the reader open the resume anyway, which adds a step |
| 2026-09-05 | Hue encodes evidence polarity only; status is encoded by weight, rule, and typography | Green and red on candidate evidence would be read as good candidate and bad candidate, which is the exact misread the product exists to prevent |
| 2026-09-05 | Evidence gaps get no hue at all | A gap is the absence of something, so it is the absence of color. Dashed outline, empty fill |
| 2026-09-05 | Trust Center section 01 is Known Limitations, and green is not used anywhere in it | The governing risk is an all-green report from co-designed fixtures. The UI has to refuse reassurance |
| 2026-09-05 | The global bar permanently carries SYNTHETIC DATA, open task count, and known limitation count | "Known limitations visible in the UI" implemented as chrome, not as a page you can skip |
| 2026-09-05 | The evidence bracket threads card, span, arithmetic term, and audit event | Adopted from the Codex outside voice, which articulated it better than the original hover-linking sketch |
| 2026-09-05 | Escalated candidates stay in the queue in their own labeled group, not behind a filter | The product exists to refuse "AI screening quietly loses candidates" |
| 2026-09-05 | The resolution form is an inspector on the packet, and spans are created by selecting text in the source pane | Resolving requires reading the evidence, and a selection-created span is structurally guaranteed to be locatable |
| 2026-09-05 | **Variant B Bench approved as the implementation design direction** | `/design-shotgun` generated three variants inside the approved system, varying only the packet pane arrangement and the command center placement. B was the only one that broke no locked constraint. A lost the paper claim that justifies light-primary. C demoted the arithmetic and collapsed the three permanent evidence slots, which is the exact silent-absence failure Part 8 rule 5 exists to prevent. See `docs/designs/recruitos-visual-variants.md` |
| 2026-09-05 | `CommandBand` added to the Part 15 closed inventory | The command center is the landing state of destination 1 and not a sixth destination, so the readouts need a component and the IA stays at five entries. Constrained to that landing state; moving it to its own route requires a new decision record |
