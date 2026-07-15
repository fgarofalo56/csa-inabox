/**
 * PERF-4.2 — the auto-adjust engine.
 *
 * When an admin turns a recommendation CLASS's "Auto-adjust" toggle ON (see
 * `perf-tunables.ts`), this engine applies that class of recommendation
 * automatically — same derivation (`recommendations.ts`), same validation/clamp
 * (`validateApplyChange`), same executor (`apply-change.ts`), same audit trail —
 * bounded by the admin min/max for the class.
 *
 * Runs piggybacked on the warm-pool sweep tick (a live-request heartbeat that
 * already exists), throttled to once per AUTO_TUNE_INTERVAL_MS, and rate-limits
 * itself to ONE apply per class per tick with a per-recommendation cooldown so
 * a noisy signal can't thrash a knob. ARM-touching classes (adx-autoscale /
 * warehouse-scale) additionally require the signal to persist across two
 * consecutive ticks before applying.
 */

import { deriveRecommendations, validateApplyChange, type PerfRecommendation, type PerfSignals } from '@/lib/perf/recommendations';
import { executeApplyChange } from '@/lib/perf/apply-change';
import { getTunables } from '@/lib/perf/usage-store';
import type { AutoAdjustClass } from '@/lib/perf/perf-tunables';

const AUTO_TUNE_INTERVAL_MS = 5 * 60_000;
/** Don't re-apply the SAME recommendation id within this window. */
const PER_REC_COOLDOWN_MS = 30 * 60_000;

interface AutoTuneState {
  lastTickAt: number;
  /** recommendationId → last-applied epoch ms. */
  appliedAt: Map<string, number>;
  /** ARM-class rec ids seen last tick (two-tick persistence gate). */
  pendingArm: Set<string>;
  running: boolean;
}

const g = globalThis as unknown as { __loomAutoTune?: AutoTuneState };
const state: AutoTuneState =
  g.__loomAutoTune ?? (g.__loomAutoTune = { lastTickAt: 0, appliedAt: new Map(), pendingArm: new Set(), running: false });

const ARM_CLASSES: ReadonlySet<string> = new Set<AutoAdjustClass>(['adx-autoscale', 'warehouse-scale']);

/** Build the live signal snapshot (shared with the recommendations BFF). */
export async function collectPerfSignals(opts?: { includeArmProbes?: boolean; trendMaxRuns?: number }): Promise<PerfSignals> {
  const includeArm = opts?.includeArmProbes ?? true;

  const { getPoolStatus, sparkPoolBackendStatus } = await import('@/lib/azure/spark-session-pool');
  const { poolCountersSnapshot } = await import('@/lib/perf/pool-counters');
  const { cacheCountersSnapshot } = await import('@/lib/perf/cache-counters');
  const { queryCacheStats } = await import('@/lib/azure/query-result-cache');
  const { recentCopilotSloEvaluations } = await import('@/lib/perf/copilot-latency-tracker');

  const pool = getPoolStatus();
  const backend = sparkPoolBackendStatus();
  const acquires = poolCountersSnapshot();
  const counters = cacheCountersSnapshot();
  const cacheStats = queryCacheStats();
  const lastFailure = pool.groups.find((grp) => grp.lastFailure)?.lastFailure;

  // Livy queue depth — real REST list on the default pool (best-effort).
  let livyQueue: PerfSignals['livyQueue'] = null;
  if (backend.backend === 'synapse' && backend.configured) {
    try {
      const { listLivySessions, defaultSparkPool } = await import('@/lib/azure/synapse-livy-client');
      const sessions = await listLivySessions(defaultSparkPool());
      const queued = sessions.filter((s) =>
        ['not_started', 'starting', 'recovering'].includes(String(s.state).toLowerCase()),
      ).length;
      livyQueue = { queued, total: sessions.length };
    } catch {
      livyQueue = null;
    }
  }

  // Benchmark trend — latest non-null p95 per metric vs its bar (best-effort).
  let trend: PerfSignals['trend'] = [];
  try {
    const { loadTrend } = await import('@/lib/perf/perf-store');
    const { metricDef } = await import('@/lib/perf/perf-metrics');
    const model = await loadTrend(opts?.trendMaxRuns ?? 5);
    trend = (model.metrics || []).map((m) => {
      const def = metricDef(m.metric);
      const latest = [...(m.points || [])].reverse().find((p) => typeof p.p95 === 'number' && p.p95 !== null);
      return {
        metric: m.metric,
        p95: latest?.p95 ?? null,
        barMs: def?.fabricBarMs ?? 0,
        gated: latest ? undefined : true,
      };
    });
  } catch {
    trend = [];
  }

  // ARM probes (ADX autoscale + dedicated pool sku) — opt-out for cheap ticks.
  let adx: PerfSignals['adx'] = null;
  let warehouse: PerfSignals['warehouse'] = null;
  if (includeArm) {
    try {
      const { getKustoClusterArm } = await import('@/lib/azure/kusto-arm-client');
      const cluster = await getKustoClusterArm();
      adx = {
        autoscaleEnabled: !!cluster.optimizedAutoscale?.isEnabled,
        capacity: Number(cluster.sku?.capacity ?? 0) || 0,
      };
    } catch {
      adx = null; // honest — unconfigured/unreachable → no ADX recommendations
    }
    try {
      const { getPoolState } = await import('@/lib/azure/synapse-pool-arm');
      const st = await getPoolState();
      warehouse = { state: st.state, sku: st.sku };
    } catch {
      warehouse = null;
    }
  }

  return {
    pool: {
      enabled: pool.enabled,
      backendConfigured: backend.configured,
      min: pool.config.min,
      max: pool.config.max,
      idleTtlSecs: Math.round(pool.config.idleTtlMs / 1000),
      reapEnabled: pool.config.reapEnabled,
      warm: pool.totals.warm,
      warming: pool.totals.warming,
      lastFailure,
    },
    poolAcquires: { hits: acquires.hits, misses: acquires.misses, missRate: acquires.missRate },
    livyQueue,
    cache: {
      enabled: cacheStats.enabled,
      hits: counters.total.hits,
      misses: counters.total.misses,
      hitRate: counters.total.hitRate,
      ttlMs: cacheStats.ttlMs,
      size: cacheStats.size,
      maxEntries: cacheStats.maxEntries ?? 500,
    },
    slo: recentCopilotSloEvaluations().map((s) => ({
      id: s.id,
      met: s.met,
      burn: s.burn,
      sampled: s.sampled,
      budgetMs: s.budgetMs,
    })),
    trend,
    adx,
    warehouse,
  };
}

export interface AutoTuneResult {
  ran: boolean;
  applied: Array<{ id: string; cls: string; ok: boolean; summary: string }>;
}

/**
 * One auto-tune pass (throttled + re-entrancy guarded). Called from the pool
 * sweep tick via dynamic import; never throws.
 */
export async function autoTuneTick(force = false): Promise<AutoTuneResult> {
  if (state.running) return { ran: false, applied: [] };
  if (!force && Date.now() - state.lastTickAt < AUTO_TUNE_INTERVAL_MS) return { ran: false, applied: [] };
  state.running = true;
  state.lastTickAt = Date.now();
  const applied: AutoTuneResult['applied'] = [];
  try {
    const tunables = await getTunables();
    const anyOn = Object.values(tunables.autoAdjust).some((x) => x.enabled);
    if (!anyOn) return { ran: true, applied };

    const signals = await collectPerfSignals({ includeArmProbes: true, trendMaxRuns: 5 });
    const recs = deriveRecommendations(signals, tunables);

    const appliedClasses = new Set<string>();
    const nextPendingArm = new Set<string>();

    for (const rec of recs) {
      if (rec.cls === 'informational' || rec.apply.kind === 'none') continue;
      const clsCfg = tunables.autoAdjust[rec.cls as AutoAdjustClass];
      if (!clsCfg?.enabled) continue;
      if (appliedClasses.has(rec.cls)) continue; // one apply per class per tick
      const last = state.appliedAt.get(rec.id) ?? 0;
      if (Date.now() - last < PER_REC_COOLDOWN_MS) continue;

      // ARM-touching classes require the signal to persist across two ticks.
      if (ARM_CLASSES.has(rec.cls)) {
        if (!state.pendingArm.has(rec.id)) {
          nextPendingArm.add(rec.id);
          continue;
        }
      }

      const validated = validateApplyChange(rec.apply, tunables);
      if (!validated.ok || !validated.change) continue;
      const receipt = await executeApplyChange(validated.change, 'auto', rec.id);
      state.appliedAt.set(rec.id, Date.now());
      appliedClasses.add(rec.cls);
      applied.push({ id: rec.id, cls: rec.cls, ok: receipt.ok, summary: receipt.summary });
    }
    state.pendingArm = nextPendingArm;
  } catch {
    /* best-effort — never break the sweep */
  } finally {
    state.running = false;
  }
  return { ran: true, applied };
}

/** Diagnostic snapshot for the admin UI. */
export function autoTuneStatus(): { lastTickAt: number; recentApplies: Array<{ id: string; at: number }> } {
  return {
    lastTickAt: state.lastTickAt,
    recentApplies: [...state.appliedAt.entries()].map(([id, at]) => ({ id, at })).sort((a, b) => b.at - a.at).slice(0, 10),
  };
}

/** TEST HOOK — reset the engine state. */
export function _resetAutoTune(): void {
  state.lastTickAt = 0;
  state.appliedAt.clear();
  state.pendingArm.clear();
  state.running = false;
}

/** A derived recommendation that auto-tune WOULD apply right now (UI preview). */
export function autoApplicable(recs: PerfRecommendation[], tunables: { autoAdjust: Record<string, { enabled: boolean }> }): string[] {
  return recs
    .filter((r) => r.cls !== 'informational' && r.apply.kind !== 'none' && tunables.autoAdjust[r.cls]?.enabled)
    .map((r) => r.id);
}
