/**
 * PERF-4.1 — actionable performance recommendations (pure, unit-tested).
 *
 * Turns a snapshot of REAL measured signals — warm-pool acquire hit/miss
 * counters, live pool status, Livy queue depth, result-cache hit-rate, Copilot
 * SLO burn, and the persisted benchmark trend (p95 vs the Fabric bar) — into
 * concrete recommendation cards: what's wrong, why, the EXACT change, and an
 * ApplyChange the BFF executes against the real config store / ARM surface.
 *
 * NO fabricated advice: every rule requires a measured signal above a stated
 * threshold, and each card carries its evidence rows (signal, measured value,
 * threshold) so the admin sees exactly why it fired (no-vaporware.md).
 *
 * Pure module — derivation and apply-change validation take plain inputs and
 * return plain outputs (vitest-covered). Execution lives in `apply-change.ts`.
 */

import {
  AUTO_ADJUST_META,
  DWU_LADDER,
  nextDwu,
  type AutoAdjustClass,
  type PerfTunables,
} from '@/lib/perf/perf-tunables';
import { CACHE_HIT_RATE_TARGET } from '@/lib/perf/perf-metrics';

// ── Signals (assembled by the BFF from live sources) ─────────────────────────

export interface PerfSignals {
  pool: {
    enabled: boolean;
    backendConfigured: boolean;
    min: number;
    max: number;
    idleTtlSecs: number;
    reapEnabled: boolean;
    warm: number;
    warming: number;
    /** Circuit-breaker failure reason when a group is backing off. */
    lastFailure?: string;
  };
  poolAcquires: {
    hits: number;
    misses: number;
    missRate: number;
  };
  /** Live Livy queue depth on the default pool (null when unprobeable). */
  livyQueue: { queued: number; total: number } | null;
  cache: {
    enabled: boolean;
    hits: number;
    misses: number;
    hitRate: number;
    ttlMs: number;
    size: number;
    maxEntries: number;
  };
  /** Copilot SLO evaluations over the live rolling window. */
  slo: Array<{ id: string; met: boolean; burn: number; sampled: number; budgetMs: number }>;
  /** Latest benchmark p95 per metric vs its Fabric bar (from the trend store). */
  trend: Array<{ metric: string; p95: number | null; barMs: number; gated?: boolean }>;
  /** ADX cluster ARM state (null when ADX unconfigured). */
  adx: { autoscaleEnabled: boolean; capacity: number } | null;
  /** Dedicated SQL pool ARM state (null when unconfigured). */
  warehouse: { state: string; sku: string } | null;
}

// ── Recommendation + ApplyChange contracts ───────────────────────────────────

export type ApplyChange =
  | { kind: 'spark-pool-config'; patch: { enabled?: boolean; min?: number; max?: number; idleTtlSecs?: number; concurrent?: boolean; reapEnabled?: boolean } }
  | { kind: 'cache-override'; patch: { enabled?: boolean; ttlMs?: number; maxEntries?: number } }
  | { kind: 'adx-autoscale'; isEnabled: boolean; minimum: number; maximum: number }
  | { kind: 'warehouse-scale'; sku: string }
  | { kind: 'none' };

export interface Evidence {
  signal: string;
  value: string;
  threshold: string;
}

export interface PerfRecommendation {
  /** Stable rule id (also the auto-tune dedupe key). */
  id: string;
  /** The auto-adjust class this belongs to ('informational' = no Apply). */
  cls: AutoAdjustClass | 'informational';
  severity: 'high' | 'medium' | 'low';
  title: string;
  whatsWrong: string;
  why: string;
  /** The exact change, human-readable. */
  change: string;
  apply: ApplyChange;
  evidence: Evidence[];
}

// ── Thresholds (named so the evidence rows can cite them) ────────────────────

export const MISS_RATE_THRESHOLD = 0.4;
export const MIN_ACQUIRES_FOR_SIGNAL = 3;
export const MIN_CACHE_LOOKUPS_FOR_SIGNAL = 25;
export const QUEUE_DEPTH_THRESHOLD = 10;
export const PAGE_TTI_SLOW_FACTOR = 2;

const pct = (x: number) => `${Math.round(x * 100)}%`;

function trendP95(signals: PerfSignals, metric: string): { p95: number; barMs: number } | null {
  const row = signals.trend.find((t) => t.metric === metric);
  if (!row || row.gated || typeof row.p95 !== 'number' || !Number.isFinite(row.p95)) return null;
  return { p95: row.p95, barMs: row.barMs };
}

// ── Derivation ───────────────────────────────────────────────────────────────

/** Derive the recommendation cards from a measured-signal snapshot. */
export function deriveRecommendations(signals: PerfSignals, tunables: PerfTunables): PerfRecommendation[] {
  const recs: PerfRecommendation[] = [];
  const b = tunables.autoAdjust;

  const attach = trendP95(signals, 'spark-attach');
  const demand = signals.poolAcquires.hits + signals.poolAcquires.misses;

  // 1 — warm pool disabled while real demand cold-starts.
  if (signals.pool.backendConfigured && !signals.pool.enabled && (signals.poolAcquires.misses > 0 || (attach && attach.p95 > attach.barMs))) {
    recs.push({
      id: 'pool-disabled',
      cls: 'spark-pool-size',
      severity: 'high',
      title: 'Warm Spark pool is disabled while runs cold-start',
      whatsWrong: `The warm pool kill switch is OFF and ${signals.poolAcquires.misses} recent session acquisitions had to cold-start (~2-4 min each).`,
      why: 'With the pool disabled every notebook run pays the full Synapse cold start. Re-enabling hands runs a pre-warmed Livy session in seconds.',
      change: 'Set warm-pool enabled = true (cross-replica config write).',
      apply: { kind: 'spark-pool-config', patch: { enabled: true } },
      evidence: [
        { signal: 'pool.enabled', value: 'false', threshold: 'true' },
        { signal: 'cold-start acquires (misses)', value: String(signals.poolAcquires.misses), threshold: '> 0' },
      ],
    });
  }

  // 2 — cold-start (miss) rate high → raise the warm target within bounds.
  if (
    signals.pool.enabled &&
    signals.pool.backendConfigured &&
    demand >= MIN_ACQUIRES_FOR_SIGNAL &&
    signals.poolAcquires.missRate > MISS_RATE_THRESHOLD &&
    signals.pool.min < b['spark-pool-size'].max
  ) {
    const nextMin = Math.min(signals.pool.min + 1, b['spark-pool-size'].max);
    const nextMax = Math.max(signals.pool.max, nextMin);
    recs.push({
      id: 'pool-raise-min',
      cls: 'spark-pool-size',
      severity: 'high',
      title: 'Cold-start rate is high — raise the warm-pool target',
      whatsWrong: `${pct(signals.poolAcquires.missRate)} of the last ${demand} session acquisitions missed the warm pool and cold-started.`,
      why: `Demand is outrunning the ${signals.pool.min} warm session(s) kept on standby. One more warm session absorbs the concurrent runs; cost stays bounded by the idle TTL + Synapse auto-pause.`,
      change: `Raise warm-pool min ${signals.pool.min} → ${nextMin}${nextMax !== signals.pool.max ? ` (max ${signals.pool.max} → ${nextMax})` : ''}.`,
      apply: { kind: 'spark-pool-config', patch: { min: nextMin, ...(nextMax !== signals.pool.max ? { max: nextMax } : {}) } },
      evidence: [
        { signal: 'warm-pool miss rate', value: pct(signals.poolAcquires.missRate), threshold: `> ${pct(MISS_RATE_THRESHOLD)}` },
        { signal: 'acquire attempts (window)', value: String(demand), threshold: `≥ ${MIN_ACQUIRES_FOR_SIGNAL}` },
        { signal: 'admin bound (max warm)', value: String(b['spark-pool-size'].max), threshold: `min ≤ ${b['spark-pool-size'].max}` },
      ],
    });
  }

  // 3 — misses while sessions get evicted early → extend the idle TTL.
  if (
    signals.pool.enabled &&
    signals.pool.backendConfigured &&
    demand >= MIN_ACQUIRES_FOR_SIGNAL &&
    signals.poolAcquires.missRate > MISS_RATE_THRESHOLD / 2 &&
    signals.pool.idleTtlSecs < b['spark-session-ttl'].max
  ) {
    const nextTtl = Math.min(Math.max(signals.pool.idleTtlSecs * 2, b['spark-session-ttl'].min), b['spark-session-ttl'].max);
    if (nextTtl > signals.pool.idleTtlSecs) {
      recs.push({
        id: 'pool-extend-ttl',
        cls: 'spark-session-ttl',
        severity: 'medium',
        title: 'Warm sessions expire before demand returns — extend the idle TTL',
        whatsWrong: `Warm sessions above min are evicted after ${signals.pool.idleTtlSecs}s idle, yet ${pct(signals.poolAcquires.missRate)} of acquisitions still cold-start.`,
        why: 'A longer idle TTL keeps a just-used session warm across the gap between runs. Cost impact is bounded: only warm-above-min sessions are affected and Synapse auto-pause still applies.',
        change: `Raise warm-session idle TTL ${signals.pool.idleTtlSecs}s → ${nextTtl}s.`,
        apply: { kind: 'spark-pool-config', patch: { idleTtlSecs: nextTtl } },
        evidence: [
          { signal: 'warm-pool miss rate', value: pct(signals.poolAcquires.missRate), threshold: `> ${pct(MISS_RATE_THRESHOLD / 2)}` },
          { signal: 'idle TTL', value: `${signals.pool.idleTtlSecs}s`, threshold: `< ${b['spark-session-ttl'].max}s (bound)` },
        ],
      });
    }
  }

  // 4 — Livy queue depth high → make sure the leaked-session reaper is on.
  if (signals.livyQueue && signals.livyQueue.queued > QUEUE_DEPTH_THRESHOLD) {
    if (!signals.pool.reapEnabled) {
      recs.push({
        id: 'pool-enable-reaper',
        cls: 'spark-pool-size',
        severity: 'high',
        title: 'Livy queue is deep and the leaked-session reaper is OFF',
        whatsWrong: `${signals.livyQueue.queued} sessions are queued on the default Spark pool (of ${signals.livyQueue.total} live) — the pattern of the 2026-07-14 loompool jam.`,
        why: 'Leaked queued/idle sessions fill the pool job queue until new sessions are hard-rejected. The reaper kills untracked sessions after a full grace window.',
        change: 'Set reapEnabled = true on the warm-pool config.',
        apply: { kind: 'spark-pool-config', patch: { reapEnabled: true } },
        evidence: [
          { signal: 'Livy queued sessions', value: String(signals.livyQueue.queued), threshold: `> ${QUEUE_DEPTH_THRESHOLD}` },
          { signal: 'reapEnabled', value: 'false', threshold: 'true' },
        ],
      });
    } else {
      recs.push({
        id: 'pool-queue-depth',
        cls: 'informational',
        severity: 'medium',
        title: 'Livy queue depth is elevated',
        whatsWrong: `${signals.livyQueue.queued} sessions are queued on the default Spark pool (of ${signals.livyQueue.total} live).`,
        why: 'The reaper is already ON and will clear untracked sessions after their grace window; a persistently deep queue with the reaper on means real concurrent demand — consider a bigger Spark pool node count via the Spark compute page.',
        change: 'No automatic change — monitored by the reaper.',
        apply: { kind: 'none' },
        evidence: [{ signal: 'Livy queued sessions', value: String(signals.livyQueue.queued), threshold: `> ${QUEUE_DEPTH_THRESHOLD}` }],
      });
    }
  }

  // 5 — warm-pool circuit breaker armed (real backend failure reason).
  if (signals.pool.enabled && signals.pool.lastFailure) {
    recs.push({
      id: 'pool-breaker-armed',
      cls: 'informational',
      severity: 'medium',
      title: 'Warm pool circuit breaker is backing off',
      whatsWrong: `Warm session creation keeps failing: "${signals.pool.lastFailure.slice(0, 160)}".`,
      why: 'The pool stops re-warming against a failing backend to avoid feeding a queue jam. It self-retries when the backoff expires.',
      change: 'No config change — the failure reason above names the real backend problem to fix.',
      apply: { kind: 'none' },
      evidence: [{ signal: 'pool.lastFailure', value: signals.pool.lastFailure.slice(0, 80), threshold: 'none' }],
    });
  }

  // 6 — result cache disabled while misses pile up.
  const lookups = signals.cache.hits + signals.cache.misses;
  if (!signals.cache.enabled && signals.cache.misses >= MIN_CACHE_LOOKUPS_FOR_SIGNAL) {
    recs.push({
      id: 'cache-enable',
      cls: 'cache-ttl',
      severity: 'high',
      title: 'Result cache is disabled while queries repeat',
      whatsWrong: `${signals.cache.misses} recent report/dashboard queries went to the live backend with the result cache OFF.`,
      why: 'Repeat visuals re-issue identical aggregate queries; the cache serves them in-process instead of a full backend round-trip (the sub-second repeat-visual lever).',
      change: 'Set the runtime cache override enabled = true (overrides LOOM_QUERY_CACHE_DISABLED).',
      apply: { kind: 'cache-override', patch: { enabled: true } },
      evidence: [
        { signal: 'cache.enabled', value: 'false', threshold: 'true' },
        { signal: 'backend round-trips (misses)', value: String(signals.cache.misses), threshold: `≥ ${MIN_CACHE_LOOKUPS_FOR_SIGNAL}` },
      ],
    });
  }

  // 7 — cache hit-rate under target with real volume → raise the TTL.
  if (
    signals.cache.enabled &&
    lookups >= MIN_CACHE_LOOKUPS_FOR_SIGNAL &&
    signals.cache.hitRate < CACHE_HIT_RATE_TARGET &&
    signals.cache.ttlMs < b['cache-ttl'].max * 1000
  ) {
    const nextTtlMs = Math.min(Math.max(signals.cache.ttlMs * 2, b['cache-ttl'].min * 1000), b['cache-ttl'].max * 1000);
    recs.push({
      id: 'cache-raise-ttl',
      cls: 'cache-ttl',
      severity: 'medium',
      title: `Cache hit-rate ${pct(signals.cache.hitRate)} is under the ${pct(CACHE_HIT_RATE_TARGET)} target`,
      whatsWrong: `Only ${pct(signals.cache.hitRate)} of ${lookups} lookups were served from cache — entries expire before the repeat query arrives.`,
      why: `The TTL is ${Math.round(signals.cache.ttlMs / 1000)}s; doubling it (bounded at ${b['cache-ttl'].max}s) keeps warm results alive across a dashboard refresh cycle. Invalidation-by-freshness-token still busts stale entries.`,
      change: `Raise result-cache TTL ${Math.round(signals.cache.ttlMs / 1000)}s → ${Math.round(nextTtlMs / 1000)}s (runtime override).`,
      apply: { kind: 'cache-override', patch: { ttlMs: nextTtlMs } },
      evidence: [
        { signal: 'cache hit-rate', value: pct(signals.cache.hitRate), threshold: `< ${pct(CACHE_HIT_RATE_TARGET)}` },
        { signal: 'lookups (window)', value: String(lookups), threshold: `≥ ${MIN_CACHE_LOOKUPS_FOR_SIGNAL}` },
        { signal: 'TTL bound', value: `${b['cache-ttl'].max}s`, threshold: 'admin max' },
      ],
    });
  }

  // 8 — cache full (evicting) while hit-rate lags → raise the entry cap.
  if (
    signals.cache.enabled &&
    signals.cache.size >= signals.cache.maxEntries &&
    signals.cache.hitRate < CACHE_HIT_RATE_TARGET &&
    lookups >= MIN_CACHE_LOOKUPS_FOR_SIGNAL
  ) {
    const nextMax = Math.min(signals.cache.maxEntries * 2, 20_000);
    recs.push({
      id: 'cache-raise-max',
      cls: 'cache-ttl',
      severity: 'low',
      title: 'Result cache is full and evicting warm entries',
      whatsWrong: `The in-process cache holds ${signals.cache.size}/${signals.cache.maxEntries} entries — insertion-order eviction is dropping results before they repeat.`,
      why: 'A bigger cap keeps more distinct query results warm. Memory cost is modest (result rows are size-capped per entry).',
      change: `Raise cache max entries ${signals.cache.maxEntries} → ${nextMax} (runtime override).`,
      apply: { kind: 'cache-override', patch: { maxEntries: nextMax } },
      evidence: [
        { signal: 'cache size', value: `${signals.cache.size}/${signals.cache.maxEntries}`, threshold: 'at cap' },
        { signal: 'cache hit-rate', value: pct(signals.cache.hitRate), threshold: `< ${pct(CACHE_HIT_RATE_TARGET)}` },
      ],
    });
  }

  // 9 — Copilot SLO breaching (informational — the tier router already downshifts).
  for (const slo of signals.slo) {
    if (slo.sampled > 0 && !slo.met && slo.burn > 1) {
      recs.push({
        id: `slo-breach-${slo.id}`,
        cls: 'informational',
        severity: 'high',
        title: `Copilot SLO breaching: ${slo.id}`,
        whatsWrong: `Error-budget burn is ${slo.burn.toFixed(1)}× over ${slo.sampled} recent turns (budget ${Math.round(slo.budgetMs / 1000)}s).`,
        why: 'The model tier-router\'s latency protection is already downshifting non-reasoning turns. A sustained breach means the Azure OpenAI deployment is capacity-constrained — raise its TPM quota or add a deployment.',
        change: 'No safe automatic change — capacity is an Azure OpenAI quota action.',
        apply: { kind: 'none' },
        evidence: [
          { signal: `${slo.id} burn`, value: `${slo.burn.toFixed(2)}×`, threshold: '> 1×' },
          { signal: 'sampled turns', value: String(slo.sampled), threshold: '> 0' },
        ],
      });
    }
  }

  // 10 — ADX p95 breaches the bar and optimized autoscale is off.
  const adxQ = trendP95(signals, 'adx-query');
  if (signals.adx && !signals.adx.autoscaleEnabled && adxQ && adxQ.p95 > adxQ.barMs) {
    const min = Math.max(b['adx-autoscale'].min, Math.min(signals.adx.capacity, b['adx-autoscale'].max));
    const max = Math.max(min, b['adx-autoscale'].max);
    recs.push({
      id: 'adx-enable-autoscale',
      cls: 'adx-autoscale',
      severity: 'medium',
      title: 'ADX query p95 breaches the bar — enable optimized autoscale',
      whatsWrong: `ADX query p95 is ${Math.round(adxQ.p95)}ms against the ${Math.round(adxQ.barMs)}ms bar and the cluster runs a fixed ${signals.adx.capacity} instance(s).`,
      why: 'Optimized autoscale is the native ADX right-sizing feature: it adds instances under sustained load and shrinks back off-peak — bounded by the admin instance window.',
      change: `Enable ADX optimized autoscale between ${min} and ${max} instances (ARM PATCH).`,
      apply: { kind: 'adx-autoscale', isEnabled: true, minimum: min, maximum: max },
      evidence: [
        { signal: 'adx-query p95', value: `${Math.round(adxQ.p95)}ms`, threshold: `> ${Math.round(adxQ.barMs)}ms` },
        { signal: 'optimizedAutoscale', value: 'disabled', threshold: 'enabled' },
      ],
    });
  }

  // 11 — dedicated warehouse p95 breaches → one bounded DWU step up.
  const whQ = trendP95(signals, 'warehouse-query-dedicated');
  if (signals.warehouse && signals.warehouse.state === 'Online' && whQ && whQ.p95 > whQ.barMs) {
    const next = nextDwu(signals.warehouse.sku);
    const nextIdx = next ? DWU_LADDER.indexOf(next as (typeof DWU_LADDER)[number]) : -1;
    if (next && nextIdx >= 0 && nextIdx <= b['warehouse-scale'].max) {
      recs.push({
        id: 'warehouse-scale-up',
        cls: 'warehouse-scale',
        severity: 'medium',
        title: 'Dedicated warehouse p95 breaches the bar — scale up one DWU step',
        whatsWrong: `Warehouse (dedicated pool) query p95 is ${Math.round(whQ.p95)}ms against the ${Math.round(whQ.barMs)}ms bar at ${signals.warehouse.sku}.`,
        why: `Dedicated SQL pools have no native autoscale; a one-step DWU raise (${signals.warehouse.sku} → ${next}) adds compute. NOTE: an ARM scale briefly disconnects running queries — apply in a quiet window.`,
        change: `Scale the dedicated pool ${signals.warehouse.sku} → ${next} (ARM PATCH sku).`,
        apply: { kind: 'warehouse-scale', sku: next },
        evidence: [
          { signal: 'warehouse-query-dedicated p95', value: `${Math.round(whQ.p95)}ms`, threshold: `> ${Math.round(whQ.barMs)}ms` },
          { signal: 'DWU ladder bound', value: `index ≤ ${b['warehouse-scale'].max}`, threshold: DWU_LADDER[b['warehouse-scale'].max] ?? 'top' },
        ],
      });
    }
  }

  // 12 — several page-TTI surfaces well over the bar (slow BFF routes).
  const slowPages = signals.trend.filter(
    (t) => t.metric.startsWith('page-tti:') && !t.gated && typeof t.p95 === 'number' && t.p95 > t.barMs * PAGE_TTI_SLOW_FACTOR,
  );
  if (slowPages.length >= 3) {
    recs.push({
      id: 'slow-bff-routes',
      cls: 'informational',
      severity: 'low',
      title: `${slowPages.length} surfaces render over ${PAGE_TTI_SLOW_FACTOR}× the TTI bar`,
      whatsWrong: `${slowPages
        .slice(0, 4)
        .map((p) => `${p.metric.slice('page-tti:'.length)} (${Math.round(p.p95 as number)}ms)`)
        .join(', ')} exceed ${PAGE_TTI_SLOW_FACTOR}× the ${slowPages[0].barMs}ms page-TTI bar.`,
      why: 'Slow server renders usually mean an un-cached backend call on the render path. The result-cache recommendations above are the first lever; persistent breaches need a per-route look.',
      change: 'No single automatic change — see the cache recommendations and the per-surface trend charts.',
      apply: { kind: 'none' },
      evidence: slowPages.slice(0, 4).map((p) => ({
        signal: `${p.metric} p95`,
        value: `${Math.round(p.p95 as number)}ms`,
        threshold: `> ${p.barMs * PAGE_TTI_SLOW_FACTOR}ms`,
      })),
    });
  }

  return recs;
}

// ── Apply-change validation (route + auto-tune both call this) ───────────────

export interface ValidatedChange {
  ok: boolean;
  error?: string;
  /** The change with every numeric clamped into the admin bounds. */
  change?: ApplyChange;
}

const clampN = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Validate + CLAMP an ApplyChange against the admin tunable bounds. Pure —
 * never trusts the client's numbers; every value is clamped into the admin
 * min/max (and the per-class hard range) before execution.
 */
export function validateApplyChange(raw: unknown, tunables: PerfTunables): ValidatedChange {
  if (!raw || typeof raw !== 'object' || typeof (raw as { kind?: unknown }).kind !== 'string') {
    return { ok: false, error: 'change.kind is required' };
  }
  const change = raw as ApplyChange;
  const b = tunables.autoAdjust;

  switch (change.kind) {
    case 'spark-pool-config': {
      const p = (change as { patch?: Record<string, unknown> }).patch;
      if (!p || typeof p !== 'object') return { ok: false, error: 'patch is required' };
      const out: { enabled?: boolean; min?: number; max?: number; idleTtlSecs?: number; concurrent?: boolean; reapEnabled?: boolean } = {};
      if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
      if (typeof p.concurrent === 'boolean') out.concurrent = p.concurrent;
      if (typeof p.reapEnabled === 'boolean') out.reapEnabled = p.reapEnabled;
      const sz = b['spark-pool-size'];
      if (typeof p.min === 'number' && Number.isFinite(p.min)) out.min = clampN(Math.floor(p.min), sz.min, sz.max);
      if (typeof p.max === 'number' && Number.isFinite(p.max)) out.max = clampN(Math.floor(p.max), sz.min, Math.max(sz.max, out.min ?? sz.min));
      const tt = b['spark-session-ttl'];
      if (typeof p.idleTtlSecs === 'number' && Number.isFinite(p.idleTtlSecs)) out.idleTtlSecs = clampN(Math.floor(p.idleTtlSecs), tt.min, tt.max);
      if (Object.keys(out).length === 0) return { ok: false, error: 'patch carries no recognised field' };
      return { ok: true, change: { kind: 'spark-pool-config', patch: out } };
    }
    case 'cache-override': {
      const p = (change as { patch?: Record<string, unknown> }).patch;
      if (!p || typeof p !== 'object') return { ok: false, error: 'patch is required' };
      const ct = b['cache-ttl'];
      const out: { enabled?: boolean; ttlMs?: number; maxEntries?: number } = {};
      if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
      if (typeof p.ttlMs === 'number' && Number.isFinite(p.ttlMs)) out.ttlMs = clampN(Math.floor(p.ttlMs), ct.min * 1000, ct.max * 1000);
      if (typeof p.maxEntries === 'number' && Number.isFinite(p.maxEntries)) out.maxEntries = clampN(Math.floor(p.maxEntries), 50, 20_000);
      if (Object.keys(out).length === 0) return { ok: false, error: 'patch carries no recognised field' };
      return { ok: true, change: { kind: 'cache-override', patch: out } };
    }
    case 'adx-autoscale': {
      const c = change as { isEnabled?: unknown; minimum?: unknown; maximum?: unknown };
      if (typeof c.isEnabled !== 'boolean') return { ok: false, error: 'isEnabled must be boolean' };
      const ax = b['adx-autoscale'];
      const minimum = clampN(Math.floor(Number(c.minimum ?? ax.min)), ax.min, ax.max);
      const maximum = clampN(Math.floor(Number(c.maximum ?? ax.max)), minimum, ax.max);
      if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return { ok: false, error: 'minimum/maximum must be numbers' };
      return { ok: true, change: { kind: 'adx-autoscale', isEnabled: c.isEnabled, minimum, maximum } };
    }
    case 'warehouse-scale': {
      const sku = String((change as { sku?: unknown }).sku ?? '');
      const idx = DWU_LADDER.indexOf(sku as (typeof DWU_LADDER)[number]);
      if (idx < 0) return { ok: false, error: `sku must be one of ${DWU_LADDER.join(', ')}` };
      const wb = b['warehouse-scale'];
      if (idx > wb.max) return { ok: false, error: `sku ${sku} exceeds the admin DWU bound (${DWU_LADDER[wb.max]})` };
      return { ok: true, change: { kind: 'warehouse-scale', sku } };
    }
    case 'none':
      return { ok: false, error: 'this recommendation is informational — nothing to apply' };
    default:
      return { ok: false, error: `unknown change kind '${(change as { kind: string }).kind}'` };
  }
}

/** Class metadata passthrough for the UI. */
export { AUTO_ADJUST_META };
