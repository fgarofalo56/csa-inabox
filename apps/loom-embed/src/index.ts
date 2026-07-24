/**
 * @csa-loom/embed — embedded analytics for CSA Loom.
 *
 * A `<loom-report>` web component + a React `<LoomReport>` wrapper that render a
 * governed Loom report from a short-lived, RLS-scoped EMBED TOKEN. Builds on
 * `@csa-loom/sdk`. Fabric-free: no Power BI Embedded, no Fabric F-SKU — the same
 * on every cloud, including Gov.
 *
 *   1. Server: mint a token — `POST /api/embed/token { reportId, identity }`.
 *   2. Client: render — `<loom-report base-url token metric …>` or `<LoomReport …>`.
 *   3. Data: `POST /api/embed/query` with the token; ROW-LEVEL SECURITY is
 *      enforced SERVER-SIDE by the N15 metric compiler (the identity's claims
 *      are ANDed into the WHERE) — never client-side row hiding.
 *
 * The React wrapper lives at the `@csa-loom/embed/react` subpath so a
 * non-React host imports only the web component.
 */

export {
  LoomEmbedClient,
  toReportView,
  EMBED_TOKEN_HEADER,
  type LoomEmbedClientOptions,
  type EmbedQueryInput,
  type EmbedFilterInput,
  type EmbedMetricResult,
  type MetricEngine,
  type ReportView,
} from './embed-client.js';

export {
  LoomReportElement,
  defineLoomReport,
  renderReportHtml,
} from './loom-report.js';
