# Visual Variants and Build Spec: RecruitOS

Status: **RECOMMENDED, awaiting your pick**
Created: 2026-09-05 by `/design-shotgun`
Binds under: `DESIGN.md` (APPROVED). This document does not change a single locked line.
Binds under: `docs/designs/recruitos-candidate-triage-control-plane.md` (product, APPROVED)
Binds under: `docs/plans/recruitos-candidate-triage-implementation-plan.md` (architecture, CLEARED)

House rule: no em dashes.

Artifacts, committed in `docs/designs/recruitos-visual-variants/`. Open
`design-board.html` in a browser; everything else is reachable from it. The originals also
live in `~/.gstack/projects/VijayChamakuri-recruitos/designs/recruitos-app-variants-20260905/`,
which is where `/design-shotgun` keeps session artifacts across branches.

| File | What it is |
|---|---|
| `design-board.html` | the comparison board. open this first |
| `tokens.css` | every token transcribed from DESIGN.md Parts 3, 4, 5. light, dark, three density steps |
| `variant-a.html` | variant A Ledger. queue and packet |
| `variant-b.html` | variant B Bench. queue with instrument band, packet with the thread |
| `variant-c.html` | variant C Dossier. run report, document-first packet |
| `surfaces.html` | the other nine surfaces built once in the recommended structure |
| `readme-sequence.html` | the nine README captures in argument order with pinned URLs |

---

## What was actually varied, and what was not

DESIGN.md is APPROVED and its locked list is not a menu. Typography, palette, radius,
spacing, motion budget, component inventory, and all four deliberate risks are identical
across A, B, and C. Anything else would have been reopening a settled decision.

So the variation is on the one axis DESIGN.md deliberately leaves open, and it is the axis
that actually matters:

> How are the packet's three surfaces arranged, and where does the command center live?

That axis is real. Part 8 specifies a 12-column grid with arithmetic at 5 columns sticky,
evidence at 7, and source as a resizable third pane, but it does not say what surface value
each pane carries, how the evidence bracket renders across the gutters, or whether the
evidence is cards or rows. Three defensible answers exist, they produce visibly different
products, and two of them break locked rules once you build them out. That is worth knowing
before T12 starts.

### The command center conflict, resolved

You asked for a "recruiting command center dashboard." DESIGN.md Part 6 locks five
destinations and says "Nothing else gets top-level navigation." Those are in tension, so
here is the resolution used in all three variants: **the command center is not a sixth
destination.** It is the landing state of destination 1, the Triage Queue. Each variant
answers it differently, which is exactly why it is a good discriminator.

- A: no band at all. One hairline run strip. The queue is the command center.
- B: a six-cell instrument band of readouts above the table. Hairline separated, mono
  values, no cards and no gauges. **Recommended.**
- C: a full serif run report page with the queue below it.

---

## The three variants

### A. Ledger

One continuous ledger. Arithmetic, evidence ledger, and source all sit near the same
surface value, separated by hairlines only. Evidence renders as flat rows rather than
cards. Densest of the three and cheapest to build.

**It breaks a locked rule.** Light mode is primary specifically because "the evidence
surface should read as paper" (Part 2). If the source pane carries the same value as the
chrome, that claim stops being visible and light-primary loses its justification. A also
has nowhere to put the command center, which leaves flows C and D without a landing
surface.

### B. Bench, recommended

Three panes at three declared surface values: `--surface-inset` graphite for the
arithmetic, `--surface` neutral for the evidence ledger, `--surface-paper` white for the
source document. Surface value carries the paper-and-graphite claim without spending any
hue, which matters when hue is rationed to evidence polarity.

The evidence bracket is promoted from a static left rule into a **thread**: focusing a
claim draws a dashed `--accent` connector with endpoint nodes across the pane gutters,
linking arithmetic term to evidence card to source span. This is the only variant where
the signature component is visible in a still frame, which is what README capture 02 needs
to do its job.

The command center is a six-readout instrument band. No stat cards, no big colored
numbers, no gauges, all four of which are on the banned list.

### C. Dossier

Document-first. Source takes the widest pane, evidence becomes margin annotations aligned
to the spans they explain, arithmetic narrows to a 250px sticky ledger. The best pure
reading experience of the three, and the closest to the "no ATS renders a resume as a
document" argument.

**It breaks two locked rules.** First, Part 8 says arithmetic and evidence are equally
first-class, and a 250px rail against a full-width document is not equal. Second, and worse:
Part 8 rule 5 requires three permanently visible slots per dimension, with empty slots
staying and saying what happened in plain words. A margin column cannot hold two empty
slots per dimension across six dimensions, so C collapses them into a footnote. That is the
silent-absence failure the rule exists to make impossible.

---

## Scorecard

Scored against the locked list in DESIGN.md. 3 = holds, 2 = holds with a cost, 1 = breaks a
locked constraint or has no answer.

| Test | A | B | C |
|---|---:|---:|---:|
| Evidence surface reads as paper | 1 | 3 | 3 |
| Arithmetic and evidence equally first-class | 3 | 3 | 1 |
| Three permanent slots per dimension survive | 3 | 3 | 1 |
| Evidence bracket legible as the signature | 2 | 3 | 2 |
| Score is not the header and not a badge | 3 | 3 | 3 |
| Queue scan signal is the six-cell strip | 3 | 3 | 2 |
| Command center without a sixth destination | 1 | 3 | 2 |
| Density holds at 140 rows, 6 dimensions | 3 | 2 | 2 |
| Dark mode is a straightforward peer | 3 | 2 | 2 |
| Implementation cost inside T12 | 3 | 2 | 1 |
| **Total** | **21** | **27** | **19** |

---

## Recommendation: B, Bench

B is the only variant that breaks no locked constraint. That is the whole argument. A and C
are each more appealing on one dimension and each pay for it by violating a rule that was
kept deliberately at approval.

**Take two things from the losers.**

From A, density discipline. The queue stays a plain table. The instrument band is six
readouts and never grows into cards. If a seventh readout is proposed, it goes in the rail
or nowhere.

From C, document typography. The source pane keeps its 68ch measure and its section heads.
C proved the reading experience is worth protecting, and B gets it for free by putting the
source on `--surface-paper` at 17/27 Source Serif 4.

**The one risk in B.** The thread is the best part of the design and the easiest part to
ship badly. It needs measured positions and it must be disabled under
`prefers-reduced-motion`. If measured positions turn out fragile across resize,
virtualization, or a docked narrow-screen source pane, **cut the connector line and keep the
synchronized bracket highlight.** The claim survives. The connector is a flourish on top of
a claim that already works.

---

## What implementation should build

This is the T12 build list. Everything below is already in the closed component inventory
from DESIGN.md Part 15 unless marked new.

### 1. Foundation, before any screen

- `tokens.css` as written, verbatim from DESIGN.md Parts 3, 4, 5. Light, dark, and three
  density steps. No new values, no ad hoc colors.
- Three surface values are load-bearing in B, so add a contrast check to the design-review
  pass: `--surface-inset` against `--surface` against `--surface-paper` must stay
  distinguishable in both themes at the hairline weights used.
- Fonts self-hosted via `next/font/local`, four faces committed. See architecture note 1.
- Theme and density read from URL first. See architecture note 4.

### 2. App shell

`ProvenanceBar` at 48px carrying the full claim line, left rail at 216px with the five
destinations and their counts. The `SYNTHETIC DATA` pill, the open task count, and the
known limitation count are permanent chrome and both counts are links, not text.

### 3. Triage Queue, destination 1

- **New component: `CommandBand`.** Six readouts, hairline separated, mono values, label in
  condensed caps, sublabel in mono faint. Three of the six values are links. This is the
  one component in this document that is not in the Part 15 inventory, so it needs a line
  in the decisions log before it ships.
- `QueueTable` with sticky 34px header, virtualized rows with stable keyboard positions,
  keyset pagination at 50.
- `EvidenceCoverageStrip`, six cells at 7px, committed rubric order, dismissible legend on
  first visit.
- `GroupHeader` for the three groups, all expanded. `CutRule` drawn across the full table
  width. `StatusToken` as mono text. `ReasonCode` wrapping to two lines when needed.
- Escalated rows get a 3px `--accent` left rule. Row focus is a 2px inset ring, never a fill.

### 4. Candidate Packet, destination detail

Three panes at 5 / 7 / 6, three surface values. The header carries the name at 26px, the
identity line, the lineage control, and the hard requirement strip. **No score.**

- `ArithmeticPanel` with `ScoreTerms` and `ConfidenceTerms`, every term clickable, all four
  confidence terms with signs, plus the threshold comparison. On the dotted measurement grid.
- `CalibrationDiagnostic` with the literal words `no scoring authority` on the surface.
- `DimensionBlock` for all six dimensions in rubric order, each with three permanently
  visible slots. Empty slots render the plain-words sentence, never disappear.
- `EvidenceCard`, `EvidenceGapCard`, `LevelChip` (four ordinal segments, no hue),
  `HardRequirementChip`.
- `SourceDocument` at 17/27 Source Serif 4, 68ch measure, `DocumentTabs`,
  `NormalizationLogLink`, `SpanHighlight` with the 45-degree hatch underlay on
  contradicting spans.
- `SpanIntegrityFailure` inline. `InjectionFlag` in the margin with the review task link.
- **New behavior on `EvidenceBracket`: the thread.** Focus any of term, card, or span and
  all four surfaces highlight at 180ms ease-out, plus a dashed connector across the pane
  gutters with endpoint nodes. Disabled under `prefers-reduced-motion`, where the
  synchronized highlight still fires as an instant swap. Cuttable without losing the claim.

### 5. Resolution Queue and Inspector

Queue grouped by reason code, ordered by reason precedence then `opened_at` then `task_id`.
Inspector is a 420px right rail on the packet and never a separate page.

Form in five parts: span created by selecting text in the source pane, polarity toggle,
level select pre-filled from `derive_level` with the derivation shown inline, `DeltaPreview`
with score, confidence, and coverage before and after plus the threshold verdict, required
rationale. Button reads `Record resolution` and carries `expectedVersion`.

`request re-extraction` is labeled live-mode-only. Completion moves the task to
`review required`, not `resolved`, and the UI says so. Identical output shows a zero delta
rather than hiding the event.

### 6. Stale conflict

`ConflictBand` pinned directly above the affected controls, `--contradict` hairline, mono
text, full width of the inspector. Approve, reject, and submit freeze. **No `Save anyway`.**
Unsaved values stay visible and disabled, not destroyed. `Compare changes` shows only what
moved. The rejected stale submission is written to the audit timeline.

### 7. Proposal Review, destination 3

`ProposalCard` per proposal rendering the actual artifact: a drafted follow-up as a message
in Source Serif 4, a stage change as `stage: Applied to Phone Screen` in mono. Each card
carries triggering evidence bracketed back to the packet, assumptions, open gaps, generated
by, packet version, and a `NO OUTBOUND EFFECT` label beside the title.

`NoOutboundEffectFooter` fixed on every proposal surface, never removed. Edit opens an
inline `DiffView`; the committed decision retains both the original and the edit.

### 8. Audit Timeline, destination 4

Global reverse-chronological keyset at 50, and candidate trace ascending as one continuous
vertical rule. Events grouped by command, expanded in `eventOrdinal` order with the receipt.
Actors distinguished by glyph, never color. Corrections read
`Resolution superseded by event 00418`. Permanent footer stating the tamper limit.

### 9. Trust Center, destination 5

Report layout, Source Serif 4 title, dateline, provenance block, `READ THIS FIRST` above
the section list. Seven sections in the locked order.

- **01 Known Limitations first.** `LimitationCard` with what it produces, what it should
  produce, the written explanation, assertion class, and a link straight to the packet.
  Owner, severity, affected workflow, discovered date, review date in the footer.
- **02 Class 1** with visual weight on the assertion text. Pass is mono `ok` in muted grey.
  Fail is `FAIL` in `--danger` with the diff and `Inspect failures`. Three topical groupings
  inside the class. Every block shows passed, failed, abstentions, not evaluated, dataset
  size, last run, regression. A pass percentage never appears without its denominator and
  dataset version.
- **03 Class 2** with `MeasurementBlock` carrying the persistent dateline chip and
  `not gated in CI`. `NotComputable` renders the literal words.
- **04 Hallucination Resistance.** `CountRow` for all nine rows, every count clickable.
  Abstention rows labeled `correct behavior` in words. The dimension-by-reason gap matrix.
  Known limitations shown both inside the totals and separately. The traceability invariant
  at the bottom.
- **05 Bias Demonstration.** `InsufficiencyStatement` full width in Source Serif 4 **before
  any table renders.** Then proposed cut, human-approved cut, and the delta in its own
  column. Every rate as `k/n` with the ratio in lighter weight. `ref` tag on the
  highest-rate group. Zero denominators print `not computable`. Excluded variant corpora
  listed by name. Never the phrase `bias passed`.
- **06 Calibration Freeze Delta** as a paired bar set on the dotted grid, filled for
  predicted and outline for actual, with the freeze note.
- **07 Workflow Assumptions.**

### 10. Ask panel

`⌘J` slide-over, six saved query buttons first and free text second. Every answer is a
`CitationBlock`. `GroundedRefusal` styled exactly like an answer, listing the six questions.
Its count feeds row 8 of the Hallucination Resistance panel.

### 11. Error and edge states

- Whole-packet `data_integrity_failed` as a full-screen typed error. See architecture note 3.
- Per-span slice failure as an inline refused highlight. Separate component.
- Empty states are one line of mono text. No illustrations, no shimmer.
- Loading is a static hairline placeholder.

### 12. README captures

Nine captures per `readme-sequence.html`, all pinned by URL to `theme=light` and
`density=default`, 1600 by 1000 at 2x, real data from the sealed run. Capture 00 is the
terminal and it must show the Class 1 failures, not a clean run.

---

## Architecture notes from DESIGN.md Part 17, resolved

### 1. Self-hosted fonts are required for the zero-network demo

**Resolution: commit the font files and load them with `next/font/local`. No CDN link, no
`@font-face` pointing at a remote URL, no `@fontsource` package that resolves at runtime.**

Four faces are needed, not three: IBM Plex Sans, IBM Plex Sans Condensed (11px column heads
only), Source Serif 4, IBM Plex Mono. All are OFL. Commit woff2 with a Latin subset and
declare `font-display: block` for the mono and serif faces, because a fallback swap on
tabular arithmetic reflows the one panel that must not move.

**Add a CI check, not just a task line.** T12 gets a test that greps the built
`apps/web/.next` output for `fonts.googleapis.com`, `fonts.gstatic.com`, and any
`https://` in a `@font-face` src, and fails the build on a hit. A prose instruction in the
plan will not survive a future `<link>` added during a hurry. The demo is judged on `make
demo` making zero network calls, so make that assertion mechanical.

This document's own comparison board is the evidence: the four faces are not installed on
this machine and every mockup rendered in fallback faces. That is exactly what a Google
Fonts link would produce in the demo.

### 2. `@recruitos/core` client-bundle-safe, or a server-action fallback

**Resolution: make core client-bundle-safe, and enforce it with a boundary test rather than
a convention.**

The plan already says core is pure values only, Zod and pure utilities. The plan's boundary
list just does not say "and therefore importable from a browser bundle," which means a
future `node:crypto` or `node:fs` import into `packages/core/canonical` would compile, pass
review, and silently break the delta preview at runtime.

Concrete enforcement:

1. Add `packages/core/test/client-bundle.boundary.test.ts` that asserts no transitive
   import of `node:*`, `fs`, `path`, `crypto`, `better-sqlite3`, or `drizzle-orm` from the
   `@recruitos/core` entry point.
2. Set `"browser"` and `"exports"` conditions in `packages/core/package.json` so a Node-only
   import fails at resolve time, not at first render.
3. Canonical JSON and hashing are the risk surface, since hashing reaches for `node:crypto`
   by habit. Use `SubtleCrypto` where a hash is needed on the client, or keep hashing in
   runtime and out of the delta preview path entirely. The preview needs `scoring` and
   `derive_level`, not `canonical`.

**Fallback if the boundary proves expensive:** a server action returning the preview. It
fits inside the 150ms D4 mutation budget and costs one round trip. Decide this before T12
starts, not during, because the inspector's live delta is the moment the product proves its
claim and a network hop mid-typing is the wrong place to discover the tradeoff.

### 3. Two integrity states, two components, never collapsed

**Resolution: build both, and add a test that asserts they cannot be produced by the same
code path.**

| | Whole packet | Per span |
|---|---|---|
| Error code | `data_integrity_failed` | slice check failure |
| Cause | a missing historical reference during the packet read | stored offsets no longer slice to the stored text under UTF-16 |
| Component | `PacketIntegrityError`, full screen, typed | `SpanIntegrityFailure`, inline, struck outline |
| Rest of packet | not rendered. partial packets are forbidden | renders normally |
| Copy | "This packet cannot be shown" plus the missing reference | `span integrity failed, highlight refused` |
| Recovery | audit trace, back to queue. not retryable | none needed. the packet is still usable |

Both are built in `surfaces.html`, surfaces 10 and the source pane of every packet frame.
The failure mode to guard against is a well-meaning refactor introducing a shared
`<IntegrityError>` that takes a `scope` prop. Add a Playwright assertion on the tier-1
fixture that carries a broken span: the packet renders, the arithmetic is present, and
exactly one refused highlight appears.

### 4. Theme and density URL-addressable with deterministic defaults

**Resolution: URL is the source of truth, `localStorage` is a convenience that never wins.**

Resolution order, and it must be this order:

1. `?theme=` and `?density=` query params. Valid values only: `light` / `dark` and
   `compact` / `default` / `comfortable`.
2. If absent, `localStorage`.
3. If absent, the deterministic defaults `light` and `default`.

An invalid value falls to the default and does not throw. Changing the control writes both
the URL and `localStorage`, so a shared link carries the state.

The reason this is cheap now and expensive later: the six Playwright workflows and the nine
README captures all pin `?theme=light&density=default`, and if `localStorage` can override
the URL then a single test that toggles the density control poisons every capture that runs
after it in the same browser context. Write the resolver once, in one module, and give it a
unit test with a table of the twelve combinations.

Applies to `data-theme` and `data-density` on the html element, both set server-side from
the parsed URL so there is no flash of the wrong theme.

---

## Open question for you

The `CommandBand` in variant B is the only component in this document that is not in the
Part 15 closed inventory. DESIGN.md says adding one requires a note in the decisions log.
If you approve B, that note gets written. If you would rather keep the inventory closed and
have destination 1 open on a bare table, say so and the band comes out. The rest of B is
unaffected either way.
