export { runCli, CLI_VERSION, type RunCliOptions } from "./cli.js";
export { parseArgs, type ParsedArgs } from "./parser.js";
export {
  EXIT_SUCCESS,
  EXIT_DOMAIN_ERROR,
  EXIT_USAGE_ERROR,
  EXIT_RUNTIME_ERROR,
  mapErrorToExitCode
} from "./exit-codes.js";
export {
  createSuccessEnvelope,
  createErrorEnvelope,
  formatEnvelopeJson,
  formatTable,
  type CliEnvelope,
  type CliSuccessEnvelope,
  type CliErrorEnvelope,
  type CliMeta
} from "./envelopes.js";
export {
  type RecruitosComposition,
  type CandidateSummary,
  type CandidatePacket,
  type ArithmeticTerm,
  type EvidenceSpan,
  type EvidenceGap,
  type ResolutionTaskSummary,
  type ResolutionTaskDetail,
  type ProposalSummary,
  type SystemStatusSummary,
  type AuditEventSummary,
  createStubComposition,
  StubRecruitosComposition,
  createCompositionFromRuntime,
  createDefaultRuntimeComposition,
  RuntimeRecruitosComposition
} from "./composition/index.js";
export { formatHelp, type CommandResult } from "./commands/index.js";
