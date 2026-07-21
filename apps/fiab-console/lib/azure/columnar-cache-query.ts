/**
 * columnar-cache-query — the Azure-native **Direct Lake substitute** (WS-3.3).
 *
 * Fabric Direct Lake loads a semantic model's columns straight from Delta files
 * into an in-memory VertiPaq cache and "frames" the model to the latest committed
 * Delta version without an Import refresh. That needs a Fabric F-SKU (unavailable
 * in Gov). This module delivers the same OUTCOME — import-like latency with **no
 * manual refresh** — on 100% Azure-native + OSS backends, per
 * `.claude/rules/no-fabric-dependency.md`:
 *
 *   1. **DirectQuery over Serverless external Delta.** The semantic model's
 *      measures/columns resolve to a Synapse Serverless `OPENROWSET(…, FORMAT='DELTA')`
 *      read over the Gold Delta files on ADLS Gen2 (or the loom-directlake ACA
 *      app's DataFusion scan when configured) — NO VertiPaq import, NO Power BI.
 *   2. **Aggressive result caching.** Every result is memoised in the always-on
 *      three-tier `query-result-cache` (in-process LRU → shared Redis → Cosmos),
 *      keyed by the compiled SQL + parameters + the **current Delta frame token**.
 *      A repeat query collapses to a Map/Redis read — import-like latency — while
 *      the frame is unchanged.
 *   3. **"Framing" refresh (metadata-only).** The current Delta commit VERSION is
 *      resolved (cheaply, then cached for `LOOM_DL_FRAME_TTL_SECONDS`) and folded
 *      into the cache key. When new rows land and the Delta version advances, the
 *      frame token rotates → every prior cache key is stranded and the next query
 *      re-reads live Delta ONCE, then re-caches. This is a lightweight metadata
 *      refresh (a version pin), NOT a full data reload — exactly Direct Lake
 *      framing. No manual refresh is ever required.
 *
 * Routing: opt in with `LOOM_SEMANTIC_BACKEND=loom-columnar-cache`
 * ({@link columnarCacheBackendSelected}). The frame VERSION is real when the
 * loom-directlake service (`LOOM_DIRECTLAKE_URL`) is deployed; otherwise a
 * per-item hint proxy (last-refresh / `_ts`) still gives correct
 * invalidate-on-change semantics (honest, never faked).
 *
 * Pure orchestration with dependency injection (resolveFrame / runQuery / cache
 * get+set) so the framing + cache-key + routing logic is unit-testable with zero
 * Azure. No Fabric / OneLake / Power BI host appears in this file.
 */

import {
  buildQueryCacheKey,
  getCachedResult,
  setCachedResult,
  queryCacheEnabled,
  type CachedQueryResult,
} from '@/lib/azure/query-result-cache';
import { buildFrameUrl } from '@/lib/directlake/scan-request';

/** The execution-surface + backend label folded into every columnar-cache key. */
export const COLUMNAR_STORAGE_MODE = 'direct-lake';
export const COLUMNAR_BACKEND = 'columnar-cache';

/** The `LOOM_SEMANTIC_BACKEND` value that routes DAX-class queries to this path. */
export const COLUMNAR_CACHE_BACKEND_VALUE = 'loom-columnar-cache';

/** True when the operator opted the semantic layer into the Direct Lake substitute. */
export function columnarCacheBackendSelected(): boolean {
  return (process.env.LOOM_SEMANTIC_BACKEND ?? '').trim().toLowerCase() === COLUMNAR_CACHE_BACKEND_VALUE;
}

/** How a frame's Delta version was resolved — surfaced honestly in the UI. */
export type FrameVia = 'directlake-service' | 'hint' | 'time-bucket';

/** A pinned Delta frame — the metadata that makes repeat queries import-fast. */
export interface DeltaFrame {
  /**
   * The invalidation token folded into the cache key. The real Delta commit
   * version when known (`v<n>`); else a per-item hint proxy or a time bucket.
   * When it changes, the frame has advanced and the result cache is bypassed.
   */
  token: string;
  /** Real Delta commit version when the loom-directlake service resolved it, else null. */
  deltaVersion: number | null;
  /** Epoch ms the frame was resolved (for the "framed at" caption + TTL). */
  framedAt: number;
  /** How the version was resolved. */
  via: FrameVia;
  /** Optional source kind echoed by the framing service (delta / parquet / fixture). */
  sourceKind?: string;
}

/** Frame-cache TTL (ms): how long a resolved Delta version is reused before re-framing. */
export function frameTtlMs(): number {
  const n = Number(process.env.LOOM_DL_FRAME_TTL_SECONDS);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : 30_000;
}

/** Build the canonical frame token from a resolved version (or a hint proxy). */
export function frameToken(parts: { deltaVersion: number | null; via: FrameVia; sourceKind?: string; hint?: string }): string {
  if (typeof parts.deltaVersion === 'number') return `dl:v${parts.deltaVersion}:${parts.sourceKind ?? ''}`;
  if (parts.hint) return `dl:h:${parts.hint}`;
  return `dl:${parts.via}:${parts.sourceKind ?? ''}`;
}

// ── Frame cache (per-replica, short-TTL) ─────────────────────────────────────
// Re-checking the Delta version on EVERY query would defeat the perf goal, so a
// resolved frame is reused for `frameTtlMs()`. That is Direct Lake's framing
// cadence: the version is pinned, all queries in the window hit the result
// cache, and the frame advances when the window lapses (or on explicit reframe).

const frameStore = new Map<string, DeltaFrame>();

/** Drop cached frames (all, or one source) so the next query re-resolves the version. */
export function invalidateFrameCache(source?: string): void {
  if (!source) {
    frameStore.clear();
    return;
  }
  frameStore.delete(source);
}

/**
 * Fetch the current Delta version from the loom-directlake ACA service's `/frame`
 * endpoint (metadata-only — NO data scanned/copied). Returns null when the
 * service is not deployed (`LOOM_DIRECTLAKE_URL` unset) or the call fails, so the
 * caller degrades to a hint proxy — never a hard Fabric gate.
 */
export async function fetchServiceFrameVersion(
  source: string,
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<{ deltaVersion: number | null; sourceKind?: string } | null> {
  const base = process.env.LOOM_DIRECTLAKE_URL?.trim();
  if (!base) return null;
  const doFetch = opts?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 8_000);
  try {
    const res = await doFetch(buildFrameUrl(base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: source }),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok?: boolean; frame?: { delta_version?: number | null; source_kind?: string } };
    if (!json || json.ok !== true || !json.frame) return null;
    const v = json.frame.delta_version;
    return { deltaVersion: typeof v === 'number' ? v : null, sourceKind: json.frame.source_kind };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Dependencies for {@link resolveFrame} — injectable so framing is testable with no network. */
export interface ResolveFrameDeps {
  /** Resolve the real Delta version for a source (loom-directlake `/frame`), or null. */
  fetchVersion?: (source: string) => Promise<{ deltaVersion: number | null; sourceKind?: string } | null>;
  /** A per-item freshness proxy (last-refresh / `_ts`) used when no real version exists. */
  hint?: string;
  now?: () => number;
}

/**
 * Resolve (and short-TTL-cache) the current Delta frame for a source. Prefers the
 * real version from the loom-directlake service; falls back to a per-item hint
 * proxy, then a time bucket. Within `frameTtlMs()` the pinned frame is reused so
 * every query in the window shares one result-cache slot.
 */
export async function resolveFrame(source: string, deps: ResolveFrameDeps = {}): Promise<DeltaFrame> {
  const now = deps.now ?? Date.now;
  const t = now();
  const cached = frameStore.get(source);
  if (cached && t - cached.framedAt < frameTtlMs()) return cached;

  const fetchVersion = deps.fetchVersion ?? ((s: string) => fetchServiceFrameVersion(s));
  let resolved: { deltaVersion: number | null; sourceKind?: string } | null = null;
  try {
    resolved = await fetchVersion(source);
  } catch {
    resolved = null;
  }

  let frame: DeltaFrame;
  if (resolved && typeof resolved.deltaVersion === 'number') {
    frame = {
      token: frameToken({ deltaVersion: resolved.deltaVersion, via: 'directlake-service', sourceKind: resolved.sourceKind }),
      deltaVersion: resolved.deltaVersion,
      framedAt: t,
      via: 'directlake-service',
      sourceKind: resolved.sourceKind,
    };
  } else if (deps.hint) {
    frame = {
      token: frameToken({ deltaVersion: null, via: 'hint', hint: deps.hint }),
      deltaVersion: null,
      framedAt: t,
      via: 'hint',
      sourceKind: resolved?.sourceKind,
    };
  } else {
    // Last resort: a time bucket of one frame-TTL so the cache still self-heals.
    const bucket = Math.floor(t / Math.max(1, frameTtlMs()));
    frame = {
      token: frameToken({ deltaVersion: null, via: 'time-bucket', sourceKind: String(bucket) }),
      deltaVersion: null,
      framedAt: t,
      via: 'time-bucket',
      sourceKind: resolved?.sourceKind,
    };
  }
  frameStore.set(source, frame);
  return frame;
}

// ── The columnar-cache query (framing + result cache + Serverless DirectQuery) ─

export interface ColumnarQuery {
  /** Semantic-model / report item id — the cache namespace. */
  modelId: string;
  /** The compiled Synapse Serverless OPENROWSET(DELTA) SQL (the query identity). */
  sql: string;
  /** The Delta source path — the framing scope (which table's version to pin). */
  source: string;
  /** Bound parameters folded into the cache key. */
  parameters?: ReadonlyArray<{ name?: string; value?: unknown } | unknown>;
}

export interface ColumnarQueryDeps {
  /** Resolve the current Delta frame for the source (framing). */
  resolveFrame: (source: string) => Promise<DeltaFrame>;
  /** Run the real Serverless DirectQuery over Delta on a cache miss. */
  runQuery: () => Promise<CachedQueryResult>;
  /** Cache read (defaults to the real three-tier result cache). */
  cacheGet?: (key: string, modelId: string) => Promise<CachedQueryResult | null>;
  /** Cache write (defaults to the real three-tier result cache). */
  cacheSet?: (key: string, modelId: string, value: CachedQueryResult, opts: { backend: string }) => Promise<void>;
  now?: () => number;
}

export interface ColumnarQueryResult {
  ok: true;
  /** `columnar-cache` (import-like cache hit) or `serverless-direct` (live Delta read). */
  servingFrom: 'columnar-cache' | 'serverless-direct';
  /** True when served from cache without touching Serverless. */
  cached: boolean;
  /** The Delta frame the answer was pinned to (version + how it was resolved). */
  frame: DeltaFrame;
  /** Wall-clock ms of THIS call (a cache hit is sub-millisecond → import-like). */
  executionMs: number;
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number;
  sql?: string;
}

/**
 * Answer a semantic query at import-like latency with no manual refresh.
 *
 *   1. Frame the source (pin the current Delta version — metadata only).
 *   2. Build a cache key from the SQL + params + frame token + storage mode.
 *   3. On a fresh cache hit → return immediately (`columnar-cache`, sub-ms).
 *   4. On a miss (or after the frame advanced) → run the real Serverless
 *      DirectQuery ONCE, cache it under the current frame, return (`serverless-direct`).
 *
 * The frame token in the key means a Delta version bump transparently invalidates
 * the frame: stale keys are stranded and the next query re-reads live — Direct
 * Lake "framing" without a full reload.
 */
export async function columnarCacheQuery(
  q: ColumnarQuery,
  deps: ColumnarQueryDeps,
): Promise<ColumnarQueryResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const cacheGet = deps.cacheGet ?? getCachedResult;
  const cacheSet =
    deps.cacheSet ??
    ((key: string, modelId: string, value: CachedQueryResult, opts: { backend: string }) =>
      setCachedResult(key, modelId, value, opts));

  const frame = await deps.resolveFrame(q.source);
  const key = buildQueryCacheKey({
    modelId: q.modelId,
    sql: q.sql,
    parameters: q.parameters,
    storageMode: COLUMNAR_STORAGE_MODE,
    freshness: frame.token,
    backend: COLUMNAR_BACKEND,
  });

  if (queryCacheEnabled()) {
    const hit = await cacheGet(key, q.modelId);
    if (hit) {
      return {
        ok: true,
        servingFrom: 'columnar-cache',
        cached: true,
        frame,
        executionMs: now() - started,
        columns: hit.columns,
        rows: hit.rows,
        rowCount: hit.rowCount ?? hit.rows?.length,
        sql: hit.sql ?? q.sql,
      };
    }
  }

  const result = await deps.runQuery();
  const value: CachedQueryResult = {
    rows: result.rows,
    columns: result.columns,
    sql: result.sql ?? q.sql,
    rowCount: result.rowCount ?? result.rows?.length,
    producedBy: 'serverless',
  };
  if (queryCacheEnabled()) {
    // Best-effort — a cache write failure must never fail the query.
    try {
      await cacheSet(key, q.modelId, value, { backend: COLUMNAR_BACKEND });
    } catch {
      /* degrade silently — the caller already has the rows */
    }
  }

  return {
    ok: true,
    servingFrom: 'serverless-direct',
    cached: false,
    frame,
    executionMs: now() - started,
    columns: value.columns,
    rows: value.rows,
    rowCount: value.rowCount,
    sql: value.sql,
  };
}
