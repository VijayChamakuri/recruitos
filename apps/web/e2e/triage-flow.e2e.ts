/**
 * Playwright E2E test scaffold for RecruitOS triage workflow.
 * Verifies:
 * 1. Triage queue command center with 6-cell instrument band
 * 2. Navigation rail transitions to review and status
 * 3. Candidate packet 3-pane Variant B layout and evidence highlights
 * 4. Refused span integrity state handling
 */

export const triageFlowTestScaffold = {
  name: "Triage Flow E2E Scaffold",
  scenarios: [
    {
      name: "loads triage queue with instrument band",
      path: "/triage",
      assertions: [
        "instrument-band visible with 6 cells",
        "candidate table populated with source keys and scores",
        "global bar displays synthetic data pill"
      ]
    },
    {
      name: "navigates to candidate packet 3-pane view",
      path: "/packet/:candidateId",
      assertions: [
        "pane arithmetic visible with 5-column terms table",
        "pane ledger visible with evidence cards",
        "pane source visible with highlighted text and zero-radius marks"
      ]
    },
    {
      name: "renders refused span integrity badge for corrupt spans",
      path: "/packet/:candidateId",
      assertions: [
        "span integrity failure rendered with class span-refused",
        "badge contains text: span integrity failed, highlight refused"
      ]
    },
    {
      name: "inspects human review queue and status",
      path: "/review",
      assertions: [
        "resolution tasks list visible",
        "pending proposals list visible"
      ]
    }
  ]
};
