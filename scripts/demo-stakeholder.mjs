#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTE_4_SOURCE_KEY = "demo/route-4-reviewable-failure";
const REQUEST_COMMAND_ID = "stakeholder-request-1";
const COMPLETE_COMMAND_ID = "stakeholder-complete-1";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repoRoot, "apps/cli/dist/bin.js");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const dbIndex = argv.indexOf("--db");
  if (dbIndex >= 0) {
    const database = argv[dbIndex + 1];
    if (!database) {
      fail("Usage: node scripts/demo-stakeholder.mjs --db <path>");
    }
    return { database, ownsDirectory: false };
  }
  const directory = mkdtempSync(join(tmpdir(), "recruitos-stakeholder."));
  return {
    database: join(directory, "runtime.db"),
    ownsDirectory: true,
    directory
  };
}

function runCli(database, args, { json = false } = {}) {
  if (!existsSync(cli)) {
    fail("CLI binary missing. Run corepack pnpm build first.");
  }
  const result = spawnSync(
    process.execPath,
    [cli, ...args, "--db", database, ...(json ? ["--json"] : [])],
    { encoding: "utf8", cwd: repoRoot }
  );
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    fail(`Command failed: recruitos ${args.join(" ")}`);
  }
  return result.stdout ?? "";
}

function runCliJson(database, args) {
  const stdout = runCli(database, args, { json: true });
  const envelope = JSON.parse(stdout);
  if (!envelope?.data) {
    fail(`JSON envelope missing data for: recruitos ${args.join(" ")}`);
  }
  return envelope.data;
}

function printSection(title, body) {
  process.stdout.write(`\n=== ${title} ===\n`);
  if (body.trim().length > 0) {
    process.stdout.write(`${body.trimEnd()}\n`);
  }
}

function scoreAsApproximateHundred(scoreText) {
  const parts = String(scoreText).split("/");
  if (parts.length !== 2) {
    fail(`Unexpected score text: ${scoreText}`);
  }
  const numerator = Number(parts[0]);
  const denominator = Number(parts[1]);
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator === 0) {
    fail(`Unexpected score text: ${scoreText}`);
  }
  return (numerator / denominator).toFixed(2);
}

function sqliteCount(database, table) {
  if (table !== "triage_run" && table !== "triage_run_member") {
    fail(`Refusing to count unknown table ${table}`);
  }
  const require = createRequire(join(repoRoot, "packages/runtime/package.json"));
  const Database = require("better-sqlite3");
  const db = new Database(database, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(`SELECT count(*) AS count FROM ${table}`).get();
    const count = Number(row?.count);
    if (!Number.isInteger(count)) {
      fail(`Unexpected count for ${table}`);
    }
    return count;
  } finally {
    db.close();
  }
}

function findRoute4(database, candidateIds) {
  for (const candidateId of candidateIds) {
    const packet = runCliJson(database, ["packet", candidateId]);
    if (packet.sourceKey === ROUTE_4_SOURCE_KEY) {
      return { candidateId, packet };
    }
  }
  fail(`No candidate found for ${ROUTE_4_SOURCE_KEY}`);
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.ownsDirectory) {
  process.on("exit", () => {
    rmSync(parsed.directory, { recursive: true, force: true });
  });
}

const { database } = parsed;

process.stdout.write("RecruitOS stakeholder demo\n");
process.stdout.write("Operator card: docs/operator-card-stakeholder-demo.md\n");
process.stdout.write(`Database: ${database}\n`);

const prepared = runCliJson(database, ["demo:prepare"]);
const route1Id = prepared.candidateIds?.[0];
if (!route1Id) {
  fail("demo:prepare did not return candidateIds[0]");
}

printSection(
  "Promise 1: explainable deterministic triage",
  "Route 1 is the scored packet. Class 1 checks the sealed arithmetic against the locked rubric."
);
printSection("Route 1 packet", runCli(database, ["packet", route1Id]));
printSection("Class 1", runCli(database, ["eval:class1", "--candidate-id", route1Id]));

const route4 = findRoute4(database, prepared.candidateIds);
printSection(
  "Promise 2: human-triggered correction with required review",
  [
    "Route 4 starts escalated. A human requests re-extraction.",
    "The fixture overlay simulates a corrected extraction response.",
    "The human action requests re-extraction but does not manually provide the extracted facts.",
    "Completion leaves review_required."
  ].join(" ")
);
printSection("Route 4 before correction", runCli(database, ["packet", route4.candidateId]));

printSection(
  "Open task",
  runCli(database, ["review", "--candidate", route4.candidateId])
);
const listed = runCliJson(database, ["review", "--candidate", route4.candidateId]);
const task = listed.tasks?.[0];
if (!task?.resolutionTaskId) {
  fail("review --candidate did not return an open resolution task");
}
if (task.status !== "open") {
  fail(`Expected an open task before correction, got ${task.status}`);
}

const requested = runCliJson(database, [
  "review",
  "--task",
  task.resolutionTaskId,
  "--action",
  "request_re_extraction",
  "--version-num",
  String(task.version),
  "--candidate-version",
  String(route4.packet.headVersion),
  "--actor",
  "human:operator",
  "--command-id",
  REQUEST_COMMAND_ID
]);
printSection(
  "Request re-extraction",
  [
    `Command ID:     ${requested.commandId}`,
    `Action ID:      ${requested.actionId}`,
    `Attempt ID:     ${requested.triageAttemptId}`,
    `Derived Status: ${requested.derivedStatus}`
  ].join("\n")
);
if (requested.commandId !== REQUEST_COMMAND_ID) {
  fail(`Expected command id ${REQUEST_COMMAND_ID}`);
}

printSection(
  "Fixture extraction",
  runCli(database, [
    "triage:extract",
    "--attempt",
    requested.triageAttemptId,
    "--demo-fixtures",
    "--correction-overlay"
  ])
);

printSection(
  "Complete correction",
  runCli(database, [
    "triage:complete-correction",
    "--attempt",
    requested.triageAttemptId,
    "--version-num",
    String(requested.newVersion),
    "--candidate-version",
    String(route4.packet.headVersion),
    "--command-id",
    COMPLETE_COMMAND_ID
  ])
);

const currentPacketText = runCli(database, ["packet", route4.candidateId]);
printSection("Route 4 current packet", currentPacketText);
if (!currentPacketText.includes("Outstanding review: required (review_required)")) {
  fail("Current packet does not show outstanding review_required");
}
if (!currentPacketText.includes("Result kind:  correction")) {
  fail("Current packet is not a correction result");
}

const originalPacketText = runCli(database, [
  "packet",
  route4.candidateId,
  "--result",
  route4.packet.resultId
]);
printSection("Route 4 original packet", originalPacketText);
if (!originalPacketText.includes("Inspecting: historical result")) {
  fail("Original packet does not identify itself as a historical result");
}
if (!originalPacketText.includes("current candidate work, not a decision on this historical result")) {
  fail("Original packet implies it owns the live review task");
}

printSection(
  "Resolution task",
  runCli(database, ["review", "--task", task.resolutionTaskId])
);

const runCount = sqliteCount(database, "triage_run");
const memberCount = sqliteCount(database, "triage_run_member");
printSection(
  "Final checks",
  [
    `triage_run count: ${runCount}`,
    `triage_run_member count: ${memberCount}`,
    "current packet outstanding review: review_required",
    "original packet remains inspectable"
  ].join("\n")
);

if (runCount !== 1) {
  fail(`Expected 1 triage_run, found ${runCount}`);
}
if (memberCount !== 7) {
  fail(`Expected 7 triage_run_member rows, found ${memberCount}`);
}

const route1Packet = runCliJson(database, ["packet", route1Id]);
const class1 = runCliJson(database, ["eval:class1", "--candidate-id", route1Id]);
const spansLocated = route1Packet.confidenceInput?.spansLocated;
const spansReturned = route1Packet.confidenceInput?.spansReturned;
if (route1Packet.status !== "scored") {
  fail(`Expected route 1 status scored, got ${route1Packet.status}`);
}
if (route1Packet.scoreText !== "467/6") {
  fail(`Expected route 1 score 467/6, got ${route1Packet.scoreText}`);
}
if (spansLocated !== 6 || spansReturned !== 6) {
  fail(`Expected route 1 evidence resolution 6/6, got ${spansLocated}/${spansReturned}`);
}
if (class1.passed !== true) {
  fail("Expected Class 1 to pass");
}

printSection(
  "Executive summary",
  [
    "Promise 1: PASS",
    "  Initial route-1 result: scored",
    `  Score: ${route1Packet.scoreText} (approximately ${scoreAsApproximateHundred(route1Packet.scoreText)}/100)`,
    `  Evidence resolution: ${spansLocated}/${spansReturned}`,
    "  Class 1: PASS (sealed arithmetic and evidence consistency check)",
    "Promise 2: PASS",
    "  Route 4: escalated -> human-requested re-extraction -> correction/scored",
    "  Human review after correction: review_required",
    "  Original result preserved: yes",
    `  Run integrity: ${runCount} triage run and ${memberCount} members`
  ].join("\n")
);

process.stdout.write("\nStakeholder demo checks passed.\n");
