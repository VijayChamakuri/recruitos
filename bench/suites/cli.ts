import { runCli } from "../../apps/cli/dist/index.js";
import type { BenchmarkTask } from "../types.js";

export function createCliTasks(iterations = 50): BenchmarkTask[] {
  const commands: Array<{ name: string; args: string[] }> = [
    { name: "CLI: status --json", args: ["status", "--json"] },
    { name: "CLI: triage --json", args: ["triage", "--json"] },
    { name: "CLI: review --json", args: ["review", "--json"] },
    { name: "CLI: packet candidate-1 --json", args: ["packet", "candidate-1", "--json"] }
  ];

  return commands.map((cmd) => ({
    name: cmd.name,
    iterations,
    warmupIterations: 5,
    fn: async () => {
      await runCli(cmd.args);
    }
  }));
}
