export type ParsedArgs = Readonly<{
  command: string;
  positionals: readonly string[];
  flags: Readonly<{
    json: boolean;
    help: boolean;
    version: boolean;
    detailed: boolean;
    dryRun: boolean;
  }>;
  options: Readonly<{
    role?: string;
    candidate?: string;
    task?: string;
    action?: string;
    decision?: string;
    proposal?: string;
    rationale?: string;
    format?: string;
    actor?: string;
    versionNum?: number;
    limit?: number;
    status?: string;
    channel?: string;
    db?: string;
    attempt?: string;
    run?: string;
    corpusTag?: string;
    kind?: string;
    candidateId?: string;
  }>;
  unknownOptions: readonly string[];
}>;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let command = "";
  const positionals: string[] = [];
  const unknownOptions: string[] = [];

  const flags = {
    json: false,
    help: false,
    version: false,
    detailed: false,
    dryRun: false
  };

  const options: {
    role?: string;
    candidate?: string;
    task?: string;
    action?: string;
    decision?: string;
    proposal?: string;
    rationale?: string;
    format?: string;
    actor?: string;
    versionNum?: number;
    limit?: number;
    status?: string;
    channel?: string;
    db?: string;
    attempt?: string;
    run?: string;
    corpusTag?: string;
    kind?: string;
    candidateId?: string;
  } = {};

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (!arg) {
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      index += 1;
    } else if (arg === "--version" || arg === "-v") {
      flags.version = true;
      index += 1;
    } else if (arg === "--json") {
      flags.json = true;
      index += 1;
    } else if (arg === "--detailed") {
      flags.detailed = true;
      index += 1;
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
      index += 1;
    } else if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      const key = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);
      let value = eqIdx !== -1 ? arg.slice(eqIdx + 1) : "";

      if (eqIdx === -1 && index + 1 < argv.length && !argv[index + 1]?.startsWith("-")) {
        index += 1;
        value = argv[index] ?? "";
      }

      switch (key) {
        case "role":
          options.role = value;
          break;
        case "candidate":
          options.candidate = value;
          break;
        case "task":
          options.task = value;
          break;
        case "action":
          options.action = value;
          break;
        case "decision":
          options.decision = value;
          break;
        case "proposal":
          options.proposal = value;
          break;
        case "rationale":
          options.rationale = value;
          break;
        case "format":
          options.format = value;
          break;
        case "actor":
          options.actor = value;
          break;
        case "version-num":
        case "version":
          options.versionNum = Number.parseInt(value, 10);
          break;
        case "limit":
          options.limit = Number.parseInt(value, 10);
          break;
        case "status":
          options.status = value;
          break;
        case "channel":
          options.channel = value;
          break;
        case "db":
          options.db = value;
          break;
        case "attempt":
          options.attempt = value;
          break;
        case "run":
          options.run = value;
          break;
        case "corpus-tag":
          options.corpusTag = value;
          break;
        case "kind":
          options.kind = value;
          break;
        case "candidate-id":
          options.candidateId = value;
          break;
        default:
          unknownOptions.push(arg);
          break;
      }
      index += 1;
    } else if (arg.startsWith("-")) {
      unknownOptions.push(arg);
      index += 1;
    } else {
      if (!command) {
        command = arg;
      } else {
        positionals.push(arg);
      }
      index += 1;
    }
  }

  return {
    command: command || (flags.help ? "help" : flags.version ? "version" : "help"),
    positionals,
    flags,
    options,
    unknownOptions
  };
}
