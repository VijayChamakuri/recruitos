import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { type Result } from "@recruitos/core";

import { createRuntime, demoCompositionOptions, type RuntimeComposition } from "../composition/index.js";
import type { RuntimeError } from "../errors/index.js";
import { listProposals } from "../read-models/index.js";
import { demoPrepare } from "./demo-prepare.js";
import { recordReviewDecision } from "./record-review-decision.js";
import { seedDemoProposals } from "./seed-demo-proposals.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
const temporaryDirectories: string[] = [];

function unwrap<T>(result: Result<T, RuntimeError>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function runtime(): Promise<RuntimeComposition> {
  const directory = await mkdtemp(join(tmpdir(), "recruitos-demo-proposals-"));
  temporaryDirectories.push(directory);
  return unwrap(
    createRuntime(
      demoCompositionOptions({
        database: { filename: join(directory, "runtime.db"), migrationsFolder }
      })
    )
  );
}

function client(composition: RuntimeComposition): {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): unknown;
  };
} {
  return (composition.connection.database as unknown as { $client: ReturnType<typeof client> }).$client;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("seedDemoProposals", () => {
  it("seeds three evidenced pending proposals and proves approve, edit, and reject", async () => {
    const composition = await runtime();
    unwrap(await demoPrepare(composition));

    const execution = unwrap(seedDemoProposals(composition, { commandId: "demo-proposals-1" }));
    expect(execution.result).toMatchObject({ triageRunCount: 1, triageRunMemberCount: 7 });
    expect(execution.result.proposals.map((proposal) => proposal.kind)).toEqual([
      "shortlist_inclusion",
      "ats_stage_change",
      "follow_up_draft"
    ]);
    expect(unwrap(listProposals(composition.connection.database)).items).toHaveLength(3);

    const [shortlist, stage, followUp] = execution.result.proposals;
    expect(
      unwrap(
        recordReviewDecision(composition, {
          actorId: "human:operator",
          proposalId: shortlist!.proposalId,
          expectedVersion: 0,
          decision: { kind: "approve" }
        })
      ).result.status
    ).toBe("approved");
    expect(
      unwrap(
        recordReviewDecision(composition, {
          actorId: "human:operator",
          proposalId: stage!.proposalId,
          expectedVersion: 0,
          decision: {
            kind: "edit",
            editedPayload: { kind: "ats_stage_change", targetStage: "Technical interview" }
          }
        })
      ).result.status
    ).toBe("edited");
    expect(
      unwrap(
        recordReviewDecision(composition, {
          actorId: "human:operator",
          proposalId: followUp!.proposalId,
          expectedVersion: 0,
          decision: { kind: "reject", rationale: "Wait for recruiter review." }
        })
      ).result.status
    ).toBe("rejected");

    const rows = unwrap(listProposals(composition.connection.database)).items;
    expect(rows.map((proposal) => proposal.status)).toEqual(["approved", "edited", "rejected"]);
    expect(
      client(composition).prepare("SELECT COUNT(*) AS count FROM triage_run").get()
    ).toEqual({ count: 1 });
    expect(
      client(composition).prepare("SELECT COUNT(*) AS count FROM triage_run_member").get()
    ).toEqual({ count: 7 });
    expect(
      client(composition)
        .prepare("SELECT COUNT(*) AS count FROM proposal_evidence_span")
        .get()
    ).toEqual({ count: 3 });
    unwrap(composition.close());
  });

  it("replays one command and rejects a second fixture seed", async () => {
    const composition = await runtime();
    unwrap(await demoPrepare(composition));
    const first = unwrap(seedDemoProposals(composition, { commandId: "demo-proposals-replay" }));
    const replay = unwrap(seedDemoProposals(composition, { commandId: "demo-proposals-replay" }));
    expect(replay.result).toEqual(first.result);
    expect(seedDemoProposals(composition)).toMatchObject({
      ok: false,
      error: { code: "command_conflict" }
    });
    unwrap(composition.close());
  });

  it("fails closed outside the exact synthetic demo shape", async () => {
    const empty = await runtime();
    expect(seedDemoProposals(empty)).toMatchObject({
      ok: false,
      error: { message: "Demo proposals require the prepared synthetic demo database" }
    });
    unwrap(empty.close());

    const altered = await runtime();
    unwrap(await demoPrepare(altered));
    client(altered).prepare("DROP TRIGGER IF EXISTS triage_run_reject_update").run();
    client(altered).prepare("UPDATE triage_run SET kind = 'main'").run();
    expect(seedDemoProposals(altered)).toMatchObject({
      ok: false,
      error: { message: "Demo proposals require one seven-member variant run" }
    });
    unwrap(altered.close());

    const missingTarget = await runtime();
    unwrap(await demoPrepare(missingTarget));
    client(missingTarget).prepare("DROP TRIGGER IF EXISTS candidate_reject_update").run();
    client(missingTarget)
      .prepare("UPDATE candidate SET source_key = 'demo/route-1-renamed' WHERE source_key = 'demo/route-1-scored'")
      .run();
    expect(seedDemoProposals(missingTarget)).toMatchObject({
      ok: false,
      error: { message: /is not a sealed evidenced result/ }
    });
    unwrap(missingTarget.close());
  });

  it("requires the system actor and validates an explicit command id", async () => {
    const composition = await runtime();
    expect(seedDemoProposals(composition, { actorId: "human:operator" })).toMatchObject({
      ok: false,
      error: { message: "Demo proposal seeding is a system-only action" }
    });
    expect(seedDemoProposals(composition, { actorId: "has space" })).toMatchObject({
      ok: false,
      error: { message: "Demo proposal seeding is a system-only action" }
    });
    expect(seedDemoProposals(composition, { commandId: "has space" })).toMatchObject({
      ok: false,
      error: { message: "Demo proposal seeding requires a valid command id" }
    });
    unwrap(composition.close());
  });

  it("validates its public composition and input boundary", () => {
    expect(seedDemoProposals(null as never)).toMatchObject({
      ok: false,
      error: { message: "Invalid runtime composition" }
    });
    expect(seedDemoProposals({ connection: null } as never)).toMatchObject({
      ok: false,
      error: { message: "Invalid runtime composition" }
    });
    expect(
      seedDemoProposals({ connection: {}, clock: null, idGenerator: {} } as never)
    ).toMatchObject({ ok: false, error: { message: "Invalid runtime composition" } });
    expect(
      seedDemoProposals({ connection: {}, clock: {}, idGenerator: {} } as never)
    ).toMatchObject({ ok: false, error: { message: "Invalid runtime composition" } });
    expect(
      seedDemoProposals({ connection: {}, clock: { now: () => 1 }, idGenerator: null } as never)
    ).toMatchObject({ ok: false, error: { message: "Invalid runtime composition" } });
    expect(
      seedDemoProposals({ connection: {}, clock: { now: () => 1 }, idGenerator: {} } as never)
    ).toMatchObject({ ok: false, error: { message: "Invalid runtime composition" } });
    expect(
      seedDemoProposals(
        {
          connection: {},
          clock: { now: () => 1 },
          idGenerator: { next: () => "command-1" }
        } as never,
        null as never
      )
    ).toMatchObject({ ok: false, error: { message: "Invalid demo proposal input" } });
  });
});
