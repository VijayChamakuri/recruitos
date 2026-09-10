#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repoRoot, "apps/cli/dist/bin.js");
const dbIndex = process.argv.indexOf("--db");
const suppliedDatabase = dbIndex >= 0 ? process.argv[dbIndex + 1] : undefined;
if (dbIndex >= 0 && !suppliedDatabase) fail("Usage: node scripts/demo-proposals.mjs --db <path>");
const directory = suppliedDatabase ? undefined : mkdtempSync(join(tmpdir(), "recruitos-proposals."));
const database = suppliedDatabase ?? join(directory, "runtime.db");

if (directory) {
  process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(args) {
  if (!existsSync(cli)) fail("CLI binary missing. Run corepack pnpm build first.");
  const result = spawnSync(process.execPath, [cli, ...args, "--db", database, "--json"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) fail(result.stderr || result.stdout || `Command failed: ${args[0]}`);
  const envelope = JSON.parse(result.stdout);
  if (!envelope?.data) fail(`JSON envelope missing data for ${args[0]}`);
  return envelope.data;
}

function decide(proposalId, decisionArgs) {
  return run([
    "review",
    "--proposal",
    proposalId,
    "--version-num",
    "0",
    "--actor",
    "human:operator",
    ...decisionArgs
  ]);
}

run(["demo:prepare"]);
const seeded = run(["demo:proposals", "--command-id", "demo-proposal-seed-1"]);
if (seeded.proposals?.length !== 3) fail("Expected three fixture proposals");

const [shortlist, stage, followUp] = seeded.proposals;
const approved = decide(shortlist.proposalId, ["--decision", "approve"]);
const edited = decide(stage.proposalId, [
  "--decision",
  "edit",
  "--edited-payload",
  JSON.stringify({ kind: "ats_stage_change", targetStage: "Technical interview" })
]);
const rejected = decide(followUp.proposalId, [
  "--decision",
  "reject",
  "--rationale",
  "Request this evidence only after recruiter review."
]);

const listed = run(["review"]);
const statusById = new Map(listed.proposals.map((proposal) => [proposal.proposalId, proposal.status]));
if (
  approved.status !== "approved" ||
  edited.status !== "edited" ||
  rejected.status !== "rejected" ||
  statusById.get(shortlist.proposalId) !== "approved" ||
  statusById.get(stage.proposalId) !== "edited" ||
  statusById.get(followUp.proposalId) !== "rejected"
) {
  fail("Proposal decisions did not persist through the real review use case");
}

const require = createRequire(join(repoRoot, "packages/runtime/package.json"));
const Database = require("better-sqlite3");
const db = new Database(database, { readonly: true, fileMustExist: true });
const runCount = Number(db.prepare("SELECT COUNT(*) AS count FROM triage_run").get().count);
const memberCount = Number(db.prepare("SELECT COUNT(*) AS count FROM triage_run_member").get().count);
const runKind = db.prepare("SELECT kind FROM triage_run").get()?.kind;
db.close();
if (runCount !== 1 || memberCount !== 7 || runKind !== "variant") {
  fail("Proposal demo changed triage run integrity");
}

process.stdout.write(
  [
    "RecruitOS proposal demo: PASS",
    `Approve: ${shortlist.sourceKey} -> ${approved.status}`,
    `Edit: ${stage.sourceKey} -> ${edited.status}`,
    `Reject: ${followUp.sourceKey} -> ${rejected.status}`,
    `Run integrity: ${runCount} variant triage run and ${memberCount} members`,
    "NO OUTBOUND EFFECT",
    "Fixture extraction and explicitly authored synthetic proposals only."
  ].join("\n") + "\n"
);
