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
        "  --action <kind>       Resolution action (resolve, override, dismiss)",
        "  --proposal <id>       Inspect or act on specific proposal",
        "  --decision <kind>     Proposal decision (approve, reject)",
        "  --rationale <text>    Justification for resolution action or decision",
        "  --actor <id>          Actor ID recording the action (default: human:operator)",
        "  --version-num <n>     Expected head version for optimistic concurrency",
        "  --status <status>     Filter tasks or proposals by status",
        "  --json                Emit output in structured JSON envelope",
        "  -h, --help            Show this help message",
        "",
        "Examples:",
        "  recruitos review",
        "  recruitos review --task task-1",
        "  recruitos review --task task-1 --action resolve --rationale \"Verified by recruiter\" --version-num 0",
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
        "  --json                Emit output in structured JSON envelope",
        "  -h, --help            Show this help message",
        "",
        "Examples:",
        "  recruitos packet candidate-1",
        "  recruitos packet candidate-1 --format arithmetic",
        "  recruitos packet candidate-1 --json"
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
