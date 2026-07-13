/**
 * PSR-1 — Cosmos persistence for benchmark runs.
 *
 * Stores one document per (runId, metric) in the `perf-benchmarks` container
 * (PK /runId), created lazily by cosmos-client.ts `ensure()`. Real Cosmos SDK
 * writes/reads — no mocks (.claude/rules/no-vaporware.md). The doc shape matches
 * the PRP contract: {runId, gitSha, rev, metric, backend, p50, p95, p99,
 * coldMs, warmMs, ts, …}.
 *
 * The trend query is an infrequent admin cross-partition read (ORDER BY ts) —
 * the /admin/performance page groups its rows by metric to draw a sparkline per
 * metric with a two-point-or-more trend.
 */
import { perfBenchmarksContainer } from '@/lib/azure/cosmos-client';
import type { PerfBackend } from '@/lib/perf/perf-metrics';
import type { MetricConfig } from '@/lib/perf/perf-config';

/** One persisted metric result within a run. `id = ${runId}:${metric}`. */
export interface PerfBenchmarkDoc {
  id: string;
  /** Partition key — groups every metric row of one run. */
  runId: string;
  gitSha: string;
  rev: string;
  metric: string;
  backend: PerfBackend;
  /** Percentiles over the run's samples (null when gated / no samples). */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  coldMs: number | null;
  warmMs: number | null;
  /** Extra descriptive stats (optional, additive). */
  min?: number | null;
  max?: number | null;
  n?: number;
  /** Copilot only — time to first token (ms). */
  firstTokenMs?: number | null;
  /** Honest gate: the probe's backend is not configured in this deployment. */
  gated?: boolean;
  /** The exact env var / role to set to enable a gated metric. */
  gateEnv?: string;
  gateMessage?: string;
  /** A real transport/backend error observed while probing (not a gate). */
  error?: string;
  /** ISO-8601 completion timestamp of the metric probe. */
  ts: string;
  /** Tenant that triggered the run (session tenant scope). */
  tenantId: string;
  /** UPN/email of the admin who triggered the run. */
  triggeredBy?: string;
}

/** Lightweight run-status doc (id = runId, metric = '__run__') for polling. */
export interface PerfRunStatusDoc {
  id: string;
  runId: string;
  metric: '__run__';
  status: 'running' | 'completed' | 'failed';
  gitSha: string;
  rev: string;
  ts: string;
  startedAt: string;
  completedAt?: string;
  totalMetrics: number;
  completedMetrics: number;
  tenantId: string;
  triggeredBy?: string;
  error?: string;
}

export const RUN_STATUS_METRIC = '__run__';

/** Upsert a batch of metric result docs (idempotent by id). */
export async function writeBenchmarkDocs(docs: PerfBenchmarkDoc[]): Promise<void> {
  if (docs.length === 0) return;
  const c = await perfBenchmarksContainer();
  for (const d of docs) {
    await c.items.upsert<PerfBenchmarkDoc>(d);
  }
}

/** Upsert (create or replace) the run-status doc. */
export async function writeRunStatus(status: PerfRunStatusDoc): Promise<void> {
  const c = await perfBenchmarksContainer();
  await c.items.upsert<PerfRunStatusDoc>(status);
}

/** Read the run-status doc for one run (single-partition point read). */
export async function readRunStatus(runId: string): Promise<PerfRunStatusDoc | null> {
  const c = await perfBenchmarksContainer();
  try {
    const { resource } = await c.item(`${runId}:${RUN_STATUS_METRIC}`, runId).read<PerfRunStatusDoc>();
    return resource ?? null;
  } catch {
    return null;
  }
}

/** Read every metric doc for one run (single-partition query). */
export async function readRunDocs(runId: string): Promise<PerfBenchmarkDoc[]> {
  const c = await perfBenchmarksContainer();
  const { resources } = await c.items
    .query<PerfBenchmarkDoc>(
      {
        query: 'SELECT * FROM c WHERE c.runId = @rid AND c.metric != @s ORDER BY c.metric ASC',
        parameters: [
          { name: '@rid', value: runId },
          { name: '@s', value: RUN_STATUS_METRIC },
        ],
      },
      { partitionKey: runId },
    )
    .fetchAll();
  return resources ?? [];
}

export interface TrendPoint {
  runId: string;
  gitSha: string;
  rev: string;
  ts: string;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  coldMs: number | null;
  warmMs: number | null;
  gated?: boolean;
  /** Honest gate: the exact env var to set to enable a gated metric. */
  gateEnv?: string;
}

/** Per-metric trend series (chronological). */
export interface MetricTrend {
  metric: string;
  backend: PerfBackend;
  points: TrendPoint[];
  /** Latest point (last element) — the "current" p50/p95 the UI headlines. */
  latest: TrendPoint | null;
}

export interface TrendModel {
  metrics: MetricTrend[];
  /** Distinct runs seen (newest first) for the run picker + count. */
  runs: { runId: string; gitSha: string; rev: string; ts: string }[];
  generatedAt: string;
  /**
   * Live SERVER-side backend-config status per metric id, resolved from the real
   * deployment env at request time (not the last run's persisted gate flag). The
   * card uses this to decide its gate so a configured backend never shows a stale
   * "…is not set" message after the env var was added. Attached by the GET route.
   */
  config?: Record<string, MetricConfig>;
}

/**
 * Build the trend model across the most recent `maxRuns` runs. Cross-partition
 * read ordered by ts; groups metric docs into per-metric chronological series.
 * `maxRuns` caps how many recent runs feed the sparklines (default 30).
 */
export async function loadTrend(maxRuns = 30): Promise<TrendModel> {
  const c = await perfBenchmarksContainer();
  // Pull recent metric docs newest-first, capped generously; we then keep only
  // the newest `maxRuns` distinct runs.
  const capDocs = Math.max(200, maxRuns * 40);
  const { resources } = await c.items
    .query<PerfBenchmarkDoc>({
      query:
        'SELECT TOP @cap c.runId, c.gitSha, c.rev, c.metric, c.backend, c.p50, c.p95, c.p99, c.coldMs, c.warmMs, c.gated, c.gateEnv, c.ts ' +
        'FROM c WHERE c.metric != @s ORDER BY c.ts DESC',
      parameters: [
        { name: '@cap', value: capDocs },
        { name: '@s', value: RUN_STATUS_METRIC },
      ],
    })
    .fetchAll();

  const docs = resources ?? [];

  // Distinct runs, newest first (docs are already ts DESC).
  const runOrder: string[] = [];
  const runMeta = new Map<string, { runId: string; gitSha: string; rev: string; ts: string }>();
  for (const d of docs) {
    if (!runMeta.has(d.runId)) {
      runMeta.set(d.runId, { runId: d.runId, gitSha: d.gitSha, rev: d.rev, ts: d.ts });
      runOrder.push(d.runId);
    }
  }
  const keepRuns = new Set(runOrder.slice(0, maxRuns));

  // Group by metric, keeping only docs from the kept runs, chronological.
  const byMetric = new Map<string, { backend: PerfBackend; points: TrendPoint[] }>();
  for (const d of docs) {
    if (!keepRuns.has(d.runId)) continue;
    let entry = byMetric.get(d.metric);
    if (!entry) {
      entry = { backend: d.backend, points: [] };
      byMetric.set(d.metric, entry);
    }
    entry.points.push({
      runId: d.runId,
      gitSha: d.gitSha,
      rev: d.rev,
      ts: d.ts,
      p50: d.p50 ?? null,
      p95: d.p95 ?? null,
      p99: d.p99 ?? null,
      coldMs: d.coldMs ?? null,
      warmMs: d.warmMs ?? null,
      gated: d.gated,
      gateEnv: d.gateEnv,
    });
  }

  const metrics: MetricTrend[] = [];
  for (const [metric, entry] of byMetric) {
    // Chronological ascending for the sparkline.
    entry.points.sort((a, b) => a.ts.localeCompare(b.ts));
    metrics.push({
      metric,
      backend: entry.backend,
      points: entry.points,
      latest: entry.points[entry.points.length - 1] ?? null,
    });
  }
  // Stable order: engines first (by metric id), then page-tti surfaces.
  metrics.sort((a, b) => a.metric.localeCompare(b.metric));

  return {
    metrics,
    runs: runOrder.slice(0, maxRuns).map((r) => runMeta.get(r)!),
    generatedAt: new Date().toISOString(),
  };
}
