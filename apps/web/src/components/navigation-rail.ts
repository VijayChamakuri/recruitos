import { hrefWithAppearance, packetHref, type Appearance } from "../appearance.js";
import { escapeHtml } from "./safe-text.js";

export type NavItem = Readonly<{
  label: string;
  href: string;
  count?: number;
  id: string;
}>;

export type NavigationRailProps = Readonly<{
  activeDestination: string;
  appearance: Appearance;
  candidateCount?: number | undefined;
  openTasksCount?: number | undefined;
  pendingProposalsCount?: number | undefined;
  auditEventsCount?: number | undefined;
  limitationsCount?: number | undefined;
  packetCandidateId?: string | undefined;
  reasonCodeCounts?: readonly { code: string; count: number }[] | undefined;
}>;

function countMarkup(count: number | undefined): string {
  return count !== undefined ? `<span class="n">${count}</span>` : "";
}

/**
 * 5 Locked Destinations Rail per DESIGN.md:
 * - Triage Queue (/triage)
 * - Resolution Queue (/review)
 * - Candidate Packet (/packet)
 * - Audit Runs (/runs)
 * - System Status (/status)
 */
export function renderNavigationRail(props: NavigationRailProps): string {
  const appearance = props.appearance;
  const packetHrefValue = props.packetCandidateId
    ? packetHref(props.packetCandidateId, appearance)
    : hrefWithAppearance("/triage", appearance);

  const destinations: readonly NavItem[] = [
    {
      id: "triage",
      label: "Triage Queue",
      href: hrefWithAppearance("/triage", appearance),
      ...(props.candidateCount === undefined ? {} : { count: props.candidateCount })
    },
    {
      id: "review",
      label: "Resolution Queue",
      href: hrefWithAppearance("/review", appearance),
      ...(props.openTasksCount === undefined ? {} : { count: props.openTasksCount })
    },
    { id: "packet", label: "Candidate Packet", href: packetHrefValue, count: 1 },
    {
      id: "runs",
      label: "Audit Timeline",
      href: hrefWithAppearance("/runs", appearance),
      ...(props.auditEventsCount === undefined ? {} : { count: props.auditEventsCount })
    },
    {
      id: "status",
      label: "System Status",
      href: hrefWithAppearance("/status", appearance),
      ...(props.limitationsCount === undefined ? {} : { count: props.limitationsCount })
    }
  ];

  const items = destinations.map((d) => {
    const isActive = props.activeDestination === d.id;
    const activeClass = isActive ? " active" : "";
    return [
      `  <a href="${escapeHtml(d.href)}" class="item${activeClass}" data-testid="nav-${d.id}" style="text-decoration:none">`,
      `    <span>${escapeHtml(d.label)}</span>`,
      `    ${countMarkup(d.count)}`,
      `  </a>`
    ].join("\n");
  });

  const reasonRows =
    props.reasonCodeCounts === undefined || props.reasonCodeCounts.length === 0
      ? `  <div class="item"><span class="mono" style="font-size:12px">none in this run</span></div>`
      : props.reasonCodeCounts
          .map(
            (row) =>
              `  <div class="item"><span class="mono" style="font-size:12px">${escapeHtml(row.code)}</span><span class="n">${row.count}</span></div>`
          )
          .join("\n");

  return [
    `<nav class="rail" data-testid="navigation-rail">`,
    `  <div class="group caps">Destinations</div>`,
    items.join("\n"),
    `  <div class="group caps" style="margin-top:16px">Reason codes</div>`,
    reasonRows,
    `</nav>`
  ].join("\n");
}
