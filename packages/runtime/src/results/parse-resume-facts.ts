import { IsoYearMonthSchema } from "@recruitos/core";

import type { RawFactProposalInput } from "./derive-candidate-result.js";

/**
 * A deterministic reader for one fixture-only resume format.
 *
 * It looks for a line that is exactly `EXPERIENCE (STRUCTURED)` and then reads
 * every following non-blank line up to the next blank line or end of document
 * as a role: `Title | Employer | YYYY-MM | YYYY-MM` or `Title | Employer |
 * YYYY-MM | present`. Parsing is all or nothing: if any line in that block is
 * not a well formed role, the document contributes no facts at all. This is
 * deliberate. A partial parse could hide older history and make a candidate
 * look conclusively under the experience floor when the truth is only that the
 * history is incomplete.
 *
 * Each role yields an `employment_interval` and an `employer_history_entry`
 * proposal, and the most recent role also yields a `current_title` proposal.
 * Every proposal cites the source document and carries the verbatim role line
 * as a grounding quote, so the bridge confirms the quote is present before the
 * fact is accepted; the deterministic reader plus the cited document is the
 * grounding, so no evidence span is pinned.
 *
 * This is not a general resume parser. Real resumes do not carry the
 * `EXPERIENCE (STRUCTURED)` sentinel or pipe-delimited ISO months, so they
 * contribute nothing. A natural-language parser is post-review work; the job
 * here is to let the demo corpus resolve years of experience, current title,
 * and employer history so at least one route reaches `scored`.
 */

export type ResumeFactDocument = Readonly<{
  candidateDocumentId: string;
  documentKind: string;
  normalizedText: string;
}>;

const EXPERIENCE_HEADER = "EXPERIENCE (STRUCTURED)";
const FIELD_SEPARATOR = " | ";
const PRESENT = "present";

type ParsedRole = Readonly<{
  title: string;
  employer: string;
  startMonth: string;
  endMonth: string;
  line: string;
}>;

function parseRoleLine(line: string): ParsedRole | undefined {
  const parts = line.split(FIELD_SEPARATOR);
  if (parts.length !== 4) {
    return undefined;
  }
  const [rawTitle, rawEmployer, rawStart, rawEnd] = parts;
  const title = rawTitle!.trim();
  const employer = rawEmployer!.trim();
  const startMonth = rawStart!.trim();
  const endMonth = rawEnd!.trim();
  if (title.length === 0 || employer.length === 0) {
    return undefined;
  }
  if (!IsoYearMonthSchema.safeParse(startMonth).success) {
    return undefined;
  }
  if (endMonth !== PRESENT && !IsoYearMonthSchema.safeParse(endMonth).success) {
    return undefined;
  }
  if (endMonth !== PRESENT && endMonth < startMonth) {
    return undefined;
  }
  return { title, employer, startMonth, endMonth, line };
}

/**
 * Reads the contiguous block after the sentinel. Returns the roles, or
 * `undefined` if the block is empty or any line in it is malformed.
 */
function collectRoles(normalizedText: string): readonly ParsedRole[] | undefined {
  const lines = normalizedText.split("\n");
  const headerIndex = lines.findIndex((line) => line.trim() === EXPERIENCE_HEADER);
  if (headerIndex === -1) {
    return undefined;
  }
  const roles: ParsedRole[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      break;
    }
    const role = parseRoleLine(line);
    if (role === undefined) {
      return undefined;
    }
    roles.push(role);
  }
  return roles.length > 0 ? roles : undefined;
}

function mostRecentRole(roles: readonly ParsedRole[]): ParsedRole {
  let latest = roles[0]!;
  for (const role of roles) {
    const roleKey = role.endMonth === PRESENT ? "9999-99" : role.startMonth;
    const latestKey = latest.endMonth === PRESENT ? "9999-99" : latest.startMonth;
    if (roleKey > latestKey) {
      latest = role;
    }
  }
  return latest;
}

/**
 * Parses `resume` documents into parsed structured-fact proposals for the
 * bridge. Non-resume documents and documents without a well formed
 * `EXPERIENCE (STRUCTURED)` block contribute nothing.
 */
export function parseResumeFacts(
  documents: readonly ResumeFactDocument[]
): readonly RawFactProposalInput[] {
  const proposals: RawFactProposalInput[] = [];
  for (const document of documents) {
    if (document.documentKind !== "resume") {
      continue;
    }
    const roles = collectRoles(document.normalizedText);
    if (roles === undefined) {
      continue;
    }
    const current = mostRecentRole(roles);
    for (const role of roles) {
      const endMonth =
        role.endMonth === PRESENT
          ? ("present" as const)
          : IsoYearMonthSchema.parse(role.endMonth);
      const grounding = [{ quotedText: role.line, polarity: "supporting" as const }];
      proposals.push({
        documentId: document.candidateDocumentId,
        provenance: "parsed",
        payload: {
          kind: "employment_interval",
          employer: role.employer,
          title: role.title,
          startMonth: IsoYearMonthSchema.parse(role.startMonth),
          endMonth
        },
        groundingQuotes: grounding
      });
      proposals.push({
        documentId: document.candidateDocumentId,
        provenance: "parsed",
        payload: {
          kind: "employer_history_entry",
          employer: role.employer,
          startMonth: IsoYearMonthSchema.parse(role.startMonth),
          endMonth
        },
        groundingQuotes: grounding
      });
    }
    proposals.push({
      documentId: document.candidateDocumentId,
      provenance: "parsed",
      payload: { kind: "current_title", title: current.title },
      groundingQuotes: [{ quotedText: current.line, polarity: "supporting" as const }]
    });
  }
  return proposals;
}
