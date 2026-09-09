import type { SystemStatusSummary } from "@recruitos/cli";
import { DEFAULT_APPEARANCE, type Appearance } from "../appearance.js";
import { renderGlobalBar } from "../components/global-bar.js";
import { renderNavigationRail } from "../components/navigation-rail.js";
import { escapeHtml } from "../components/safe-text.js";
import { TOKENS_CSS } from "../tokens.js";

export type PageRenderOptions = Readonly<{
  title: string;
  activeDestination: "triage" | "review" | "packet" | "runs" | "status";
  status?: SystemStatusSummary | undefined;
  appearance: Appearance;
  currentPath: string;
  contentHtml: string;
  outstandingTaskCount?: number | undefined;
  packetCandidateId?: string | undefined;
  reasonCodeCounts?: readonly { code: string; count: number }[] | undefined;
  roleTitle?: string | undefined;
  searchParams?: URLSearchParams | undefined;
}>;

/**
 * Server-Side Renderer for RecruitOS Variant B Bench layout.
 */
export function renderPage(options: PageRenderOptions): string {
  const appearance = options.appearance ?? DEFAULT_APPEARANCE;
  const title = options.title;

  const globalBarHtml = renderGlobalBar({
    status: options.status,
    appearance,
    currentPath: options.currentPath,
    ...(options.outstandingTaskCount === undefined
      ? {}
      : { outstandingTaskCount: options.outstandingTaskCount }),
    ...(options.roleTitle === undefined ? {} : { roleTitle: options.roleTitle }),
    ...(options.searchParams === undefined ? {} : { searchParams: options.searchParams })
  });

  const railHtml = renderNavigationRail({
    activeDestination: options.activeDestination,
    appearance,
    candidateCount: options.status?.candidateCount,
    openTasksCount: options.outstandingTaskCount ?? options.status?.openTasksCount,
    pendingProposalsCount: options.status?.pendingProposalsCount,
    auditEventsCount: options.status?.auditEventsCount,
    limitationsCount: options.status?.knownLimitationsCount,
    packetCandidateId: options.packetCandidateId,
    reasonCodeCounts: options.reasonCodeCounts
  });

  return `<!doctype html>
<html lang="en" data-theme="${appearance.theme}" data-density="${appearance.density}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - RecruitOS</title>
  <style>
${TOKENS_CSS}
  </style>
</head>
<body>
  <div class="app">
    ${globalBarHtml}
    ${railHtml}
    <main class="work">
      ${options.contentHtml}
    </main>
  </div>
</body>
</html>`;
}
