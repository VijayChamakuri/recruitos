import { ok, err, sha256Hex, type Result } from "@recruitos/core";

import { createRuntimeError, type RuntimeError } from "../errors/index.js";
import type {
  ExtractionAdapter,
  ExtractionAdapterDescriptor,
  ExtractionRequest,
  ExtractionResponse
} from "./extraction.js";

export const FIXTURE_EXTRACTION_ADAPTER_ID = "fixture-extraction";
export const FIXTURE_EXTRACTION_CONTRACT_VERSION = 1;

export type FixtureExtractionAdapterOptions = Readonly<{
  adapterId?: string;
  contractVersion?: number;
  fixtures?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
}>;

export class FixtureExtractionAdapter implements ExtractionAdapter {
  readonly descriptor: ExtractionAdapterDescriptor;
  private readonly fixtures: Map<string, string>;

  constructor(options: FixtureExtractionAdapterOptions = {}) {
    this.descriptor = Object.freeze({
      adapterId: options.adapterId ?? FIXTURE_EXTRACTION_ADAPTER_ID,
      mode: "fixture",
      contractVersion:
        options.contractVersion ?? FIXTURE_EXTRACTION_CONTRACT_VERSION
    });

    this.fixtures = new Map();
    if (options.fixtures instanceof Map) {
      for (const [key, value] of options.fixtures.entries()) {
        this.fixtures.set(key, value);
      }
    } else if (options.fixtures && typeof options.fixtures === "object") {
      for (const [key, value] of Object.entries(options.fixtures)) {
        this.fixtures.set(key, value);
      }
    }
  }

  hasFixture(specHash: string): boolean {
    return this.fixtures.has(specHash);
  }

  registerFixture(specHash: string, body: string): void {
    if (typeof specHash !== "string" || specHash.length === 0) {
      throw new TypeError("Fixture spec hash must be a non-empty string");
    }
    if (typeof body !== "string") {
      throw new TypeError("Fixture body must be a string");
    }
    this.fixtures.set(specHash, body);
  }

  async extract(
    request: ExtractionRequest
  ): Promise<Result<ExtractionResponse, RuntimeError>> {
    if (
      request === null ||
      typeof request !== "object" ||
      Array.isArray(request)
    ) {
      return err(
        createRuntimeError(
          "persistence_failed",
          "Extraction request must be a non-null object",
          false
        )
      );
    }

    if (
      typeof request.extractionSpecHash !== "string" ||
      request.extractionSpecHash.length === 0
    ) {
      return err(
        createRuntimeError(
          "persistence_failed",
          "Extraction request requires a non-empty extractionSpecHash",
          false
        )
      );
    }

    if (!Array.isArray(request.documents)) {
      return err(
        createRuntimeError(
          "persistence_failed",
          "Extraction request documents must be an array",
          false
        )
      );
    }

    if (typeof request.instructions !== "string") {
      return err(
        createRuntimeError(
          "persistence_failed",
          "Extraction request instructions must be a string",
          false
        )
      );
    }

    const body = this.fixtures.get(request.extractionSpecHash);
    if (body === undefined) {
      return err(
        createRuntimeError(
          "persistence_failed",
          `Fixture not found for extraction spec hash: ${request.extractionSpecHash}`,
          false,
          { extractionSpecHash: request.extractionSpecHash }
        )
      );
    }

    const bodyHash = sha256Hex(body);

    return ok(
      Object.freeze({
        extractionSpecHash: request.extractionSpecHash,
        descriptor: this.descriptor,
        body,
        bodyHash
      })
    );
  }
}

export function createFixtureExtractionAdapter(
  options?: FixtureExtractionAdapterOptions
): FixtureExtractionAdapter {
  return new FixtureExtractionAdapter(options);
}
