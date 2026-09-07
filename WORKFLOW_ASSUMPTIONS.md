# Workflow Assumptions

**Status: PRE-CALL BASELINE. Last updated 2026-09-07.**

No recruiter, hiring manager, or recruiting operator has reviewed anything in this
repository. Every statement below about how recruiting actually works is the author's
reconstruction from a job description, published ATS and recruiting-operations material,
regulatory text, and candidate-side experience. Nothing here is attributed to a real
practitioner, because no practitioner has been asked yet.

This file exists because the product design makes it a shipping requirement, not a
footnote (`docs/designs/recruitos-candidate-triage-control-plane.md`, Demand Evidence).
RecruitOS claims to be the recruiting tool that opens with what it got wrong. A tool that
made that claim while quietly presenting inferred workflow as observed workflow would be
failing its own thesis on page one.

The Trust Center renders this file as section 07.

---

## How to read this file

Every assumption carries a **provenance** class and a **validation status**.

**Provenance: where the statement came from.**

| Class | Meaning |
|---|---|
| `synthetic` | Fabricated for this repository. No real person, company, or candidate. |
| `observed` | Read directly from a primary source the author verified (regulatory text, vendor documentation, a published study). The source is cited. |
| `cited` | Reported by a secondary source the author read but did not verify independently. |
| `inferred` | Reconstructed by the author. Nobody told us this. |

**Validation status: what a real conversation has done to it.**

| Status | Meaning |
|---|---|
| `inferred` | Not yet put to a practitioner. The state of every workflow assumption today. |
| `validated` | A named practitioner confirmed it. Attribution recorded. |
| `corrected` | A named practitioner contradicted it, and the assumption text was rewritten to what they said. The original is preserved in the entry. |
| `unresolved` | Asked, and the practitioner did not know or the answers conflicted. |

Today every entry below is either `synthetic`, `observed`, `cited`, or `inferred`. There
are zero `validated` and zero `corrected` entries, and that count is itself reported in
the Trust Center. The build sequence requires at least three entries to move out of
`inferred` before the rubric locks and before a single extraction fixture is recorded
(design, The Assignment; implementation plan, Gate 1 and Gate 2).

---

## 1. What is synthetic

All of it. There is no real candidate data anywhere in this repository, and no path by
which real candidate data can enter it.

- **WA-S1 Candidates.** All 140 corpus candidates (25 hand-authored tier 1, 115 generated
  tier 2), plus 20 perturbation variants and 5 injection or control pairs, are fabricated.
  Names, employers, schools, dates, and document text are invented.
- **WA-S2 Demographics.** `CandidateDemographics` values are assigned to all 140 synthetic
  candidates so the bias gate has a complete population. They describe nobody. The bias
  report is a demonstration of a mechanism, not an audit of a real selection process, and
  the Trust Center says so in those words.
- **WA-S3 The role.** The Applied AI Engineer requisition, its description, and its hard
  requirements are authored for this project. No company posted it.
- **WA-S4 The ATS.** `AtsPort` is backed by a mock adapter. No candidate state exists
  outside this repository, and no outbound effect reaches any real system. `EmailPort`,
  `CalendarPort`, `SlackPort`, and `SourcingPort` are declared and deliberately
  unimplemented.
- **WA-S5 Extraction fixtures.** Recorded model responses are replayed from disk in the
  default demo path. They are frozen artifacts of one dated recording run, not evidence
  that the extractor behaves this way today.
- **WA-S6 Actors.** The actor picker seeds fictional recruiters and hiring managers.
  There is no authentication and no real identity in any audit event.

---

## 2. What was actually observed

A short list, and deliberately so.

- **WA-O1 NYC Local Law 144 applies to tools of this shape.** An automated employment
  decision tool is any tool producing a score, classification, or recommendation used to
  substantially assist an employment decision; the law requires an annual independent bias
  audit for disparate impact by sex and by race or ethnicity, a published summary, and 10
  business days of candidate notice. Read from the DCWP FAQ. Provenance `observed`.
- **WA-O2 The EU AI Act classifies recruitment and candidate evaluation as high risk**
  under Annex III 4(a), with the Annex III deadline moved to 2 December 2027. Human
  oversight (Art 14), logging (Art 12), and transparency to deployers (Art 13) map onto
  this architecture. Read from the regulation text. Provenance `observed`.
- **WA-O3 The four-fifths rule flags a group whose selection rate falls below 80% of the
  highest group's rate, and it is unreliable at small sample sizes.** Provenance
  `observed`. This is why P7 states in advance that the primary finding at n=140 with a
  shortlist near 10 will be insufficient n.
- **WA-O4 Competitor feature sets as of 2026-09-05.** Ashby, Greenhouse, Lever, and
  Metaview all surface a score, a match, or a generated note. None of the reviewed
  material describes exposing rubric dimensions, the quoted spans behind each, a computed
  confidence, and a human approval gate with an audit record. Provenance `observed` for
  what the vendor and review material says, `inferred` for the conclusion that the gap is
  real rather than undocumented.
- **WA-O5 Structured scorecards have higher predictive validity and lower demographic
  disparity than unstructured evaluation, and the structure carries most of the gap.**
  Provenance `cited`. The author read the summaries, not the underlying studies.
- **WA-O6 A recruiter handed a bare match percentage with no reasoning opens the resume
  and reads it anyway.** Provenance `cited`. This is the single load-bearing demand claim
  in the whole design, and it comes from a vendor blog post and one review article rather
  than from a recruiter the author spoke to. If it is wrong, the wedge is wrong. It is the
  first thing the recruiter call should test.

Everything else in this file is inferred.

---

## 3. Inferred: the workflow

**WA-01 The daily loop is import, triage, shortlist, hand off, and it runs every morning
during an active requisition.**
Basis: the job description's described responsibilities plus common ATS workflow material.
Falsified by: a recruiter who describes triage as a twice-weekly batch, or as something
that happens inside the ATS inbox with no separate compilation step.
Status: `inferred`

**WA-02 Manual evidence compilation costs 5 to 10 minutes per candidate and gets worse at
volume, and that specific cost is the thing worth removing.**
Basis: author estimate from reading resumes against a job description.
Falsified by: a recruiter who says the resume read is 45 seconds and the real cost is
scheduling, sourcing, or chasing hiring managers for feedback. This is the most likely
single correction on the whole list, and it would move the wedge, not just the estimate.
Status: `inferred`

**WA-03 A recruiter works one urgent requisition in a burst rather than fifteen
requisitions in parallel.**
Basis: the design's problem statement, which was authored to make a single-role wedge
coherent.
Falsified by: almost any real recruiter. A recruiter carrying 8 to 15 open roles changes
what "the daily loop" means and changes what an escalation queue costs them. Flagged as
probably wrong rather than merely unvalidated.
Status: `inferred`

**WA-04 The hiring manager reads a structured packet rather than skimming the resume the
recruiter forwarded.**
Basis: inference from the packet-as-primary-artifact premise (P2).
Falsified by: a hiring manager who says they open the resume first regardless of what is
attached, which would make the packet a recruiter-facing artifact only and change who the
design budget serves.
Status: `inferred`

**WA-05 Triage happens before any candidate contact, so no scoring or routing decision is
visible to a candidate.**
Basis: inference, and a design constraint. `rejected_hard_requirement` is an internal
triage status; telling a candidate anything requires an approved `Proposal(type:
rejection)`.
Falsified by: a process where an automated acknowledgement or knockout question fires at
application time, which would put a candidate-visible decision upstream of everything
RecruitOS does.
Status: `inferred`

**WA-06 The internal triage status and the ATS stage are separate things, and a recruiter
would accept a tool that never writes stage changes without approval.**
Basis: premise P3, system of engagement over system of record.
Falsified by: a recruiter who says a second status field is duplicate bookkeeping they
will not maintain.
Status: `inferred`

**WA-07 140 candidates in a single week for one technical requisition is a realistic
volume.**
Basis: author estimate.
Falsified by: real inbound numbers, in either direction. 140 may be low for an inbound
role and absurdly high for a senior sourced one.
Status: `inferred`

---

## 4. Inferred: the rubric

The rubric is where being wrong is most expensive, because dimension text lives in the
extraction prompt and is part of the fixture cache key. See
`docs/designs/rubric-lock-prep.md` for the draft being taken to the call.

**WA-08 Six dimensions is the right number for a resume-stage screen.**
Basis: author judgment, balancing decomposition against reviewer attention.
Falsified by: a recruiter who screens on three things, or who names ten.
Status: `inferred`

**WA-09 The six named dimensions are the right ones for an Applied AI Engineer.**
Applied ML and LLM systems, production software engineering, evaluation and measurement,
data and pipeline work, ambiguity and ownership, communication of technical reasoning.
Basis: the job description plus author domain knowledge of the role.
Falsified by: a named dimension the recruiter screens on that is absent here, or a
dimension here they would never look for at resume stage.
Status: `inferred`

**WA-10 The weights 3 / 3 / 2 / 2 / 1 / 1 reflect relative importance to a hiring
decision for this role.**
Basis: author judgment.
Falsified by: a recruiter or hiring manager ranking the six differently. Weights are the
cheapest thing in the system to change, because they never enter the extraction prompt and
tuning them never invalidates a fixture. They are also the number most likely to be
challenged, which is a good combination.
Status: `inferred`

**WA-11 The required and not-required split matches how a practitioner would treat a
missing signal.**
Three dimensions escalate when unevidenced; three record a gap and score `none`.
Basis: **an engineering constraint, not a recruiter judgment.** The design states this
plainly: with all six required, nearly every candidate would carry an unevidenced required
dimension, every candidate would escalate, and `shortlist_cut` would have no `scored`
population to draw from. The split is the lever that keeps the escalation rate inside its
35 to 60 percent design band.
Falsified by: a recruiter who says an absent data-pipeline signal absolutely warrants a
human look, or that an absent evaluation signal does not. Either answer creates a real
conflict between product truth and a demo constraint, and that conflict should be recorded
rather than resolved silently in favor of the constraint.
Status: `inferred`

**WA-12 Four ordinal levels (none, weak, partial, strong) is the right granularity, and a
reader will read them as ordinal rather than as grades.**
Basis: author judgment. The design records the alternative (five levels with a neutral
midpoint) as an open question and notes the midpoint may invite default-to-middle bias.
Falsified by: two people assigning different levels to the same text for reasons that
would disappear with a fifth level or with three.
Status: `inferred`

**WA-13 Resume text can support a level for behavioral dimensions.**
Specifically ambiguity and ownership, and communication of technical reasoning.
Basis: inference, and a weak one. This is the assumption the author has least confidence
in on the entire list. It is why both dimensions carry weight 1 and neither is `required`.
Falsified by: a recruiter who says these are phone-screen judgments and a resume tells you
nothing about them, in which case the honest fix is to drop them from v2 rather than to
keep them at low weight for completeness.
Status: `inferred`

**WA-14 A dimension gets one level per candidate rather than one per relevant role or
project.**
Basis: the domain model, which carries one `DimensionAssessment` per dimension per result.
Falsified by: a reviewer who needs to say "strong at the last job, weak before that", a
distinction the current type cannot express.
Status: `inferred`

**WA-15 Self-description is not evidence, and a skills-list keyword is not evidence.**
The draft anchors exclude both explicitly, at every level.
Basis: the design's own argument against keyword gaming, plus WA-O6.
Falsified by: a recruiter who says a skills list is exactly how they filter at this volume,
which would mean the rubric is measuring something other than what practitioners use.
Status: `inferred`

---

## 5. Inferred: hard requirements

**WA-16 The hard requirements for this role are work authorization, years of experience,
and location.**
Basis: the design's worked example and common requisition patterns.
Falsified by: a real requisition for this role, which may add clearance, on-site days,
compensation band, or degree.
Status: `inferred`

**WA-17 Work authorization is answerable from candidate documents at all.**
Basis: inference. The parser looks for `work_authorization_statement` in resume text.
Falsified by: a process where work authorization arrives as an application form question
and never appears in a resume, which would mean the requirement resolves `unknown` for
nearly every candidate and floods the escalation queue with a question the documents can
never answer. This is a specific, checkable, high-impact failure mode.
Status: `inferred`

**WA-18 Resolving a hard requirement to `unknown` and escalating, rather than rejecting,
is the behavior a practitioner wants.**
Basis: premise, and the design's direct answer to "AI screening quietly loses candidates".
Falsified by: a recruiter who says an unanswerable requirement at this volume is a
practical reject and the queue this creates is unworkable.
Status: `inferred`

---

## 6. Inferred: evidence and trust

**WA-19 Verbatim quoted spans, located in the normalized source, are what make a
recommendation trustworthy.**
Basis: WA-O6 plus premise P1. This is the product's central bet.
Falsified by: a recruiter who reads the quotes once, decides the tool is fine, and stops
looking, which would mean spans buy trust rather than verification, and the honest design
consequence is different (spot-check sampling rather than always-on decomposition).
Status: `inferred`

**WA-20 Contradicting evidence should be surfaced as its own section rather than netted
out into a lower level.**
Basis: Refinement B.
Falsified by: a reviewer who finds the contradiction section noise and wants a verdict.
Status: `inferred`

**WA-21 Showing the score arithmetic term by term increases trust rather than reading as
false precision.**
Basis: premise, and the design's central claim.
Falsified by: a recruiter who sees "61.7" decomposed into six products and reads it as
more authoritative than it deserves to be, which would be the opposite of the intent and
would argue for rendering the arithmetic with coarser output.
Status: `inferred`

**WA-22 A computed confidence value between 0 and 1 is meaningful to a recruiter.**
Basis: premise P4.
Falsified by: a recruiter who cannot act differently on 0.48 versus 0.61, which would
argue for a three-band presentation over the raw number, while keeping the number visible
in the arithmetic column.
Status: `inferred`

**WA-23 A recruiter will work an escalation queue rather than ignore it.**
Basis: premise P5, and the design's insistence that escalation is a routing outcome rather
than a terminal state.
Falsified by: a recruiter who says any queue that is not the main queue goes unread. This
would not invalidate the architecture, but it would move the escalation surface into the
main queue rather than beside it.
Status: `inferred`

**WA-24 Supply evidence and set level is a task a recruiter would actually perform.**
Basis: premise. It is the flagship demo interaction.
Falsified by: a recruiter who says that if they are already reading the resume to supply
the span, the tool has saved them nothing on that candidate. The design's answer is that
the tool saved them the other 139, but that answer needs to survive contact.
Status: `inferred`

**WA-25 "Escalated" is acceptable terminology and does not read as something bad happening
to the candidate.**
Basis: author word choice.
Falsified by: any practitioner wincing at it. Terminology is free to change before the UI
copy lands and expensive after.
Status: `inferred`

---

## 7. Inferred: constants and thresholds

Every constant below is a committed starting value chosen by the author before the system
ran end to end. The Calibration Freeze exists so that the first run's delta between
predicted and actual behavior is recorded rather than tuned away.

**WA-26 `T_ESCALATE = 0.55` and a 35 to 60 percent tier-1 escalation band describe a
workload a practitioner would tolerate.**
Basis: author judgment, constrained so that `shortlist_cut` has a population to draw from.
Falsified by: arithmetic plus a recruiter. At 140 candidates, that band is roughly 49 to
84 resolution tasks in a week. If the tolerable number is 10, the design's escalation
model is right and its calibration is wrong.
Status: `inferred`

**WA-27 `T_DUPE = 0.82` separates near-duplicates from distinct candidates.**
Basis: a starting value, named as such in the design's open questions. Requires empirical
selection against the tier-1 near-duplicate pairs.
Status: `inferred`

**WA-28 `SHORTLIST_N = 10` out of 140 is the right cut for this role.**
Basis: a starting value, named as such in the design's open questions.
Falsified by: a recruiter who forwards 3, or 25.
Status: `inferred`

**WA-29 The confidence weights (0.45 coverage, 0.25 resolution, minus 0.20 contradiction
rate, minus 0.10 missing-field rate) describe how a human would discount a packet.**
Basis: author judgment, frozen before the first end-to-end run.
Falsified by: a reviewer whose sense of "how much should I trust this packet" moves in a
different order than the formula does.
Status: `inferred`

---

## 8. Inferred: the tier-1 adversarial corpus

**WA-30 The tier-1 failure modes resemble real ones.**
Contradictory dates, ambiguous seniority, missing years-of-experience evidence, missing
work-authorization evidence, exact and near duplicates, malformed sections, prompt
injection text, definitive hard-requirement failures, a strong candidate with weak
formatting, a weak candidate with keyword stuffing, mixed evidence.
Basis: author judgment about what breaks resume parsing and screening.
Falsified by: a recruiter naming a common real failure mode absent from the list. The
governing risk on this project is that the corpus, the fixtures, the rubric, and the
evaluator were all authored by one person and therefore agree with each other. A
practitioner naming a missing failure mode is the cheapest available defense against it.
Status: `inferred`

**WA-31 A tool of this shape used on real candidates would be an automated employment
decision tool under NYC Local Law 144 and a high-risk system under the EU AI Act.**
Basis: the author's reading of WA-O1 and WA-O2 against this architecture. Not legal
advice, and not reviewed by counsel.
Falsified by: counsel.
Status: `inferred`

---

## 9. What must be validated before the rubric locks

The build sequence is binding: get practitioner input, lock the rubric, then record
fixtures, then build against the locked rubric. Dimension text lives in the extraction
prompt and is part of the fixture cache key, so changing it after fixture recording
invalidates all 140 recorded fixtures and every tier-1 expected outcome. Weights are
deliberately kept out of the prompt, so weight changes stay free.

Blocking on practitioner input before lock: **WA-09, WA-11, WA-13, WA-15, WA-16, WA-17.**

Strongly wanted before lock, not strictly blocking: WA-02, WA-06, WA-10, WA-12, WA-26.

The full question set, the draft rubric v2 those questions react to, and the exact list of
open questions is in `docs/designs/rubric-lock-prep.md`.

**If no practitioner is reachable.** The implementation plan allows the product owner to
sign a `RubricAssumptionRecord` after three documented outreach attempts over five business
days. Taking that path is not a neutral fallback: the Trust Center must then label rubric
v1 as product-authored rather than practitioner-validated, and must show the unvalidated
assumptions by ID from this file. The outreach attempts themselves get recorded here.

---

## 10. How this file gets updated

After a real conversation:

1. Move each touched entry's status to `validated`, `corrected`, or `unresolved`.
2. On `validated`, append the attribution line: role, date, and either a name or a stated
   anonymity preference. Never a name the person did not agree to publish.
3. On `corrected`, rewrite the assumption to what they said, and keep the original text
   under `Previously (inferred, 2026-09-07):` so the correction is visible rather than
   silently absorbed. A corrected entry is a better artifact than an entry that was right
   the first time, and this file should make that obvious.
4. Add new entries for anything they raised that is not here, numbered from WA-32 onward.
5. Record the conversation date, the person's role, and what was not covered.
6. Update the counts the Trust Center reads.

The design requires at least three entries to move out of `inferred` before the rubric
bumps to v2.

**Attribution rules.** No real candidate data is discussed on any call. No real names of
candidates, ever. The practitioner's own attribution is their choice and defaults to role
plus company stage if they do not state one.

---

## 11. What this file is not

It is not a bias audit, not a compliance certification, not legal advice, and not evidence
that RecruitOS works. It is a list of things the author believes and has not checked, kept
where a reader will trip over it.
