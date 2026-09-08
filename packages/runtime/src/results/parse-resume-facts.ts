import { IsoYearMonthSchema } from "@recruitos/core";

import type { RawFactProposalInput } from "./derive-candidate-result.js";

/**
 * A deterministic resume-fact parser for the synthetic demo corpus.
 *
 * It reads a machine-readable `EXPERIENCE` block: one pipe-delimited line per
 * role, `Title | Employer | YYYY-MM | YYYY-MM` or `Title | Employer | YYYY-MM |
 * present`. Each line yields an `employment_interval` and an
 * `employer_history_entry` fact, and the most recent role also yields a
 * `current_title` fact. The proposals carry `parsed` provenance, so like the
 * parsed work-authorization statement they are grounded by this parser rather
 * than by a relocated document quote. Anything it cannot parse is skipped.
 *
 * This is not a general resume parser. Real documents do not follow this
 * format; a natural-language parser is post-review work. Its only job here is
 * to let the finalize path resolve years of experience, current title, and
 * employer history for candidates the demo corpus authors to the format, so at
 * least one route can reach `scored`.
 */

export type ResumeFactDocument = Readonly<{
  candidateDocumentId: string;
  documentKind: string;
  normalizedText: string;
}>;

const EXPERIENCE_HEADER = "EXPERIENCE";
const FIELD_SEPARATOR = " | ";
const PRESENT = "present";

type ParsedRole = Readonly<{
  title: string;
  employer: string;
  startMonth: string;
  endMonth: string;
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
  return { title, employer, startMonth, endMonth };
}

function collectRoles(normalizedText: string): readonly ParsedRole[] {
  const lines = normalizedText.split("\n");
  const headerIndex = lines.findIndex((line) => line.trim() === EXPERIENCE_HEADER);
  if (headerIndex === -1) {
    return [];
  }
  const roles: ParsedRole[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      break;
    }
    const role = parseRoleLine(line);
    if (role === undefined) {
      break;
    }
    roles.push(role);
  }
  return roles;
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
 * Parses `resume` documents into grounded structured-fact proposals for the
 * bridge. Non-resume documents and documents without an `EXPERIENCE` block
 * contribute nothing.
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
    if (roles.length === 0) {
      continue;
    }
    const current = mostRecentRole(roles);
    for (const role of roles) {
      const endMonth =
        role.endMonth === PRESENT
          ? ("present" as const)
          : IsoYearMonthSchema.parse(role.endMonth);
      proposals.push({
        documentId: document.candidateDocumentId,
        provenance: "parsed",
        payload: {
          kind: "employment_interval",
          employer: role.employer,
          title: role.title,
          startMonth: IsoYearMonthSchema.parse(role.startMonth),
          endMonth
        }
      });
      proposals.push({
        documentId: document.candidateDocumentId,
        provenance: "parsed",
        payload: {
          kind: "employer_history_entry",
          employer: role.employer,
          startMonth: IsoYearMonthSchema.parse(role.startMonth),
          endMonth
        }
      });
    }
    proposals.push({
      documentId: document.candidateDocumentId,
      provenance: "parsed",
      payload: { kind: "current_title", title: current.title }
    });
  }
  return proposals;
}
