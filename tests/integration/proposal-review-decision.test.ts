import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runImmediateTransaction } from "../../packages/runtime/src/commands/index.js";
import {
  createRuntime,
  demoCompositionOptions,
  type RuntimeComposition
} from "../../packages/runtime/src/composition/index.js";
import { insertProposal, prepareProposal } from "../../packages/runtime/src/proposals/index.js";
import { listProposals } from "../../packages/runtime/src/read-models/index.js";
import { demoPrepare } from "../../packages/runtime/src/use-cases/demo-prepare.js";
import { recordReviewDecision } from "../../packages/runtime/src/use-cases/record-review-decision.js";
import { MIGRATIONS_FOLDER } from "./harness/database.js";
import { unwrap } from "./harness/results.js";

const temporaryDirectories: string[] = [];
const HUMAN_ACTOR_ID = "human:operator";
const SCORED_SOURCE_KEY = "demo/route-1-scored";

function nativeClient(runtime: RuntimeComposition): {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
  };
} {
  return (runtime.connection.database as unknown as { $client: ReturnType<typeof nativeClient> })
    .$client;
}

async function demoRuntime(): Promise<RuntimeComposition> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-proposal-decision-integration-"));
  temporaryDirectories.push(directory);
  return unwrap(
    createRuntime(
      demoCompositionOptions({
        database: { filename: join(directory, "runtime.db"), migrationsFolder: MIGRATIONS_FOLDER }
      })
    )
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("proposal review decision integration", () => {
  it("approves a current-head proposal, lists it as approved, and performs no outbound I/O", async () => {
    const runtime = await demoRuntime();
    unwrap(await demoPrepare(runtime));
    const current = nativeClient(runtime)
      .prepare(
        `SELECT h.current_result_id AS resultId
         FROM candidate c
         JOIN candidate_head h ON h.candidate_id = c.candidate_id
         WHERE c.source_key = ?`
      )
      .get(SCORED_SOURCE_KEY) as { resultId: string };
    unwrap(
      runImmediateTransaction(runtime.connection, (context) => {
        const prepared = prepareProposal({
          proposalId: "proposal-live-1",
          candidateResultId: current.resultId,
          proposalOrdinal: 0,
          payload: {
            kind: "follow_up_draft",
            body: "Ask for a work-authorization document."
          },
          evidenceSpans: [],
          createdAt: 1_788_700_000_000
        });
        if (!prepared.ok) {
          return prepared;
        }
        return insertProposal(context, prepared.value);
      })
    );

    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const before = unwrap(listProposals(runtime.connection.database, { status: "pending" }));
    expect(before.items.map((item) => item.proposalId)).toEqual(["proposal-live-1"]);
    const decided = unwrap(
      recordReviewDecision(runtime, {
        actorId: HUMAN_ACTOR_ID,
        proposalId: "proposal-live-1",
        expectedVersion: 0,
        decision: { kind: "approve" },
        commandId: "integration-approve-1"
      })
    );
    expect(decided.result).toEqual({
      decisionId: expect.any(String),
      newVersion: 1,
      status: "approved"
    });
    const approved = unwrap(listProposals(runtime.connection.database, { status: "approved" }));
    expect(approved.items.map((item) => item.proposalId)).toEqual(["proposal-live-1"]);
    const pending = unwrap(listProposals(runtime.connection.database, { status: "pending" }));
    expect(pending.items).toEqual([]);
    const replay = unwrap(
      recordReviewDecision(runtime, {
        actorId: HUMAN_ACTOR_ID,
        proposalId: "proposal-live-1",
        expectedVersion: 0,
        decision: { kind: "approve" },
        commandId: "integration-approve-1"
      })
    );
    expect(replay.metadata.replayed).toBe(true);
    expect(replay.result).toEqual(decided.result);
    const decisionCount = nativeClient(runtime)
      .prepare("SELECT count(*) AS n FROM review_decision")
      .get() as { n: number };
    expect(decisionCount.n).toBe(1);
    const original = nativeClient(runtime)
      .prepare("SELECT payload_json AS payloadJson FROM proposal WHERE proposal_id = ?")
      .get("proposal-live-1") as { payloadJson: string };
    expect(JSON.parse(original.payloadJson)).toEqual({
      kind: "follow_up_draft",
      body: "Ask for a work-authorization document."
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    unwrap(runtime.close());
  });
});
