# Stakeholder demo operator card

One command presents both RecruitOS product promises in one terminal sitting.

```text
make demo-stakeholder
```

`make demo` is unchanged. It still prepares a fresh temporary database, prints the route-1 scored packet, and runs Class 1. It does not run the correction loop. `make demo-stakeholder` uses its own fresh temporary SQLite database for the whole sitting. It does not call `make demo`, because that target deletes its database when it exits.

## What the route-1 packet proves

Route 1 is explainable deterministic triage. The packet shows a sealed `scored` result, visible arithmetic, located evidence, and confidence inputs. Class 1 then checks that sealed packet against the locked rubric. No model is called. The score is not a badge. It is the printed sum of the weighted dimension terms.

## What changes between the route-4 packets

The initial route-4 packet is `escalated` with `assessment_unavailable`. The real `review` command finds the open task. A human `request_re_extraction` uses durable `--command-id stakeholder-request-1`. Fixture extraction with `--correction-overlay` supplies the proving correction body. `triage:complete-correction` uses durable `--command-id stakeholder-complete-1`.

The current packet is then a `correction` result. Status becomes `scored`. The original reasons no longer describe the live head. The packet still lists the outstanding resolution task so the sitting does not look finished.

## Why the original result remains available

Correction writes a new sealed result and moves the candidate head. It does not rewrite the initial result. `packet <id> --result <original-result-id>` prints that first packet. Historical inspection is labeled as a historical result. Any live task shown there is marked `current_candidate_work`, not as a decision owned by the old result.

## Why `review_required` is not a final decision

`review_required` means a human still owes a review. The system completed a correction and kept the task open on purpose. It has not resolved, dismissed, or shortlisted the candidate. RecruitOS does not treat a successful re-extraction as the last human call.

## Current limitations

- Fixture extraction only. There is no live LLM and no provider credential.
- The route-4 flip needs `--correction-overlay`. The default demo fixtures keep the reviewable failure.
- The corpus is synthetic. Seven routes, not a production applicant pool.
- No T12 UI and no web serving. This sitting is CLI text only.
- A `review_required` task does not accept a second `request_re_extraction` from this slice.
- `make demo` still shows only promise 1. Use `make demo-stakeholder` when both promises must appear together.
