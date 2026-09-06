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

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in
doubt, invoke the skill.

RecruitOS pipeline, in the order the project actually moves:

| Stage | Skill | What it owns here |
|---|---|---|
| Product premise and wedge | `/office-hours` | what to build, who for, what the narrowest complete slice is. Produced `docs/designs/recruitos-candidate-triage-control-plane.md` |
| Architecture and implementation plan | `/plan-eng-review` | package boundaries, schema, commands, tests, gates. Produced `docs/plans/recruitos-candidate-triage-implementation-plan.md` |
| Design system and UX direction | `/design-consultation` | `DESIGN.md`. Already run and APPROVED. Re-run only to update it, never to start fresh |
| Visual variants | `/design-shotgun` | generating and comparing concrete visual options inside the approved system |
| Post-implementation visual QA | `/design-review` | run after UI code exists. Flags anything that does not match `DESIGN.md` |
| Browser testing | `/qa` | live behavior, the six required Playwright workflows, the offline demo path |
| Pre-ship code review | `/review` | the diff, before landing |
| Ship | `/ship` | only when implementation, tests, design review, and QA are all ready. Not before |

`/ship` is the last gate, not a shortcut past the ones above it.

General routing:

- Bugs and errors, invoke `/investigate`
- Strategy and scope calls, invoke `/plan-ceo-review`
- Full review pipeline, invoke `/autoplan`
- Save progress, invoke `/context-save`. Resume it, invoke `/context-restore`
- Author a backlog-ready spec or issue, invoke `/spec`

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
