import type { SystemStatusSummary } from "@recruitos/cli";
import { escapeHtml } from "./safe-text.js";

export type GlobalBarProps = Readonly<{
  status?: SystemStatusSummary | undefined;
  roleTitle?: string | undefined;
  theme?: string | undefined;
  density?: string | undefined;
}>;

/**
 * RecruitOS Global Chrome Bar:
 * Synthetic data pill, open tasks count, known limitations, active run tag.
 */
export function renderGlobalBar(props?: GlobalBarProps): string {
  const roleTitle = props?.roleTitle ?? "Applied AI Engineer";
  const runTag = props?.status ? `${props.status.activeRunId} ${props.status.isSealed ? "sealed" : "active"}` : "run-7 sealed";
  const openTasks = props?.status?.openTasksCount ?? 41;
  const knownLimitations = props?.status?.knownLimitationsCount ?? 3;
  const theme = props?.theme ?? "light";
  const density = props?.density ?? "default";

  return [
    `<header class="globalbar" data-testid="global-bar">`,
    `  <a href="/triage" class="brand" style="color:inherit;text-decoration:none">RecruitOS</a>`,
    `  <span class="muted">${escapeHtml(roleTitle)}</span>`,
    `  <span class="mono muted" style="font-size:12px">${escapeHtml(runTag)}</span>`,
    `  <span class="sep">&#124;</span>`,
    `  <span class="pill-synthetic">Synthetic data</span>`,
    `  <span class="sep">&#124;</span>`,
    `  <a href="/review" class="mono link" style="font-size:12px">${openTasks} open tasks</a>`,
    `  <span class="sep">&#124;</span>`,
    `  <a href="/status" class="mono link" style="font-size:12px">${knownLimitations} known limitations</a>`,
    `  <span class="spacer"></span>`,
    `  <a href="?theme=${theme === 'light' ? 'dark' : 'light'}&amp;density=${density}" class="mono muted" style="font-size:12px;text-decoration:none">theme: ${theme}</a>`,
    `  <span class="sep">&#124;</span>`,
    `  <span style="font-size:13px">Operator &#9662;</span>`,
    `</header>`
  ].join("\n");
}
