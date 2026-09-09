import type { CandidatePacket } from "@recruitos/cli";
import { RUBRIC_V1 } from "@recruitos/core";
import { TEST_IDS } from "../testids.js";

export type EvidenceCoverageCell = "supporting" | "contradicting" | "gap" | "unavailable";

export function coverageCellsForPacket(
  packet: CandidatePacket | null
): readonly EvidenceCoverageCell[] {
  const dimensions = RUBRIC_V1.dimensions;
  if (packet === null) {
    return dimensions.map(() => "unavailable");
  }
  return dimensions.map((dimension) => {
    const spans = packet.evidenceSpans.filter(
      (span) => span.dimensionId === dimension.dimensionId
    );
    if (spans.some((span) => span.polarity === "contradicting")) {
      return "contradicting";
    }
    if (spans.some((span) => span.polarity === "supporting")) {
      return "supporting";
    }
    if (packet.evidenceGaps.some((gap) => gap.dimensionId === dimension.dimensionId)) {
      return "gap";
    }
    return "unavailable";
  });
}

function cellClass(cell: EvidenceCoverageCell): string {
  if (cell === "supporting") return "sup";
  if (cell === "contradicting") return "con";
  if (cell === "gap") return "gap";
  return "na";
}

export function renderEvidenceCoverageStrip(
  cells: readonly EvidenceCoverageCell[]
): string {
  const unavailable = cells.length > 0 && cells.every((cell) => cell === "unavailable");
  const inner = cells.map((cell) => `<i class="${cellClass(cell)}"></i>`).join("");
  const unavailableAttr = unavailable ? ` data-coverage="unavailable"` : "";
  return `<span class="strip" data-testid="${TEST_IDS.EVIDENCE_STRIP}"${unavailableAttr}>${inner}</span>`;
}
