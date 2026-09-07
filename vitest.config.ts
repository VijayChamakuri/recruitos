import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "core",
          include: ["packages/core/src/**/*.test.ts"]
        }
      },
      {
        extends: true,
        test: {
          name: "runtime",
          include: ["packages/runtime/src/**/*.test.ts"]
        }
      },
      {
        extends: true,
        test: {
          name: "architecture",
          include: ["scripts/**/*.test.mjs"]
        }
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"]
        }
      }
    ],
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**/*.ts", "packages/runtime/src/**/*.ts"],
      exclude: [
        "packages/core/src/**/*.test.ts",
        "packages/runtime/src/**/*.test.ts",
        // Adapter contracts declare types only and erase to empty modules,
        // so there is no executable line for coverage to report on.
        "packages/runtime/src/adapters/candidate-source.ts",
        "packages/runtime/src/adapters/extraction.ts"
      ],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
});
