export type {
  ExtractionAdapter,
  ExtractionAdapterDescriptor,
  ExtractionAdapterMode,
  ExtractionInputDocument,
  ExtractionRequest,
  ExtractionResponse
} from "./extraction.js";
export {
  FIXTURE_EXTRACTION_ADAPTER_ID,
  FIXTURE_EXTRACTION_CONTRACT_VERSION,
  FixtureExtractionAdapter,
  createFixtureExtractionAdapter,
  type FixtureExtractionAdapterOptions
} from "./fixture-extraction.js";
export type {
  ApplicationAnswerProvenance,
  CandidateApplicationAnswers,
  CandidateSourceAdapter,
  CandidateSourceDescriptor,
  CandidateSourceDocument,
  CandidateSourcePage,
  CandidateSourceRecord,
  CandidateSourceRequest,
  StructuredApplicationAnswer
} from "./candidate-source.js";
export {
  SYNTHETIC_CANDIDATE_SOURCE_ADAPTER_ID,
  SYNTHETIC_CANDIDATE_SOURCE_SYSTEM,
  SYNTHETIC_CANDIDATE_SOURCE_CONTRACT_VERSION,
  SyntheticCandidateSourceAdapter,
  createSyntheticCandidateSourceAdapter,
  type SyntheticCandidateSourceAdapterOptions
} from "./synthetic-candidate-source.js";
