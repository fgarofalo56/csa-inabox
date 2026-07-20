/**
 * retrieval-metrics — process-wide telemetry for the docs Copilot retrieval
 * path (WS-G / G3). The Help Copilot's `searchDocs()` RAG lookup previously had
 * NO operational telemetry — only a generic `query-result-cache` hit-rate
 * existed, which measures the report/semantic-layer cache, not doc retrieval.
 * Without retrieval numbers you can't tune the corpus (are queries returning
 * anything? how slow is the round-trip? how often does AI Search fall back to
 * the Cosmos substring backend?).
 *
 * WHY a separate module (mirrors `cache-counters.ts`): `perf-metrics.ts` is a
 * pure, browser-importable constants/types registry (no runtime state, no Node
 * imports). This module holds the RUNTIME numbers `loom-docs-index.searchDocs`
 * feeds and stays Node-side, so the browser bundle never pulls a counter
 * singleton along.
 *
 * State lives in module scope → per-ACA-replica, resets with the process (same
 * model as `cache-counters.ts`). An operator reads the aggregate from the perf
 * surface, which samples one replica.
 *
 * NO Fabric / Power BI dependency — these are Loom-internal counters only
 * (.claude/rules/no-fabric-dependency.md).
 */

/** Which retrieval backend answered a docs-Copilot lookup. */
export type RetrievalBackend = 'ai-search' | 'cosmos' | 'none';

/** Bounded reservoir of the most recent latency samples used for percentiles.
 *  500 samples is plenty for a p50/p95 read and caps memory at a few KB. */
const LATENCY_RESERVOIR_MAX = 500;

interface RetrievalState {
  /** Total retrieval lookups recorded (non-blank queries). */
  queries: number;
  /** Lookups that returned >= 1 chunk. */
  hits: number;
  /** Lookups that returned 0 chunks. */
  empty: number;
  /** Lookups where AI Search was configured but the request fell back to the
   *  Cosmos substring backend (error or empty AI-Search result). */
  fallbacks: number;
  /** Sum of every recorded latency (ms) — for the running average. */
  totalLatencyMs: number;
  /** Max latency (ms) seen this process. */
  maxLatencyMs: number;
  /** Per-backend answered counts. */
  byBackend: Record<RetrievalBackend, number>;
  /** Ring buffer of recent latencies (ms) for p50/p95. */
  latencies: number[];
}

function freshState(): RetrievalState {
  return {
    queries: 0,
    hits: 0,
    empty: 0,
    fallbacks: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    byBackend: { 'ai-search': 0, cosmos: 0, none: 0 },
    latencies: [],
  };
}

let state: RetrievalState = freshState();

/** One retrieval observation from the docs-Copilot RAG path. */
export interface RetrievalObservation {
  /** Backend that ultimately answered. */
  backend: RetrievalBackend;
  /** Wall-clock latency of the whole `searchDocs` call (ms). */
  latencyMs: number;
  /** Number of chunks returned. */
  resultCount: number;
  /** True when AI Search was configured but the call fell back to Cosmos. */
  fallback: boolean;
}

/** Record a single docs-retrieval lookup. Called by `loom-docs-index.searchDocs`. */
export function recordRetrieval(obs: RetrievalObservation): void {
  state.queries += 1;
  if (obs.resultCount > 0) state.hits += 1;
  else state.empty += 1;
  if (obs.fallback) state.fallbacks += 1;
  const ms = Math.max(0, Math.round(obs.latencyMs));
  state.totalLatencyMs += ms;
  if (ms > state.maxLatencyMs) state.maxLatencyMs = ms;
  state.byBackend[obs.backend] = (state.byBackend[obs.backend] || 0) + 1;
  state.latencies.push(ms);
  if (state.latencies.length > LATENCY_RESERVOIR_MAX) state.latencies.shift();
}

/** Nearest-rank percentile (0..100) over a numeric sample; 0 when empty. */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

export interface RetrievalMetricsSnapshot {
  /** Total lookups. */
  queries: number;
  /** Lookups that returned >= 1 chunk. */
  hits: number;
  /** Lookups that returned nothing. */
  empty: number;
  /** hits / queries (0..1); 0 when no lookups yet. */
  hitRate: number;
  /** Count of AI-Search → Cosmos fallbacks. */
  fallbacks: number;
  /** fallbacks / queries (0..1); 0 when no lookups yet. */
  fallbackRate: number;
  /** Latency distribution (ms) over the recent reservoir + lifetime avg/max. */
  latency: { p50: number; p95: number; avg: number; max: number; samples: number };
  /** Per-backend answered counts. */
  byBackend: Record<RetrievalBackend, number>;
}

/** Point-in-time snapshot for the perf / diagnostics UI + the retrieval-stats route. */
export function retrievalMetricsSnapshot(): RetrievalMetricsSnapshot {
  const { queries, hits, empty, fallbacks, totalLatencyMs, maxLatencyMs, byBackend, latencies } = state;
  return {
    queries,
    hits,
    empty,
    hitRate: queries > 0 ? hits / queries : 0,
    fallbacks,
    fallbackRate: queries > 0 ? fallbacks / queries : 0,
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      avg: queries > 0 ? Math.round(totalLatencyMs / queries) : 0,
      max: maxLatencyMs,
      samples: latencies.length,
    },
    byBackend: { ...byBackend },
  };
}

/** Reset every counter (used by tests + an operator diagnostics reset). */
export function resetRetrievalMetrics(): void {
  state = freshState();
}
