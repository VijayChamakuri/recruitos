# RecruitOS

Explainable agentic recruiting automation. The wedge is the candidate triage packet end
to end: import synthetic candidates, extract reviewable evidence proposals, compute score
and confidence deterministically, route uncertainty into named human resolution tasks, and
record immutable history.

Binding documents, in order of authority:

1. `docs/designs/recruitos-candidate-triage-control-plane.md` (product, APPROVED)
2. `docs/plans/recruitos-candidate-triage-implementation-plan.md` (architecture, CLEARED)
3. `DESIGN.md` (visual and interaction design)

## House style

No em dashes anywhere: not in code, comments, docs, commit messages, or product copy.

## Design System

Always read `DESIGN.md` before making any visual or UI decision.
All font choices, colors, spacing, layout, motion, component patterns, screen hierarchy,
and copy rules are defined there. Do not deviate without explicit user approval.
In QA mode, flag any code that does not match `DESIGN.md`.

Three rules from `DESIGN.md` are load-bearing and worth repeating here, because breaking
any of them silently breaks the product's central claim:

- The aggregate score never appears as a badge, ring, gauge, or grade, and never in the
  candidate packet header. It appears only as the output of visible arithmetic.
- Hue encodes evidence polarity only. Status is encoded by weight, rule, and typography.
  Green never means "passed" anywhere. Evidence gaps get no hue at all.
- Known limitations are section 01 of the Trust Center and carry a permanent count in the
  global bar. Never move them, never collapse them, never make them all pass.
