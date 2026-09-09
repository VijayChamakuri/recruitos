import type { SystemStatusSummary } from "@recruitos/cli";
import { hrefWithAppearance, type Appearance } from "../appearance.js";
import { escapeHtml } from "./safe-text.js";
import { TEST_IDS } from "../testids.js";

export type GlobalBarProps = Readonly<{
  status?: SystemStatusSummary | undefined;
  roleTitle?: string | undefined;
  appearance: Appearance;
  currentPath?: string | undefined;
  searchParams?: URLSearchParams | undefined;
  outstandingTaskCount?: number | undefined;
}>;

/**
 * RecruitOS Global Chrome Bar:
 * SYNTHETIC DATA pill, open tasks count, known limitations, active run tag.
 */
export function renderGlobalBar(props: GlobalBarProps): string {
  const appearance = props.appearance;
  const roleTitle = props.roleTitle;
  const currentPath = props.currentPath ?? "/triage";
  const otherTheme = appearance.theme === "light" ? "dark" : "light";
  const themeHref = hrefWithAppearance(
    currentPath,
    { theme: otherTheme, density: appearance.density },
    props.searchParams
  );
  const runTag = props.status
    ? `${props.status.activeRunId} ${props.status.isSealed ? "sealed" : "active"}`
    : "status unavailable";
  const openTasks =
    props.outstandingTaskCount ?? props.status?.openTasksCount;
  const knownLimitations = props.status?.knownLimitationsCount;

  return [
    `<header class="globalbar" data-testid="global-bar">`,
    `  <a href="${escapeHtml(hrefWithAppearance("/triage", appearance))}" class="brand" style="color:inherit;text-decoration:none">RecruitOS</a>`,
    roleTitle
      ? `  <span class="muted">${escapeHtml(roleTitle)}</span>`
      : `  <span class="muted">RecruitOS</span>`,
    `  <span class="mono muted" style="font-size:12px">${escapeHtml(runTag)}</span>`,
    `  <span class="sep">&#124;</span>`,
    `  <span class="pill-synthetic" data-testid="${TEST_IDS.SYNTHETIC_DATA_PILL}">SYNTHETIC DATA</span>`,
    `  <span class="sep">&#124;</span>`,
    openTasks === undefined
      ? `  <span class="mono muted" style="font-size:12px">open tasks unavailable</span>`
      : `  <a href="${escapeHtml(hrefWithAppearance("/review", appearance))}" class="mono link" style="font-size:12px">${openTasks} open tasks</a>`,
    `  <span class="sep">&#124;</span>`,
    knownLimitations === undefined
      ? `  <span class="mono muted" style="font-size:12px">limitations unavailable</span>`
      : `  <a href="${escapeHtml(hrefWithAppearance("/status", appearance))}" class="mono link" style="font-size:12px">${knownLimitations} known limitations</a>`,
    `  <span class="spacer"></span>`,
    `  <a href="${escapeHtml(themeHref)}" class="mono muted" style="font-size:12px;text-decoration:none">theme: ${appearance.theme}</a>`,
    `  <span class="sep">&#124;</span>`,
    `  <span class="mono muted" style="font-size:12px">density: ${appearance.density}</span>`,
    `</header>`
  ].join("\n");
}
