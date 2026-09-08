import {
  createCompositionFromRuntime,
  createDefaultRuntimeComposition,
  type RuntimeComposition
} from "./composition/index.js";
import type { RecruitosComposition } from "./composition/types.js";
import {
  formatHelp,
  runPacketCommand,
  runReviewCommand,
  runRuntimeCommand,
  runStatusCommand,
  runTriageCommand,
  type CommandResult
} from "./commands/index.js";
import {
  createErrorEnvelope,
  createSuccessEnvelope,
  formatEnvelopeJson
} from "./envelopes.js";
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from "./exit-codes.js";
import { parseArgs } from "./parser.js";

export const CLI_VERSION = "0.1.0";

export type RunCliOptions = Readonly<{
  composition?: RecruitosComposition | undefined;
  runtime?: RuntimeComposition | undefined;
}>;

export async function runCli(
  argv: readonly string[],
  options?: RunCliOptions
): Promise<CommandResult> {
  const startTime = Date.now();
  const parsed = parseArgs(argv);

  let composition: RecruitosComposition;
  if (options?.composition) {
    composition = options.composition;
  } else if (options?.runtime) {
    composition = createCompositionFromRuntime(options.runtime);
  } else if (parsed.options.db) {
    const runtimeComp = createDefaultRuntimeComposition({
      database: { filename: parsed.options.db }
    });
    if (!runtimeComp.ok) {
      const durationMs = Date.now() - startTime;
      return {
        exitCode: EXIT_RUNTIME_ERROR,
        stderr: parsed.flags.json
          ? formatEnvelopeJson(
              createErrorEnvelope(
                parsed.command,
                runtimeComp.error.code,
                runtimeComp.error.message,
                EXIT_RUNTIME_ERROR,
                durationMs,
                runtimeComp.error.details
              )
            )
          : `Error [${runtimeComp.error.code}]: ${runtimeComp.error.message}`
      };
    }
    composition = runtimeComp.value;
  } else {
    const runtimeComp = createDefaultRuntimeComposition();
    if (!runtimeComp.ok) {
      const durationMs = Date.now() - startTime;
      return {
        exitCode: EXIT_RUNTIME_ERROR,
        stderr: parsed.flags.json
          ? formatEnvelopeJson(
              createErrorEnvelope(
                parsed.command,
                runtimeComp.error.code,
                runtimeComp.error.message,
                EXIT_RUNTIME_ERROR,
                durationMs,
                runtimeComp.error.details
              )
            )
          : `Error [${runtimeComp.error.code}]: ${runtimeComp.error.message}`
      };
    }
    composition = runtimeComp.value;
  }

  if (parsed.unknownOptions.length > 0) {
    const durationMs = Date.now() - startTime;
    const msg = `Unknown option(s): ${parsed.unknownOptions.join(", ")}`;
    if (parsed.flags.json) {
      return {
        exitCode: EXIT_USAGE_ERROR,
        stderr: formatEnvelopeJson(
          createErrorEnvelope(
            parsed.command,
            "unknown_option",
            msg,
            EXIT_USAGE_ERROR,
            durationMs
          )
        )
      };
    }
    return {
      exitCode: EXIT_USAGE_ERROR,
      stderr: `Usage error: ${msg}\nSee 'recruitos --help' for available options.`
    };
  }

  // Handle help
  if (parsed.flags.help || parsed.command === "help") {
    const targetCommand = parsed.positionals[0] || (parsed.command !== "help" ? parsed.command : undefined);
    const helpText = formatHelp(targetCommand);
    const durationMs = Date.now() - startTime;

    if (parsed.flags.json) {
      return {
        exitCode: EXIT_SUCCESS,
        stdout: formatEnvelopeJson(
          createSuccessEnvelope("help", { help: helpText }, durationMs)
        )
      };
    }
    return {
      exitCode: EXIT_SUCCESS,
      stdout: helpText
    };
  }

  // Handle version
  if (parsed.flags.version || parsed.command === "version") {
    const durationMs = Date.now() - startTime;
    if (parsed.flags.json) {
      return {
        exitCode: EXIT_SUCCESS,
        stdout: formatEnvelopeJson(
          createSuccessEnvelope("version", { version: CLI_VERSION }, durationMs)
        )
      };
    }
    return {
      exitCode: EXIT_SUCCESS,
      stdout: `recruitos version ${CLI_VERSION}`
    };
  }

  switch (parsed.command) {
    case "db:migrate":
    case "import":
    case "corpus:import":
    case "triage:run":
    case "triage:start":
    case "triage:extract":
    case "triage:finalize":
      return runRuntimeCommand(parsed, composition, startTime);
    case "triage":
      return runTriageCommand(parsed, composition, startTime);
    case "review":
      return runReviewCommand(parsed, composition, startTime);
    case "packet":
      return runPacketCommand(parsed, composition, startTime);
    case "status":
      return runStatusCommand(parsed, composition, startTime);
    default: {
      const durationMs = Date.now() - startTime;
      const msg = `Unknown command '${parsed.command}'. Available commands: triage, review, packet, status, help.`;
      if (parsed.flags.json) {
        return {
          exitCode: EXIT_USAGE_ERROR,
          stderr: formatEnvelopeJson(
            createErrorEnvelope(
              parsed.command,
              "unknown_command",
              msg,
              EXIT_USAGE_ERROR,
              durationMs
            )
          )
        };
      }
      return {
        exitCode: EXIT_USAGE_ERROR,
        stderr: `Usage error: ${msg}`
      };
    }
  }
}
