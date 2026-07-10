/**
 * PSR-1 — benchmark metric registry + Fabric outcome-equivalence bars.
 *
 * Single source of truth for WHAT the perf suite measures and WHAT Fabric bar
 * each metric is compared against. Consumed by:
 *   - the server-side runner (`perf-runner.ts`) — which metrics to probe,
 *   - the BFF trend route + Cosmos store — metric ids on each run doc,
 *   - the `/admin/performance` UI — labels, units, and the Fabric reference
 *     line drawn on each trend chart,
 *   - the standalone `scripts/csa-loom/perf` suite (which mirrors these ids).
 *
 * The Fabric bars are **outcome-equivalence targets**, NOT mechanism-parity
 * claims (see PRP §PSR-1). Every backend here is Azure-native — no Fabric
 * dependency, no `api.fabric.microsoft.com` call (.claude/rules/no-fabric-
 * dependency.md). Pure constants + types only: NO editor-registry / React
 * imports, so this stays importable from both the browser bundle and Node
 * scripts without a circular dependency.
 */

/** Backend a metric exercises — always an Azure-native service, never Fabric. */
export type PerfBackend =
  | 'synapse-livy'       // Spark session-attach + notebook cell (Azure Synapse Livy)
  | 'synapse-serverless' // Serverless SQL pool (on-demand)
  | 'synapse-dedicated'  // Dedicated SQL pool
  | 'adx'                // Azure Data Explorer (Kusto)
  | 'aoai'               // Azure OpenAI (Copilot turn)
  | 'http';              // Console HTML GET (page TTI)

/** How a metric is measured — informs the cold/warm interpretation in the UI. */
export type PerfMetricKind = 'attach' | 'query' | 'roundtrip' | 'llm' | 'tti';

export interface PerfMetricDef {
  /** Stable metric id — the Cosmos `metric` field + chart key. */
  id: string;
  /** Human label for the chart header. */
  label: string;
  /** Azure-native backend the probe drives. */
  backend: PerfBackend;
  kind: PerfMetricKind;
  /** Display unit (always ms today). */
  unit: 'ms';
  /**
   * Fabric outcome-equivalence bar in ms — the reference line drawn on the
   * trend chart. Lower is better; a run whose p95 is at/under this bar is at
   * or better than the published Fabric experience.
   */
  fabricBarMs: number;
  /** Short label for the reference line (e.g. "Fabric starter pool ~7s"). */
  fabricBarLabel: string;
  /** Microsoft Learn URL grounding the bar. */
  learnUrl: string;
  /** One-line description shown under the chart. */
  description: string;
  /**
   * When true the probe is OFF by default because running it spends real money
   * on every invocation (e.g. creating + tearing down a Spark session). It runs
   * only when the operator opts in (`includeSpark`), otherwise it records an
   * honest gate row — never a fabricated number.
   */
  costlyOptIn?: boolean;
}

// ── Top-10 surfaces measured for page TTI (HTML GET timing) ──────────────────
// Home, catalog, and the eight heaviest editors/pages. Each becomes a
// `page-tti:<slug>` metric. Kept in one place so the runner + UI agree.
export interface PerfSurface {
  slug: string;
  label: string;
  path: string;
}

export const TOP_SURFACES: readonly PerfSurface[] = [
  { slug: 'home', label: 'Home', path: '/' },
  { slug: 'catalog', label: 'Catalog', path: '/catalog' },
  { slug: 'workspaces', label: 'Workspaces', path: '/workspaces' },
  { slug: 'marketplace', label: 'Marketplace', path: '/marketplace' },
  { slug: 'governance', label: 'Governance', path: '/govern' },
  { slug: 'monitor', label: 'Monitor hub', path: '/monitor' },
  { slug: 'lineage', label: 'Lineage', path: '/lineage' },
  { slug: 'learn', label: 'Learning hub', path: '/learn' },
  { slug: 'admin', label: 'Admin overview', path: '/admin' },
  { slug: 'copilot', label: 'Copilot', path: '/copilot' },
] as const;

export const PAGE_TTI_PREFIX = 'page-tti:';

/** The page-TTI Fabric bar — Fabric portal navigations target ~2s TTI. */
export const PAGE_TTI_FABRIC_BAR_MS = 2000;
export const PAGE_TTI_LEARN_URL =
  'https://learn.microsoft.com/fabric/fundamentals/direct-lake-overview';

/** Build the metric id for a page-TTI surface. */
export function pageTtiMetricId(slug: string): string {
  return `${PAGE_TTI_PREFIX}${slug}`;
}

/** True when a metric id is a page-TTI surface metric. */
export function isPageTtiMetric(id: string): boolean {
  return id.startsWith(PAGE_TTI_PREFIX);
}

/** Resolve the surface for a page-TTI metric id (or undefined). */
export function surfaceForMetric(id: string): PerfSurface | undefined {
  if (!isPageTtiMetric(id)) return undefined;
  const slug = id.slice(PAGE_TTI_PREFIX.length);
  return TOP_SURFACES.find((s) => s.slug === slug);
}

// ── Engine metrics (Spark / warehouse / ADX / dashboard / Copilot) ───────────
export const ENGINE_METRICS: readonly PerfMetricDef[] = [
  {
    id: 'spark-attach',
    label: 'Spark session attach',
    backend: 'synapse-livy',
    kind: 'attach',
    unit: 'ms',
    fabricBarMs: 7000,
    fabricBarLabel: 'Fabric starter pool ~5-10s',
    learnUrl: 'https://learn.microsoft.com/fabric/data-engineering/configure-starter-pools',
    description:
      'Time to attach a live Spark session on the Azure Synapse Livy backend (cold create vs warm-pool hit). Compared against the Fabric starter-pool ~5-10s attach.',
    costlyOptIn: true,
  },
  {
    id: 'notebook-roundtrip',
    label: 'Notebook cell round-trip',
    backend: 'synapse-livy',
    kind: 'roundtrip',
    unit: 'ms',
    fabricBarMs: 2000,
    fabricBarLabel: 'Fabric interactive cell ~2s',
    learnUrl: 'https://learn.microsoft.com/fabric/data-engineering/author-execute-notebook',
    description:
      'Submit a trivial cell to an attached Synapse Livy session and wait for the result — the interactive notebook feel.',
    costlyOptIn: true,
  },
  {
    id: 'warehouse-query-serverless',
    label: 'Warehouse query (serverless)',
    backend: 'synapse-serverless',
    kind: 'query',
    unit: 'ms',
    fabricBarMs: 1000,
    fabricBarLabel: 'Direct Lake sub-second',
    learnUrl: 'https://learn.microsoft.com/fabric/fundamentals/direct-lake-overview',
    description:
      'Round-trip of a lightweight query on the Azure Synapse serverless (on-demand) SQL endpoint. Compared against the Direct Lake sub-second bar.',
  },
  {
    id: 'warehouse-query-dedicated',
    label: 'Warehouse query (dedicated pool)',
    backend: 'synapse-dedicated',
    kind: 'query',
    unit: 'ms',
    fabricBarMs: 1000,
    fabricBarLabel: 'Direct Lake sub-second',
    learnUrl: 'https://learn.microsoft.com/fabric/fundamentals/direct-lake-overview',
    description:
      'Round-trip of a lightweight query on the Azure Synapse dedicated SQL pool (warm compute).',
  },
  {
    id: 'adx-query',
    label: 'ADX query',
    backend: 'adx',
    kind: 'query',
    unit: 'ms',
    fabricBarMs: 5000,
    fabricBarLabel: 'Fabric RTI 2-30s end-to-end',
    learnUrl: 'https://learn.microsoft.com/azure/data-explorer/kusto/query/',
    description:
      'Round-trip of a lightweight KQL query on the Azure Data Explorer cluster — the Azure-native Real-Time Intelligence eventhouse engine.',
  },
  {
    id: 'dashboard-tile-tti',
    label: 'Dashboard tile TTI',
    backend: 'adx',
    kind: 'tti',
    unit: 'ms',
    fabricBarMs: 3000,
    fabricBarLabel: 'Fabric Real-Time dashboard tile ~3s',
    learnUrl: 'https://learn.microsoft.com/azure/data-explorer/azure-data-explorer-dashboards',
    description:
      'Time for a representative KQL-dashboard tile aggregation to return from ADX — the render-blocking query behind a Real-Time dashboard tile.',
  },
  {
    id: 'copilot-turn',
    label: 'Copilot turn latency',
    backend: 'aoai',
    kind: 'llm',
    unit: 'ms',
    fabricBarMs: 3000,
    fabricBarLabel: 'Fabric Copilot full turn ~3s',
    learnUrl: 'https://learn.microsoft.com/fabric/get-started/copilot-fabric-overview',
    description:
      'Azure OpenAI Copilot turn latency — first-token and full-turn — measured against the Fabric Copilot experience.',
  },
] as const;

/** All engine metric ids (for the runner + budgets). */
export const ENGINE_METRIC_IDS = ENGINE_METRICS.map((m) => m.id);

/** Look up an engine metric def by id. */
export function engineMetric(id: string): PerfMetricDef | undefined {
  return ENGINE_METRICS.find((m) => m.id === id);
}

/**
 * Resolve the full display def (label / bar / learn / unit) for ANY metric id,
 * including the dynamic `page-tti:<slug>` ids. Returns a synthesised def for a
 * page surface so the UI never needs to special-case it.
 */
export function metricDef(id: string): PerfMetricDef | undefined {
  const eng = engineMetric(id);
  if (eng) return eng;
  const surface = surfaceForMetric(id);
  if (surface) {
    return {
      id,
      label: `Page TTI — ${surface.label}`,
      backend: 'http',
      kind: 'tti',
      unit: 'ms',
      fabricBarMs: PAGE_TTI_FABRIC_BAR_MS,
      fabricBarLabel: 'Fabric portal nav ~2s',
      learnUrl: PAGE_TTI_LEARN_URL,
      description: `Time-to-first-byte + HTML transfer for ${surface.path} — the server-render latency a user feels navigating to ${surface.label}.`,
    };
  }
  return undefined;
}

/** Category grouping for the UI (Engines vs Surfaces). */
export type PerfCategory = 'engine' | 'surface';
export function metricCategory(id: string): PerfCategory {
  return isPageTtiMetric(id) ? 'surface' : 'engine';
}

// ── Cache hit-rate KPI (PSR-5 / PSR-6) ───────────────────────────────────────
// Browser-safe metadata for the result-cache hit-rate the perf page reports
// alongside latency. This is a RATE (0..1), not a latency bar — kept separate
// from ENGINE_METRICS (which are ms-with-a-Fabric-bar) so those stay uniform.
// The live numbers come from `lib/perf/cache-counters.ts` (Node-side runtime).

/** Stable id for the cache hit-rate KPI on the perf surface. */
export const CACHE_HIT_RATE_METRIC_ID = 'cache-hit-rate';

/**
 * Target hit-rate for the always-on result cache. A warm report/dashboard
 * re-issues identical aggregate queries, so a healthy cache clears this bar;
 * below it signals TTLs too short or a freshness token rotating too often.
 */
export const CACHE_HIT_RATE_TARGET = 0.6;

export interface CacheHitRateKpi {
  id: string;
  label: string;
  /** Target rate (0..1) — the reference line on the KPI. */
  targetRate: number;
  learnUrl: string;
  description: string;
}

/** Display metadata for the cache hit-rate KPI (labels/target/help). */
export const CACHE_HIT_RATE_KPI: CacheHitRateKpi = {
  id: CACHE_HIT_RATE_METRIC_ID,
  label: 'Result-cache hit-rate',
  targetRate: CACHE_HIT_RATE_TARGET,
  learnUrl: 'https://learn.microsoft.com/azure/data-explorer/query-results-cache',
  description:
    'Share of report / semantic-layer / ADX tile queries served from the Loom result cache (in-process LRU → shared Redis → Cosmos) instead of a live backend round-trip. Higher is better — the outcome-equivalence lever behind sub-second repeat visuals (PSR-5/PSR-6).',
};
