import type {
  CandidateSummary,
  ProposalSummary,
  ResolutionTaskSummary
} from "@recruitos/cli";
import { renderCandidatePacketView } from "../components/candidate-packet.js";
import { renderInstrumentBand } from "../components/instrument-band.js";
import { escapeHtml } from "../components/safe-text.js";
import { TOKENS_CSS } from "../tokens.js";
import { getServerComposition } from "./composition.js";
import { renderPage } from "./ssr.js";

export type HttpResponse = Readonly<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}>;

export async function handleRequest(
  urlPath: string,
  searchParams: URLSearchParams
): Promise<HttpResponse> {
  const theme = (searchParams.get("theme") as "light" | "dark" | null) ?? "light";
  const density = (searchParams.get("density") as "compact" | "default" | "comfortable" | null) ?? "default";
  const composition = getServerComposition();

  // Route: tokens.css
  if (urlPath === "/tokens.css") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/css; charset=utf-8" },
      body: TOKENS_CSS
    };
  }

  // API Route: /api/status
  if (urlPath === "/api/status") {
    const statusResult = await composition.getStatus();
    return {
      statusCode: statusResult.ok ? 200 : 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(statusResult.ok ? statusResult.value : { error: statusResult.error })
    };
  }

  // API Route: /api/candidates
  if (urlPath === "/api/candidates") {
    const listResult = await composition.listCandidates();
    return {
      statusCode: listResult.ok ? 200 : 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(listResult.ok ? listResult.value : { error: listResult.error })
    };
  }

  // Common status for page shell
  const statusResult = await composition.getStatus();
  const status = statusResult.ok ? statusResult.value : undefined;

  // Route 1: / and /triage (Triage Queue Command Center)
  if (urlPath === "/" || urlPath === "/triage") {
    const candidatesResult = await composition.listCandidates();
    const candidates = candidatesResult.ok ? candidatesResult.value : [];

    const instrumentBandHtml = status ? renderInstrumentBand({ status }) : "";

    const candidateRows = candidates.map((c: CandidateSummary, idx: number) => {
      const isEscalated = c.status === "escalated";
      const isRejected = c.status === "rejected";
      const rowClass = isEscalated ? "row-escalated" : isRejected ? "rejected" : "";

      // Evidence strip mockup: 6 ticks
      const stripHtml = isEscalated
        ? `<span class="strip"><i class="sup"></i><i class="con"></i><i class="gap"></i><i class="sup"></i><i class="gap"></i><i class="sup"></i></span>`
        : `<span class="strip"><i class="sup"></i><i class="sup"></i><i class="sup"></i><i class="sup"></i><i class="sup"></i><i class="sup"></i></span>`;

      const reasonsText = c.reasons.length > 0 ? c.reasons.join(", ") : "n/a";

      return [
        `        <tr class="${rowClass}">`,
        `          <td class="num">00${idx + 1}</td>`,
        `          <td><a href="/packet/${escapeHtml(c.candidateId)}" class="link" style="color:inherit;text-decoration:underline">${escapeHtml(c.sourceKey)}</a></td>`,
        `          <td class="mono">${escapeHtml(c.channel === "inbound" ? "in" : "src")}</td>`,
        `          <td>${stripHtml}</td>`,
        `          <td class="num">${c.score !== null ? c.score.toFixed(1) : '<span class="faint">n/a</span>'}</td>`,
        `          <td class="num">${c.confidence !== null ? c.confidence.toFixed(2) : '<span class="faint">n/a</span>'}</td>`,
        `          <td><span class="status${isRejected ? " rejected" : ""}">${escapeHtml(c.status)}</span></td>`,
        `          <td class="reason">${escapeHtml(reasonsText)}</td>`,
        `          <td class="num">${c.tasksCount}</td>`,
        `          <td class="mono faint" style="font-size:12px">${c.sealed ? "sealed" : "mutable"}</td>`,
        `        </tr>`
      ].join("\n");
    });

    const contentHtml = [
      instrumentBandHtml,
      `      <div style="display:flex;align-items:baseline;gap:16px;padding:8px 16px;border-bottom:1px solid var(--hairline)">`,
      `        <span style="font-size:19px;line-height:26px;font-weight:600">Triage Queue</span>`,
      `        <span style="flex:1"></span>`,
      `        <span class="strip"><i class="sup"></i></span><span class="mono faint" style="font-size:11px">supporting</span>`,
      `        <span class="strip"><i class="con"></i></span><span class="mono faint" style="font-size:11px">contradicting</span>`,
      `        <span class="strip"><i class="gap"></i></span><span class="mono faint" style="font-size:11px">evidence gap</span>`,
      `        <span class="mono faint" style="font-size:11px">&middot; rubric order</span>`,
      `      </div>`,
      `      <table class="q">`,
      `        <thead><tr>`,
      `          <th style="width:44px">#</th><th style="width:190px">Candidate</th><th style="width:44px">Ch</th>`,
      `          <th style="width:76px">Evidence</th><th style="width:64px;text-align:right">Score</th>`,
      `          <th style="width:56px;text-align:right">Conf</th><th style="width:130px">Status</th>`,
      `          <th style="width:210px">Reasons</th><th style="width:56px;text-align:right">Tasks</th><th>State</th>`,
      `        </tr></thead>`,
      `        <tbody>`,
      candidateRows.join("\n"),
      `        </tbody>`,
      `      </table>`
    ].join("\n");

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: renderPage({
        title: "Triage Queue",
        activeDestination: "triage",
        status,
        theme,
        density,
        contentHtml
      })
    };
  }

  // Route 2: /review (Resolution Queue & Stage Proposals)
  if (urlPath === "/review") {
    const tasksResult = await composition.listResolutionTasks();
    const proposalsResult = await composition.listProposals();

    const tasks = tasksResult.ok ? tasksResult.value : [];
    const proposals = proposalsResult.ok ? proposalsResult.value : [];

    const taskRows = tasks.map((t: ResolutionTaskSummary) => [
      `        <tr>`,
      `          <td class="mono"><strong>${escapeHtml(t.resolutionTaskId)}</strong></td>`,
      `          <td><a href="/packet/${escapeHtml(t.candidateId)}" class="link">${escapeHtml(t.candidateId)}</a></td>`,
      `          <td class="mono">${escapeHtml(t.reasonCode)}</td>`,
      `          <td><span class="status">${escapeHtml(t.status)}</span></td>`,
      `          <td class="num">${t.taskOrdinal}</td>`,
      `          <td class="num">${t.version}</td>`,
      `          <td class="mono faint">${escapeHtml(t.currentActionId ?? "(none)")}</td>`,
      `        </tr>`
    ].join("\n"));

    const proposalRows = proposals.map((p: ProposalSummary) => [
      `        <tr>`,
      `          <td class="mono"><strong>${escapeHtml(p.proposalId)}</strong></td>`,
      `          <td><a href="/packet/${escapeHtml(p.candidateId)}" class="link">${escapeHtml(p.candidateId)}</a></td>`,
      `          <td class="mono">${escapeHtml(p.kind)}</td>`,
      `          <td><span class="status">${escapeHtml(p.status)}</span></td>`,
      `          <td class="num">${p.version}</td>`,
      `          <td class="muted">${escapeHtml(p.proposedChange)}</td>`,
      `        </tr>`
    ].join("\n"));

    const contentHtml = [
      `      <div style="padding:16px;border-bottom:1px solid var(--hairline);background:var(--surface)">`,
      `        <h2 style="margin:0 0 4px;font-size:20px">Human Resolution Queue</h2>`,
      `        <div class="muted" style="font-size:13px">Candidate tasks requiring reviewer intervention or override</div>`,
      `      </div>`,
      `      <div style="padding:16px">`,
      `        <h3 style="margin:0 0 8px;font-size:15px">Resolution Tasks (${tasks.length})</h3>`,
      `        <table class="q">`,
      `          <thead><tr>`,
      `            <th>Task ID</th><th>Candidate</th><th>Reason Code</th><th>Status</th><th style="text-align:right">Ordinal</th><th style="text-align:right">Version</th><th>Action Head</th>`,
      `          </tr></thead>`,
      `          <tbody>`,
      taskRows.length > 0 ? taskRows.join("\n") : `<tr><td colspan="7" class="muted">(no open resolution tasks)</td></tr>`,
      `          </tbody>`,
      `        </table>`,
      `        <h3 style="margin:24px 0 8px;font-size:15px">Stage Proposals (${proposals.length})</h3>`,
      `        <table class="q">`,
      `          <thead><tr>`,
      `            <th>Proposal ID</th><th>Candidate</th><th>Kind</th><th>Status</th><th style="text-align:right">Version</th><th>Proposed Change</th>`,
      `          </tr></thead>`,
      `          <tbody>`,
      proposalRows.length > 0 ? proposalRows.join("\n") : `<tr><td colspan="6" class="muted">(no pending proposals)</td></tr>`,
      `          </tbody>`,
      `        </table>`,
      `      </div>`
    ].join("\n");

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: renderPage({
        title: "Resolution Queue",
        activeDestination: "review",
        status,
        theme,
        density,
        contentHtml
      })
    };
  }

  // Route 3: /packet and /packet/:id (Candidate Review Packet)
  if (urlPath === "/packet" || urlPath.startsWith("/packet/")) {
    let candidateId = "candidate-1";
    if (urlPath.startsWith("/packet/") && urlPath.length > "/packet/".length) {
      candidateId = decodeURIComponent(urlPath.slice("/packet/".length));
    }

    const packetResult = await composition.getCandidatePacket(candidateId);

    if (!packetResult.ok) {
      const contentHtml = [
        `      <div style="padding:40px;text-align:center">`,
        `        <h2 style="color:var(--danger)">Candidate Packet Not Found</h2>`,
        `        <p class="muted">No candidate evaluation packet matching ID: ${escapeHtml(candidateId)}</p>`,
        `        <p><a href="/triage" class="link">Return to Triage Queue</a></p>`,
        `      </div>`
      ].join("\n");

      return {
        statusCode: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: renderPage({
          title: "Packet Not Found",
          activeDestination: "packet",
          status,
          theme,
          density,
          contentHtml
        })
      };
    }

    const packet = packetResult.value;
    const contentHtml = renderCandidatePacketView({ packet });

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: renderPage({
        title: `Packet: ${packet.candidateId}`,
        activeDestination: "packet",
        status,
        theme,
        density,
        contentHtml
      })
    };
  }

  // Route 4: /runs (Audit Timeline & Runs)
  if (urlPath === "/runs") {
    const auditResult = await composition.listAuditEvents({ limit: 50 });
    const auditEvents = auditResult.ok ? auditResult.value : [];

    const eventRows = auditEvents.map((e) => [
      `        <tr>`,
      `          <td class="mono"><strong>${escapeHtml(e.auditEventId)}</strong></td>`,
      `          <td class="mono">${escapeHtml(e.eventName)}</td>`,
      `          <td class="mono">${escapeHtml(e.actorId)}</td>`,
      `          <td class="mono">${new Date(e.occurredAt).toISOString()}</td>`,
      `          <td class="mono faint">${escapeHtml(e.payloadHash.slice(0, 16))}...</td>`,
      `        </tr>`
    ].join("\n"));

    const contentHtml = [
      `      <div style="padding:16px;border-bottom:1px solid var(--hairline);background:var(--surface)">`,
      `        <h2 style="margin:0 0 4px;font-size:20px">Audit Timeline &amp; Run History</h2>`,
      `        <div class="muted" style="font-size:13px">Verifiable ledger of automated triage runs and actor decisions</div>`,
      `      </div>`,
      `      <div style="padding:16px">`,
      `        <table class="q">`,
      `          <thead><tr>`,
      `            <th>Event ID</th><th>Event Name</th><th>Actor ID</th><th>Timestamp</th><th>Payload Hash</th>`,
      `          </tr></thead>`,
      `          <tbody>`,
      eventRows.length > 0 ? eventRows.join("\n") : `<tr><td colspan="5" class="muted">(no audit events recorded)</td></tr>`,
      `          </tbody>`,
      `        </table>`,
      `      </div>`
    ].join("\n");

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: renderPage({
        title: "Audit Timeline",
        activeDestination: "runs",
        status,
        theme,
        density,
        contentHtml
      })
    };
  }

  // Route 5: /status (System & Corpus Seal Status)
  if (urlPath === "/status") {
    const contentHtml = [
      `      <div style="padding:16px;border-bottom:1px solid var(--hairline);background:var(--surface)">`,
      `        <h2 style="margin:0 0 4px;font-size:20px">System Status &amp; Trust Center</h2>`,
      `        <div class="muted" style="font-size:13px">Database integrity, schema migrations, and corpus immutability</div>`,
      `      </div>`,
      `      <div style="padding:24px;max-width:800px">`,
      `        <div class="panel" style="padding:16px;margin-bottom:16px">`,
      `          <h3 style="margin:0 0 12px;font-size:16px">Corpus Seal Verification</h3>`,
      `          <div class="mono" style="font-size:13px;line-height:22px">`,
      `            <div>Status: <strong style="color:${status?.isSealed ? 'var(--support)' : 'var(--danger)'}">${status?.isSealed ? "SEALED (IMMUTABLE)" : "UNSEALED"}</strong></div>`,
      `            <div>Active Run ID: ${escapeHtml(status?.activeRunId ?? "unknown")}</div>`,
      `            <div>Schema Version: ${status?.schemaVersion ?? "unknown"}</div>`,
      `            <div>Database Path: ${escapeHtml(status?.databasePath ?? "unknown")}</div>`,
      `          </div>`,
      `        </div>`,
      `        <div class="panel" style="padding:16px">`,
      `          <h3 style="margin:0 0 12px;font-size:16px">Known Limitations (${status?.knownLimitationsCount ?? 0})</h3>`,
      `          <ol style="margin:0;padding-left:20px;font-size:13px;line-height:22px" class="muted">`,
      `            <li>Assessment data unavailable for unverified candidates (escalated to human review).</li>`,
      `            <li>Seniority level inference requires external confirmation when title lacks year qualifiers.</li>`,
      `            <li>Work authorization status verification requires manual compliance check.</li>`,
      `          </ol>`,
      `        </div>`,
      `      </div>`
    ].join("\n");

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: renderPage({
        title: "System Status",
        activeDestination: "status",
        status,
        theme,
        density,
        contentHtml
      })
    };
  }

  // 404 for unknown route
  return {
    statusCode: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: renderPage({
      title: "Not Found",
      activeDestination: "triage",
      status,
      theme,
      density,
      contentHtml: `<div style="padding:40px;text-align:center"><h2 style="color:var(--danger)">404 Page Not Found</h2><p><a href="/triage" class="link">Return to Triage Queue</a></p></div>`
    })
  };
}
