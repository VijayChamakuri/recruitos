export { escapeHtml, validateSpanInterval, validateSpanContent } from "./components/safe-text.js";
export {
  renderSpanHighlight,
  renderAnnotatedDocument,
  type SpanHighlightProps
} from "./components/span-highlight.js";
export {
  renderSpanIntegrityFailure,
  type SpanIntegrityFailureProps
} from "./components/span-integrity-failure.js";
export { renderEvidenceGapCard } from "./components/evidence-gap-card.js";
export { renderInstrumentBand, type InstrumentBandProps } from "./components/instrument-band.js";
export { renderGlobalBar, type GlobalBarProps } from "./components/global-bar.js";
export { renderNavigationRail, type NavigationRailProps } from "./components/navigation-rail.js";
export {
  renderCandidatePacketView,
  type CandidatePacketViewProps
} from "./components/candidate-packet.js";
export { renderLevelChip, levelSegmentCount } from "./components/level-chip.js";
export { renderPriorResultLink, renderCurrentResultLink } from "./components/task-inspector.js";

export { handleRequest, type HttpResponse, type IncomingRequest } from "./server/handlers.js";
export { renderPage, type PageRenderOptions } from "./server/ssr.js";
export {
  getServerComposition,
  setServerComposition,
  resetServerComposition,
  openExplicitDatabaseComposition
} from "./server/composition.js";
export { createWebServer, parseWebServerOptions } from "./server/server.js";
export {
  parseAppearance,
  hrefWithAppearance,
  packetHref,
  DEFAULT_APPEARANCE
} from "./appearance.js";
export { TOKENS_CSS } from "./tokens.js";
export { ROUTES, TEST_IDS } from "./testids.js";
