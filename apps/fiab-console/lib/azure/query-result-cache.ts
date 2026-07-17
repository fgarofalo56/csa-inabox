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
 *   • Shared Redis (OPTIONAL, PSR-5): the hband-shared Azure Cache for Redis,
 *     enabled ONLY when `LOOM_RESULT_CACHE_REDIS` is set. Preferred distributed
 *     tier — a visual cached by one replica is a Redis read on another. ANY
 *     failure degrades silently to the lower tiers.
 *   • Distributed Cosmos (OPTIONAL): a Cosmos container, enabled ONLY when
 *     `LOOM_QUERY_CACHE_COSMOS_CONTAINER` is set (uses the same
 *     `LOOM_COSMOS_ENDPOINT` + Console UAMI the rest of the console uses, with a
 *     native container TTL). Shares hits across replicas. ANY Cosmos error
 *     degrades silently to the in-process tier — never a request failure
 *     (honest fallback to a direct query is always available upstream).
 *
 * ── Per-backend TTL ──────────────────────────────────────────────────────────
 * A key optionally carries the answering `backend` (serverless / dedicated /
 * accel / adx / tabular). TTL resolves per backend via
 * `LOOM_QUERY_CACHE_TTL_MS_<BACKEND>` (e.g. a warm dedicated pool tolerates a
 * longer TTL than a serverless on-demand endpoint), falling back to
 * `LOOM_QUERY_CACHE_TTL_MS` and then the 60s default. The backend is folded into
 * the cache key so two tiers never collide.
 *
 * NO Fabric / Power BI / OneLake dependency (no-fabric-dependency.md); the cache
 * stores only rows the Azure-native backends already produced (no-vaporware.md).
 */

import { createHash } from 'crypto';
import { loomServerCredential } from '@/lib/azure/aca-managed-identity';
import { redisCacheConfigured, redisGet, redisSet } from '@/lib/azure/redis-cache-client';
import { recordCacheHit, recordCacheMiss, type CacheCounterBackend } from '@/lib/perf/cache-counters';
import { getTunablesCached } from '@/lib/perf/usage-store';

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
  /**
   * Answering backend label for per-backend TTL + key isolation
   * (`serverless` | `dedicated` | `accel` | `adx` | `tabular`). Folded into the
   * key so a warm-pool result never serves a serverless-cache read.
   */
  backend?: string;
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
  // `unknown` so the same tiers back both the rows-typed API
  // (`getCachedResult`/`setCachedResult`) and the generic get-or-compute path
  // ({@link getOrComputeCached}) used by the observability routes. The typed
  // getters cast on the way out; nothing else stores here.
  value: unknown;
  cachedAt: number;
  expiresAt: number;
}

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * PERF-4.1/4.2 — the ADMIN RUNTIME OVERRIDE (perf-tunables Cosmos doc, cached
 * in-process by usage-store). Lets the Performance page's cache recommendations
 * REALLY apply (enable / TTL / max entries) without an env roll. Precedence:
 * per-backend env var > runtime override > generic env var > default.
 * Best-effort: an import/store failure degrades to env-only behaviour.
 */
function runtimeCacheOverride(): { enabled?: boolean; ttlMs?: number; maxEntries?: number } {
  try {
    return getTunablesCached().cacheOverride ?? {};
  } catch {
    return {};
  }
}

/** Result TTL (ms). Short by default so a missed invalidation self-heals fast. */
function ttlMs(): number {
  const o = runtimeCacheOverride();
  if (typeof o.ttlMs === 'number' && o.ttlMs > 0) return o.ttlMs;
  const n = Number(process.env.LOOM_QUERY_CACHE_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/** A backend label reduced to an env-var-safe uppercase token (A-Z0-9_). */
export function backendEnvToken(backend: string | undefined): string {
  return (backend ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Per-backend result TTL (ms): `LOOM_QUERY_CACHE_TTL_MS_<BACKEND>` overrides the
 * generic `LOOM_QUERY_CACHE_TTL_MS`, which overrides the 60s default. Lets a
 * warm dedicated pool cache longer than a serverless on-demand endpoint.
 */
export function ttlMsForBackend(backend?: string): number {
  const token = backendEnvToken(backend);
  if (token) {
    const n = Number(process.env[`LOOM_QUERY_CACHE_TTL_MS_${token}`]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return ttlMs();
}

/**
 * Per-backend TTL (ms) with a CALLER-SUPPLIED default: `LOOM_QUERY_CACHE_TTL_MS_<BACKEND>`
 * overrides `defaultMs`. Unlike {@link ttlMsForBackend} (which falls back to the
 * generic 60s knob), this keeps a route's own sensible default when no env
 * override is set — e.g. Cost Management tolerates a 20-min TTL by default while
 * still honouring `LOOM_QUERY_CACHE_TTL_MS_COSTMGMT` when an operator sets it.
 */
export function resolveBackendTtl(backend: string, defaultMs: number): number {
  const token = backendEnvToken(backend);
  if (token) {
    const n = Number(process.env[`LOOM_QUERY_CACHE_TTL_MS_${token}`]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return defaultMs;
}

/** Max in-process entries before insertion-order eviction. */
function maxEntries(): number {
  const o = runtimeCacheOverride();
  if (typeof o.maxEntries === 'number' && o.maxEntries > 0) return Math.floor(o.maxEntries);
  const n = Number(process.env.LOOM_QUERY_CACHE_MAX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
}

/**
 * Master off-switch (the cache is on by default — it needs no infra). The admin
 * runtime override (Performance page) wins over the env kill switch so the
 * "Enable cache" recommendation's Apply really applies.
 */
export function queryCacheEnabled(): boolean {
  const o = runtimeCacheOverride();
  if (typeof o.enabled === 'boolean') return o.enabled;
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
    b: parts.backend ?? '',
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
  return env.value as CachedQueryResult;
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

// ── Optional shared Redis tier (PSR-5) ───────────────────────────────────────
//
// Enabled only when `LOOM_RESULT_CACHE_REDIS` is set. Preferred over Cosmos for
// cross-replica coherence (a Map read on any replica). Values are the JSON
// envelope; the native Redis TTL (EX) mirrors the per-backend TTL, so a missed
// invalidation self-heals exactly like the in-process tier. Any failure inside
// the client degrades to null/no-op (never a request failure).

/** Namespaced Redis key: `loom:qc:<modelId>:<hash>` (readable per-model prefix). */
function redisKeyFor(key: string, modelId: string): string {
  return `loom:qc:${modelId}:${key}`;
}

async function redisTierGet(key: string, modelId: string): Promise<CachedQueryResult | null> {
  if (!redisCacheConfigured()) return null;
  const raw = await redisGet(redisKeyFor(key, modelId));
  if (!raw) return null;
  try {
    const env = JSON.parse(raw) as CacheEnvelope;
    if (typeof env.expiresAt === 'number' && env.expiresAt <= Date.now()) return null;
    return (env.value as CachedQueryResult) ?? null;
  } catch {
    return null;
  }
}

async function redisTierSet(env: CacheEnvelope): Promise<void> {
  if (!redisCacheConfigured()) return;
  const seconds = Math.ceil((env.expiresAt - Date.now()) / 1000) || 1;
  await redisSet(redisKeyFor(env.key, env.modelId), JSON.stringify(env), seconds);
}

/**
 * Expiry-AGNOSTIC Redis read — returns the full envelope (including cachedAt /
 * expiresAt) even when past its TTL, so the SWR path can serve a stale value
 * while it refreshes. Redis' own EX would normally evict the key at expiry, but
 * we keep the envelope's own expiresAt as the source of truth. Any failure → null.
 */
async function redisPeek(key: string, modelId: string): Promise<CacheEnvelope | null> {
  if (!redisCacheConfigured()) return null;
  const raw = await redisGet(redisKeyFor(key, modelId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CacheEnvelope;
  } catch {
    return null;
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

/** Canonical Cosmos container id for the distributed result-cache tier. */
export const DEFAULT_QUERY_CACHE_COSMOS_CONTAINER = 'query-result-cache';

/**
 * The Cosmos container id backing the distributed cache tier, or null when the
 * tier is off. PSR-5 die-hard default-ON: when a Cosmos endpoint is configured
 * (every real deployment), the distributed tier is ON using the canonical
 * container — no extra env needed. It's created lazily via createIfNotExists,
 * so no ARM step is required. An operator opts OUT with
 * `LOOM_QUERY_CACHE_COSMOS_DISABLED=1`, or overrides the container name with
 * `LOOM_QUERY_CACHE_COSMOS_CONTAINER`. Off entirely with no Cosmos endpoint
 * (local dev) so tests + the in-process tier still work with zero infra.
 */
export function distributedContainerId(): string | null {
  if (process.env.LOOM_QUERY_CACHE_COSMOS_DISABLED === '1') return null;
  if (!process.env.LOOM_COSMOS_ENDPOINT) return null;
  const explicit = process.env.LOOM_QUERY_CACHE_COSMOS_CONTAINER?.trim();
  return explicit || DEFAULT_QUERY_CACHE_COSMOS_CONTAINER;
}

function distributedEnabled(): boolean {
  return distributedContainerId() !== null;
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
      id: distributedContainerId()!,
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

/** Expiry-agnostic Cosmos read (returns the envelope even if past TTL). */
async function distPeek(key: string, modelId: string): Promise<CacheEnvelope | null> {
  const container = await getCosmosContainer();
  if (!container) return null;
  try {
    const { resource } = await container.item(key, modelId).read();
    if (!resource) return null;
    return {
      key,
      modelId,
      value: resource.value,
      cachedAt: resource.cachedAt,
      expiresAt: resource.expiresAt,
    };
  } catch {
    return null;
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
    recordCacheHit('result-cache');
    return local;
  }
  // Shared Redis tier (preferred), then Cosmos.
  const shared = (await redisTierGet(key, modelId)) ?? (await distGet(key, modelId));
  if (shared) {
    hits++;
    recordCacheHit('result-cache');
    // Promote into the in-process tier for the next hit on this replica.
    ipSet({ key, modelId, value: shared, cachedAt: Date.now(), expiresAt: Date.now() + ttlMs() });
    return shared;
  }
  misses++;
  recordCacheMiss('result-cache');
  return null;
}

/**
 * Store a result in every configured tier. No-op when caching is disabled.
 * `opts.ttlMs` (or the key's `backend`, resolved via {@link ttlMsForBackend})
 * sets a per-backend TTL; otherwise the generic default applies.
 */
export async function setCachedResult(
  key: string,
  modelId: string,
  value: CachedQueryResult,
  opts?: { ttlMs?: number; backend?: string },
): Promise<void> {
  if (!queryCacheEnabled()) return;
  const effectiveTtl =
    opts?.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : ttlMsForBackend(opts?.backend ?? value.producedBy);
  await writeAllTiers(key, modelId, value, effectiveTtl);
}

/** Build an envelope and fan it out to every configured tier (in-process → Redis → Cosmos). */
async function writeAllTiers(key: string, modelId: string, value: unknown, ttl: number): Promise<void> {
  const now = Date.now();
  const env: CacheEnvelope = { key, modelId, value, cachedAt: now, expiresAt: now + ttl };
  ipSet(env);
  await redisTierSet(env);
  await distSet(env);
}

// ── Generic get-or-compute with optional stale-while-revalidate ──────────────
//
// Used by the observability routes (chargeback / usage / audit / copilot-usage /
// monitor) whose backends are slow, rate-limited, and re-queried constantly. It
// wraps ANY async compute (not just row results) in the same three tiers, and —
// with `staleWhileRevalidate` — serves a stale value the instant TTL lapses while
// a single background recompute repopulates the cache, so a page never blocks on
// a cold Cost Management / Log Analytics / ARM round-trip.

/** Freshness metadata a route echoes to the client as `meta`. */
export interface CacheMeta {
  /** Epoch ms the served value was computed. */
  cachedAt: number;
  /** True when a stale value was served and a background refresh was kicked. */
  stale: boolean;
  /** True when the value was served from a cache tier (fresh OR stale) — not computed inline. */
  hit: boolean;
}

/** In-flight background refreshes, keyed by cache key — the SWR stampede guard. */
const inFlightRefresh = new Map<string, Promise<unknown>>();

/**
 * Cross-tier peek that returns the freshest available envelope REGARDLESS of
 * expiry (so SWR can serve stale). Prefers any non-expired entry; otherwise the
 * newest stale one. In-process fresh is the hot path and skips the shared tiers.
 */
async function peekAnyTier(key: string, modelId: string): Promise<CacheEnvelope | null> {
  const now = Date.now();
  const ip = store.get(key) ?? null;
  if (ip && ip.expiresAt > now) return ip; // hot path — in-process still fresh

  const candidates: CacheEnvelope[] = [];
  if (ip) candidates.push(ip);
  const rd = await redisPeek(key, modelId);
  if (rd) candidates.push(rd);
  const cx = await distPeek(key, modelId);
  if (cx) candidates.push(cx);
  if (candidates.length === 0) return null;

  const fresh = candidates
    .filter((c) => c.expiresAt > now)
    .sort((a, b) => b.cachedAt - a.cachedAt)[0];
  if (fresh) return fresh;
  return candidates.sort((a, b) => b.cachedAt - a.cachedAt)[0]; // newest stale
}

/** Kick a single de-duped background recompute; swallow errors (stale already served). */
function kickBackgroundRefresh<T>(
  key: string,
  modelId: string,
  compute: () => Promise<T>,
  ttl: number,
): void {
  if (inFlightRefresh.has(key)) return; // a refresh for this key is already running
  const p = (async () => {
    const value = await compute();
    await writeAllTiers(key, modelId, value, ttl);
  })()
    .catch(() => {
      /* best-effort — the stale value was already served; next request retries */
    })
    .finally(() => {
      inFlightRefresh.delete(key);
    });
  inFlightRefresh.set(key, p);
}

/**
 * Get-or-compute across all cache tiers, with an opt-in stale-while-revalidate mode.
 *
 *   • Fresh hit  → returns the cached value with `{ stale: false, cachedAt }`.
 *   • Stale hit + `staleWhileRevalidate` → returns the stale value immediately with
 *     `{ stale: true, cachedAt }` and kicks ONE background recompute (de-duped, so
 *     a burst of concurrent requests never stampedes the backend).
 *   • Miss (or stale without SWR) → computes inline and stores, `{ stale: false }`.
 *
 * `bypass: true` (wire to `?refresh=1`) skips the read but still writes the fresh
 * result. Never caches a thrown error — an inline compute that throws propagates.
 *
 * @param key      stable cache key (see {@link buildScopedCacheKey})
 * @param modelId  namespace / partition (Redis prefix + Cosmos partition key)
 * @param compute  the real (slow) backend call
 */
export async function getOrComputeCached<T>(
  key: string,
  modelId: string,
  compute: () => Promise<T>,
  opts?: {
    ttlMs?: number;
    backend?: string;
    staleWhileRevalidate?: boolean;
    bypass?: boolean;
    /**
     * Which cache-counter backend hits/misses are attributed to (perf surface
     * hit-rate). Defaults to `result-cache`; the ADX query path passes `adx` so
     * its Loom-tier hits land on the ADX hit-rate.
     */
    counterBackend?: CacheCounterBackend;
    /**
     * Hard wall-clock budget for the INLINE compute on a miss. A cold read
     * that fans out across ARM / Cost Management / Log Analytics can outlive
     * Front Door's ~60s edge budget — with a budget set the route fails FAST
     * (or serves stale via `serveStaleOnError`) instead of 504ing at the edge.
     */
    budgetMs?: number;
    /**
     * When the inline compute throws (including a blown budget), serve the
     * most recent EXPIRED copy from any tier — flagged `stale: true` — and
     * kick one background recompute. A dashboard that shows slightly-old
     * numbers beats one that 504s (operator directive 2026-07-15).
     */
    serveStaleOnError?: boolean;
  },
): Promise<{ value: T; meta: CacheMeta }> {
  const ttl = opts?.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : ttlMsForBackend(opts?.backend);
  const counter: CacheCounterBackend = opts?.counterBackend ?? 'result-cache';

  // Disabled or explicit bypass → compute inline; still populate the cache when enabled.
  if (!queryCacheEnabled() || opts?.bypass) {
    const value = await compute();
    if (queryCacheEnabled()) await writeAllTiers(key, modelId, value, ttl);
    return { value, meta: { cachedAt: Date.now(), stale: false, hit: false } };
  }

  const env = await peekAnyTier(key, modelId);
  const now = Date.now();

  if (env && env.expiresAt > now) {
    recordCacheHit(counter);
    ipSet(env); // promote a shared-tier hit into the in-process tier
    return { value: env.value as T, meta: { cachedAt: env.cachedAt, stale: false, hit: true } };
  }

  if (env && opts?.staleWhileRevalidate) {
    recordCacheHit(counter);
    kickBackgroundRefresh(key, modelId, compute, ttl);
    return { value: env.value as T, meta: { cachedAt: env.cachedAt, stale: true, hit: true } };
  }

  // Miss, or expired without SWR → compute inline and store.
  recordCacheMiss(counter);
  try {
    let value: T;
    if (opts?.budgetMs) {
      // COLD-MISS BUDGET FIX (2026-07-17): the compute must WRITE THROUGH to the
      // cache even when the budget wins the race, otherwise a genuinely-slow
      // backend (e.g. cross-subscription Cost Management > 25s under QPU
      // throttling) never populates on a cold miss — computeWithBudget would
      // orphan and DISCARD the in-flight result, so every request restarted a
      // doomed budgeted compute and the dashboard was stuck "warming" forever.
      // Share ONE write-through compute per key (stampede guard, reusing the SWR
      // in-flight map) so concurrent budgeted callers don't each hammer the
      // backend; the shared promise keeps running past the budget and populates
      // the cache, so the NEXT request is a fresh hit.
      let shared = inFlightRefresh.get(key) as Promise<T> | undefined;
      if (!shared) {
        shared = (async () => {
          const v = await compute();
          await writeAllTiers(key, modelId, v, ttl);
          return v;
        })();
        inFlightRefresh.set(key, shared);
        void shared.catch(() => { /* next request retries */ }).finally(() => inFlightRefresh.delete(key));
      }
      value = await computeWithBudget(shared, opts.budgetMs, key);
      return { value, meta: { cachedAt: now, stale: false, hit: false } };
    }
    value = await compute();
    await writeAllTiers(key, modelId, value, ttl);
    return { value, meta: { cachedAt: now, stale: false, hit: false } };
  } catch (e) {
    if (opts?.serveStaleOnError && env) {
      // Serve the expired copy rather than failing; one background recompute
      // repairs the cache for the next request.
      kickBackgroundRefresh(key, modelId, compute, ttl);
      return { value: env.value as T, meta: { cachedAt: env.cachedAt, stale: true, hit: true } };
    }
    throw e;
  }
}

/** Race a compute against a hard wall-clock budget (see `budgetMs`). */
export class ComputeBudgetExceededError extends Error {
  constructor(key: string, budgetMs: number) {
    super(`read '${key.slice(0, 24)}…' exceeded its ${Math.round(budgetMs / 1000)}s budget — the backend is slow or throttled; a cached copy will serve once one exists`);
    this.name = 'ComputeBudgetExceededError';
  }
}

function computeWithBudget<T>(p: Promise<T>, budgetMs: number, key: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ComputeBudgetExceededError(key, budgetMs)), budgetMs);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Stable cache key for a get-or-compute scope: SHA-256 over the scope label +
 * normalized params. Distinct from {@link buildQueryCacheKey} (rows identity);
 * this is for arbitrary route aggregates (usage rollups, cost reports, etc.).
 */
export function buildScopedCacheKey(scope: string, params: Record<string, unknown> = {}): string {
  return createHash('sha256').update(JSON.stringify({ scope, params })).digest('hex');
}

/**
 * TEST HOOK — await all in-flight background refreshes. Not part of the runtime
 * contract; exported so unit tests can deterministically observe SWR recompute.
 */
export async function _awaitBackgroundRefreshes(): Promise<void> {
  await Promise.allSettled([...inFlightRefresh.values()]);
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
  redis: boolean;
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
  ttlMs: number;
  maxEntries: number;
  /** True when the admin runtime override (perf tunables) is shaping config. */
  overrideActive: boolean;
} {
  const total = hits + misses;
  const o = runtimeCacheOverride();
  return {
    enabled: queryCacheEnabled(),
    distributed: distributedEnabled(),
    redis: redisCacheConfigured(),
    size: store.size,
    hits,
    misses,
    hitRate: total > 0 ? hits / total : 0,
    ttlMs: ttlMs(),
    maxEntries: maxEntries(),
    overrideActive: typeof o.enabled === 'boolean' || typeof o.ttlMs === 'number' || typeof o.maxEntries === 'number',
  };
}
