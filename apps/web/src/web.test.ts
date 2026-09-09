import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCompositionFromRuntime,
  RuntimeRecruitosComposition
} from "@recruitos/cli";
import { createRuntime, demoCompositionOptions } from "@recruitos/runtime/composition";
import { DEFAULT_APPEARANCE } from "./appearance.js";
import {
  escapeHtml,
  validateSpanContent,
  validateSpanInterval
} from "./components/safe-text.js";
import { renderSpanHighlight, renderAnnotatedDocument } from "./components/span-highlight.js";
import { renderSpanIntegrityFailure } from "./components/span-integrity-failure.js";
import { renderEvidenceGapCard } from "./components/evidence-gap-card.js";
import { coverageCellsForPacket } from "./components/evidence-coverage-strip.js";
import { renderInstrumentBand } from "./components/instrument-band.js";
import { renderGlobalBar } from "./components/global-bar.js";
import { renderNavigationRail } from "./components/navigation-rail.js";
import { renderCandidatePacketView } from "./components/candidate-packet.js";
import { handleRequest } from "./server/handlers.js";
import {
  getServerComposition,
  openExplicitDatabaseComposition,
  resetServerComposition,
  setServerComposition
} from "./server/composition.js";
import { parseWebServerOptions } from "./server/options.js";
import { TEST_IDS } from "./testids.js";

describe("Web Safe Text & Interval Validation", () => {
  it("escapes dangerous HTML characters", () => {
    const raw = '<script>alert("xss & \'danger\'")</script>';
    const escaped = escapeHtml(raw);
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).toContain("&amp;");
    expect(escaped).toContain("&quot;");
    expect(escaped).toContain("&#039;");
  });

  it("validates interval bounds", () => {
    const text = "Hello world";
    expect(validateSpanInterval(text, 0, 5).ok).toBe(true);
    expect(validateSpanInterval(text, -1, 5).ok).toBe(false);
    expect(validateSpanInterval(text, 0, 20).ok).toBe(false);
    expect(validateSpanInterval(text, 5, 2).ok).toBe(false);
  });

  it("detects and rejects surrogate pair splitting", () => {
    const textWithSurrogate = "Launch 🚀 now!";
    expect(validateSpanInterval(textWithSurrogate, 7, 9).ok).toBe(true);
    const splitCheck = validateSpanInterval(textWithSurrogate, 8, 9);
    expect(splitCheck.ok).toBe(false);
    expect(splitCheck.reason).toContain("surrogate pair");
  });

  it("validates span content match", () => {
    const doc = "Alex designed a distributed query engine";
    expect(validateSpanContent(doc, 0, 4, "Alex").ok).toBe(true);
    const mismatch = validateSpanContent(doc, 0, 4, "Bob");
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toContain("mismatch");
  });
});

describe("Span Highlight & Refusal Components", () => {
  it("renders supporting highlight with mark.sup", () => {
    const html = renderSpanHighlight({
      text: "distributed query engine",
      polarity: "supporting",
      dimensionId: "system_architecture"
    });
    expect(html).toContain('<mark class="sup"');
    expect(html).toContain('data-polarity="supporting"');
    expect(html).toContain('data-dimension="system_architecture"');
    expect(html).toContain("distributed query engine");
  });

  it("renders contradicting highlight with mark.con and 45-degree hatch underlay class", () => {
    const html = renderSpanHighlight({
      text: "contradicting tenure statement",
      polarity: "contradicting"
    });
    expect(html).toContain('<mark class="con"');
    expect(html).toContain('data-polarity="contradicting"');
  });

  it("renders span integrity failure designed state", () => {
    const html = renderSpanIntegrityFailure({
      reason: "Span hash mismatch",
      spanId: "span-corrupt"
    });
    expect(html).toContain('class="span-refused"');
    expect(html).toContain('role="status"');
    expect(html).toContain("span integrity failed, highlight refused");
    expect(html).toContain('data-reason="Span hash mismatch"');
  });

  it("annotates document and substitutes span integrity failure on corrupt spans", () => {
    const doc = "Engineer led incident response across squads.";
    const validSpan = {
      evidenceSpanId: "span-1",
      dimensionId: "evaluation",
      start: 9,
      end: 30,
      quotedText: "led incident response",
      polarity: "supporting" as const,
      matchQuality: "exact" as const,
      documentId: "doc-1"
    };
    const corruptSpan = {
      evidenceSpanId: "span-2",
      dimensionId: "evaluation",
      start: 31,
      end: 44,
      quotedText: "CORRUPT TEXT HERE",
      polarity: "contradicting" as const,
      matchQuality: "exact" as const,
      documentId: "doc-1"
    };

    const rendered = renderAnnotatedDocument(doc, [validSpan, corruptSpan]);
    expect(rendered).toContain('<mark class="sup"');
    expect(rendered).toContain("led incident response");
    expect(rendered).toContain("span integrity failed, highlight refused");
    expect(rendered).toContain('class="span-refused"');
  });
});

describe("Evidence Gap & UI Readout Components", () => {
  it("renders evidence gap card with bracket gap styling", () => {
    const html = renderEvidenceGapCard({
      dimensionId: "system_architecture",
      reason: "No evidence of multi-region consensus deployment"
    });
    expect(html).toContain('class="bracket gap"');
    expect(html).toContain("Evidence Gap &middot; system_architecture");
    expect(html).toContain("No evidence of multi-region consensus deployment");
  });

  it("renders an honest unavailable coverage strip when the packet is missing", () => {
    const cells = coverageCellsForPacket(null);
    expect(cells.every((cell) => cell === "unavailable")).toBe(true);
  });

  it("renders global bar with SYNTHETIC DATA pill and no invented task counts", () => {
    const html = renderGlobalBar({
      appearance: DEFAULT_APPEARANCE,
      roleTitle: "Applied AI Engineer"
    });
    expect(html).toContain('class="pill-synthetic"');
    expect(html).toContain("SYNTHETIC DATA");
    expect(html).not.toContain("Synthetic data");
    expect(html).toContain("RecruitOS");
    expect(html).toContain("Applied AI Engineer");
    expect(html).not.toContain("41 open tasks");
    expect(html).not.toContain("run-7 sealed");
  });

  it("renders navigation rail with 5 locked destinations and no fabricated 140-row counts", () => {
    const html = renderNavigationRail({
      activeDestination: "triage",
      appearance: DEFAULT_APPEARANCE,
      candidateCount: 7,
      openTasksCount: 2
    });
    expect(html).toContain("Triage Queue");
    expect(html).toContain("Resolution Queue");
    expect(html).toContain("Candidate Packet");
    expect(html).toContain("Audit Timeline");
    expect(html).toContain("System Status");
    expect(html).toContain('class="item active"');
    expect(html).not.toContain(">140<");
    expect(html).not.toContain(">1842<");
  });
});

describe("Server options and explicit database", () => {
  it("does not fall back to a stub composition when unconfigured", async () => {
    resetServerComposition();
    const result = getServerComposition();
    expect(result.ok).toBe(false);
    const page = await handleRequest("/triage", new URLSearchParams());
    expect(page.statusCode).toBe(503);
    expect(page.body).toContain("Database unavailable");
  });

  it("refuses to start without --db or DATABASE_PATH", () => {
    const parsed = parseWebServerOptions([], {});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("implicit stub");
  });

  it("reads --db and --port", () => {
    const parsed = parseWebServerOptions(["--db", "/tmp/runtime.db", "--port", "4010"], {});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.databasePath).toBe("/tmp/runtime.db");
    expect(parsed.value.port).toBe(4010);
    expect(parsed.value.host).toBe("127.0.0.1");
  });

  it("fails closed when the explicit database file is missing", () => {
    const result = openExplicitDatabaseComposition(join(tmpdir(), "recruitos-missing-db.sqlite"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("database_not_found");
  });

  it("fails closed when the explicit path is not a file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recruitos-web-not-a-file-"));
    try {
      const result = openExplicitDatabaseComposition(directory);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("not a file");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Prepared seven-candidate demo composition", () => {
  let databasePath = "";
  let tempDir = "";

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "recruitos-web-demo-"));
    databasePath = join(tempDir, "runtime.db");
    const runtime = createRuntime(demoCompositionOptions({ database: { filename: databasePath } }));
    if (!runtime.ok) {
      throw new Error(runtime.error.message);
    }
    const composition = createCompositionFromRuntime(runtime.value, databasePath);
    if (!composition.prepareDemo) {
      throw new Error("prepareDemo is required for web presenter tests");
    }
    const prepared = await composition.prepareDemo({});
    if (!prepared.ok) {
      throw new Error(prepared.error.message);
    }
    setServerComposition(composition);
  }, 120_000);

  afterAll(async () => {
    const composition = getServerComposition();
    if (composition.ok && composition.value instanceof RuntimeRecruitosComposition) {
      composition.value.runtime.close();
    }
    resetServerComposition();
    if (tempDir.length > 0) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not use the stub candidate-1 records", async () => {
    const composition = getServerComposition();
    expect(composition.ok).toBe(true);
    if (!composition.ok) return;
    const missing = await composition.value.getCandidatePacket("candidate-1");
    expect(missing.ok).toBe(false);
  });

  it("lists seven real demo candidates including scored, escalated, and rejected_hard_requirement", async () => {
    const composition = getServerComposition();
    expect(composition.ok).toBe(true);
    if (!composition.ok) return;
    const listed = await composition.value.listCandidates({ limit: 50 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(7);
    const statuses = new Set(listed.value.map((candidate) => candidate.status));
    expect(statuses.has("scored")).toBe(true);
    expect(statuses.has("escalated")).toBe(true);
    expect(statuses.has("rejected_hard_requirement")).toBe(true);
    expect(listed.value.some((candidate) => candidate.sourceKey === "demo/route-1-scored")).toBe(
      true
    );
    expect(
      listed.value.some((candidate) => candidate.sourceKey === "demo/route-4-reviewable-failure")
    ).toBe(true);
  });

  it("records fixture extraction runs and zero live provider rows", () => {
    const composition = getServerComposition();
    expect(composition.ok).toBe(true);
    if (!composition.ok) return;
    expect(composition.value).toBeInstanceOf(RuntimeRecruitosComposition);
    const runtime = (composition.value as RuntimeRecruitosComposition).runtime;
    const native = (
      runtime.connection.database as {
        $client: {
          prepare: (sql: string) => { get: () => { total: number; live: number } };
        };
      }
    ).$client;
    const row = native
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN fixture_key IS NULL OR fixture_key = '' THEN 1 ELSE 0 END) AS live
         FROM extraction_run`
      )
      .get();
    expect(row.total).toBeGreaterThan(0);
    expect(Number(row.live ?? 0)).toBe(0);
  });

  it("renders 6-cell instrument band from real status", async () => {
    const composition = getServerComposition();
    expect(composition.ok).toBe(true);
    if (!composition.ok) return;
    const status = (await composition.value.getStatus()).value!;
    const html = renderInstrumentBand({
      status,
      appearance: DEFAULT_APPEARANCE,
      inboundCount: 7,
      sourcedCount: 0,
      scoredCount: 2,
      outstandingTaskCount: 1,
      corpusSublabel: "seven-candidate proving corpus"
    });
    expect(html).toContain('class="band"');
    expect(html).toContain('data-testid="instrument-band"');
    expect(html).toContain("Run");
    expect(html).toContain("Corpus");
    expect(html).toContain("Routed to humans");
    expect(html).toContain("Scored");
    expect(html).not.toContain("cut at 62.9");
  });

  it("renders the route-1 packet with visible arithmetic and no header score badge", async () => {
    const composition = getServerComposition();
    expect(composition.ok).toBe(true);
    if (!composition.ok) return;
    const listed = await composition.value.listCandidates({ limit: 50 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const route1 = listed.value.find((candidate) => candidate.sourceKey === "demo/route-1-scored");
    expect(route1).toBeDefined();
    if (!route1) return;
    const packet = (await composition.value.getCandidatePacket(route1.candidateId)).value!;
    const html = renderCandidatePacketView({ packet, appearance: DEFAULT_APPEARANCE });
    expect(html).toContain('data-testid="pane-arithmetic"');
    expect(html).toContain('data-testid="pane-ledger"');
    expect(html).toContain('data-testid="pane-source"');
    expect(html).toContain("467/6");
    expect(html).toContain("Inspecting: current head");
    expect(html).toContain("SYNTHETIC DATA");
    expect(html).toContain("Return to triage queue");
    const header = html.slice(0, html.indexOf('data-testid="candidate-packet-view"'));
    expect(header).not.toContain("/ 100");
    expect(header).not.toContain("Overall Score");
  });

  it("serves tokens.css without a composition", async () => {
    const res = await handleRequest("/tokens.css", new URLSearchParams());
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/css");
    expect(res.body).toContain("--surface-paper");
    expect(res.body).toContain("--support");
    expect(res.body).toContain("--contradict");
  });

  it("renders the triage queue with seven candidates and SYNTHETIC DATA", async () => {
    const res = await handleRequest("/triage", new URLSearchParams());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Triage Queue");
    expect(res.body).toContain("SYNTHETIC DATA");
    expect(res.body).toContain("demo/route-1-scored");
    expect(res.body).toContain("demo/route-4-reviewable-failure");
    expect(res.body).toContain("rejected_hard_requirement");
    expect(res.body).toContain("data-testid=\"instrument-band\"");
    expect((res.body.match(/data-testid="candidate-row"/g) ?? []).length).toBe(7);
    expect(res.body).not.toContain("candidate-1");
  });

  it("falls back to default appearance for invalid query values", async () => {
    const res = await handleRequest(
      "/triage",
      new URLSearchParams("theme=neon&density=huge")
    );
    expect(res.body).toContain('data-theme="light"');
    expect(res.body).toContain('data-density="default"');
  });

  it("preserves dark compact appearance on packet links", async () => {
    const res = await handleRequest(
      "/triage",
      new URLSearchParams("theme=dark&density=compact")
    );
    expect(res.body).toContain('data-theme="dark"');
    expect(res.body).toContain('data-density="compact"');
    expect(res.body).toContain("theme=dark");
    expect(res.body).toContain("density=compact");
  });

  it("renders the route-1 packet route with real arithmetic and evidence", async () => {
    const listed = await handleRequest("/api/candidates", new URLSearchParams());
    const candidates = JSON.parse(listed.body) as Array<{
      candidateId: string;
      sourceKey: string;
    }>;
    const route1 = candidates.find((candidate) => candidate.sourceKey === "demo/route-1-scored");
    expect(route1).toBeDefined();
    if (!route1) return;
    const res = await handleRequest(`/packet/${route1.candidateId}`, new URLSearchParams());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("467/6");
    expect(res.body).toContain("scored");
    expect(res.body).toContain("data-testid=\"pane-arithmetic\"");
    expect(res.body).toContain("data-testid=\"pane-source\"");
    expect(res.body).toContain("Inspecting: current head");
    expect(res.body).toContain("SYNTHETIC DATA");
  });

  it("renders the route-4 packet as escalated with assessment_unavailable and an open task", async () => {
    const listed = await handleRequest("/api/candidates", new URLSearchParams());
    const candidates = JSON.parse(listed.body) as Array<{
      candidateId: string;
      sourceKey: string;
    }>;
    const route4 = candidates.find(
      (candidate) => candidate.sourceKey === "demo/route-4-reviewable-failure"
    );
    expect(route4).toBeDefined();
    if (!route4) return;
    const res = await handleRequest(`/packet/${route4.candidateId}`, new URLSearchParams());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("escalated");
    expect(res.body).toContain("assessment_unavailable");
    expect(res.body).toContain("unavailable");
    expect(res.body).toContain("open");
    expect(res.body).toContain(`data-testid="${TEST_IDS.PACKET_TASKS}"`);
  });

  it("returns the typed not-found page for an unknown candidate", async () => {
    const res = await handleRequest("/packet/nonexistent", new URLSearchParams());
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("Candidate Packet Not Found");
    expect(res.body).toContain(`data-testid="${TEST_IDS.PACKET_NOT_FOUND}"`);
  });

  it("renders Resolution Queue at /review without stub proposals", async () => {
    const res = await handleRequest("/review", new URLSearchParams());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Human Resolution Queue");
    expect(res.body).toContain("Resolution Tasks");
    expect(res.body).not.toContain("prop-1");
  });

  it("renders Audit Timeline as an honest deferred state", async () => {
    const res = await handleRequest("/runs", new URLSearchParams());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Audit Timeline");
    expect(res.body).toContain("deferred");
  });

  it("renders System Status without invented limitation bullets", async () => {
    const res = await handleRequest("/status", new URLSearchParams());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("System Status &amp; Trust Center");
    expect(res.body).toContain("Corpus Seal Verification");
    expect(res.body).not.toContain("Seniority level inference requires external confirmation");
  });

  it("returns JSON at /api/candidates and /api/status", async () => {
    const candRes = await handleRequest("/api/candidates", new URLSearchParams());
    expect(candRes.statusCode).toBe(200);
    const candidates = JSON.parse(candRes.body);
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates).toHaveLength(7);

    const statusRes = await handleRequest("/api/status", new URLSearchParams());
    expect(statusRes.statusCode).toBe(200);
    const status = JSON.parse(statusRes.body);
    expect(status.activeRunId).toBeDefined();
  });

  it("returns 404 for unknown route", async () => {
    const res = await handleRequest("/nonexistent-page", new URLSearchParams());
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("404 Page Not Found");
  });

  it("does not create an empty database when an explicit missing path is supplied", async () => {
    const missing = join(tempDir, "does-not-exist.db");
    const opened = openExplicitDatabaseComposition(missing);
    expect(opened.ok).toBe(false);
    await writeFile(join(tempDir, "probe.txt"), "ok");
    expect(opened.ok).toBe(false);
  });
});
