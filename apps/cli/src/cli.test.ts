import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { err, ok } from "@recruitos/core";
import { DEMO_REVIEWABLE_FAILURE_SOURCE_KEY } from "@recruitos/runtime";
import { parseArgs } from "./parser.js";
import { runCli } from "./cli.js";
import {
  EXIT_DOMAIN_ERROR,
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  mapErrorToExitCode
} from "./exit-codes.js";
import { createStubComposition } from "./composition/index.js";
import type { RecruitosComposition } from "./composition/types.js";
import type { CommandResult } from "./commands/index.js";

function parseEnvelopeData<T>(result: CommandResult): T {
  expect(result.exitCode).toBe(EXIT_SUCCESS);
  const envelope = JSON.parse(result.stdout ?? "{}") as { data?: T };
  expect(envelope.data).toBeDefined();
  return envelope.data as T;
}

describe("CLI Parser", () => {
  it("parses empty arguments to default help command", () => {
    const parsed = parseArgs([]);
    expect(parsed.command).toBe("help");
    expect(parsed.flags.help).toBe(false);
  });

  it("parses global flags --help and --version", () => {
    const helpParsed = parseArgs(["--help"]);
    expect(helpParsed.flags.help).toBe(true);
    expect(helpParsed.command).toBe("help");

    const versionParsed = parseArgs(["--version"]);
    expect(versionParsed.flags.version).toBe(true);
    expect(versionParsed.command).toBe("version");
  });

  it("parses subcommands and flags", () => {
    const parsed = parseArgs(["triage", "--json", "--dry-run", "--detailed"]);
    expect(parsed.command).toBe("triage");
    expect(parsed.flags.json).toBe(true);
    expect(parsed.flags.dryRun).toBe(true);
    expect(parsed.flags.detailed).toBe(true);
  });

  it("parses options with space or equal sign", () => {
    const p1 = parseArgs(["triage", "--role", "role-ai", "--limit", "5"]);
    expect(p1.options.role).toBe("role-ai");
    expect(p1.options.limit).toBe(5);

    const p2 = parseArgs(["review", "--task=task-1", "--version-num=2"]);
    expect(p2.options.task).toBe("task-1");
    expect(p2.options.versionNum).toBe(2);

    const p3 = parseArgs([
      "triage:finalize",
      "--attempt=attempt-1",
      "--run",
      "run-1",
      "--corpus-tag",
      "variant",
      "--kind=variant_run"
    ]);
    expect(p3.options).toMatchObject({
      attempt: "attempt-1",
      run: "run-1",
      corpusTag: "variant",
      kind: "variant_run"
    });

    const p4 = parseArgs(["eval:class1", "--candidate-id=candidate-1"]);
    expect(p4.options.candidateId).toBe("candidate-1");

    const p5 = parseArgs([
      "triage:extract",
      "--attempt",
      "attempt-1",
      "--demo-fixtures",
      "--correction-overlay",
      "--candidate-version",
      "1",
      "--result",
      "result-original"
    ]);
    expect(p5.flags.demoFixtures).toBe(true);
    expect(p5.flags.correctionOverlay).toBe(true);
    expect(p5.options.candidateVersion).toBe(1);
    expect(p5.options.result).toBe("result-original");
  });

  it("records unknown options", () => {
    const parsed = parseArgs(["triage", "--foo-bar", "-x"]);
    expect(parsed.unknownOptions).toContain("--foo-bar");
    expect(parsed.unknownOptions).toContain("-x");
  });
});

describe("Exit Codes Mapping", () => {
  it("maps known domain error codes to EXIT_DOMAIN_ERROR (1)", () => {
    expect(mapErrorToExitCode("version_conflict")).toBe(EXIT_DOMAIN_ERROR);
    expect(mapErrorToExitCode("not_found")).toBe(EXIT_DOMAIN_ERROR);
    expect(mapErrorToExitCode("validation_error")).toBe(EXIT_DOMAIN_ERROR);
    expect(mapErrorToExitCode("precondition_failed")).toBe(EXIT_DOMAIN_ERROR);
  });

  it("maps usage error codes to EXIT_USAGE_ERROR (2)", () => {
    expect(mapErrorToExitCode("usage_error")).toBe(EXIT_USAGE_ERROR);
    expect(mapErrorToExitCode("invalid_argument")).toBe(EXIT_USAGE_ERROR);
  });

  it("maps unexpected error codes to EXIT_RUNTIME_ERROR (3)", () => {
    expect(mapErrorToExitCode("database_disk_full")).toBe(EXIT_RUNTIME_ERROR);
    expect(mapErrorToExitCode("internal_error")).toBe(EXIT_RUNTIME_ERROR);
  });
});

describe("CLI Commands Execution", () => {
  describe("Help & Version", () => {
    it("displays general help", async () => {
      const res = await runCli(["--help"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      expect(res.stdout).toContain("RecruitOS CLI");
      expect(res.stdout).toContain("triage");
      expect(res.stdout).toContain("review");
      expect(res.stdout).toContain("packet");
      expect(res.stdout).toContain("status");
      expect(res.stdout).toContain("demo:prepare");
      expect(res.stdout).toContain("eval:class1");
      expect(res.stdout).toContain("triage:complete-correction");
    });

    it("displays command-specific help", async () => {
      const res = await runCli(["help", "packet"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      expect(res.stdout).toContain("recruitos packet <candidate-id>");
      expect(res.stdout).toContain("--result");

      const reviewHelp = await runCli(["help", "review"]);
      expect(reviewHelp.stdout).toContain("request_re_extraction");
      expect(reviewHelp.stdout).toContain("--candidate-version");

      const extractHelp = await runCli(["help", "triage:extract"]);
      expect(extractHelp.stdout).toContain("--demo-fixtures");
      expect(extractHelp.stdout).toContain("--correction-overlay");

      const completeHelp = await runCli(["help", "triage:complete-correction"]);
      expect(completeHelp.stdout).toContain("reextraction_completed");
      expect(completeHelp.stdout).toContain("review_required");
    });

    it("emits help as structured JSON when requested", async () => {
      const res = await runCli(["--help", "--json"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      const parsed = JSON.parse(res.stdout ?? "{}");
      expect(parsed.ok).toBe(true);
      expect(parsed.data.help).toContain("RecruitOS CLI");
    });

    it("displays version string", async () => {
      const res = await runCli(["--version"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      expect(res.stdout).toContain("0.1.0");
    });
  });

  describe("Unknown Commands & Options", () => {
    it("fails with EXIT_USAGE_ERROR on unknown command", async () => {
      const res = await runCli(["nonexistent-cmd"]);
      expect(res.exitCode).toBe(EXIT_USAGE_ERROR);
      expect(res.stderr).toContain("Unknown command 'nonexistent-cmd'");
    });

    it("fails with EXIT_USAGE_ERROR on unknown option", async () => {
      const res = await runCli(["triage", "--nonexistent"]);
      expect(res.exitCode).toBe(EXIT_USAGE_ERROR);
      expect(res.stderr).toContain("Unknown option(s): --nonexistent");
    });

    it("emits JSON error envelope for unknown command with --json", async () => {
      const res = await runCli(["nonexistent-cmd", "--json"]);
      expect(res.exitCode).toBe(EXIT_USAGE_ERROR);
      const errEnv = JSON.parse(res.stderr ?? "{}");
      expect(errEnv.ok).toBe(false);
      expect(errEnv.error.exitCode).toBe(EXIT_USAGE_ERROR);
    });
  });

  describe("Triage Command", () => {
    it("lists candidates in terminal tabular format", async () => {
      const res = await runCli(["triage"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      expect(res.stdout).toContain("Candidate ID");
      expect(res.stdout).toContain("candidate-1");
      expect(res.stdout).toContain("shortlisted");
    });

    it("lists candidates in JSON envelope format", async () => {
      const res = await runCli(["triage", "--json"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      const env = JSON.parse(res.stdout ?? "{}");
      expect(env.ok).toBe(true);
      expect(Array.isArray(env.data)).toBe(true);
      expect(env.data.length).toBeGreaterThan(0);
      expect(env.data[0].candidateId).toBe("candidate-1");
    });

    it("rejects invalid status filter with EXIT_USAGE_ERROR", async () => {
      const res = await runCli(["triage", "--status", "bogus_status"]);
      expect(res.exitCode).toBe(EXIT_USAGE_ERROR);
      expect(res.stderr).toContain("Invalid candidate status");
    });

    it("filters candidates by status", async () => {
      const res = await runCli(["triage", "--status", "shortlisted", "--json"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      const env = JSON.parse(res.stdout ?? "{}");
      expect(env.data.every((c: any) => c.status === "shortlisted")).toBe(true);
    });

    it("executes triage run", async () => {
      const res = await runCli(["triage", "run"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      expect(res.stdout).toContain("RecruitOS Triage Run Summary");
      expect(res.stdout).toContain("Run ID:");
    });

    it("executes triage dry run in JSON mode", async () => {
      const res = await runCli(["triage", "--dry-run", "--json"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      const env = JSON.parse(res.stdout ?? "{}");
      expect(env.ok).toBe(true);
      expect(env.data.runId).toContain("run-");
    });
  });

  describe("Runtime Use-case Commands", () => {
    it("prepares, prints, and evaluates the real seven-route demo", async () => {
      const directory = mkdtempSync(join(tmpdir(), "recruitos-cli-demo-"));
      const database = join(directory, "runtime.db");
      try {
        const prepared = await runCli([
          "demo:prepare",
          "--db",
          database,
          "--json"
        ]);
        expect(prepared.exitCode).toBe(EXIT_SUCCESS);
        const envelope = JSON.parse(prepared.stdout ?? "{}") as {
          data?: { candidateIds?: string[] };
        };
        // candidateIds[0] is the first corpus route, demo/route-1-scored.
        const candidateId = envelope.data?.candidateIds?.[0];
        expect(candidateId).toMatch(/\S/);
        expect(envelope.data?.candidateIds).toHaveLength(7);

        const packet = await runCli(["packet", candidateId ?? "", "--db", database]);
        expect(packet.exitCode).toBe(EXIT_SUCCESS);
        expect(packet.stdout).toContain("Status:       scored");
        expect(packet.stdout).toContain("Sealed:       yes");

        const evaluated = await runCli([
          "eval:class1",
          "--candidate-id",
          candidateId ?? "",
          "--db",
          database
        ]);
        expect(evaluated.exitCode).toBe(EXIT_SUCCESS);
        expect(evaluated.stdout).toContain("Passed:                    yes");

        const second = await runCli(["demo:prepare", "--db", database]);
        expect(second.exitCode).toBe(EXIT_RUNTIME_ERROR);
        expect(second.stderr).toContain("Demo corpus imported no candidates");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("requests, extracts, and completes a fixture correction across CLI invocations", async () => {
      const directory = mkdtempSync(join(tmpdir(), "recruitos-cli-correction-"));
      const database = join(directory, "runtime.db");
      try {
        const prepared = parseEnvelopeData<{ candidateIds: string[] }>(
          await runCli(["demo:prepare", "--db", database, "--json"])
        );

        let candidateId: string | undefined;
        let originalResultId: string | undefined;
        let candidateVersion: number | undefined;
        for (const id of prepared.candidateIds) {
          const packet = parseEnvelopeData<{
            sourceKey: string;
            resultId?: string;
            resultKind?: string;
            headVersion?: number;
            reasons: string[];
          }>(await runCli(["packet", id, "--db", database, "--json"]));
          if (packet.sourceKey !== DEMO_REVIEWABLE_FAILURE_SOURCE_KEY) continue;
          candidateId = id;
          originalResultId = packet.resultId;
          candidateVersion = packet.headVersion;
          expect(packet.resultKind).toBe("initial");
          expect(packet.reasons).toContain("assessment_unavailable");
          break;
        }
        expect(candidateId).toMatch(/\S/);
        expect(originalResultId).toMatch(/\S/);
        expect(candidateVersion).toBe(1);

        const listed = parseEnvelopeData<{
          tasks: Array<{ resolutionTaskId: string; version: number; status: string }>;
        }>(
          await runCli([
            "review",
            "--candidate",
            candidateId ?? "",
            "--db",
            database,
            "--json"
          ])
        );
        const task = listed.tasks[0];
        expect(task?.status).toBe("open");
        expect(task?.version).toBe(0);

        const inspected = parseEnvelopeData<{ status: string; actions: unknown[] }>(
          await runCli([
            "review",
            "--task",
            task?.resolutionTaskId ?? "",
            "--db",
            database,
            "--json"
          ])
        );
        expect(inspected.status).toBe("open");
        expect(inspected.actions).toEqual([]);

        const requested = parseEnvelopeData<{
          triageAttemptId: string;
          newVersion: number;
          derivedStatus: string;
        }>(
          await runCli([
            "review",
            "--task",
            task?.resolutionTaskId ?? "",
            "--action",
            "request_re_extraction",
            "--version-num",
            "0",
            "--candidate-version",
            String(candidateVersion),
            "--actor",
            "human:operator",
            "--db",
            database,
            "--json"
          ])
        );
        expect(requested.derivedStatus).toBe("open");
        expect(requested.newVersion).toBe(1);
        expect(requested.triageAttemptId).toMatch(/\S/);

        const extracted = parseEnvelopeData<{
          succeeded: number;
          blockedFailures: number;
        }>(
          await runCli([
            "triage:extract",
            "--attempt",
            requested.triageAttemptId,
            "--demo-fixtures",
            "--correction-overlay",
            "--db",
            database,
            "--json"
          ])
        );
        expect(extracted.succeeded).toBeGreaterThan(0);
        expect(extracted.blockedFailures).toBe(0);

        const completed = parseEnvelopeData<{
          resultId: string;
          baseResultId: string;
          candidateHeadVersion: number;
          derivedStatus: string;
        }>(
          await runCli([
            "triage:complete-correction",
            "--attempt",
            requested.triageAttemptId,
            "--version-num",
            "1",
            "--candidate-version",
            String(candidateVersion),
            "--db",
            database,
            "--json"
          ])
        );
        expect(completed.baseResultId).toBe(originalResultId);
        expect(completed.derivedStatus).toBe("review_required");
        expect(completed.candidateHeadVersion).toBe(2);

        const current = parseEnvelopeData<{
          resultId?: string;
          resultKind?: string;
          status: string;
          headVersion?: number;
        }>(await runCli(["packet", candidateId ?? "", "--db", database, "--json"]));
        expect(current.resultId).toBe(completed.resultId);
        expect(current.resultKind).toBe("correction");
        expect(current.status).toBe("scored");
        expect(current.headVersion).toBe(2);

        const original = parseEnvelopeData<{
          resultId?: string;
          resultKind?: string;
          reasons: string[];
        }>(
          await runCli([
            "packet",
            candidateId ?? "",
            "--result",
            originalResultId ?? "",
            "--db",
            database,
            "--json"
          ])
        );
        expect(original.resultId).toBe(originalResultId);
        expect(original.resultKind).toBe("initial");
        expect(original.reasons).toContain("assessment_unavailable");

        const after = parseEnvelopeData<{ status: string }>(
          await runCli([
            "review",
            "--task",
            task?.resolutionTaskId ?? "",
            "--db",
            database,
            "--json"
          ])
        );
        expect(after.status).toBe("review_required");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("never returns a stub packet from an explicitly selected database", async () => {
      const directory = mkdtempSync(join(tmpdir(), "recruitos-cli-empty-db-"));
      try {
        const result = await runCli([
          "packet",
          "candidate-1",
          "--db",
          join(directory, "runtime.db")
        ]);
        expect(result.exitCode).toBe(EXIT_DOMAIN_ERROR);
        expect(result.stderr).toContain("Candidate packet not found");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("requires a database path for migration", async () => {
      const result = await runCli(["db:migrate"]);
      expect(result.exitCode).toBe(EXIT_USAGE_ERROR);
      expect(result.stderr).toContain("--db <path> is required");
    });

    it("prints the import receipt", async () => {
      const result = await runCli(["corpus:import"], {
        composition: createStubComposition()
      });
      expect(result.exitCode).toBe(EXIT_SUCCESS);
      expect(result.stdout).toContain("RecruitOS Candidate Import");
      expect(result.stdout).toContain("command-stub-import");
    });

    it("starts, extracts, and finalizes by their explicit command names", async () => {
      const composition = createStubComposition();
      const started = await runCli([
        "triage:run",
        "--role",
        "role-1",
        "--candidate",
        "candidate-1,candidate-2"
      ], { composition });
      expect(started.exitCode).toBe(EXIT_SUCCESS);
      expect(started.stdout).toContain("attempt-stub");

      const extracted = await runCli(
        ["triage:extract", "--attempt", "attempt-stub"],
        { composition }
      );
      expect(extracted.exitCode).toBe(EXIT_SUCCESS);
      expect(extracted.stdout).toContain("RecruitOS Fixture Extraction");

      const finalized = await runCli(
        ["triage:finalize", "--attempt", "attempt-stub"],
        { composition }
      );
      expect(finalized.exitCode).toBe(EXIT_SUCCESS);
      expect(finalized.stdout).toContain("RecruitOS Triage Run Finalized");

      const extractedWithFixtures = await runCli(
        ["triage:extract", "--attempt", "attempt-stub", "--demo-fixtures", "--correction-overlay"],
        { composition }
      );
      expect(extractedWithFixtures.exitCode).toBe(EXIT_SUCCESS);

      const completed = await runCli(
        [
          "triage:complete-correction",
          "--attempt",
          "attempt-stub",
          "--version-num",
          "1",
          "--candidate-version",
          "1"
        ],
        { composition }
      );
      expect(completed.exitCode).toBe(EXIT_SUCCESS);
      expect(completed.stdout).toContain("RecruitOS Correction Completed");
      expect(completed.stdout).toContain("review_required");
    });

    it("validates start and finalize inputs", async () => {
      expect((await runCli(["triage:run", "--candidate", "candidate-1"])).exitCode).toBe(
        EXIT_USAGE_ERROR
      );
      expect((await runCli(["triage:run", "--role", "role-1"])).exitCode).toBe(
        EXIT_USAGE_ERROR
      );
      expect((await runCli(["triage:finalize"])).exitCode).toBe(EXIT_USAGE_ERROR);
      expect((await runCli(["demo:prepare"])).exitCode).toBe(EXIT_USAGE_ERROR);
      expect((await runCli(["eval:class1"])).exitCode).toBe(EXIT_USAGE_ERROR);
      expect((await runCli(["triage:complete-correction"])).exitCode).toBe(EXIT_USAGE_ERROR);
      expect(
        (await runCli(["triage:complete-correction", "--attempt", "attempt-1"])).exitCode
      ).toBe(EXIT_USAGE_ERROR);
      expect(
        (
          await runCli([
            "triage:complete-correction",
            "--attempt",
            "attempt-1",
            "--version-num",
            "1"
          ])
        ).exitCode
      ).toBe(EXIT_USAGE_ERROR);

      const noComplete = createStubComposition();
      (noComplete as { completeReExtraction?: unknown }).completeReExtraction = undefined;
      expect(
        (
          await runCli(
            [
              "triage:complete-correction",
              "--attempt",
              "attempt-1",
              "--version-num",
              "1",
              "--candidate-version",
              "1"
            ],
            { composition: noComplete }
          )
        ).stderr
      ).toContain("does not support correction completion");

      const noFixtures = createStubComposition();
      (noFixtures as { registerExtractionFixtures?: unknown }).registerExtractionFixtures = undefined;
      expect(
        (
          await runCli(
            ["triage:extract", "--attempt", "attempt-1", "--demo-fixtures"],
            { composition: noFixtures }
          )
        ).stderr
      ).toContain("does not support fixture registration");
    });
  });

  describe("Review Command", () => {
    it("lists review queue tasks and proposals", async () => {
      const res = await runCli(["review"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      expect(res.stdout).toContain("Resolution Tasks");
      expect(res.stdout).toContain("Pending Proposals");
    });

    it("lists review queue in JSON mode", async () => {
      const res = await runCli(["review", "--json"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      const env = JSON.parse(res.stdout ?? "{}");
      expect(env.ok).toBe(true);
      expect(Array.isArray(env.data.tasks)).toBe(true);
      expect(Array.isArray(env.data.proposals)).toBe(true);
    });

    it("inspects specific resolution task with action history", async () => {
      const res = await runCli(["review", "--task", "task-1"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      expect(res.stdout).toContain("Resolution Task: task-1");
      expect(res.stdout).toContain("assessment_unavailable");
    });

    it("requires --version-num when recording resolution action", async () => {
      const res = await runCli(["review", "--task", "task-1", "--action", "resolve"]);
      expect(res.exitCode).toBe(EXIT_USAGE_ERROR);
      expect(res.stderr).toContain("--version-num is required");
    });

    it("rejects a human reextraction_completed action", async () => {
      const text = await runCli([
        "review",
        "--task",
        "task-1",
        "--action",
        "reextraction_completed",
        "--version-num",
        "1"
      ]);
      expect(text.exitCode).toBe(EXIT_USAGE_ERROR);
      expect(text.stderr).toContain("reextraction_completed is a system-only action");

      const json = await runCli([
        "review",
        "--task",
        "task-1",
        "--action",
        "reextraction_completed",
        "--version-num",
        "1",
        "--json"
      ]);
      expect(json.exitCode).toBe(EXIT_USAGE_ERROR);
      const env = JSON.parse(json.stderr ?? "{}");
      expect(env.error.code).toBe("command_conflict");
    });

    it("requires --candidate-version when requesting re-extraction", async () => {
      const res = await runCli([
        "review",
        "--task",
        "task-1",
        "--action",
        "request_re_extraction",
        "--version-num",
        "0"
      ]);
      expect(res.exitCode).toBe(EXIT_USAGE_ERROR);
      expect(res.stderr).toContain("--candidate-version is required");

      const json = await runCli([
        "review",
        "--task",
        "task-1",
        "--action",
        "request_re_extraction",
        "--version-num",
        "0",
        "--json"
      ]);
      expect(json.exitCode).toBe(EXIT_USAGE_ERROR);
      expect(JSON.parse(json.stderr ?? "{}").error.code).toBe("missing_candidate_version");
    });

    it("records a request_re_extraction action when both head versions are supplied", async () => {
      const composition = createStubComposition();
      const res = await runCli(
        [
          "review",
          "--task",
          "task-1",
          "--action",
          "request_re_extraction",
          "--version-num",
          "0",
          "--candidate-version",
          "1",
          "--actor",
          "human:operator"
        ],
        { composition }
      );
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      expect(res.stdout).toContain("Resolution action recorded");
    });

    it("records resolution action and handles optimistic concurrency conflict", async () => {
      const composition = createStubComposition();

      // First action at expected version 0 succeeds
      const res1 = await runCli(
        ["review", "--task", "task-1", "--action", "resolve", "--version-num", "0", "--rationale", "Verified manually"],
        { composition }
      );
      expect(res1.exitCode).toBe(EXIT_SUCCESS);
      expect(res1.stdout).toContain("Resolution action recorded");
      expect(res1.stdout).toContain("New Version:    1");

      // Second action at version 0 fails with version conflict (exit code 1)
      const res2 = await runCli(
        ["review", "--task", "task-1", "--action", "resolve", "--version-num", "0", "--json"],
        { composition }
      );
      expect(res2.exitCode).toBe(EXIT_DOMAIN_ERROR);
      const errEnv = JSON.parse(res2.stderr ?? "{}");
      expect(errEnv.error.code).toBe("version_conflict");
    });

    it("records proposal review decision", async () => {
      const composition = createStubComposition();
      const res = await runCli(
        ["review", "--proposal", "proposal-1", "--decision", "approve", "--version-num", "0"],
        { composition }
      );
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      expect(res.stdout).toContain("Review decision recorded");
    });

    it("rejects invalid decision", async () => {
      const res = await runCli(
        ["review", "--proposal", "proposal-1", "--decision", "maybe", "--version-num", "0"]
      );
      expect(res.exitCode).toBe(EXIT_USAGE_ERROR);
      expect(res.stderr).toContain("Must be 'approve' or 'reject'");
    });
  });

  describe("Packet Command", () => {
    it("requires candidate ID", async () => {
      const res = await runCli(["packet"]);
      expect(res.exitCode).toBe(EXIT_USAGE_ERROR);
      expect(res.stderr).toContain("Candidate ID is required");
    });

    it("inspects candidate packet in full format", async () => {
      const res = await runCli(["packet", "candidate-1"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      expect(res.stdout).toContain("RecruitOS Candidate Evaluation Packet: candidate-1");
      expect(res.stdout).toContain("Arithmetic Score Decomposition");
      expect(res.stdout).toContain("Confidence Inputs");
      expect(res.stdout).toContain("Quote resolution:   7/8");
      expect(res.stdout).toContain("Reasons (0):");
      expect(res.stdout).toContain("Evidence Spans");
      expect(res.stdout).toContain("Source Documents");
    });

    it("filters packet display by format", async () => {
      const resArith = await runCli(["packet", "candidate-1", "--format", "arithmetic"]);
      expect(resArith.exitCode).toBe(EXIT_SUCCESS);
      expect(resArith.stdout).toContain("Arithmetic Score Decomposition");
      expect(resArith.stdout).not.toContain("Source Documents");

      const resEvidence = await runCli(["packet", "candidate-1", "--format", "evidence"]);
      expect(resEvidence.exitCode).toBe(EXIT_SUCCESS);
      expect(resEvidence.stdout).toContain("Evidence Spans");
      expect(resEvidence.stdout).not.toContain("Arithmetic Score Decomposition");
    });

    it("prints result identity when the packet carries it", async () => {
      const res = await runCli(["packet", "candidate-1"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      expect(res.stdout).toContain("Result ID:    result-1");
      expect(res.stdout).toContain("Result kind:  initial");
    });

    it("outputs candidate packet in JSON envelope", async () => {
      const res = await runCli(["packet", "candidate-1", "--json"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      const env = JSON.parse(res.stdout ?? "{}");
      expect(env.ok).toBe(true);
      expect(env.data.candidateId).toBe("candidate-1");
      expect(env.data.arithmeticTerms.length).toBe(6);
    });

    it("returns EXIT_DOMAIN_ERROR for unknown candidate", async () => {
      const res = await runCli(["packet", "nonexistent-candidate"]);
      expect(res.exitCode).toBe(EXIT_DOMAIN_ERROR);
      expect(res.stderr).toContain("Candidate packet not found for ID: nonexistent-candidate");
    });
  });

  describe("Status Command", () => {
    it("displays system status summary", async () => {
      const res = await runCli(["status"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      expect(res.stdout).toContain("RecruitOS System Status");
      expect(res.stdout).toContain("Database:");
      expect(res.stdout).toContain("Schema Version:");
      expect(res.stdout).toContain("Corpus Sealed:");
    });

    it("includes recent audit events with --detailed", async () => {
      const res = await runCli(["status", "--detailed"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      expect(res.stdout).toContain("Recent Audit Events");
    });

    it("emits system status in JSON envelope", async () => {
      const res = await runCli(["status", "--detailed", "--json"]);
      expect(res.exitCode).toBe(EXIT_SUCCESS);
      const env = JSON.parse(res.stdout ?? "{}");
      expect(env.ok).toBe(true);
      expect(env.data.activeRunId).toBeDefined();
      expect(Array.isArray(env.data.recentAuditEvents)).toBe(true);
    });
  });

  describe("Custom Composition / Error Handling", () => {
    it("handles composition runtime failure cleanly", async () => {
      const failingComposition: RecruitosComposition = {
        importCandidates: async () => err({ code: "internal", message: "fail", retryable: false }),
        startTriage: async () => err({ code: "internal", message: "fail", retryable: false }),
        extractTriage: async () => err({ code: "internal", message: "fail", retryable: false }),
        finalizeTriage: async () => err({ code: "internal", message: "fail", retryable: false }),
        listCandidates: async () =>
          err({
            code: "internal_error",
            message: "Simulated SQLite database failure",
            retryable: false
          }),
        getCandidatePacket: async () => err({ code: "internal", message: "fail", retryable: false }),
        runTriage: async () => err({ code: "internal", message: "fail", retryable: false }),
        getStatus: async () => err({ code: "internal", message: "fail", retryable: false }),
        listResolutionTasks: async () => err({ code: "internal", message: "fail", retryable: false }),
        getResolutionTask: async () => err({ code: "internal", message: "fail", retryable: false }),
        recordResolutionAction: async () => err({ code: "internal", message: "fail", retryable: false }),
        listProposals: async () => err({ code: "internal", message: "fail", retryable: false }),
        recordReviewDecision: async () => err({ code: "internal", message: "fail", retryable: false }),
        listAuditEvents: async () => err({ code: "internal", message: "fail", retryable: false })
      };

      const res = await runCli(["triage"], { composition: failingComposition });
      expect(res.exitCode).toBe(EXIT_RUNTIME_ERROR);
      expect(res.stderr).toContain("Simulated SQLite database failure");
    });
  });
});
