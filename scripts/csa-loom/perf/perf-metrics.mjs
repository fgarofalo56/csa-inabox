/**
 * PSR-1 — shared benchmark metric definitions for the standalone perf suite.
 *
 * Mirrors apps/fiab-console/lib/perf/perf-metrics.ts (the app-side source of
 * truth) so the standalone script and the console agree on metric ids, the
 * top-10 surfaces measured for page TTI, and the Microsoft Fabric outcome-
 * equivalence bars each metric is compared against. Kept as a plain .mjs (no
 * build step) to match the repo's Node-script convention.
 */

/** Top-10 surfaces measured for page TTI (HTML GET timing). */
export const TOP_SURFACES = [
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
];

export const PAGE_TTI_PREFIX = 'page-tti:';
export const pageTtiMetricId = (slug) => `${PAGE_TTI_PREFIX}${slug}`;

/** Fabric outcome-equivalence bars (ms) per metric id, with a Learn URL. */
export const FABRIC_BARS = {
  'spark-attach': { ms: 7000, label: 'Fabric starter pool ~5-10s', learn: 'https://learn.microsoft.com/fabric/data-engineering/configure-starter-pools' },
  'notebook-roundtrip': { ms: 2000, label: 'Fabric interactive cell ~2s', learn: 'https://learn.microsoft.com/fabric/data-engineering/author-execute-notebook' },
  'warehouse-query-serverless': { ms: 1000, label: 'Direct Lake sub-second', learn: 'https://learn.microsoft.com/fabric/fundamentals/direct-lake-overview' },
  'warehouse-query-dedicated': { ms: 1000, label: 'Direct Lake sub-second', learn: 'https://learn.microsoft.com/fabric/fundamentals/direct-lake-overview' },
  'adx-query': { ms: 5000, label: 'Fabric RTI 2-30s end-to-end', learn: 'https://learn.microsoft.com/azure/data-explorer/kusto/query/' },
  'dashboard-tile-tti': { ms: 3000, label: 'Fabric Real-Time dashboard tile ~3s', learn: 'https://learn.microsoft.com/azure/data-explorer/azure-data-explorer-dashboards' },
  'copilot-turn': { ms: 3000, label: 'Fabric Copilot full turn ~3s', learn: 'https://learn.microsoft.com/fabric/get-started/copilot-fabric-overview' },
  'page-tti': { ms: 2000, label: 'Fabric portal nav ~2s', learn: 'https://learn.microsoft.com/fabric/fundamentals/direct-lake-overview' },
};

/** Nearest-rank percentile (matches lib/perf/percentile.ts). */
export function percentile(samples, p) {
  const clean = samples.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (clean.length === 0) return NaN;
  if (clean.length === 1) return clean[0];
  const pct = Math.min(100, Math.max(0, p));
  const rank = Math.ceil((pct / 100) * clean.length);
  const idx = Math.min(clean.length - 1, Math.max(0, rank - 1));
  return clean[idx];
}

/** Summarise a raw latency series (cold = first sample, warm = median of rest). */
export function summarize(samples) {
  const finite = samples.filter((n) => Number.isFinite(n));
  const coldMs = Number.isFinite(samples[0]) ? samples[0] : null;
  const warm = samples.slice(1).filter((n) => Number.isFinite(n));
  const median = (a) => percentile(a, 50);
  return {
    n: finite.length,
    p50: Math.round(percentile(finite, 50)),
    p95: Math.round(percentile(finite, 95)),
    p99: Math.round(percentile(finite, 99)),
    coldMs: coldMs === null ? null : Math.round(coldMs),
    warmMs: warm.length ? Math.round(median(warm)) : coldMs,
  };
}
