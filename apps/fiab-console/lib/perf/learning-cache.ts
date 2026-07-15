/**
 * PERF-4.4 — sync learning bridge for the warm-pool refill/sweep hot path.
 *
 * `spark-session-pool.ts` needs the LEARNED warm target synchronously inside
 * `refillPool()` / `sweep()` (both run on the request path). This module keeps
 * an in-process snapshot of the aggregated usage histograms + learning config,
 * refreshed asynchronously by the pool sweep tick (`refreshLearningCache`), so
 * the sync `learnedTargetMin()` read is O(1) with no I/O.
 *
 * Import direction: pool → learning-cache → usage-store → cosmos-client — no
 * cycle back into the pool. Honest degradation: until the first refresh (or
 * with Cosmos unconfigured / learning disabled) the learned target is exactly
 * the admin base `min` — behaviour identical to today.
 */

import { learnedTarget, type LearningConfig, type LearnedDecision, hourOfWeek } from '@/lib/perf/usage-learning';
import { aggregateByPool, getTunablesCached, listHistograms } from '@/lib/perf/usage-store';

interface LearningSnapshot {
  /** Aggregated hour-of-week weights per pool groupKey. */
  byPoolKey: Map<string, { weights: number[]; total: number }>;
  refreshedAt: number;
}

const g = globalThis as unknown as { __loomLearningSnap?: LearningSnapshot };
const snap: LearningSnapshot =
  g.__loomLearningSnap ?? (g.__loomLearningSnap = { byPoolKey: new Map(), refreshedAt: 0 });

const REFRESH_MIN_INTERVAL_MS = 60_000;

/**
 * Refresh the histogram snapshot from Cosmos (throttled). Called from the pool
 * sweep tick — best-effort; a failure leaves the previous snapshot in place.
 */
export async function refreshLearningCache(force = false): Promise<void> {
  if (!force && Date.now() - snap.refreshedAt < REFRESH_MIN_INTERVAL_MS) return;
  snap.refreshedAt = Date.now();
  try {
    const cfg = getTunablesCached().learning;
    if (!cfg.enabled) {
      snap.byPoolKey = new Map();
      return;
    }
    const docs = await listHistograms();
    snap.byPoolKey = aggregateByPool(docs, cfg.workspaces);
  } catch {
    /* best-effort — keep the previous snapshot */
  }
}

/** The learned decision for a pool group RIGHT NOW (sync; O(1)). */
export function learnedDecision(groupKey: string, baseMin: number, boundMax: number): LearnedDecision {
  const cfg: LearningConfig = getTunablesCached().learning;
  const hist = snap.byPoolKey.get(groupKey);
  const weights = hist?.weights ?? [];
  return learnedTarget(weights, hourOfWeek(Date.now()), cfg, baseMin, boundMax);
}

/**
 * The effective warm-target `min` for a pool group — the admin base `min`
 * modulated by the learned schedule (boost in predicted-busy windows, 0 in
 * confidently-dead hours, manual overrides beat both). Never exceeds boundMax.
 */
export function learnedTargetMin(groupKey: string, baseMin: number, boundMax: number): number {
  return learnedDecision(groupKey, baseMin, boundMax).target;
}

/** Snapshot metadata for the status/diagnostics surfaces. */
export function learningCacheStatus(): { pools: number; refreshedAt: number } {
  return { pools: snap.byPoolKey.size, refreshedAt: snap.refreshedAt };
}

/** TEST HOOK — reset the snapshot. */
export function _resetLearningCache(): void {
  snap.byPoolKey = new Map();
  snap.refreshedAt = 0;
}
