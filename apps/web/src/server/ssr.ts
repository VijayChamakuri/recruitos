import type { SystemStatusSummary } from "@recruitos/cli";
import { renderGlobalBar } from "../components/global-bar.js";
import { renderNavigationRail } from "../components/navigation-rail.js";
import { escapeHtml } from "../components/safe-text.js";
import { TOKENS_CSS } from "../tokens.js";

export type PageRenderOptions = Readonly<{
  title: string;
  activeDestination: "triage" | "review" | "packet" | "runs" | "status";
  status?: SystemStatusSummary | undefined;
  theme?: ("light" | "dark") | undefined;
  density?: ("compact" | "default" | "comfortable") | undefined;
  contentHtml: string;
}>;

/**
 * Server-Side Renderer for RecruitOS Variant B Bench layout.
 */
export function renderPage(options: PageRenderOptions): string {
  const theme = options.theme ?? "light";
  const density = options.density ?? "default";
  const title = options.title;

  const globalBarHtml = renderGlobalBar({
    status: options.status,
    theme,
    density
  });

  const railHtml = renderNavigationRail({
    activeDestination: options.activeDestination,
    candidateCount: options.status?.candidateCount,
    openTasksCount: options.status?.openTasksCount,
    pendingProposalsCount: options.status?.pendingProposalsCount,
    auditEventsCount: options.status?.auditEventsCount,
    limitationsCount: options.status?.knownLimitationsCount
  });

  return `<!doctype html>
<html lang="en" data-theme="${theme}" data-density="${density}">
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
