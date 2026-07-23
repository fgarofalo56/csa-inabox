/**
 * GET /api/admin/spark/health — the Spark pools tab of the Health &
 * Reliability hub (A10, loom-next-level Spark reliability).
 *
 * REAL backends only, aggregated read-only (no new state):
 *   • warm-pool snapshot — `getPoolStatus()` (spark-session-pool): warm /
 *     leased / shared / warming per group, circuit-breaker state, cross-replica
 *     lease-store mode, effective config (incl. the #1796 reaper settings),
 *   • ARM Spark pools — `listSparkPools()` (synapse-dev-client):
 *     provisioningState / nodeSize / autoscale / autopause / Spark version →
 *     FAULTED detection per lib/admin/spark-health (hard ARM fault + the
 *     "Succeeded but can't launch" suspect flavor from the armed breaker),
 *   • live Livy census — `listLivySessions()` per pool (synapse-livy-client,
 *     detailed=true): tracked vs untracked sessions, leak candidates the reaper
 *     targets, terminal errorInfo (MAX_QUEUED_JOBS_PER_COMPUTE_EXCEEDED class),
 *   • warm-acquire counters — `poolCountersSnapshot()` (hit = a run adopted a
 *     warm session instead of cold-starting).
 *
 * Session-gated + tenant-admin (withTenantAdmin — R1 route-toolkit). Honest
 * gate: no Spark backend configured → the normalized 503 gate envelope
 * (svc-synapse / svc-databricks) with its Fix-it. Per-source failures degrade
 * honestly into `armError` / per-pool `sessionsError` — never silent, never
 * mocked. Runbook: docs/fiab/runbooks/spark-pools.md.
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk } from '@/lib/api/respond';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import { getPoolStatus, sparkPoolBackendStatus } from '@/lib/azure/spark-session-pool';
import { listSparkPools, type SparkPool } from '@/lib/azure/synapse-dev-client';
import { listLivySessions, defaultSparkPool, type LivySession } from '@/lib/azure/synapse-livy-client';
import { poolCountersSnapshot } from '@/lib/perf/pool-counters';
import { summarizePool, type PoolHealthSummary, type SparkHealthPayload } from '@/lib/admin/spark-health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Cap the number of pools whose Livy sessions we enumerate per request. */
const MAX_SESSION_PROBES = 6;

export const GET = withTenantAdmin(async (_req: NextRequest) => {
  const backend = sparkPoolBackendStatus();
  if (!backend.configured) {
    // Honest 503 gate envelope → the pane renders the shared HonestGate +
    // Fix-it wizard for the ACTIVE backend's registry gate.
    return apiHonestGateError(backend.backend === 'databricks' ? 'svc-databricks' : 'svc-synapse');
  }

  const status = getPoolStatus();
  const counters = poolCountersSnapshot();

  const payload: SparkHealthPayload = {
    generatedAt: new Date().toISOString(),
    backend,
    pool: {
      enabled: status.enabled,
      totals: status.totals,
      groups: status.groups,
      store: {
        mode: status.store.mode,
        container: status.store.container,
        replicaId: status.store.replicaId,
      },
      config: {
        min: status.config.min,
        max: status.config.max,
        idleTtlMs: status.config.idleTtlMs,
        reapEnabled: status.config.reapEnabled,
        reapGraceMs: status.config.reapGraceMs,
      },
    },
    counters: {
      hits: counters.hits,
      misses: counters.misses,
      total: counters.total,
      missRate: counters.missRate,
      hitAcquireP50Ms: counters.hitAcquireP50Ms,
    },
    pools: [],
  };

  if (backend.backend === 'databricks') {
    // Databricks warmth is cluster-level shared infra — ARM Spark-pool census
    // and Livy session enumeration are Synapse concepts. The warm-pool
    // snapshot above is the honest full picture for this backend.
    payload.note =
      'Databricks backend: pool census is cluster-level (see the workspace UI); the warm-pool snapshot above is live.';
    return apiOk({ ...payload });
  }

  // ── ARM pool census (real ARM; failure surfaces honestly) ────────────────
  let armPools: SparkPool[] = [];
  try {
    armPools = await listSparkPools();
  } catch (e) {
    payload.armError = e instanceof Error ? e.message : String(e);
  }

  // Probe live Livy sessions for the pools that matter: the default pool +
  // every pool a warm-pool group targets, then remaining ARM pools up to the
  // cap (each probe is a real paged Livy list call).
  const priority = new Set<string>([defaultSparkPool()]);
  for (const g of status.groups) if (g.backend === 'synapse' && g.poolName) priority.add(g.poolName);
  const ordered = [
    ...armPools.filter((p) => priority.has(p.name)),
    ...armPools.filter((p) => !priority.has(p.name)),
  ];

  const summaries: PoolHealthSummary[] = [];
  for (const [i, arm] of ordered.entries()) {
    let live: { sessions?: LivySession[]; error?: string } | undefined;
    if (i < MAX_SESSION_PROBES) {
      try {
        live = { sessions: await listLivySessions(arm.name, { hardCap: 400 }) };
      } catch (e) {
        live = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    summaries.push(summarizePool(arm, status.groups, live));
  }
  payload.pools = summaries;

  return apiOk({ ...payload });
});
