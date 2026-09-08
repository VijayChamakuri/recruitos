import {
  createErrorEnvelope,
  createSuccessEnvelope,
  formatEnvelopeJson,
  formatTable
} from "../envelopes.js";
import { EXIT_SUCCESS, EXIT_USAGE_ERROR, mapErrorToExitCode } from "../exit-codes.js";
import type { ParsedArgs } from "../parser.js";
import type {
  ArithmeticTerm,
  CandidatePacket,
  EvidenceGap,
  EvidenceSpan,
  RecruitosComposition
} from "../composition/types.js";
import type { CommandResult } from "./triage.js";

export async function runPacketCommand(
  args: ParsedArgs,
  composition: RecruitosComposition,
  startTime: number
): Promise<CommandResult> {
  const candidateId = args.options.candidate ?? args.positionals[0];

  if (!candidateId) {
    const durationMs = Date.now() - startTime;
    const msg = "Candidate ID is required. Usage: recruitos packet <candidate-id>";
    if (args.flags.json) {
      return {
        exitCode: EXIT_USAGE_ERROR,
        stderr: formatEnvelopeJson(
          createErrorEnvelope("packet", "missing_candidate_id", msg, EXIT_USAGE_ERROR, durationMs)
        )
      };
    }
    return {
      exitCode: EXIT_USAGE_ERROR,
      stderr: `Usage error: ${msg}`
    };
  }

  const packetResult = await composition.getCandidatePacket(candidateId);
  const durationMs = Date.now() - startTime;

  if (!packetResult.ok) {
    const exitCode = mapErrorToExitCode(packetResult.error.code);
    if (args.flags.json) {
      return {
        exitCode,
        stderr: formatEnvelopeJson(
          createErrorEnvelope(
            "packet",
            packetResult.error.code,
            packetResult.error.message,
            exitCode,
            durationMs,
            packetResult.error.details
          )
        )
      };
    }
    return {
      exitCode,
      stderr: `Error [${packetResult.error.code}]: ${packetResult.error.message}`
    };
  }

  const packet: CandidatePacket = packetResult.value;

  if (args.flags.json) {
    return {
      exitCode: EXIT_SUCCESS,
      stdout: formatEnvelopeJson(createSuccessEnvelope("packet", packet, durationMs))
    };
  }

  const format = args.options.format ?? "full";
  const lines: string[] = [
    `RecruitOS Candidate Evaluation Packet: ${packet.candidateId}`,
    "=".repeat(60),
    `Source Key:   ${packet.sourceKey}`,
    ...(packet.roleId === "role-default"
      ? []
      : [`Role:         ${packet.roleTitle} (${packet.roleId})`]),
    `Channel:      ${packet.channel}`,
    `Status:       ${packet.status}`,
    `Score:        ${packet.scoreText ?? (packet.score !== null ? packet.score.toFixed(1) : "-")}`,
    `Confidence:   ${packet.confidenceText ?? (packet.confidence !== null ? `${Math.round(packet.confidence * 100)}%` : "-")}`,
    `Sealed:       ${packet.sealed ? "yes" : "no"}`,
    `Content Hash: ${packet.contentHash}`
  ];

  if (packet.confidenceInput !== null) {
    lines.push("");
    lines.push("Confidence Inputs:");
    lines.push(
      `  Dimension coverage: ${packet.confidenceInput.dimensionsWithLocatedSpan}/${packet.confidenceInput.totalDimensions}`,
      `  Quote resolution:   ${packet.confidenceInput.spansLocated}/${packet.confidenceInput.spansReturned}`,
      `  Contradictions:     ${packet.confidenceInput.contradictionCount}`,
      `  Required missing:   ${packet.confidenceInput.requiredFieldsMissing}/${packet.confidenceInput.totalRequiredFields}`
    );
  }

  lines.push("");
  lines.push(`Reasons (${packet.reasons.length}):`);
  lines.push(
    ...(packet.reasons.length === 0
      ? ["  none"]
      : packet.reasons.map((reason) => `  ${reason}`))
  );

  if (format === "full" || format === "arithmetic") {
    lines.push("");
    lines.push("Arithmetic Score Decomposition (5-Column Matrix):");
    const arithHeaders = ["Dimension", "Weight", "Level", "Level Score", "Weighted Score"];
    const arithRows = packet.arithmeticTerms.map((term: ArithmeticTerm) => [
      term.dimensionName,
      `${term.weight.toFixed(1)}%`,
      term.level,
      term.levelScore.toFixed(1),
      term.weightedScore.toFixed(2)
    ]);
    lines.push(formatTable(arithHeaders, arithRows));
  }

  if (format === "full" || format === "evidence") {
    lines.push("");
    lines.push(`Evidence Spans (${packet.evidenceSpans.length}):`);
    if (packet.evidenceSpans.length === 0) {
      lines.push("  (no evidence spans recorded)");
    } else {
      const spanHeaders = ["Dimension", "Polarity", "Quality", "Quoted Span"];
      const spanRows = packet.evidenceSpans.map((s: EvidenceSpan) => [
        s.dimensionId,
        s.polarity,
        s.matchQuality,
        `"${s.quotedText.slice(0, 45)}${s.quotedText.length > 45 ? "..." : ""}"`
      ]);
      lines.push(formatTable(spanHeaders, spanRows));
    }

    if (packet.evidenceGaps.length > 0) {
      lines.push("");
      lines.push(`Evidence Gaps (${packet.evidenceGaps.length}):`);
      const gapHeaders = ["Dimension", "Gap Description"];
      const gapRows = packet.evidenceGaps.map((g: EvidenceGap) => [g.dimensionId, g.reason]);
      lines.push(formatTable(gapHeaders, gapRows));
    }
  }

  if (format === "full" || format === "document") {
    lines.push("");
    lines.push(`Source Documents (${packet.documents.length}):`);
    for (const doc of packet.documents) {
      lines.push(`--- [${doc.label} (${doc.documentKind})] ---`);
      lines.push(doc.text);
    }
  }

  return {
    exitCode: EXIT_SUCCESS,
    stdout: lines.join("\n")
  };
}
