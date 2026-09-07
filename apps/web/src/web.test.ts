import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  validateSpanContent,
  validateSpanInterval
} from "./components/safe-text.js";
import { renderSpanHighlight, renderAnnotatedDocument } from "./components/span-highlight.js";
import { renderSpanIntegrityFailure } from "./components/span-integrity-failure.js";
import { renderEvidenceGapCard } from "./components/evidence-gap-card.js";
import { renderInstrumentBand } from "./components/instrument-band.js";
import { renderGlobalBar } from "./components/global-bar.js";
import { renderNavigationRail } from "./components/navigation-rail.js";
import { renderCandidatePacketView } from "./components/candidate-packet.js";
import { handleRequest } from "./server/handlers.js";
import { getServerComposition } from "./server/composition.js";

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
    // Emoji 🚀 is encoded as surrogate pair: \uD83D\uDE80 (2 code units)
    const textWithSurrogate = "Launch 🚀 now!";
    // "Launch " is 7 chars, emoji is indices 7 and 8
    expect(validateSpanInterval(textWithSurrogate, 7, 9).ok).toBe(true);
    // Index 8 is between high and low surrogate
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
    // Valid span rendered as mark.sup
    expect(rendered).toContain('<mark class="sup"');
    expect(rendered).toContain("led incident response");
    // Corrupt span replaced by designed integrity refusal
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

  it("renders 6-cell instrument band with tabular numbers and no cards", async () => {
    const composition = getServerComposition();
    const status = (await composition.getStatus()).value!;
    const html = renderInstrumentBand({ status });

    expect(html).toContain('class="band"');
    expect(html).toContain("data-testid=\"instrument-band\"");
    expect(html).toContain("Run");
    expect(html).toContain("Corpus");
    expect(html).toContain("Routed to humans");
    expect(html).toContain("Shortlist");
    expect(html).toContain("Awaiting approval");
    expect(html).toContain("Known limitations");
  });

  it("renders global bar with synthetic data pill", () => {
    const html = renderGlobalBar({ roleTitle: "Applied AI Engineer" });
    expect(html).toContain('class="pill-synthetic"');
    expect(html).toContain("Synthetic data");
    expect(html).toContain("RecruitOS");
    expect(html).toContain("Applied AI Engineer");
  });

  it("renders navigation rail with 5 locked destinations", () => {
    const html = renderNavigationRail({ activeDestination: "triage" });
    expect(html).toContain("Triage Queue");
    expect(html).toContain("Resolution Queue");
    expect(html).toContain("Candidate Packet");
    expect(html).toContain("Audit Timeline");
    expect(html).toContain("System Status");
    expect(html).toContain('class="item active"');
  });
});

describe("Candidate Packet 3-Pane View", () => {
  it("renders 3 panes at declared surface values", async () => {
    const composition = getServerComposition();
    const packet = (await composition.getCandidatePacket("candidate-1")).value!;
    const html = renderCandidatePacketView({ packet });

    expect(html).toContain('data-testid="pane-arithmetic"');
    expect(html).toContain('data-testid="pane-ledger"');
    expect(html).toContain('data-testid="pane-source"');
    expect(html).toContain("Score Decomposition (5-Col)");
    expect(html).toContain("Evidence Ledger");
    expect(html).toContain("Source &middot;");
    expect(html).toContain('class="packet-b"');
  });
});

describe("Server Route Handlers", () => {
  it("serves tokens.css", async () => {
    const res = await handleRequest("/tokens.css", new URLSearchParams());
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/css");
    expect(res.body).toContain("--surface-paper");
    expect(res.body).toContain("--support");
    expect(res.body).toContain("--contradict");
  });

  it("renders Triage Queue page at / and /triage", async () => {
    const res = await handleRequest("/triage", new URLSearchParams());
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/html");
    expect(res.body).toContain("Triage Queue");
    expect(res.body).toContain('data-testid="instrument-band"');
    expect(res.body).toContain("candidate-1");
  });

  it("renders Resolution Queue at /review", async () => {
    const res = await handleRequest("/review", new URLSearchParams());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Human Resolution Queue");
    expect(res.body).toContain("Resolution Tasks");
    expect(res.body).toContain("Stage Proposals");
  });

  it("renders Candidate Packet at /packet/candidate-1", async () => {
    const res = await handleRequest("/packet/candidate-1", new URLSearchParams());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("data-testid=\"pane-arithmetic\"");
    expect(res.body).toContain("data-testid=\"pane-ledger\"");
    expect(res.body).toContain("data-testid=\"pane-source\"");
  });

  it("returns 404 for nonexistent candidate packet", async () => {
    const res = await handleRequest("/packet/nonexistent", new URLSearchParams());
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("Candidate Packet Not Found");
  });

  it("renders Audit Timeline at /runs", async () => {
    const res = await handleRequest("/runs", new URLSearchParams());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Audit Timeline");
  });

  it("renders System Status at /status", async () => {
    const res = await handleRequest("/status", new URLSearchParams());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("System Status &amp; Trust Center");
    expect(res.body).toContain("Corpus Seal Verification");
    expect(res.body).toContain("Known Limitations");
  });

  it("returns JSON at /api/candidates and /api/status", async () => {
    const candRes = await handleRequest("/api/candidates", new URLSearchParams());
    expect(candRes.statusCode).toBe(200);
    const candidates = JSON.parse(candRes.body);
    expect(Array.isArray(candidates)).toBe(true);

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
});
