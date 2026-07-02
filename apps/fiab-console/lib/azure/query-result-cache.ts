/**
 * query-result-cache — a keyed, TTL'd cache for report / semantic-layer query
 * results. This is the always-on, no-infra half of the Loom report query
 * ACCELERATION layer (the pragmatic 80% of Fabric "Direct Lake": import-mode
 * speed on Delta without a Fabric capacity). Its sibling is
 * `report-accel-client.ts` (the opt-in Databricks SQL / Photon over-Delta fast path).
 *
 * ── What it buys ───────────────────────────────────────────────────────────
 * Report visuals re-issue the SAME aggregate query constantly — page loads,
 * cross-filter round-trips, slicer changes that don't touch a given visual,
 * multiple users on the same report. Each of those is today a full Synapse
 * Serverless round-trip. Caching the RESULT keyed by the exact logical query +
 * a data-freshness token collapses every repeat to an in-process Map read.
 *
 * ── Cache-key design (the correctness contract) ────────────────────────────
 * A key is the SHA-256 of a canonical tuple so two callers hit the same slot
 * IFF they would get byte-identical rows:
 *
 *   1. `modelId`      — the report / semantic-model identity (report item id).
 *                       Scopes the key so two reports never collide.
 *   2. `queryHash`    — the COMPILED SQL text + bound parameters. The compiled
 *                       SQL deterministically encodes the visual's wells,
 *                       filters, drill/what-if, and the resolved source relation
 *                       — so it is the query's true identity regardless of which
 *                       backend (accel vs Serverless) ultimately answers it.
 *   3. `storageMode`  — the execution surface label (`serverless` / `dedicated`
 *                       / `accel` / a per-table Import|Dual|DirectLake mode).
 *                       Keeps a live DirectQuery result from being served for an
 *                       Import-cache read (different snapshot semantics).
 *   4. `freshness`    — the invalidation token. The LAST DELTA COMMIT VERSION
 *                       when the caller can resolve it (the accel service reports
 *                       `deltaVersion`); otherwise a proxy derived from the item's
 *                       `_ts` + `state.lastRefresh` + `state.dataSource`. Because
 *                       a report /refresh rewrites `lastRefresh`, the freshness
 *                       token ROTATES on refresh — every prior key is stranded and
 *                       ages out by TTL, so a refresh transparently invalidates
 *                       the cache (belt-and-braces: `invalidateModel` drops the
 *                       in-process slots immediately).
 *
 * ── Tiers ──────────────────────────────────────────────────────────────────
 *   • In-process LRU (ALWAYS ON, zero infra): a bounded Map with per-entry
 *     expiry + insertion-order eviction. Per-replica; the freshness token keeps
 *     it correct across replicas even without a shared tier.
 *   • Distributed (OPTIONAL): a Cosmos container, enabled ONLY when
 *     `LOOM_QUERY_CACHE_COSMOS_CONTAINER` is set (uses the same
 *     `LOOM_COSMOS_ENDPOINT` + Console UAMI the rest of the console uses, with a
 *     native container TTL). Shares hits across replicas. ANY Cosmos error
 *     degrades silently to the in-process tier — never a request failure
 *     (honest fallback to a direct query is always available upstream).
 *
 * NO Fabric / Power BI / OneLake dependency (no-fabric-dependency.md); the cache
 * stores only rows the Azure-native backends already produced (no-vaporware.md).
 */

import { createHash } from 'crypto';
import { loomServerCredential } from '@/lib/azure/aca-managed-identity';

// ── Public shapes ──────────────────────────────────────────────────────────

/** The parts that canonically identify a cached query result. */
export interface QueryCacheKeyParts {
  /** Report / semantic-model item id (a Cosmos id or a `loom:` content id). */
  modelId: string;
  /** The compiled SQL text (query identity). */
  sql: string;
  /** Bound parameters, in emit order (folded into the query identity). */
  parameters?: ReadonlyArray<{ name?: string; value?: unknown } | unknown>;
  /** Execution-surface label: `serverless` | `dedicated` | `accel` | storage mode. */
  storageMode: string;
  /**
   * Data-freshness token. The last Delta commit version when resolvable; else a
   * proxy the caller derives from item state (see `deriveFreshnessToken`).
   */
  freshness?: string;
}

/** A cached query result payload (the exact body the route returns downstream). */
export interface CachedQueryResult {
  /** Object rows — identical shape across accel / cache / Serverless backends. */
  rows: Record<string, unknown>[];
  /** Result column order, when known. */
  columns?: string[];
  /** The SQL (Synapse T-SQL or Databricks SQL) that produced the rows — for the SQL pane. */
  sql?: string;
  /** Row count, when the backend reported it. */
  rowCount?: number;
  /** Which backend originally produced these rows (`accel` | `serverless` | `dedicated`). */
  producedBy?: string;
}

interface CacheEnvelope {
  key: string;
  modelId: string;
  value: CachedQueryResult;
  cachedAt: number;
  expiresAt: number;
}

// ── Config ───────────────────────────────────────────────────────────────────

/** Result TTL (ms). Short by default so a missed invalidation self-heals fast. */
function ttlMs(): number {
  const n = Number(process.env.LOOM_QUERY_CACHE_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/** Max in-process entries before insertion-order eviction. */
function maxEntries(): number {
  const n = Number(process.env.LOOM_QUERY_CACHE_MAX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
}

/** Master off-switch (the cache is on by default — it needs no infra). */
export function queryCacheEnabled(): boolean {
  return process.env.LOOM_QUERY_CACHE_DISABLED !== '1';
}

// ── Key builder ────────────────────────────────────────────────────────────

/**
 * Canonical cache key: SHA-256 over the identity tuple. Parameters are reduced
 * to their `{name,value}` (or raw value) so functionally-identical binds hash
 * the same regardless of surrounding object identity.
 */
export function buildQueryCacheKey(parts: QueryCacheKeyParts): string {
  const params = (parts.parameters || []).map((p) => {
    if (p && typeof p === 'object' && ('value' in (p as object) || 'name' in (p as object))) {
      const r = p as { name?: string; value?: unknown };
      return { n: r.name ?? null, v: r.value ?? null };
    }
    return { v: p ?? null };
  });
  const canonical = JSON.stringify({
    m: parts.modelId,
    q: parts.sql,
    p: params,
    s: parts.storageMode,
    f: parts.freshness ?? '',
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Derive a freshness/invalidation token from a report item's state when a true
 * Delta commit version isn't resolvable. Combines the store timestamp, the
 * per-table last-refresh map (rotates on every report /refresh), and the
 * data-source binding (rebinding must bust the cache). Callers that CAN resolve
 * a Delta version (e.g. the accel service response) should prefer that.
 */
export function deriveFreshnessToken(item: {
  _ts?: number;
  state?: unknown;
}): string {
  const state = (item?.state || {}) as Record<string, unknown>;
  return JSON.stringify({
    ts: item?._ts ?? null,
    lr: state.lastRefresh ?? null,
    ds: state.dataSource ?? null,
    tstor: state.tableStorage ?? null,
  });
}

// ── In-process LRU tier ──────────────────────────────────────────────────────

const store = new Map<string, CacheEnvelope>();
let hits = 0;
let misses = 0;

function ipGet(key: string): CachedQueryResult | null {
  const env = store.get(key);
  if (!env) return null;
  if (env.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  // Refresh recency (LRU): re-insert to move to the tail.
  store.delete(key);
  store.set(key, env);
  return env.value;
}

function ipSet(env: CacheEnvelope): void {
  if (store.has(env.key)) store.delete(env.key);
  store.set(env.key, env);
  // Evict oldest entries beyond the cap.
  while (store.size > maxEntries()) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

// ── Optional distributed (Cosmos) tier ──────────────────────────────────────
//
// Lazily initialized ONLY when `LOOM_QUERY_CACHE_COSMOS_CONTAINER` is set. Uses
// the same endpoint + credential the rest of the console uses. Any failure (no
// endpoint, no RBAC, throttling, network) degrades to the in-process tier — the
// cache is a latency optimization, never a correctness or availability
// dependency.

let cosmosContainer: any | null = null;
let cosmosInitTried = false;
let cosmosWarned = false;

function distributedEnabled(): boolean {
  return !!process.env.LOOM_QUERY_CACHE_COSMOS_CONTAINER && !!process.env.LOOM_COSMOS_ENDPOINT;
}

async function getCosmosContainer(): Promise<any | null> {
  if (!distributedEnabled()) return null;
  if (cosmosContainer) return cosmosContainer;
  if (cosmosInitTried) return cosmosContainer; // one-shot init; don't hammer on failure
  cosmosInitTried = true;
  try {
    const { CosmosClient } = await import('@azure/cosmos');
    const client = new CosmosClient({
      endpoint: process.env.LOOM_COSMOS_ENDPOINT!,
      aadCredentials: loomServerCredential as any,
    });
    const dbId = process.env.LOOM_COSMOS_DATABASE || 'loom';
    const { database } = await client.databases.createIfNotExists({ id: dbId });
    const { container } = await database.containers.createIfNotExists({
      id: process.env.LOOM_QUERY_CACHE_COSMOS_CONTAINER!,
      partitionKey: { paths: ['/modelId'] },
      // Native per-item TTL; individual docs also carry `ttl` (seconds).
      defaultTtl: Math.ceil((ttlMs() / 1000) * 4),
    });
    cosmosContainer = container;
    return cosmosContainer;
  } catch (e) {
    if (!cosmosWarned) {
      cosmosWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[query-result-cache] distributed (Cosmos) tier unavailable; using in-process only:',
        (e as Error)?.message || e,
      );
    }
    return null;
  }
}

async function distGet(key: string, modelId: string): Promise<CachedQueryResult | null> {
  const container = await getCosmosContainer();
  if (!container) return null;
  try {
    const { resource } = await container.item(key, modelId).read();
    if (!resource) return null;
    if (typeof resource.expiresAt === 'number' && resource.expiresAt <= Date.now()) return null;
    return (resource.value as CachedQueryResult) ?? null;
  } catch {
    return null;
  }
}

async function distSet(env: CacheEnvelope): Promise<void> {
  const container = await getCosmosContainer();
  if (!container) return;
  try {
    await container.items.upsert({
      id: env.key,
      modelId: env.modelId,
      value: env.value,
      cachedAt: env.cachedAt,
      expiresAt: env.expiresAt,
      ttl: Math.ceil((env.expiresAt - Date.now()) / 1000) || 1,
    });
  } catch {
    /* degrade silently — the in-process tier already holds it */
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Read a cached result (in-process first, then the distributed tier). Returns
 * null on any miss so the caller runs the real query and then `set`s it.
 */
export async function getCachedResult(
  key: string,
  modelId: string,
): Promise<CachedQueryResult | null> {
  if (!queryCacheEnabled()) return null;
  const local = ipGet(key);
  if (local) {
    hits++;
    return local;
  }
  const dist = await distGet(key, modelId);
  if (dist) {
    hits++;
    // Promote into the in-process tier for the next hit on this replica.
    ipSet({ key, modelId, value: dist, cachedAt: Date.now(), expiresAt: Date.now() + ttlMs() });
    return dist;
  }
  misses++;
  return null;
}

/** Store a result in both tiers. No-op when caching is disabled. */
export async function setCachedResult(
  key: string,
  modelId: string,
  value: CachedQueryResult,
): Promise<void> {
  if (!queryCacheEnabled()) return;
  const env: CacheEnvelope = {
    key,
    modelId,
    value,
    cachedAt: Date.now(),
    expiresAt: Date.now() + ttlMs(),
  };
  ipSet(env);
  await distSet(env);
}

/**
 * Drop every in-process slot for a model (belt-and-braces invalidate-on-refresh;
 * the freshness token already strands stale keys). The distributed tier relies
 * on its native TTL + freshness rotation, so this only sweeps the local Map.
 */
export function invalidateModel(modelId: string): void {
  for (const [k, env] of store) {
    if (env.modelId === modelId) store.delete(k);
  }
}

/** Cache counters (for a health/diagnostics badge). */
export function queryCacheStats(): {
  enabled: boolean;
  distributed: boolean;
  size: number;
  hits: number;
  misses: number;
  ttlMs: number;
} {
  return {
    enabled: queryCacheEnabled(),
    distributed: distributedEnabled(),
    size: store.size,
    hits,
    misses,
    ttlMs: ttlMs(),
  };
}
