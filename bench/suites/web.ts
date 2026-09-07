import { handleRequest } from "../../apps/web/dist/index.js";
import type { BenchmarkTask } from "../types.js";

export function createWebTasks(iterations = 50): BenchmarkTask[] {
  const routes = [
    "/triage",
    "/review",
    "/packet/candidate-1",
    "/runs",
    "/status"
  ];

  return routes.map((route) => ({
    name: `Web SSR: ${route}`,
    iterations,
    warmupIterations: 5,
    fn: async () => {
      const params = new URLSearchParams();
      await handleRequest(route, params);
    }
  }));
}
