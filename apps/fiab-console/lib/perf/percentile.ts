/**
 * PSR-1 — percentile + latency-summary helpers (pure, unit-tested).
 *
 * The benchmark harness records N latency samples per metric (a cold first
 * sample + N-1 warm samples) and summarises them with p50/p95/p99 and a
 * cold-vs-warm split. These helpers are deliberately dependency-free so the
 * standalone `scripts/csa-loom/perf` suite, the server-side runner, and the
 * unit tests all share the exact same math (no drift between "the number CI
 * measured" and "the number the admin page shows").
 *
 * Percentile method: nearest-rank on the sorted sample set (the same method
 * Azure Monitor / Kusto `percentile()` documents), clamped to the array bounds.
 */

/** Nearest-rank percentile of `samples` at `p` in [0,100]. Returns NaN when empty. */
export function percentile(samples: readonly number[], p: number): number {
  const clean = samples.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (clean.length === 0) return NaN;
  if (clean.length === 1) return clean[0];
  const pct = Math.min(100, Math.max(0, p));
  // Nearest-rank: rank = ceil(pct/100 * N), 1-indexed, clamped to [1, N].
  const rank = Math.ceil((pct / 100) * clean.length);
  const idx = Math.min(clean.length - 1, Math.max(0, rank - 1));
  return clean[idx];
}

/** Arithmetic mean of the finite samples (NaN when empty). */
export function mean(samples: readonly number[]): number {
  const clean = samples.filter((n) => Number.isFinite(n));
  if (clean.length === 0) return NaN;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

/** Median (p50) convenience. */
export function median(samples: readonly number[]): number {
  return percentile(samples, 50);
}

export interface LatencySummary {
  /** Number of finite samples that fed the summary. */
  n: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  /** First (cold-start) sample in the raw ordering, if any. */
  coldMs: number | null;
  /** Median of the warm samples (everything after the first), if any. */
  warmMs: number | null;
}

/**
 * Summarise a raw latency series. `samples[0]` is treated as the COLD sample
 * (first attach / first request against a cold pool / cold plan cache); the
 * remaining samples are the WARM steady-state. p50/p95/p99/min/max are computed
 * over ALL finite samples so the tail reflects the real distribution the run
 * observed.
 */
export function summarize(samples: readonly number[]): LatencySummary {
  const finite = samples.filter((n) => Number.isFinite(n));
  const coldMs = Number.isFinite(samples[0]) ? (samples[0] as number) : null;
  const warm = samples.slice(1).filter((n) => Number.isFinite(n));
  return {
    n: finite.length,
    p50: percentile(finite, 50),
    p95: percentile(finite, 95),
    p99: percentile(finite, 99),
    min: finite.length ? Math.min(...finite) : NaN,
    max: finite.length ? Math.max(...finite) : NaN,
    coldMs,
    warmMs: warm.length ? median(warm) : (coldMs !== null ? coldMs : null),
  };
}

/** Round a millisecond number to the nearest whole ms for storage/display. */
export function roundMs(n: number | null): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  return Math.round(n);
}
