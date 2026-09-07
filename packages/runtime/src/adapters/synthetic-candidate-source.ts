import { ok, err, type Result } from "@recruitos/core";

import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import type {
  CandidateSourceAdapter,
  CandidateSourceDescriptor,
  CandidateSourcePage,
  CandidateSourceRecord,
  CandidateSourceRequest
} from "./candidate-source.js";

export const SYNTHETIC_CANDIDATE_SOURCE_ADAPTER_ID =
  "synthetic-candidate-source";
export const SYNTHETIC_CANDIDATE_SOURCE_SYSTEM = "ats_synthetic";
export const SYNTHETIC_CANDIDATE_SOURCE_CONTRACT_VERSION = 1;

export type SyntheticCandidateSourceAdapterOptions = Readonly<{
  adapterId?: string;
  sourceSystem?: string;
  contractVersion?: number;
  records?: readonly CandidateSourceRecord[];
}>;

export class SyntheticCandidateSourceAdapter
  implements CandidateSourceAdapter
{
  readonly descriptor: CandidateSourceDescriptor;
  private readonly records: CandidateSourceRecord[];

  constructor(options: SyntheticCandidateSourceAdapterOptions = {}) {
    this.descriptor = Object.freeze({
      adapterId: options.adapterId ?? SYNTHETIC_CANDIDATE_SOURCE_ADAPTER_ID,
      sourceSystem: options.sourceSystem ?? SYNTHETIC_CANDIDATE_SOURCE_SYSTEM,
      contractVersion:
        options.contractVersion ?? SYNTHETIC_CANDIDATE_SOURCE_CONTRACT_VERSION
    });

    this.records = options.records ? [...options.records] : [];
  }

  hasCandidate(sourceKey: string): boolean {
    return this.records.some((record) => record.sourceKey === sourceKey);
  }

  registerCandidate(record: CandidateSourceRecord): void {
    if (
      record === null ||
      typeof record !== "object" ||
      Array.isArray(record)
    ) {
      throw new TypeError("Candidate source record must be an object");
    }
    if (typeof record.sourceKey !== "string" || record.sourceKey.length === 0) {
      throw new TypeError("Candidate sourceKey must be a non-empty string");
    }
    const existingIndex = this.records.findIndex(
      (existing) => existing.sourceKey === record.sourceKey
    );
    if (existingIndex >= 0) {
      this.records[existingIndex] = record;
    } else {
      this.records.push(record);
    }
  }

  async listCandidates(
    request: CandidateSourceRequest
  ): Promise<Result<CandidateSourcePage, RuntimeError>> {
    if (
      request === null ||
      typeof request !== "object" ||
      Array.isArray(request)
    ) {
      return err(
        createRuntimeError(
          "persistence_failed",
          "Candidate source request must be a non-null object",
          false
        )
      );
    }

    if (
      typeof request.limit !== "number" ||
      !Number.isInteger(request.limit) ||
      request.limit <= 0
    ) {
      return err(
        createRuntimeError(
          "persistence_failed",
          "Candidate source request limit must be a positive integer",
          false
        )
      );
    }

    let startIndex = 0;
    if (request.cursor !== undefined) {
      if (typeof request.cursor !== "string") {
        return err(
          createRuntimeError(
            "persistence_failed",
            "Candidate source request cursor must be a string or undefined",
            false
          )
        );
      }

      const matchIndex = this.records.findIndex(
        (record) => record.sourceKey === request.cursor
      );
      if (matchIndex === -1) {
        return err(
          createRuntimeError(
            "persistence_failed",
            `Invalid cursor: ${request.cursor}`,
            false,
            { cursor: request.cursor }
          )
        );
      }
      startIndex = matchIndex + 1;
    }

    const endIndex = Math.min(startIndex + request.limit, this.records.length);
    const pageRecords = Object.freeze(this.records.slice(startIndex, endIndex));
    const hasMore = endIndex < this.records.length;
    const nextCursor = hasMore
      ? pageRecords[pageRecords.length - 1]!.sourceKey
      : undefined;

    return ok(
      Object.freeze({
        descriptor: this.descriptor,
        records: pageRecords,
        nextCursor
      })
    );
  }
}

export function createSyntheticCandidateSourceAdapter(
  options?: SyntheticCandidateSourceAdapterOptions
): SyntheticCandidateSourceAdapter {
  return new SyntheticCandidateSourceAdapter(options);
}
