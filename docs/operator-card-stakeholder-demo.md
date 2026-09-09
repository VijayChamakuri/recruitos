# Stakeholder demo operator card

RecruitOS is ready for a controlled local showcase with synthetic data. No additional product work is required before the sitting.

## Recommended browser showcase

Start the correction-enabled local app:

```text
make demo-web-correction
```

Open the printed local URL, then use this short path:

1. Start at `/triage` and point out the seven synthetic candidates and the three routing outcomes.
2. Open route 1. Show the sealed score, arithmetic, confidence inputs, evidence spans, and source text.
3. Return to the queue and open route 4. Show `escalated`, `assessment_unavailable`, and the open resolution task.
4. Request re-extraction, run the fixture correction, and show the new `correction` result with `scored` status and `review_required` human follow-up.
5. Open the original result from the historical link to show that it remains unchanged.
6. Open `/runs` to show the persisted append-only audit history for the initial result and correction.

Say at the start that the candidates and extraction responses are synthetic fixtures. The product behavior, persistence, scoring, evidence linking, correction workflow, and audit history use the real runtime.

If the browser path has an environment problem, use the terminal sitting below. It proves the two core promises without relying on browser automation.

## Terminal fallback

One command presents both RecruitOS product promises in one terminal sitting.

```text
make demo-stakeholder
```

`make demo` is unchanged. It still prepares a fresh temporary database, prints the route-1 scored packet, and runs Class 1. It does not run the correction loop. `make demo-stakeholder` uses its own fresh temporary SQLite database for the whole sitting. It does not call `make demo`, because that target deletes its database when it exits.

The sitting keeps the detailed packets and checks. It ends with an executive summary: Promise 1 PASS (scored `467/6`, approximately `77.83/100`, evidence `6/6`, Class 1 PASS) and Promise 2 PASS (escalated to human-requested re-extraction to correction/scored, `review_required`, original result preserved, 1 triage run and 7 members). Class 1 is the sealed arithmetic and evidence consistency check.

## What the route-1 packet proves

Route 1 is explainable deterministic triage. The packet shows a sealed `scored` result, visible arithmetic, located evidence, and confidence inputs. Class 1 then checks that sealed packet against the locked rubric. No model is called. The score is not a badge. It is the printed sum of the weighted dimension terms.

## What changes between the route-4 packets

The initial route-4 packet is `escalated` with `assessment_unavailable`. The real `review` command finds the open task. A human `request_re_extraction` uses durable `--command-id stakeholder-request-1`. That human action requests re-extraction. It does not manually provide extracted facts. Fixture extraction with `--correction-overlay` simulates a corrected extraction response. `triage:complete-correction` uses durable `--command-id stakeholder-complete-1`.

The current packet is then a `correction` result. Status becomes `scored`. The original reasons no longer describe the live head. The packet still lists the outstanding resolution task so the sitting does not look finished. This is human-triggered correction with required review, not a finished human decision.

## Why the original result remains available

Correction writes a new sealed result and moves the candidate head. It does not rewrite the initial result. `packet <id> --result <original-result-id>` prints that first packet. Historical inspection is labeled as a historical result. Any live task shown there is marked `current_candidate_work`, not as a decision owned by the old result.

## Why `review_required` is not a final decision

`review_required` means a human still owes a review. The system completed a correction and kept the task open on purpose. It has not resolved, dismissed, or shortlisted the candidate. RecruitOS does not treat a successful re-extraction as the last human call.

## Current limitations

- Fixture extraction only. There is no live LLM and no provider credential.
- The route-4 flip needs `--correction-overlay`. The default demo fixtures keep the reviewable failure.
- The corpus is synthetic. Seven routes, not a production applicant pool.
- The showcase is local. There is no public deployment, authentication, real candidate data, or outbound ATS action.
- Proposal persistence and review decisions exist in the runtime, but the synthetic demo does not create a main-run shortlist and no proposal UI is shown.
- A `review_required` task does not accept a second `request_re_extraction` from this slice.
- `make demo` still shows only promise 1. Use `make demo-stakeholder` when both promises must appear together.
