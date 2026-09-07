# RubricAssumptionRecord: Applied AI Engineer, rubric v1

**Status: DRAFT PROPOSAL. Unsigned.** Claude Code drafted the proposed answers below.
The product owner reviews each one, amends where the proposal is wrong, and adopts the
result by signing at the end. Nothing here is validated practitioner input, and signing
does not make it so.

## What signing this does

The implementation plan (Gate 1) allows the product owner to sign a RubricAssumptionRecord
after three documented outreach attempts over five business days when no
recruiter, hiring manager, or triage practitioner is reachable. Signing it:

1. Lets rubric v1 lock (Gate 2) without a practitioner call.
2. Sets the rubric snapshot `provenance` to `product-authored`, not `recruiter-validated`.
3. Requires the Trust Center to render rubric v1 as product-authored and to list the
   assumptions in this record as known limitations, with their `WA` ids.
4. Leaves every `WA` entry this rubric rests on at its current status. None move to
   `validated`. `WORKFLOW_ASSUMPTIONS.md` section 07 keeps rendering the unvalidated count.

The ten answers below replace "pending the call" for OQ-1 through OQ-10 in
`rubric-lock-prep.md`. They do not change the frozen structure (six dimension ids, weights
3/3/2/2/1/1, three `required`, four-level closed enum, the scoring and confidence math).

## Outreach attempts (product owner fills before signing)

The plan requires three documented attempts over five business days. Record them here, or
state explicitly that you are proceeding without them and accept the weaker record.

| # | Date | Who contacted | Channel | Outcome |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |

Proceeding without the three attempts: ☐ (initial if checked)

---

## OQ-1. Are these six the right dimensions, and what is missing?

**Proposed answer:** Keep the six. Do not add a seventh now.

The gap worth naming is a **product and domain judgment** dimension, plausible for an
internal-tooling role. It is not added because (a) it is the least resume-legible of any
candidate dimension, weaker even than dimensions 5 and 6, so it would sit near `none` for
almost every candidate and add noise rather than signal, and (b) a seventh dimension
changes the frozen weight total and the whole scoring surface. The "works with
non-engineers" signal is partially carried by `communication_of_reasoning` and
`ambiguity_and_ownership` as written.

Record product and domain judgment as a **known gap and a v2 candidate dimension** in the
Trust Center. Rests on WA-09.

**Product owner:** adopt / amend → __________________________________

## OQ-2. Are the weights right, and should `evaluation_and_measurement` be 3 rather than 2?

**Proposed answer:** Keep `evaluation_and_measurement` at weight 2, `required`.

The v2 justification already argues this: evaluation is weight 2 but `required` precisely
because its absence is the most common gap in this pool, so it functions as a gate rather
than a heavy score term. Raising it to 3 puts 9 of 12 total weight on the three technical
dimensions and further flattens the behavioral signal. Weights never enter the extraction
prompt, so this is cheap to revisit after lock if the tier-1 corpus shows evaluation is
more discriminating than expected. Rests on WA-10.

**Product owner:** adopt / amend → __________________________________

## OQ-3. Is the `required` and not-`required` split right? (tension T1)

**Proposed answer:** Adopt the split as committed (1, 2, 3 `required`; 4, 5, 6 not), **and
record in the Trust Center that the split is engineering-driven, not practitioner-validated.**

The split is the lever that keeps the escalation rate inside the 35 to 60 percent band. With
all six `required`, every candidate escalates and `shortlist_cut` has no `scored`
population. This record does not pretend a practitioner blessed it. Per T1, the honest
resolution when no practitioner is available is to keep the band and **record the
disagreement risk as a known limitation**: a hiring team might reasonably want a missing
data-pipeline signal to interrupt, or a missing evaluation signal to not. Rests on WA-11.

**Product owner:** adopt / amend → __________________________________

## OQ-4. Are `ambiguity_and_ownership` and `communication_of_reasoning` readable from a resume? (tension T2)

**Proposed answer:** Keep both, weight 1, not `required`, with a recorded caveat.

They rest on the weakest assumption in the file (WA-13). At weight 1 and not `required`,
the cost of a dimension that is only weakly resume-legible is small: absent evidence lands
it at `none` with a visible gap, contributing about 1 of 12. Cutting them changes the
frozen structure and is a decision-record-level change for marginal benefit. Record both as
**the most likely v2 cut**, to be stress-tested by the tier-1 corpus (include candidates
where the resume genuinely does and does not evidence each). Rests on WA-13.

**Product owner:** adopt / amend → __________________________________

## OQ-5. Is `strong` reachable from a resume for each of the six?

**Proposed answer:**

- Dimensions 1, 2, 4 (technical, artifact-bearing): yes. A resume that names systems,
  scale, and outcomes reaches `strong`, and the anchors are written to that.
- Dimension 3 (evaluation): reachable but rarer. A resume that names what was measured,
  against what, and the decision that followed reaches it.
- Dimensions 5, 6 (behavioral): `strong` as written leans on an interview-stage judgment
  more than a resume signal. Accept that `strong` on 5 and 6 will be rare to absent in the
  corpus, and that this is correct rather than a defect.

Record: the tier-1 corpus must include at least one candidate reaching `strong` on each of
dimensions 1 through 4, so the top of the scale is demonstrably live. Rests on WA-05.

**Product owner:** adopt / amend → __________________________________

## OQ-6. Would a practitioner assign the same levels to the same text?

**Proposed answer:** Not assertable without the C1 calibration exercise, and this record
does not assert it.

The RubricAssumptionRecord adopts the twenty-four anchors as the **product owner's
operational definitions** of each level. It explicitly does **not** claim they would
reproduce across independent raters. Trust Center limitation entry: *rubric levels are
product-authored operational definitions, not calibrated against independent practitioner
judgment.* If a practitioner becomes available after launch, run C1 and either validate or
revise the anchors under a new rubric version. Rests on WA-12.

**Product owner:** adopt / amend → __________________________________

## OQ-7. Are work authorization, years of experience, and location the right hard requirements?

**Proposed answer:**

- **Work authorization:** keep as a hard requirement, resolved only from a **structured
  application answer**, never from resume text (WA-17, WA-32, readiness item T4). If the
  corpus provides no structured source, it resolves `unknown` corpus-wide and never
  rejects. That is the safe behavior and it is acceptable for v1.
- **Years of experience:** keep as a hard requirement with a low, defensible floor, roughly
  two years of professional software or ML work, derived by `deriveTenureMonths` over
  employment ranges. Absence or ambiguity resolves `unknown`, not `fail`. Only a
  conclusive grounded shortfall fails.
- **Location:** **remove from hard requirements for v1.** For a role that may be remote or
  hybrid, a location gate is likely wrong and would reject or escalate candidates on a
  criterion the role may not enforce. Keep location as a routing note only, or reinstate it
  as a hard requirement only if the role is explicitly onsite-mandatory.

Rests on WA-16.

**Product owner:** adopt / amend → __________________________________

## OQ-8. What escalation volume is tolerable?

**Proposed answer:** Adopt an upper tolerance of roughly **60 escalations per
140-candidate batch (about 43 percent)**, inside the committed 35 to 60 percent band.

For a demo and portfolio artifact the figure needs to be defensible and inside the band; a
real deployment would tune it to a hiring team's actual review capacity. Recorded as a
product-owner assumption, not a validated capacity number. Rests on WA-26.

**Product owner:** adopt / amend → __________________________________

## OQ-9. What would make you distrust the recommendation?

**Proposed answer (the product owner's own list, since Q0 asks what would make *you*
distrust it):**

- A score with no visible evidence behind it.
- An evidence quote that does not actually appear in the source text.
- A `strong` level on a behavioral dimension from a one-line resume mention.
- The same candidate scored differently on two runs of the same inputs.
- A hard requirement passing silently when the underlying data is absent.
- The system not showing how many known limitations it has.

These become the Trust Center's **known distrust triggers** section and the seed of its
backlog. Does not block the lock. Rests on WA-09.

**Product owner:** adopt / amend → __________________________________

## OQ-10. Is "escalated" the right word?

**Proposed answer:** Keep `escalated` for the status.

It is standard applicant-tracking and recruiting vocabulary, the design already uses it,
and it is more precise than softer alternatives like "needs review". Low stakes and cheap
to change before UI copy lands, but no change proposed. Rests on nothing structural.

**Product owner:** adopt / amend → __________________________________

---

## Assumptions this rubric rests on

WA-05, WA-09, WA-10, WA-11, WA-12, WA-13, WA-16, WA-17, WA-26, WA-32. All remain at their
current `WORKFLOW_ASSUMPTIONS.md` status. None are `validated`. The Trust Center renders
this list under rubric v1 provenance.

## Carried-forward decisions this record does not reopen

Tension T2 (whether dimensions 5 and 6 survive) is answered "keep for v1, flag as v2 cut
candidates" under OQ-4. Tension T1 (the `required` split) is answered "keep the band,
record the disagreement risk" under OQ-3. The work-authorization source (readiness item
T4) still gates tier-1 authoring, not this lock, and is answered under OQ-7: structured
application answer only.

## Signature

By signing, the product owner adopts the answers above as amended, accepts that rubric v1
locks as `product-authored`, and accepts the Trust Center consequences described at the top
of this record.

Product owner: __________________________________  Date: ______________
