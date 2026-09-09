/**
 * Test ID and Route Contract for RecruitOS Web UI and Playwright E2E Workflows.
 * All interactive presenters, pages, and navigation targets must satisfy this contract.
 */

export const ROUTES = {
  HOME: "/",
  TRIAGE: "/triage",
  REVIEW: "/review",
  REVIEW_TASKS: "/review?tab=tasks",
  REVIEW_PROPOSALS: "/review?tab=proposals",
  REVIEW_BIAS: "/review?tab=bias",
  RUNS: "/runs",
  STATUS: "/status",
  PACKET: (candidateId = ":id") => `/packet/${candidateId}`
} as const;

export const TEST_IDS = {
  // Navigation and Global Shell
  GLOBAL_BAR: "global-bar",
  NAVIGATION_RAIL: "navigation-rail",
  INSTRUMENT_BAND: "instrument-band",
  NAV_TRIAGE: "nav-triage",
  NAV_REVIEW: "nav-review",
  NAV_PACKET: "nav-packet",
  NAV_RUNS: "nav-runs",
  NAV_STATUS: "nav-status",

  // Workflow 1: Demo Start and Triage Queue
  TRIAGE_HEADING: "triage-heading",
  TRIAGE_QUEUE: "triage-queue",
  CANDIDATE_ROW: "candidate-row",
  CANDIDATE_LINK: (id: string) => `candidate-link-${id}`,
  CANDIDATE_STATUS: (id: string) => `candidate-status-${id}`,
  EVIDENCE_STRIP: "evidence-strip",
  SYNTHETIC_DATA_PILL: "synthetic-data-pill",

  // Workflow 2: Candidate Packet Review
  PACKET_VIEW: "candidate-packet-view",
  PACKET_NOT_FOUND: "packet-not-found",
  RETURN_TO_QUEUE: "return-to-queue",
  PACKET_INSPECTING_LABEL: "packet-inspecting-label",
  PACKET_TASKS: "packet-tasks",
  PACKET_TASK_ITEM: (id: string) => `packet-task-${id}`,
  CONFIDENCE_INPUTS: "confidence-inputs",
  PANE_ARITHMETIC: "pane-arithmetic",
  PANE_LEDGER: "pane-ledger",
  PANE_SOURCE: "pane-source",
  RESUME_VIEWER: "resume-viewer",
  RAW_SOURCE_TEXT: "raw-source-text",
  SCORE_CARD: "score-card",
  ROUTING_REASONS: "routing-reasons",
  ROUTING_REASON_TAG: (reason: string) => `routing-reason-${reason}`,
  ARITHMETIC_TABLE: "arithmetic-table",
  ARITHMETIC_TERM: (dimId: string) => `arithmetic-term-${dimId}`,
  DIMENSION_BLOCK: (dimId: string) => `dim-block-${dimId}`,
  EVIDENCE_SPAN_CARD: (spanId: string) => `card-${spanId}`,
  EVIDENCE_GAP_CARD: (dimId: string) => `evidence-gap-card-${dimId}`,
  SPAN_HIGHLIGHT: "span-highlight",
  SPAN_INTEGRITY_FAILURE: "span-integrity-failure",
  SUPERSEDING_BADGE: "superseding-badge",
  PRIOR_VERSION_LINK: "prior-version-link",
  VERSION_HISTORY: "version-history",

  // Workflow 3: fixture correction request and completion
  TASK_ITEM: (id: string) => `task-item-${id}`,
  TASK_STATUS: (id: string) => `task-status-${id}`,
  TASK_INSPECTOR: "task-inspector",
  RESOLUTION_FORM: "resolution-form",
  RATIONALE_INPUT: "resolution-rationale",
  EVIDENCE_INPUT: "evidence-input",
  LEVEL_SELECT: "level-select",
  SUBMIT_RESOLUTION_BTN: "submit-resolution-btn",
  FIXTURE_MODE_MARK: "fixture-correction-mark",
  FIXTURE_COMPLETE_FORM: "fixture-complete-form",
  COMPLETE_FIXTURE_BTN: "complete-fixture-extraction-btn",

  // Workflow 4: Stale Conflict
  CONFLICT_ERROR_BANNER: "conflict-error-banner",
  TOAST_SUCCESS: "toast-success",

  // Workflow 5: Proposal Review
  PROPOSAL_ITEM: (id: string) => `proposal-item-${id}`,
  PROPOSAL_STATUS: (id: string) => `status-${id}`,
  PROPOSAL_APPROVE_BTN: (id: string) => `proposal-approve-${id}`,
  PROPOSAL_EDIT_BTN: (id: string) => `proposal-edit-${id}`,
  PROPOSAL_REJECT_BTN: (id: string) => `proposal-reject-${id}`,
  PROPOSAL_COMMENT_INPUT: "proposal-comment-input",
  CONFIRM_EDIT_BTN: "confirm-edit-btn",
  OUTBOUND_COUNTER: "outbound-counter",

  // Workflow 6: Audit Trust Center and System Status
  AUDIT_EVENT_TABLE: "audit-event-table",
  AUDIT_EVENT_ROW: "audit-event-row",
  AUDIT_EVENT_ITEM: (id: string) => `audit-event-${id}`,
  CORPUS_SEAL_STATUS: "corpus-seal-status",
  KNOWN_LIMITATIONS: "known-limitations",
  KNOWN_LIMITATION_ITEM: "known-limitation-item",
  BIAS_AUDIT_SUMMARY: "bias-audit-summary",
  SYNTHETIC_DATA_DISCLAIMER: "synthetic-data-disclaimer",
  INSUFFICIENT_SAMPLE_STATEMENT: "insufficient-sample-statement",
  PROPOSED_BIAS_CUTS: "proposed-bias-cuts",
  APPROVED_BIAS_CUTS: "approved-bias-cuts",
  BIAS_GROUP_ROW: (group: string) => `bias-group-${group}`,
  HALLUCINATION_PANEL: "hallucination-panel"
} as const;
