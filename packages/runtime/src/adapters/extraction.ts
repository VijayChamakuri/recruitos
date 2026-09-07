import type { Result } from "@recruitos/core";

import type { RuntimeError } from "../errors/index.js";

/**
 * The extraction port. Fixture and live variants implement this one shape, so
 * the validator, the scheduler, and every call-count assertion see the same
 * boundary regardless of where the bytes came from.
 *
 * Nothing here knows about rubrics, dimensions, or levels. The request carries
 * an opaque specification hash and the documents to read; the response carries
 * an unvalidated body. Meaning is assigned later, by a validator this module
 * deliberately does not reference.
 *
 * This file declares types only. It performs no I/O and imports no provider
 * SDK; an implementation supplies those and stays outside the contract.
 */

export type ExtractionAdapterMode = "fixture" | "live";

export type ExtractionAdapterDescriptor = Readonly<{
  adapterId: string;
  mode: ExtractionAdapterMode;
  /** Bumped when the request or response shape changes in a breaking way. */
  contractVersion: number;
}>;

/** A document the adapter is allowed to read, already normalized upstream. */
export type ExtractionInputDocument = Readonly<{
  documentId: string;
  documentKind: string;
  normalizedText: string;
  /** SHA-256 of `normalizedText`, so a recording can be matched exactly. */
  normalizedHash: string;
}>;

export type ExtractionRequest = Readonly<{
  /**
   * Content address of everything that determines the answer. Fixture lookup
   * keys on it, live recording writes under it, and replay compares against it.
   */
  extractionSpecHash: string;
  /** Opaque instruction text. The adapter never composes or edits it. */
  instructions: string;
  documents: readonly ExtractionInputDocument[];
}>;

export type ExtractionResponse = Readonly<{
  extractionSpecHash: string;
  descriptor: ExtractionAdapterDescriptor;
  /** Raw adapter output. Unparsed and untrusted until the validator runs. */
  body: string;
  /** SHA-256 of `body`, so the artifact can be stored content-addressed. */
  bodyHash: string;
}>;

export interface ExtractionAdapter {
  readonly descriptor: ExtractionAdapterDescriptor;
  extract(
    request: ExtractionRequest
  ): Promise<Result<ExtractionResponse, RuntimeError>>;
}
