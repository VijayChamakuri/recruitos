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

export { handleRequest, type HttpResponse } from "./server/handlers.js";
export { renderPage, type PageRenderOptions } from "./server/ssr.js";
export {
  getServerComposition,
  setServerComposition
} from "./server/composition.js";
export { createWebServer } from "./server/server.js";
export { TOKENS_CSS } from "./tokens.js";
