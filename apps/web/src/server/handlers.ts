import type { CandidatePacket, RecruitosComposition } from "@recruitos/cli";
import { parseAppearance, packetHref, type Appearance } from "../appearance.js";
import { renderCandidatePacketView } from "../components/candidate-packet.js";
import { renderEvidenceCoverageStrip } from "../components/evidence-coverage-strip.js";
import { renderInstrumentBand } from "../components/instrument-band.js";
import { escapeHtml } from "../components/safe-text.js";
import { TEST_IDS } from "../testids.js";
import { TOKENS_CSS } from "../tokens.js";
import { getServerComposition, getServerRuntime } from "./composition.js";
import {
  completeFixtureReExtractionAction,
  requestReExtractionAction,
  staleConflictCopy,
  type WebActionFailure
} from "./correction-actions.js";
import { isCorrectionFixtureMode } from "./correction-mode.js";
import { requiredInteger, requiredText } from "./form-body.js";
import { loadPacketInspectorModel } from "./inspector-model.js";
import {
  AUDIT_APPEND_ONLY_DISCLAIMER,
  actorGlyph,
  formatAuditTimestamp,
  groupAuditEventsByCommand
} from "./audit-ledger.js";
import { overlayPersistedRunStatus } from "./persisted-run.js";
import { listAllAuditEventSummaries } from "./read-pages.js";
import { renderPage, type PageRenderOptions } from "./ssr.js";
import { loadTriageQueueModel } from "./triage-queue.js";

export type HttpResponse = Readonly<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}>;

export type IncomingRequest = Readonly<{
  method?: string;
  body?: URLSearchParams;
}>;

function htmlHeaders(): Record<string, string> {
  return { "Content-Type": "text/html; charset=utf-8" };
}

function jsonHeaders(): Record<string, string> {
  return { "Content-Type": "application/json" };
}

function rowClassForStatus(status: string): string {
  if (status === "escalated") return "row-escalated";
  if (status === "rejected_hard_requirement") return "rejected";
  return "";
}

function typedErrorPage(
  title: string,
  message: string,
  appearance: Appearance,
  currentPath: string,
  statusCode: number,
  searchParams?: URLSearchParams
): HttpResponse {
  const contentHtml = [
    `      <div style="padding:40px;text-align:center" data-testid="typed-error">`,
    `        <h2 style="color:var(--danger)">${escapeHtml(title)}</h2>`,
    `        <p class="muted">${escapeHtml(message)}</p>`,
    `        <p><a href="/triage?${escapeHtml(`theme=${appearance.theme}&density=${appearance.density}`)}" class="link">Return to Triage Queue</a></p>`,
    `      </div>`
  ].join("\n");
  return {
    statusCode,
    headers: htmlHeaders(),
    body: renderPage({
      title,
      activeDestination: "triage",
      appearance,
      currentPath,
      contentHtml,
      ...(searchParams === undefined ? {} : { searchParams })
    })
  };
}

function redirect(location: string): HttpResponse {
  return {
    statusCode: 303,
    headers: { ...htmlHeaders(), Location: location },
    body: ""
  };
}

async function loadDisplayedStatus(composition: RecruitosComposition) {
  const statusResult = await composition.getStatus();
  if (!statusResult.ok) {
    return statusResult;
  }
  const runtime = getServerRuntime();
  if (runtime === null) {
    return statusResult;
  }
  return overlayPersistedRunStatus(statusResult.value, runtime.connection.database);
}

type PageShell = Omit<
  PageRenderOptions,
  "title" | "activeDestination" | "currentPath" | "contentHtml"
>;

function actionFailurePage(
  failure: WebActionFailure,
  appearance: Appearance,
  urlPath: string,
  searchParams: URLSearchParams
): HttpResponse {
  return typedErrorPage(
    "Correction action failed",
    failure.message,
    appearance,
    urlPath,
    failure.httpStatus,
    searchParams
  );
}

async function renderPacketPage(
  composition: RecruitosComposition,
  candidateId: string,
  searchParams: URLSearchParams,
  appearance: Appearance,
  pageShell: PageShell,
  extras?: {
    statusCode?: number;
    conflictMessage?: string;
    preservedRationale?: string;
    freezeSubmit?: boolean;
    expectedTaskHeadVersion?: number;
    expectedCandidateHeadVersion?: number;
  }
): Promise<HttpResponse> {
  const resultId = searchParams.get("result") ?? undefined;
  const packetResult = await composition.getCandidatePacket(
    candidateId,
    resultId === undefined ? undefined : { resultId }
  );

  if (!packetResult.ok) {
    const contentHtml = [
      `      <div style="padding:40px;text-align:center" data-testid="${TEST_IDS.PACKET_NOT_FOUND}">`,
      `        <h2 style="color:var(--danger)">Candidate Packet Not Found</h2>`,
      `        <p class="muted">No candidate evaluation packet matching ID: ${escapeHtml(candidateId)}</p>`,
      `        <p><a href="${escapeHtml(`/triage?theme=${appearance.theme}&density=${appearance.density}`)}" class="link" data-testid="${TEST_IDS.RETURN_TO_QUEUE}">Return to Triage Queue</a></p>`,
      `      </div>`
    ].join("\n");
    return {
      statusCode: 404,
      headers: htmlHeaders(),
      body: renderPage({
        ...pageShell,
        title: "Packet Not Found",
        activeDestination: "packet",
        currentPath: `/packet/${candidateId}`,
        contentHtml
      })
    };
  }

  const packet: CandidatePacket = packetResult.value;
  const inspector = await loadPacketInspectorModel({
    composition,
    packet,
    appearance,
    searchParams,
    ...(extras?.conflictMessage === undefined ? {} : { conflictMessage: extras.conflictMessage }),
    ...(extras?.preservedRationale === undefined
      ? {}
      : { preservedRationale: extras.preservedRationale }),
    ...(extras?.freezeSubmit === undefined ? {} : { freezeSubmit: extras.freezeSubmit }),
    ...(extras?.expectedTaskHeadVersion === undefined
      ? {}
      : { expectedTaskHeadVersion: extras.expectedTaskHeadVersion }),
    ...(extras?.expectedCandidateHeadVersion === undefined
      ? {}
      : { expectedCandidateHeadVersion: extras.expectedCandidateHeadVersion })
  });
  const contentHtml = renderCandidatePacketView({ packet, appearance, inspector });
  return {
    statusCode: extras?.statusCode ?? 200,
    headers: htmlHeaders(),
    body: renderPage({
      ...pageShell,
      title: `Packet: ${packet.candidateId}`,
      activeDestination: "packet",
      currentPath: `/packet/${encodeURIComponent(packet.candidateId)}`,
      packetCandidateId: packet.candidateId,
      roleTitle: packet.roleTitle,
      contentHtml
    })
  };
}

async function handleCorrectionPost(
  urlPath: string,
  searchParams: URLSearchParams,
  body: URLSearchParams,
  composition: RecruitosComposition,
  appearance: Appearance,
  pageShell: PageShell
): Promise<HttpResponse> {
  if (urlPath === "/actions/request-re-extraction") {
    const result = await requestReExtractionAction(composition, body);
    if (result.ok) {
      const next = new URLSearchParams(searchParams);
      next.set("correction_attempt", result.value.triageAttemptId);
      next.set("notice", "reextraction_requested");
      next.delete("result");
      next.delete("prior");
      return redirect(
        `/packet/${encodeURIComponent(result.value.candidateId)}?${next.toString()}`
      );
    }
    if (result.error.httpStatus === 409) {
      const candidateId = requiredText(body, "candidateId");
      if (candidateId === undefined) {
        return actionFailurePage(result.error, appearance, urlPath, searchParams);
      }
      const preservedRationale = requiredText(body, "rationale");
      const expectedTaskHeadVersion = requiredInteger(body, "expectedTaskHeadVersion");
      const expectedCandidateHeadVersion = requiredInteger(body, "expectedCandidateHeadVersion");
      return renderPacketPage(composition, candidateId, searchParams, appearance, pageShell, {
        statusCode: 409,
        conflictMessage: staleConflictCopy(result.error),
        freezeSubmit: true,
        ...(preservedRationale === undefined ? {} : { preservedRationale }),
        ...(expectedTaskHeadVersion === undefined ? {} : { expectedTaskHeadVersion }),
        ...(expectedCandidateHeadVersion === undefined
          ? {}
          : { expectedCandidateHeadVersion })
      });
    }
    return actionFailurePage(result.error, appearance, urlPath, searchParams);
  }

  if (urlPath === "/actions/complete-fixture-extraction") {
    const result = await completeFixtureReExtractionAction(
      composition,
      body,
      getServerRuntime()?.connection.database
    );
    if (result.ok) {
      const next = new URLSearchParams(searchParams);
      next.set("prior", result.value.baseResultId);
      next.set("notice", "correction_complete");
      next.delete("correction_attempt");
      next.delete("result");
      return redirect(
        `/packet/${encodeURIComponent(result.value.candidateId)}?${next.toString()}`
      );
    }
    return actionFailurePage(result.error, appearance, urlPath, searchParams);
  }

  return typedErrorPage(
    "Not Found",
    "Unknown correction action.",
    appearance,
    urlPath,
    404,
    searchParams
  );
}

export async function handleRequest(
  urlPath: string,
  searchParams: URLSearchParams,
  incoming?: IncomingRequest
): Promise<HttpResponse> {
  const method = (incoming?.method ?? "GET").toUpperCase();
  const body = incoming?.body ?? new URLSearchParams();
  const appearance = parseAppearance(searchParams);

  if (urlPath === "/tokens.css") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/css; charset=utf-8" },
      body: TOKENS_CSS
    };
  }

  const compositionResult = getServerComposition();
  if (!compositionResult.ok) {
    if (urlPath.startsWith("/api/")) {
      return {
        statusCode: 503,
        headers: jsonHeaders(),
        body: JSON.stringify({ error: compositionResult.error })
      };
    }
    return typedErrorPage(
      "Database unavailable",
      compositionResult.error.message,
      appearance,
      urlPath,
      503,
      searchParams
    );
  }
  const composition: RecruitosComposition = compositionResult.value;

  if (urlPath === "/api/status") {
    const statusResult = await loadDisplayedStatus(composition);
    return {
      statusCode: statusResult.ok ? 200 : 500,
      headers: jsonHeaders(),
      body: JSON.stringify(statusResult.ok ? statusResult.value : { error: statusResult.error })
    };
  }

  const queueModelResult = await loadTriageQueueModel(composition);

  if (urlPath === "/api/candidates") {
    return {
      statusCode: queueModelResult.ok ? 200 : 500,
      headers: jsonHeaders(),
      body: JSON.stringify(
        queueModelResult.ok
          ? queueModelResult.value.rows.map((row) => row.candidate)
          : { error: queueModelResult.error }
      )
    };
  }

  const statusResult = await loadDisplayedStatus(composition);
  const status = statusResult.ok ? statusResult.value : undefined;
  const queueModel = queueModelResult.ok ? queueModelResult.value : undefined;
  const outstandingTaskCount = queueModel?.outstandingTaskCount;
  const packetCandidateId = queueModel?.firstCandidateId;
  const reasonCodeCounts = queueModel?.reasonCodeCounts;
  const roleTitle = queueModel?.rows[0]?.candidate.roleTitle;

  const pageShell = {
    status,
    appearance,
    searchParams,
    ...(outstandingTaskCount === undefined ? {} : { outstandingTaskCount }),
    ...(packetCandidateId === undefined ? {} : { packetCandidateId }),
    ...(reasonCodeCounts === undefined ? {} : { reasonCodeCounts }),
    ...(roleTitle === undefined ? {} : { roleTitle })
  };

  if (urlPath.startsWith("/actions/")) {
    if (method !== "POST") {
      return typedErrorPage(
        "Method not allowed",
        "Correction actions accept POST only.",
        appearance,
        urlPath,
        405,
        searchParams
      );
    }
    return handleCorrectionPost(urlPath, searchParams, body, composition, appearance, pageShell);
  }

  if (method !== "GET" && method !== "HEAD") {
    return typedErrorPage(
      "Method not allowed",
      "This resource accepts GET.",
      appearance,
      urlPath,
      405,
      searchParams
    );
  }

  if (urlPath === "/" || urlPath === "/triage") {
    if (!queueModelResult.ok) {
      return typedErrorPage(
        "Triage queue unavailable",
        queueModelResult.error.message,
        appearance,
        urlPath,
        500
      );
    }
    const model = queueModelResult.value;
    const instrumentBandHtml = status
      ? renderInstrumentBand({
          status,
          appearance,
          inboundCount: model.inboundCount,
          sourcedCount: model.sourcedCount,
          scoredCount: model.scoredCount,
          outstandingTaskCount: model.outstandingTaskCount,
          routedCandidateCount: model.routedCandidateCount,
          corpusSublabel: `${model.inboundCount} inbound · ${model.sourcedCount} sourced · seven-candidate proving corpus`
        })
      : "";

    const candidateRows = model.rows.map((row, idx) => {
      const c = row.candidate;
      const isRejected = c.status === "rejected_hard_requirement";
      const rowClass = rowClassForStatus(c.status);
      const stripHtml = renderEvidenceCoverageStrip(row.coverage);
      const reasonsText = c.reasons.length > 0 ? c.reasons.join(", ") : "n/a";
      const packetUrl = packetHref(c.candidateId, appearance);
      const ordinal = String(idx + 1).padStart(3, "0");

      return [
        `        <tr class="${rowClass}" data-testid="${TEST_IDS.CANDIDATE_ROW}">`,
        `          <td class="num">${ordinal}</td>`,
        `          <td><a href="${escapeHtml(packetUrl)}" class="link" data-testid="${TEST_IDS.CANDIDATE_LINK(c.candidateId)}" style="color:inherit;text-decoration:underline">${escapeHtml(c.sourceKey)}</a></td>`,
        `          <td class="mono">${escapeHtml(c.channel === "inbound" ? "in" : "src")}</td>`,
        `          <td>${stripHtml}</td>`,
        `          <td class="num">${row.scoreLabel === "n/a" ? '<span class="faint">n/a</span>' : escapeHtml(row.scoreLabel)}</td>`,
        `          <td class="num">${row.confidenceLabel === "n/a" ? '<span class="faint">n/a</span>' : escapeHtml(row.confidenceLabel)}</td>`,
        `          <td><span class="status${isRejected ? " rejected" : ""}" data-testid="${TEST_IDS.CANDIDATE_STATUS(c.candidateId)}">${escapeHtml(c.status)}</span></td>`,
        `          <td class="reason">${escapeHtml(reasonsText)}</td>`,
        `          <td class="num">${row.tasksCount}</td>`,
        `          <td class="mono faint" style="font-size:12px">${c.sealed ? "sealed" : "mutable"}</td>`,
        `        </tr>`
      ].join("\n");
    });

    const contentHtml = [
      instrumentBandHtml,
      `      <div style="display:flex;align-items:baseline;gap:16px;padding:8px 16px;border-bottom:1px solid var(--hairline)">`,
      `        <span style="font-size:19px;line-height:26px;font-weight:600" data-testid="${TEST_IDS.TRIAGE_HEADING}">Triage Queue</span>`,
      `        <span class="mono faint" style="font-size:12px">${model.rows.length} candidates · ${model.scoredCount} scored · ${model.escalatedCount} escalated · ${model.rejectedHardRequirementCount} rejected_hard_requirement</span>`,
      `        <span style="flex:1"></span>`,
      `        <span class="strip"><i class="sup"></i></span><span class="mono faint" style="font-size:11px">supporting</span>`,
      `        <span class="strip"><i class="con"></i></span><span class="mono faint" style="font-size:11px">contradicting</span>`,
      `        <span class="strip"><i class="gap"></i></span><span class="mono faint" style="font-size:11px">evidence gap</span>`,
      `        <span class="strip"><i class="na"></i></span><span class="mono faint" style="font-size:11px">unavailable</span>`,
      `        <span class="mono faint" style="font-size:11px">&middot; rubric order</span>`,
      `      </div>`,
      `      <table class="q" data-testid="${TEST_IDS.TRIAGE_QUEUE}">`,
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
      headers: htmlHeaders(),
      body: renderPage({
        ...pageShell,
        title: "Triage Queue",
        activeDestination: "triage",
        currentPath: "/triage",
        contentHtml
      })
    };
  }

  if (urlPath === "/review") {
    const tasks = queueModel?.allTasks ?? [];
    const sourceKeyByCandidateId = new Map(
      (queueModel?.rows ?? []).map((row) => [row.candidate.candidateId, row.candidate.sourceKey])
    );
    const correctionCopy = isCorrectionFixtureMode()
      ? "Fixture correction is on for demo/route-4-reviewable-failure. The browser requests re-extraction as human:operator. The overlay simulates the provider."
      : "Listing is live. Correction mutations stay off until make demo-web-correction.";

    const taskRows = tasks.map((t) => {
      const sourceKey = sourceKeyByCandidateId.get(t.candidateId) ?? t.candidateId;
      const packetUrl = packetHref(t.candidateId, appearance);
      return [
        `        <tr data-testid="${TEST_IDS.TASK_ITEM(t.resolutionTaskId)}">`,
        `          <td class="mono"><strong>${escapeHtml(t.resolutionTaskId)}</strong></td>`,
        `          <td><a href="${escapeHtml(packetUrl)}" class="link">${escapeHtml(sourceKey)}</a></td>`,
        `          <td class="mono">${escapeHtml(t.reasonCode)}</td>`,
        `          <td><span class="status" data-testid="${TEST_IDS.TASK_STATUS(t.resolutionTaskId)}">${escapeHtml(t.status)}</span></td>`,
        `          <td class="num">${t.taskOrdinal}</td>`,
        `          <td class="num">${t.version}</td>`,
        `          <td><a href="${escapeHtml(packetUrl)}" class="link">Open packet</a></td>`,
        `        </tr>`
      ].join("\n");
    });

    const contentHtml = [
      `      <div style="padding:16px;border-bottom:1px solid var(--hairline);background:var(--surface)">`,
      `        <h2 style="margin:0 0 4px;font-size:20px">Human Resolution Queue</h2>`,
      `        <div class="muted" style="font-size:13px">${escapeHtml(correctionCopy)}</div>`,
      `      </div>`,
      `      <div style="padding:16px">`,
      `        <div data-testid="resolution-queue">`,
      `          <h3 style="margin:0 0 8px;font-size:15px">Resolution Tasks (${tasks.length})</h3>`,
      `          <table class="q">`,
      `            <thead><tr>`,
      `              <th>Task ID</th><th>Candidate</th><th>Reason Code</th><th>Status</th><th style="text-align:right">Ordinal</th><th style="text-align:right">Version</th><th>Action</th>`,
      `            </tr></thead>`,
      `            <tbody>`,
      taskRows.length > 0
        ? taskRows.join("\n")
        : `<tr><td colspan="7" class="muted">(no open resolution tasks)</td></tr>`,
      `            </tbody>`,
      `          </table>`,
      `        </div>`,
      `        <div data-testid="proposal-queue" style="margin-top:24px">`,
      `          <h3 style="margin:0 0 8px;font-size:15px">Stage Proposals</h3>`,
      `          <p class="muted" style="font-size:13px">Proposal review is deferred. This page does not render stub proposal records as if they were real.</p>`,
      `        </div>`,
      `      </div>`
    ].join("\n");

    return {
      statusCode: 200,
      headers: htmlHeaders(),
      body: renderPage({
        ...pageShell,
        title: "Resolution Queue",
        activeDestination: "review",
        currentPath: "/review",
        contentHtml
      })
    };
  }

  if (urlPath === "/packet" || urlPath.startsWith("/packet/")) {
    if (urlPath === "/packet" || urlPath === "/packet/") {
      const contentHtml = [
        `      <div style="padding:40px;text-align:center" data-testid="${TEST_IDS.PACKET_NOT_FOUND}">`,
        `        <h2 style="color:var(--danger)">Candidate Packet Not Found</h2>`,
        `        <p class="muted">No candidate id was supplied.</p>`,
        `        <p><a href="${escapeHtml(`/triage?theme=${appearance.theme}&density=${appearance.density}`)}" class="link" data-testid="${TEST_IDS.RETURN_TO_QUEUE}">Return to Triage Queue</a></p>`,
        `      </div>`
      ].join("\n");
      return {
        statusCode: 404,
        headers: htmlHeaders(),
        body: renderPage({
          ...pageShell,
          title: "Packet Not Found",
          activeDestination: "packet",
          currentPath: urlPath,
          contentHtml
        })
      };
    }

    const candidateId = decodeURIComponent(urlPath.slice("/packet/".length));
    return renderPacketPage(composition, candidateId, searchParams, appearance, pageShell);
  }

  if (urlPath === "/runs") {
    const runtime = getServerRuntime();
    if (runtime === null) {
      return typedErrorPage(
        "Audit ledger unavailable",
        "Audit history requires a runtime database. This page does not display stub events.",
        appearance,
        "/runs",
        503,
        searchParams
      );
    }
    const listed = listAllAuditEventSummaries(runtime.connection.database);
    if (!listed.ok) {
      return typedErrorPage(
        "Audit ledger unavailable",
        listed.error.message,
        appearance,
        "/runs",
        500,
        searchParams
      );
    }

    const groups = groupAuditEventsByCommand(listed.value);
    const groupBlocks = groups.map((group) => {
      const header =
        group.commandId === null
          ? ""
          : [
              `        <tr class="group-head">`,
              `          <td colspan="7">command ${escapeHtml(group.commandId)} · ${group.events.length} event${group.events.length === 1 ? "" : "s"}</td>`,
              `        </tr>`
            ].join("\n");
      const rows = group.events.map((event) => {
        const ordinal =
          event.eventOrdinal === null ? "" : String(event.eventOrdinal);
        const commandId = event.commandId ?? "";
        return [
          `        <tr data-testid="${TEST_IDS.AUDIT_EVENT_ROW}" id="${escapeHtml(TEST_IDS.AUDIT_EVENT_ITEM(event.auditEventId))}">`,
          `          <td class="mono" data-testid="${TEST_IDS.AUDIT_EVENT_ITEM(event.auditEventId)}">${escapeHtml(event.auditEventId)}</td>`,
          `          <td class="num">${escapeHtml(ordinal)}</td>`,
          `          <td class="mono">${escapeHtml(formatAuditTimestamp(event.occurredAt))}</td>`,
          `          <td class="mono">${escapeHtml(commandId)}</td>`,
          `          <td class="mono">${escapeHtml(`${actorGlyph(event.actorId)} ${event.actorId}`)}</td>`,
          `          <td class="mono">${escapeHtml(event.eventName)}</td>`,
          `          <td class="mono" style="white-space:normal;word-break:break-all">${escapeHtml(event.payloadHash)}</td>`,
          `        </tr>`
        ].join("\n");
      });
      return [header, ...rows].filter((block) => block.length > 0).join("\n");
    });

    const bodyRows =
      groupBlocks.length > 0
        ? groupBlocks.join("\n")
        : `        <tr><td colspan="7" class="muted">No audit events are recorded in this database.</td></tr>`;

    const contentHtml = [
      `      <div style="padding:16px;border-bottom:1px solid var(--hairline);background:var(--surface)">`,
      `        <h2 style="margin:0 0 4px;font-size:20px">Audit Timeline &amp; Run History</h2>`,
      `        <div class="muted" style="font-size:13px">Persisted audit_event rows. Newest first. Events that share a command ID are grouped.</div>`,
      `      </div>`,
      `      <div style="padding:16px">`,
      `        <table class="q" data-testid="${TEST_IDS.AUDIT_EVENT_TABLE}">`,
      `          <thead><tr>`,
      `            <th>Event ID</th><th style="text-align:right">Ordinal</th><th>Timestamp</th><th>Command ID</th><th>Actor ID</th><th>Event type</th><th>Payload hash</th>`,
      `          </tr></thead>`,
      `          <tbody>`,
      bodyRows,
      `          </tbody>`,
      `        </table>`,
      `        <p class="muted mono" style="font-size:12px;margin-top:16px" data-testid="${TEST_IDS.AUDIT_APPEND_ONLY_DISCLAIMER}">${escapeHtml(AUDIT_APPEND_ONLY_DISCLAIMER)}</p>`,
      `      </div>`
    ].join("\n");

    return {
      statusCode: 200,
      headers: htmlHeaders(),
      body: renderPage({
        ...pageShell,
        title: "Audit Timeline",
        activeDestination: "runs",
        currentPath: "/runs",
        contentHtml
      })
    };
  }

  if (urlPath === "/status") {
    const contentHtml = [
      `      <div style="padding:16px;border-bottom:1px solid var(--hairline);background:var(--surface)">`,
      `        <h2 style="margin:0 0 4px;font-size:20px">System Status &amp; Trust Center</h2>`,
      `        <div class="muted" style="font-size:13px">Database path and seal flags from runtime status. Limitation catalog copy is deferred.</div>`,
      `      </div>`,
      `      <div style="padding:24px;max-width:800px">`,
      `        <div class="panel" data-testid="${TEST_IDS.CORPUS_SEAL_STATUS}" style="padding:16px;margin-bottom:16px">`,
      `          <h3 style="margin:0 0 12px;font-size:16px">Corpus Seal Verification</h3>`,
      `          <div class="mono" style="font-size:13px;line-height:22px">`,
      `            <div>Status: <strong>${status?.isSealed ? "SEALED" : "UNSEALED"}</strong></div>`,
      `            <div>Active Run ID: ${escapeHtml(status?.activeRunId ?? "unknown")}</div>`,
      `            <div>Schema Version: ${status?.schemaVersion ?? "unknown"}</div>`,
      `            <div>Database Path: ${escapeHtml(status?.databasePath ?? "unknown")}</div>`,
      `          </div>`,
      `        </div>`,
      `        <div class="panel" style="padding:16px">`,
      `          <h3 style="margin:0 0 12px;font-size:16px">Known Limitations (${status?.knownLimitationsCount ?? "unavailable"})</h3>`,
      `          <p class="muted" data-testid="${TEST_IDS.KNOWN_LIMITATIONS}" style="font-size:13px;line-height:22px">`,
      `            The Trust Center limitation catalog is not wired in this read-only phase. The runtime reports a known-limitations count of ${status?.knownLimitationsCount ?? "unavailable"}. This page does not invent catalog copy to fill that count.`,
      `          </p>`,
      `        </div>`,
      `      </div>`
    ].join("\n");

    return {
      statusCode: 200,
      headers: htmlHeaders(),
      body: renderPage({
        ...pageShell,
        title: "System Status",
        activeDestination: "status",
        currentPath: "/status",
        contentHtml
      })
    };
  }

  return {
    statusCode: 404,
    headers: htmlHeaders(),
    body: renderPage({
      ...pageShell,
      title: "Not Found",
      activeDestination: "triage",
      currentPath: urlPath,
      contentHtml: `<div style="padding:40px;text-align:center"><h2 style="color:var(--danger)">404 Page Not Found</h2><p><a href="/triage?theme=${appearance.theme}&amp;density=${appearance.density}" class="link">Return to Triage Queue</a></p></div>`
    })
  };
}
