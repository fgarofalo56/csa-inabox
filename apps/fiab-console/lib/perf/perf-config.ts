/**
 * PSR-1 — live server-side backend-config resolver for benchmark metrics.
 *
 * The perf trend cards used to headline the persisted `gated`/`gateEnv` flag of
 * the LAST run — which reflects the deployment's config AT THAT RUN, not now.
 * So once an operator sets (e.g.) LOOM_SYNAPSE_WORKSPACE, a card whose last run
 * predated that env var kept falsely claiming "…is not running because
 * LOOM_SYNAPSE_WORKSPACE is not set in this deployment" until a fresh run
 * overwrote the doc. That is a lie about SERVER truth.
 *
 * This resolver reads the REAL server env (Node route context only — never the
 * browser) and reports, per metric, whether its Azure-native backend is
 * configured RIGHT NOW. The GET /api/admin/performance route attaches the map so
 * the card decides its gate from current config, not a stale run doc. Mirrors
 * the exact env checks the runner probes use (perf-runner.ts) so the two never
 * drift. Azure-native only — no Fabric dependency (no-fabric-dependency.md).
 */
import { isPageTtiMetric } from '@/lib/perf/perf-metrics';

/** Live configuration status of one metric's backend in this deployment. */
export interface MetricConfig {
  /** True when the metric's backend is configured on the server right now. */
  configured: boolean;
  /** The exact env var to set to enable it (when not configured). */
  gateEnv?: string;
  /** Precise remediation message naming the env var / role to set. */
  gateMessage?: string;
}

const has = (name: string): boolean => Boolean((process.env[name] || '').trim());

/**
 * Resolve the live backend-config status for a single metric id, reading real
 * server env. Pure (no I/O beyond `process.env`), so it is safe to call for
 * every metric on each GET. Unknown ids default to configured (no false gate).
 */
export function resolveMetricConfig(metricId: string): MetricConfig {
  // Page-TTI probes GET the console over HTTP; the run route always supplies an
  // origin (LOOM_CONSOLE_BASE_URL or the request host), so they are runnable.
  if (isPageTtiMetric(metricId)) return { configured: true };

  switch (metricId) {
    case 'warehouse-query-serverless':
      return has('LOOM_SYNAPSE_WORKSPACE')
        ? { configured: true }
        : {
            configured: false,
            gateEnv: 'LOOM_SYNAPSE_WORKSPACE',
            gateMessage:
              'Serverless-warehouse benchmark needs the Synapse workspace. Set ' +
              'LOOM_SYNAPSE_WORKSPACE (the ondemand SQL endpoint is derived from it) ' +
              'and grant the Console UAMI db_datareader.',
          };

    case 'warehouse-query-dedicated':
      return has('LOOM_SYNAPSE_WORKSPACE') && has('LOOM_SYNAPSE_DEDICATED_POOL')
        ? { configured: true }
        : {
            configured: false,
            gateEnv: has('LOOM_SYNAPSE_WORKSPACE')
              ? 'LOOM_SYNAPSE_DEDICATED_POOL'
              : 'LOOM_SYNAPSE_WORKSPACE',
            gateMessage:
              'Dedicated-pool benchmark needs a dedicated SQL pool. Set ' +
              'LOOM_SYNAPSE_WORKSPACE + LOOM_SYNAPSE_DEDICATED_POOL and resume the pool.',
          };

    case 'spark-attach':
    case 'notebook-roundtrip':
      // Backend = Synapse Spark; the metric is additionally cost-opt-in
      // (`includeSpark`), which the card surfaces via the metric def's
      // `costlyOptIn` flag — that is not an infra gate.
      return has('LOOM_SYNAPSE_WORKSPACE')
        ? { configured: true }
        : {
            configured: false,
            gateEnv: 'LOOM_SYNAPSE_WORKSPACE',
            gateMessage:
              'Spark benchmark needs LOOM_SYNAPSE_WORKSPACE + a configured Spark pool.',
          };

    case 'adx-query':
    case 'dashboard-tile-tti':
      // Mirrors kustoConfigGate(): the ADX cluster URI is the deployment signal.
      return has('LOOM_KUSTO_CLUSTER_URI')
        ? { configured: true }
        : {
            configured: false,
            gateEnv: 'LOOM_KUSTO_CLUSTER_URI',
            gateMessage:
              'ADX benchmark needs the Azure Data Explorer cluster. Set ' +
              'LOOM_KUSTO_CLUSTER_URI (the ADX cluster query URI) and grant the ' +
              'Console UAMI Database Viewer.',
          };

    case 'copilot-turn':
      return has('LOOM_AOAI_ENDPOINT') || has('AZURE_OPENAI_ENDPOINT')
        ? { configured: true }
        : {
            configured: false,
            gateEnv: 'LOOM_AOAI_ENDPOINT',
            gateMessage:
              'Copilot benchmark needs Azure OpenAI. Set LOOM_AOAI_ENDPOINT + ' +
              'LOOM_AOAI_DEPLOYMENT (or bind a Foundry hub) and grant the Console ' +
              'UAMI Cognitive Services OpenAI User.',
          };

    default:
      // Unknown metric → do not invent a false gate.
      return { configured: true };
  }
}

/** Resolve the live config map for a set of metric ids. */
export function resolveMetricConfigMap(metricIds: string[]): Record<string, MetricConfig> {
  const out: Record<string, MetricConfig> = {};
  for (const id of metricIds) out[id] = resolveMetricConfig(id);
  return out;
}
