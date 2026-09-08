export function formatHelp(targetCommand?: string): string {
  switch (targetCommand) {
    case "demo:prepare":
      return [
        "recruitos demo:prepare - Build the deterministic local demo spine",
        "",
        "Usage:",
        "  recruitos demo:prepare --db <path> [--actor <id>] [--json]",
        "",
        "The database must be fresh. This imports the synthetic candidate, runs",
        "fixture extraction, finalizes the run, and seals the result."
      ].join("\n");

    case "eval:class1":
      return [
        "recruitos eval:class1 - Evaluate one sealed candidate result",
        "",
        "Usage:",
        "  recruitos eval:class1 --db <path> --candidate-id <id> [--json]"
      ].join("\n");

    case "triage":
      return [
        "recruitos triage - Candidate triage queue and execution",
        "",
        "Usage:",
        "  recruitos triage [options]",
        "",
        "Options:",
        "  --role <id>           Filter candidates or run triage for specific role",
        "  --candidate <id>      Run triage or filter for specific candidate ID",
        "  --status <status>     Filter candidates (shortlisted, reviewed, escalated)",
        "  --channel <channel>   Filter by channel (inbound, sourced)",
        "  --limit <n>           Limit number of returned candidates",
        "  --dry-run             Simulate triage without committing seals",
        "  --json                Emit output in structured JSON envelope",
        "  -h, --help            Show this help message",
        "",
        "Examples:",
        "  recruitos triage",
        "  recruitos triage --status escalated --limit 10",
        "  recruitos triage --role role-applied-ai-engineer --json"
      ].join("\n");

    case "review":
      return [
        "recruitos review - Resolution tasks and proposal review",
        "",
        "Usage:",
        "  recruitos review [options]",
        "",
        "Options:",
        "  --task <id>           Inspect or act on specific resolution task",
        "  --action <kind>       Resolution action (resolve, request_re_extraction, ...)",
        "  --proposal <id>       Inspect or act on specific proposal",
        "  --decision <kind>     Proposal decision (approve, reject)",
        "  --rationale <text>    Justification for resolution action or decision",
        "  --actor <id>          Actor ID recording the action (default: human:operator)",
        "  --version-num <n>     Expected task head version for optimistic concurrency",
        "  --candidate-version <n>  Expected candidate head version (request_re_extraction)",
        "  --command-id <id>     Durable command id so a lost receipt can be replayed",
        "  --status <status>     Filter tasks or proposals by status",
        "  --json                Emit output in structured JSON envelope",
        "  -h, --help            Show this help message",
        "",
        "Examples:",
        "  recruitos review",
        "  recruitos review --task task-1",
        "  recruitos review --task task-1 --action resolve --rationale \"Verified by recruiter\" --version-num 0",
        "  recruitos review --task task-1 --action request_re_extraction --version-num 0 --candidate-version 1",
        "  recruitos review --task task-1 --action request_re_extraction --version-num 0 --candidate-version 1 --command-id request-1",
        "  recruitos review --proposal proposal-1 --decision approve --version-num 0"
      ].join("\n");

    case "packet":
      return [
        "recruitos packet - Candidate review packet inspector",
        "",
        "Usage:",
        "  recruitos packet <candidate-id> [options]",
        "",
        "Options:",
        "  --format <fmt>        Display format (full, arithmetic, evidence, document)",
        "  --result <id>         Inspect a historical sealed result for this candidate",
        "  --json                Emit output in structured JSON envelope",
        "  -h, --help            Show this help message",
        "",
        "Examples:",
        "  recruitos packet candidate-1",
        "  recruitos packet candidate-1 --format arithmetic",
        "  recruitos packet candidate-1 --json",
        "  recruitos packet candidate-1 --result result-original --json"
      ].join("\n");

    case "triage:extract":
      return [
        "recruitos triage:extract - Run fixture extraction for one attempt",
        "",
        "Usage:",
        "  recruitos triage:extract --attempt <id> [--demo-fixtures] [--correction-overlay] [--db <path>] [--json]",
        "",
        "--demo-fixtures registers the seven-route corpus bodies on the fixture",
        "adapter. --correction-overlay uses the proving correction bodies for the",
        "reviewable-extraction-failure candidate."
      ].join("\n");

    case "triage:complete-correction":
      return [
        "recruitos triage:complete-correction - Seal a completed correction attempt",
        "",
        "Usage:",
        "  recruitos triage:complete-correction --attempt <id> --version-num <n> --candidate-version <n> [--command-id <id>] [--db <path>] [--json]",
        "",
        "Writes a system-only reextraction_completed action and a superseding",
        "correction result. The original packet stays inspectable. The task moves",
        "to review_required, never resolved. Actor is always system:runtime.",
        "",
        "Fixture-only sequence after demo:prepare --db <path>:",
        "  packet <candidate> --db <path>",
        "  review --candidate <candidate> --db <path>",
        "  review --task <task> --action request_re_extraction --version-num 0 --candidate-version 1 --actor human:operator --db <path> [--command-id req-1]",
        "  triage:extract --attempt <attempt> --demo-fixtures --correction-overlay --db <path>",
        "  triage:complete-correction --attempt <attempt> --version-num 1 --candidate-version 1 --db <path> [--command-id complete-1]",
        "  packet <candidate> --db <path>",
        "  packet <candidate> --result <original-result> --db <path>"
      ].join("\n");

    case "status":
      return [
        "recruitos status - Inspect database, corpus, and seal status",
        "",
        "Usage:",
        "  recruitos status [options]",
        "",
        "Options:",
        "  --detailed            Include table statistics and audit counts",
        "  --json                Emit output in structured JSON envelope",
        "  -h, --help            Show this help message",
        "",
        "Examples:",
        "  recruitos status",
        "  recruitos status --detailed --json"
      ].join("\n");

    default:
      return [
        "RecruitOS CLI - AI-assisted candidate evaluation and review control plane",
        "",
        "Usage:",
        "  recruitos <command> [options]",
        "",
        "Commands:",
        "  demo:prepare     Build the deterministic one-candidate demo in a fresh database",
        "  eval:class1      Run the Class 1 gate against a sealed candidate result",
        "  db:migrate       Open and migrate a local runtime database",
        "  corpus:import    Import candidates through the configured source adapter",
        "  triage:run       Start a triage attempt through the runtime use case",
        "  triage:extract   Run deterministic fixture extraction for an attempt",
        "  triage:finalize  Finalize an attempt and seal candidate results",
        "  triage:complete-correction",
        "                   Seal a completed candidate_correction attempt",
        "  triage     List candidate triage queue or run automated triage",
        "  review     Inspect and resolve open tasks or review stage proposals",
        "  packet     Inspect candidate evaluation packet (arithmetic, evidence, doc)",
        "  status     Check system, corpus seal, and database status",
        "  help       Show help for a command",
        "",
        "Global Options:",
        "  --db <path>  Use a local SQLite runtime database",
        "  --json        Emit output in structured JSON envelope",
        "  -h, --help    Show help message",
        "  -v, --version Show RecruitOS version",
        "",
        "Run 'recruitos help <command>' for detailed command usage."
      ].join("\n");
  }
}
