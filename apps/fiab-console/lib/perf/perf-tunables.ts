/**
 * PERF-4.2 — admin performance tunables (pure types + defaults + sanitizer).
 *
 * ONE admin-owned config document (persisted by `usage-store.ts` in the
 * `perf-learning` Cosmos container, cached in-process) that carries:
 *
 *   • per-class AUTO-ADJUST toggles + admin min/max bounds — when a class is
 *     ON, `auto-tune.ts` applies that recommendation class automatically,
 *     always clamped inside the admin bounds;
 *   • the runtime result-cache override (enabled / ttlMs / maxEntries) that
 *     `query-result-cache.ts` consults so a cache recommendation's Apply is a
 *     REAL config write that takes effect immediately (no-vaporware.md);
 *   • the usage-learning config (`usage-learning.ts` LearningConfig).
 *
 * All classes default ON (default-on / opt-out) with conservative bounds, so
 * out of the box the system self-tunes only within safe, cost-bounded ranges.
 * Pure module — no I/O — so the clamp rules are vitest-covered.
 */

import {
  defaultLearningConfig,
  sanitizeLearningConfig,
  type LearningConfig,
} from '@/lib/perf/usage-learning';

/** A recommendation class the admin can put on auto-pilot. */
export type AutoAdjustClass =
  | 'spark-pool-size' // warm-pool min/max session counts
  | 'spark-session-ttl' // warm-session idle TTL (seconds)
  | 'cache-ttl' // result-cache TTL (seconds) + max entries
  | 'adx-autoscale' // ADX optimized autoscale (instance count bounds)
  | 'warehouse-scale'; // dedicated SQL pool DWU (Loom-driven scale — no native autoscale)

export const AUTO_ADJUST_CLASSES: readonly AutoAdjustClass[] = [
  'spark-pool-size',
  'spark-session-ttl',
  'cache-ttl',
  'adx-autoscale',
  'warehouse-scale',
];

export interface AutoAdjustBounds {
  /** Auto-apply this recommendation class (bounded below). DEFAULT ON. */
  enabled: boolean;
  /** Lower bound (unit per class — see AUTO_ADJUST_META). */
  min: number;
  /** Upper bound. */
  max: number;
}

/** Display metadata + hard clamp range per class (units the admin sees). */
export const AUTO_ADJUST_META: Record<
  AutoAdjustClass,
  { label: string; unit: string; hardMin: number; hardMax: number; description: string }
> = {
  'spark-pool-size': {
    label: 'Spark warm-pool size',
    unit: 'sessions',
    hardMin: 0,
    hardMax: 20,
    description:
      'Auto-raises/lowers the warm-session target when the measured cold-start (miss) rate is high or the pool sits idle. Bounds cap the min/max warm sessions auto-tune may set.',
  },
  'spark-session-ttl': {
    label: 'Warm-session idle TTL',
    unit: 'seconds',
    hardMin: 120,
    hardMax: 14_400,
    description:
      'Auto-extends the idle TTL when warm sessions are evicted just before real demand returns (miss after evict). Bounds cap the TTL auto-tune may set.',
  },
  'cache-ttl': {
    label: 'Result-cache TTL',
    unit: 'seconds',
    hardMin: 15,
    hardMax: 3_600,
    description:
      'Auto-raises the result-cache TTL when the measured hit-rate is under target with real lookup volume. Bounds cap the TTL auto-tune may set.',
  },
  'adx-autoscale': {
    label: 'ADX optimized autoscale',
    unit: 'instances',
    hardMin: 2,
    hardMax: 16,
    description:
      'Enables/keeps ADX optimized autoscale (a native Azure Data Explorer feature) when query p95 breaches the bar. Bounds are the autoscale instance-count window.',
  },
  'warehouse-scale': {
    label: 'Warehouse DWU scale',
    unit: 'DWU steps (ladder index)',
    hardMin: 0,
    hardMax: 5,
    description:
      'Applies a one-step DWU scale-up on the dedicated SQL pool when its query p95 breaches persistently. Dedicated pools have NO native autoscale — this is a Loom-driven ARM scale, bounded by the ladder index below. A scale briefly disconnects running queries.',
  },
};

/** DWU ladder for the Loom-driven warehouse scale (index = bounds unit). */
export const DWU_LADDER = ['DW100c', 'DW200c', 'DW300c', 'DW400c', 'DW500c', 'DW1000c'] as const;

/** Next DWU step up from `sku` (null when unknown / already at the ladder top). */
export function nextDwu(sku: string): string | null {
  const i = DWU_LADDER.indexOf(sku as (typeof DWU_LADDER)[number]);
  if (i < 0 || i >= DWU_LADDER.length - 1) return null;
  return DWU_LADDER[i + 1];
}

/** Runtime result-cache override (consulted by query-result-cache.ts). */
export interface CacheOverride {
  /** Overrides the env kill switch when set (admin runtime control). */
  enabled?: boolean;
  /** Overrides the generic TTL (per-backend env vars still win). */
  ttlMs?: number;
  /** Overrides the in-process max-entry cap. */
  maxEntries?: number;
}

export interface PerfTunables {
  autoAdjust: Record<AutoAdjustClass, AutoAdjustBounds>;
  cacheOverride: CacheOverride;
  learning: LearningConfig;
  updatedAt: number;
  updatedBy?: string;
}

export function defaultTunables(): PerfTunables {
  return {
    autoAdjust: {
      // Default-ON everywhere (die-hard default-on / opt-out) with conservative,
      // cost-bounded windows the admin can widen.
      'spark-pool-size': { enabled: true, min: 1, max: 3 },
      'spark-session-ttl': { enabled: true, min: 600, max: 3600 },
      'cache-ttl': { enabled: true, min: 60, max: 900 },
      'adx-autoscale': { enabled: true, min: 2, max: 3 },
      // Bounded to ladder index 0..1 (DW100c→DW200c) until the admin widens it.
      'warehouse-scale': { enabled: true, min: 0, max: 1 },
    },
    cacheOverride: {},
    learning: defaultLearningConfig(),
    updatedAt: 0,
  };
}

const clampN = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function sanitizeBounds(cls: AutoAdjustClass, p: Partial<AutoAdjustBounds> | undefined, d: AutoAdjustBounds): AutoAdjustBounds {
  const meta = AUTO_ADJUST_META[cls];
  const min = Number.isFinite(p?.min) ? clampN(Math.floor(Number(p!.min)), meta.hardMin, meta.hardMax) : d.min;
  const maxRaw = Number.isFinite(p?.max) ? clampN(Math.floor(Number(p!.max)), meta.hardMin, meta.hardMax) : d.max;
  return {
    enabled: typeof p?.enabled === 'boolean' ? p.enabled : d.enabled,
    min,
    max: Math.max(min, maxRaw),
  };
}

/** Clamp/repair an untrusted partial into a valid PerfTunables. */
export function sanitizeTunables(p: Partial<PerfTunables> | undefined): PerfTunables {
  const d = defaultTunables();
  if (!p) return d;
  const autoAdjust = {} as Record<AutoAdjustClass, AutoAdjustBounds>;
  for (const cls of AUTO_ADJUST_CLASSES) {
    autoAdjust[cls] = sanitizeBounds(cls, p.autoAdjust?.[cls], d.autoAdjust[cls]);
  }
  const co: CacheOverride = {};
  if (typeof p.cacheOverride?.enabled === 'boolean') co.enabled = p.cacheOverride.enabled;
  if (Number.isFinite(p.cacheOverride?.ttlMs) && Number(p.cacheOverride!.ttlMs) > 0)
    co.ttlMs = clampN(Math.floor(Number(p.cacheOverride!.ttlMs)), 15_000, 3_600_000);
  if (Number.isFinite(p.cacheOverride?.maxEntries) && Number(p.cacheOverride!.maxEntries) > 0)
    co.maxEntries = clampN(Math.floor(Number(p.cacheOverride!.maxEntries)), 50, 20_000);
  return {
    autoAdjust,
    cacheOverride: co,
    learning: sanitizeLearningConfig(p.learning),
    updatedAt: Number.isFinite(p.updatedAt) ? Number(p.updatedAt) : Date.now(),
    updatedBy: typeof p.updatedBy === 'string' ? p.updatedBy.slice(0, 200) : undefined,
  };
}
