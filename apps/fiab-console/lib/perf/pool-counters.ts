/**
 * PERF-4.1 — process-wide warm-pool acquisition counters.
 *
 * Records every `acquireWarmSession` outcome (warm HIT vs MISS→cold-start) plus
 * the acquisition latency, so the Performance page's recommendation engine
 * derives its "cold-start rate is high" advice from REAL measured demand — not
 * a fabricated signal (no-vaporware.md).
 *
 * Same in-process model as `cache-counters.ts`: module scope → per-ACA-replica,
 * resets with the process. The recommendation derivation treats these as a
 * recent-window sample from the replica serving the admin page.
 */

const MAX_SAMPLES = 200;

interface PoolCounterState {
  hits: number;
  misses: number;
  /** Recent acquisition latencies (ms), hits only (a miss returns ~instantly). */
  hitAcquireMs: number[];
  /** Epoch ms of the most recent miss (drives "recent demand went cold"). */
  lastMissAt: number | null;
  lastHitAt: number | null;
}

const state: PoolCounterState = { hits: 0, misses: 0, hitAcquireMs: [], lastMissAt: null, lastHitAt: null };

/** Record an acquire outcome. `hit` = a warm session was handed off. */
export function recordPoolAcquire(hit: boolean, acquireMs?: number): void {
  if (hit) {
    state.hits++;
    state.lastHitAt = Date.now();
    if (typeof acquireMs === 'number' && Number.isFinite(acquireMs) && acquireMs >= 0) {
      state.hitAcquireMs.push(acquireMs);
      if (state.hitAcquireMs.length > MAX_SAMPLES) state.hitAcquireMs.shift();
    }
  } else {
    state.misses++;
    state.lastMissAt = Date.now();
  }
}

export interface PoolCountersSnapshot {
  hits: number;
  misses: number;
  total: number;
  /** misses / total (0 when no acquires yet). */
  missRate: number;
  /** Median warm-hit acquisition latency (ms), null when no hits sampled. */
  hitAcquireP50Ms: number | null;
  lastMissAt: number | null;
  lastHitAt: number | null;
}

export function poolCountersSnapshot(): PoolCountersSnapshot {
  const total = state.hits + state.misses;
  let p50: number | null = null;
  if (state.hitAcquireMs.length > 0) {
    const sorted = [...state.hitAcquireMs].sort((a, b) => a - b);
    p50 = sorted[Math.floor((sorted.length - 1) / 2)];
  }
  return {
    hits: state.hits,
    misses: state.misses,
    total,
    missRate: total > 0 ? state.misses / total : 0,
    hitAcquireP50Ms: p50,
    lastMissAt: state.lastMissAt,
    lastHitAt: state.lastHitAt,
  };
}

/** TEST HOOK — reset every counter. */
export function _resetPoolCounters(): void {
  state.hits = 0;
  state.misses = 0;
  state.hitAcquireMs = [];
  state.lastMissAt = null;
  state.lastHitAt = null;
}
