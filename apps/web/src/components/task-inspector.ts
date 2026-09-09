import { hrefWithAppearance, packetHref } from "../appearance.js";
import { escapeHtml } from "./safe-text.js";
import { TEST_IDS } from "../testids.js";
import type { PacketInspectorModel } from "../server/inspector-model.js";

function hiddenInput(name: string, value: string): string {
  return `        <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`;
}

function versionLine(label: string, value: number | undefined): string {
  const shown = value === undefined ? "unavailable" : String(value);
  return `      <div class="mono" style="font-size:12px;margin:4px 0">${escapeHtml(label)}: ${escapeHtml(shown)}</div>`;
}

function noticeBand(notice: string | undefined): string {
  if (notice === "reextraction_requested") {
    return [
      `    <div class="toast-success" data-testid="${TEST_IDS.TOAST_SUCCESS}">`,
      `      Re-extraction requested. The fixture overlay simulates the provider. The browser did not supply extracted facts.`,
      `    </div>`
    ].join("\n");
  }
  if (notice === "correction_complete") {
    return [
      `    <div class="toast-success" data-testid="${TEST_IDS.TOAST_SUCCESS}">`,
      `      Correction recorded. The task is review_required, not resolved.`,
      `    </div>`
    ].join("\n");
  }
  return "";
}

export function renderConflictBand(message: string | undefined): string {
  if (message === undefined) {
    return "";
  }
  return [
    `    <div class="conflict-band" data-testid="${TEST_IDS.CONFLICT_ERROR_BANNER}">`,
    `      ${escapeHtml(message)}`,
    `    </div>`
  ].join("\n");
}

function requestForm(model: PacketInspectorModel): string {
  const task = model.task;
  if (task === undefined) {
    return "";
  }
  const disabled = model.freezeSubmit ? " disabled" : "";
  const rationale = model.preservedRationale ?? "";
  return [
    `    <form method="post" action="${escapeHtml(model.requestActionHref)}" data-testid="${TEST_IDS.RESOLUTION_FORM}">`,
    hiddenInput("candidateId", model.packet.candidateId),
    hiddenInput("taskId", task.resolutionTaskId),
    hiddenInput("actionKind", "request_re_extraction"),
    hiddenInput("expectedTaskHeadVersion", String(model.expectedTaskHeadVersion ?? "")),
    hiddenInput("expectedCandidateHeadVersion", String(model.expectedCandidateHeadVersion ?? "")),
    `      <label class="caps" for="resolution-rationale">Rationale</label>`,
    `      <textarea id="resolution-rationale" name="rationale" required data-testid="${TEST_IDS.RATIONALE_INPUT}" ${model.freezeSubmit ? "readonly" : ""}>${escapeHtml(rationale)}</textarea>`,
    `      <button type="submit" class="inspector-btn primary" data-testid="${TEST_IDS.SUBMIT_RESOLUTION_BTN}"${disabled}>Request re-extraction</button>`,
    `    </form>`
  ].join("\n");
}

function completeForm(model: PacketInspectorModel): string {
  const task = model.task;
  if (task === undefined || model.triageAttemptId === undefined) {
    return "";
  }
  return [
    `    <form method="post" action="${escapeHtml(model.completeActionHref)}" data-testid="${TEST_IDS.FIXTURE_COMPLETE_FORM}">`,
    hiddenInput("candidateId", model.packet.candidateId),
    hiddenInput("taskId", task.resolutionTaskId),
    hiddenInput("triageAttemptId", model.triageAttemptId),
    hiddenInput("expectedTaskHeadVersion", String(model.expectedTaskHeadVersion ?? "")),
    hiddenInput("expectedCandidateHeadVersion", String(model.expectedCandidateHeadVersion ?? "")),
    `      <p class="muted" style="font-size:12px;margin:8px 0">Demo-only fixture path. Registers the correction overlay, runs the extraction scheduler, and completes through the system-only use case. The browser does not select the system actor.</p>`,
    `      <button type="submit" class="inspector-btn" data-testid="${TEST_IDS.COMPLETE_FIXTURE_BTN}">Complete fixture extraction</button>`,
    `    </form>`
  ].join("\n");
}

function inspectorBody(model: PacketInspectorModel): string {
  if (model.task === undefined) {
    return `    <p class="muted" style="font-size:13px">No current open resolution task.</p>`;
  }

  const task = model.task;
  const refreshHref = hrefWithAppearance(
    `/packet/${encodeURIComponent(model.packet.candidateId)}`,
    model.appearance
  );
  const lines = [
    `    <div class="caps">Current task</div>`,
    `    <div class="mono" style="font-size:12px;margin:6px 0" data-testid="${TEST_IDS.TASK_ITEM(task.resolutionTaskId)}">${escapeHtml(task.resolutionTaskId)}</div>`,
    `    <div class="mono" style="font-size:12px">reason: ${escapeHtml(task.reasonCode)}</div>`,
    `    <div class="mono" style="font-size:12px">status: <span data-testid="${TEST_IDS.TASK_STATUS(task.resolutionTaskId)}">${escapeHtml(task.status)}</span></div>`,
    versionLine("task head version", model.expectedTaskHeadVersion),
    versionLine("candidate head version", model.expectedCandidateHeadVersion),
    `    <div class="mono" style="font-size:12px;margin:8px 0 12px">Actor: human:operator (fixed)</div>`
  ];

  if (model.historical) {
    lines.push(
      `    <p class="muted" style="font-size:13px">Inspecting a historical result. Mutations apply to the current head.</p>`
    );
    return lines.join("\n");
  }

  if (!model.correctionFixtureMode) {
    lines.push(
      `    <p class="muted" style="font-size:13px">Correction mutations are disabled. Start with make demo-web-correction.</p>`
    );
    return lines.join("\n");
  }

  if (!model.fixtureCandidate) {
    lines.push(
      `    <p class="muted" style="font-size:13px">Request re-extraction is live-mode-only. This candidate is not the pre-scripted fixture path (demo/route-4-reviewable-failure).</p>`
    );
    return lines.join("\n");
  }

  lines.push(
    `    <div class="fixture-mark" data-testid="${TEST_IDS.FIXTURE_MODE_MARK}">Pre-scripted fixture candidate</div>`
  );

  if (model.freezeSubmit || model.conflictMessage !== undefined) {
    lines.push(requestForm(model));
    lines.push(
      `    <p style="margin-top:10px"><a href="${escapeHtml(refreshHref)}" class="link">Refresh to the current head</a></p>`
    );
    return lines.join("\n");
  }

  if (model.inFlight || model.triageAttemptId !== undefined) {
    if (task.status === "open") {
      lines.push(completeForm(model));
    } else {
      lines.push(
        `    <p class="muted" style="font-size:13px">This task is ${escapeHtml(task.status)}. Fixture completion is not available.</p>`
      );
    }
    return lines.join("\n");
  }

  if (task.status !== "open") {
    lines.push(
      `    <p class="muted" style="font-size:13px">This task is ${escapeHtml(task.status)}. Request re-extraction requires an open task.</p>`
    );
    return lines.join("\n");
  }

  lines.push(requestForm(model));
  return lines.join("\n");
}

export function renderTaskInspector(model: PacketInspectorModel): string {
  return [
    `  <aside class="packet-inspector" data-testid="${TEST_IDS.TASK_INSPECTOR}">`,
    noticeBand(model.notice),
    inspectorBody(model),
    `  </aside>`
  ].join("\n");
}

export function renderPriorResultLink(
  candidateId: string,
  appearance: PacketInspectorModel["appearance"],
  priorResultId: string | undefined
): string {
  if (priorResultId === undefined) {
    return "";
  }
  const href = packetHref(candidateId, appearance, priorResultId);
  return `<a href="${escapeHtml(href)}" class="link mono" style="font-size:12px" data-testid="${TEST_IDS.PRIOR_VERSION_LINK}">Inspect original result</a>`;
}
