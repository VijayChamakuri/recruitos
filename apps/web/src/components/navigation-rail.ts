import { escapeHtml } from "./safe-text.js";

export type NavItem = Readonly<{
  label: string;
  href: string;
  count?: number;
  id: string;
}>;

export type NavigationRailProps = Readonly<{
  activeDestination: string;
  candidateCount?: number | undefined;
  openTasksCount?: number | undefined;
  pendingProposalsCount?: number | undefined;
  auditEventsCount?: number | undefined;
  limitationsCount?: number | undefined;
}>;

/**
 * 5 Locked Destinations Rail per DESIGN.md:
 * - Triage Queue (/triage)
 * - Resolution Queue (/review)
 * - Candidate Packet (/packet)
 * - Audit Runs (/runs)
 * - System Status (/status)
 */
export function renderNavigationRail(props: NavigationRailProps): string {
  const destinations: readonly NavItem[] = [
    { id: "triage", label: "Triage Queue", href: "/triage", count: props.candidateCount ?? 140 },
    { id: "review", label: "Resolution Queue", href: "/review", count: props.openTasksCount ?? 41 },
    { id: "packet", label: "Candidate Packet", href: "/packet/candidate-1", count: 1 },
    { id: "runs", label: "Audit Timeline", href: "/runs", count: props.auditEventsCount ?? 1842 },
    { id: "status", label: "System Status", href: "/status", count: props.limitationsCount ?? 3 }
  ];

  const items = destinations.map((d) => {
    const isActive = props.activeDestination === d.id;
    const activeClass = isActive ? " active" : "";
    return [
      `  <a href="${d.href}" class="item${activeClass}" data-testid="nav-${d.id}" style="text-decoration:none">`,
      `    <span>${escapeHtml(d.label)}</span>`,
      `    ${d.count !== undefined ? `<span class="n">${d.count}</span>` : ""}`,
      `  </a>`
    ].join("\n");
  });

  return [
    `<nav class="rail" data-testid="navigation-rail">`,
    `  <div class="group caps">Destinations</div>`,
    items.join("\n"),
    `  <div class="group caps" style="margin-top:16px">Reason codes</div>`,
    `  <div class="item"><span class="mono" style="font-size:12px">missing_evidence</span><span class="n">19</span></div>`,
    `  <div class="item"><span class="mono" style="font-size:12px">contradiction</span><span class="n">9</span></div>`,
    `  <div class="item"><span class="mono" style="font-size:12px">ambiguous</span><span class="n">7</span></div>`,
    `  <div class="item"><span class="mono" style="font-size:12px">low_confidence</span><span class="n">4</span></div>`,
    `</nav>`
  ].join("\n");
}
