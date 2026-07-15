/**
 * PERF-4.2 / 4.4 — Cosmos persistence for the performance tunables + the
 * usage-learning histograms + the auto-tune audit trail.
 *
 * Container: `perf-learning` (PK /scopeKey, TTL-enabled), created lazily by
 * cosmos-client.ts `ensure()`. Docs:
 *   • id 'tunables', scopeKey '#config'          — the PerfTunables doc
 *   • id 'hist:<scope>:<poolKeyHash>', scopeKey '<scope>'
 *        — one EWMA hour-of-week histogram per (workspace|'global', pool group)
 *   • id 'audit:<ts>-<rnd>', scopeKey '#audit'   — auto-apply audit rows (ttl 30d)
 *
 * Every call is best-effort + guarded: a Cosmos failure degrades to in-process
 * defaults / a dropped telemetry write — the perf system never becomes a hard
 * dependency of a notebook run (no-vaporware.md honest-degradation posture).
 *
 * Usage events are BUFFERED in-process (a per-(scope,pool,hour) counter map)
 * and flushed at most once per minute — one cheap read-modify-write per touched
 * histogram doc — so the hot acquire path never pays a Cosmos round-trip.
 */

import {
  addCounts,
  decayHistogram,
  emptyHistogram,
  hourOfWeek,
  totalWeight,
  HOURS_PER_WEEK,
} from '@/lib/perf/usage-learning';
import { defaultTunables, sanitizeTunables, type PerfTunables } from '@/lib/perf/perf-tunables';

const TUNABLES_ID = 'tunables';
const CONFIG_SCOPE = '#config';
const AUDIT_SCOPE = '#audit';
const AUDIT_TTL_SECS = 30 * 24 * 3600; // 30 days
const FLUSH_INTERVAL_MS = 60_000;
const TUNABLES_CACHE_MS = 30_000;
export const GLOBAL_SCOPE = 'global';

// ── Container (lazy; unconfigured Cosmos → every op is a guarded no-op) ──────

async function container() {
  const { perfLearningContainer } = await import('@/lib/azure/cosmos-client');
  return perfLearningContainer();
}

function cosmosOn(): boolean {
  const v = process.env.LOOM_COSMOS_ENDPOINT;
  return typeof v === 'string' && v.trim().length > 0;
}

// ── Tunables doc + in-process cache ──────────────────────────────────────────

interface TunablesDoc extends PerfTunables {
  id: string;
  scopeKey: string;
}

interface TunablesCacheState {
  value: PerfTunables;
  loadedAt: number;
  loading: boolean;
}

// globalThis singleton so Next dev hot-reload keeps one cache per process.
const g = globalThis as unknown as {
  __loomPerfTunables?: TunablesCacheState;
  __loomUsageBuffer?: Map<string, number>;
  __loomUsageFlushedAt?: number;
};
const cache: TunablesCacheState =
  g.__loomPerfTunables ?? (g.__loomPerfTunables = { value: defaultTunables(), loadedAt: 0, loading: false });

/** Read the tunables (Cosmos, 30s in-process cache). Falls back to defaults. */
export async function getTunables(): Promise<PerfTunables> {
  if (Date.now() - cache.loadedAt < TUNABLES_CACHE_MS) return cache.value;
  if (!cosmosOn()) {
    cache.loadedAt = Date.now();
    return cache.value;
  }
  try {
    const c = await container();
    const { resource } = await c.item(TUNABLES_ID, CONFIG_SCOPE).read<TunablesDoc>();
    if (resource) cache.value = sanitizeTunables(resource);
    cache.loadedAt = Date.now();
  } catch {
    cache.loadedAt = Date.now(); // don't hammer a failing store
  }
  return cache.value;
}

/**
 * SYNC last-known tunables for hot paths (query-result-cache getters, the pool
 * sweep). Returns the cached value immediately and kicks a background refresh
 * when stale — the standard "converge within a tick" pattern.
 */
export function getTunablesCached(): PerfTunables {
  if (Date.now() - cache.loadedAt >= TUNABLES_CACHE_MS && !cache.loading) {
    cache.loading = true;
    void getTunables()
      .catch(() => {})
      .finally(() => {
        cache.loading = false;
      });
  }
  return cache.value;
}

/** Persist a sanitized tunables doc + update the local cache immediately. */
export async function writeTunables(next: PerfTunables, updatedBy?: string): Promise<PerfTunables> {
  const clean = sanitizeTunables({ ...next, updatedAt: Date.now(), updatedBy });
  cache.value = clean;
  cache.loadedAt = Date.now();
  if (!cosmosOn()) return clean;
  try {
    const c = await container();
    const body: TunablesDoc = { ...clean, id: TUNABLES_ID, scopeKey: CONFIG_SCOPE };
    await c.items.upsert(body);
  } catch {
    /* best-effort — this replica applies it locally; others converge on next read */
  }
  return clean;
}

// ── Usage-event recording (buffered) ─────────────────────────────────────────

export interface UsageHistogramDoc {
  id: string;
  /** PK — workspaceId or 'global'. */
  scopeKey: string;
  /** The pool group key this histogram tracks (spark-session-pool groupKey). */
  poolKey: string;
  /** EWMA hour-of-week weights (168). */
  weights: number[];
  /** Total raw events ever folded in (diagnostics). */
  events: number;
  updatedAt: number;
}

function histId(scope: string, poolKey: string): string {
  // Pool keys contain '|' and arbitrary sizing hashes — base64url them for a
  // stable, Cosmos-safe id.
  const enc = Buffer.from(poolKey).toString('base64url');
  return `hist:${scope}:${enc}`;
}

const buffer: Map<string, number> = g.__loomUsageBuffer ?? (g.__loomUsageBuffer = new Map());

/**
 * Record one session-demand event (a warm-pool acquire attempt — hit OR miss;
 * both are real demand). CHEAP: increments an in-process counter keyed by
 * (scope, poolKey, hourOfWeek); `flushUsageEvents` folds the counters into the
 * Cosmos histograms at most once a minute (called from the pool sweep).
 */
export function recordUsageEvent(poolKey: string, workspaceId?: string, atMs: number = Date.now()): void {
  const how = hourOfWeek(atMs);
  const scopes = workspaceId ? [GLOBAL_SCOPE, workspaceId] : [GLOBAL_SCOPE];
  for (const scope of scopes) {
    const k = `${scope}\u001f${poolKey}\u001f${how}`;
    buffer.set(k, (buffer.get(k) ?? 0) + 1);
  }
}

/**
 * Flush buffered usage counters into the Cosmos histogram docs (EWMA decay
 * applied lazily by elapsed weeks since each doc's last update). Best-effort;
 * throttled to once per FLUSH_INTERVAL_MS unless `force`.
 */
export async function flushUsageEvents(force = false): Promise<number> {
  const last = g.__loomUsageFlushedAt ?? 0;
  if (!force && Date.now() - last < FLUSH_INTERVAL_MS) return 0;
  g.__loomUsageFlushedAt = Date.now();
  if (buffer.size === 0 || !cosmosOn()) return 0;

  // Drain the buffer into per-(scope,pool) count maps.
  const perDoc = new Map<string, { scope: string; poolKey: string; counts: Record<number, number>; n: number }>();
  for (const [k, v] of buffer.entries()) {
    const [scope, poolKey, howStr] = k.split('\u001f');
    const how = Number(howStr);
    const dk = `${scope}\u001f${poolKey}`;
    const e = perDoc.get(dk) ?? { scope, poolKey, counts: {}, n: 0 };
    e.counts[how] = (e.counts[how] ?? 0) + v;
    e.n += v;
    perDoc.set(dk, e);
  }
  buffer.clear();

  let flushed = 0;
  const halfLife = (await getTunables()).learning.halfLifeWeeks;
  try {
    const c = await container();
    for (const { scope, poolKey, counts, n } of perDoc.values()) {
      try {
        const id = histId(scope, poolKey);
        let doc: UsageHistogramDoc | undefined;
        try {
          const { resource } = await c.item(id, scope).read<UsageHistogramDoc>();
          doc = resource || undefined;
        } catch {
          doc = undefined;
        }
        const prevW = doc?.weights?.length === HOURS_PER_WEEK ? doc.weights : emptyHistogram();
        const elapsedWeeks = doc ? (Date.now() - doc.updatedAt) / (7 * 24 * 3600 * 1000) : 0;
        const decayed = decayHistogram(prevW, elapsedWeeks, halfLife);
        const weights = addCounts(decayed, counts);
        const body: UsageHistogramDoc = {
          id,
          scopeKey: scope,
          poolKey,
          weights,
          events: (doc?.events ?? 0) + n,
          updatedAt: Date.now(),
        };
        await c.items.upsert(body);
        flushed++;
      } catch {
        /* best-effort per doc */
      }
    }
  } catch {
    /* container unavailable — counters were drained; next window re-accumulates */
  }
  return flushed;
}

/** List every histogram doc (admin heatmap + the learning cache refresh). */
export async function listHistograms(): Promise<UsageHistogramDoc[]> {
  if (!cosmosOn()) return [];
  try {
    const c = await container();
    const { resources } = await c.items
      .query<UsageHistogramDoc>({
        query: 'SELECT * FROM c WHERE STARTSWITH(c.id, @p)',
        parameters: [{ name: '@p', value: 'hist:' }],
      })
      .fetchAll();
    return (resources || []).filter((d) => Array.isArray(d.weights) && d.weights.length === HOURS_PER_WEEK);
  } catch {
    return [];
  }
}

/** Aggregate histograms per poolKey across LEARNING-ENABLED scopes. */
export function aggregateByPool(
  docs: UsageHistogramDoc[],
  workspaceEnabled: Record<string, boolean>,
): Map<string, { weights: number[]; total: number }> {
  const out = new Map<string, { weights: number[]; total: number }>();
  for (const d of docs) {
    // The 'global' doc already includes every event (workspace docs are the
    // per-scope breakdown), so the aggregate uses ONLY per-workspace docs when
    // any workspace doc exists for the pool; otherwise it falls back to global.
    if (d.scopeKey !== GLOBAL_SCOPE && workspaceEnabled[d.scopeKey] === false) continue;
    const bucket = d.scopeKey === GLOBAL_SCOPE ? `#global\u001f${d.poolKey}` : d.poolKey;
    const e = out.get(bucket) ?? { weights: emptyHistogram(), total: 0 };
    for (let i = 0; i < HOURS_PER_WEEK; i++) e.weights[i] += d.weights[i];
    e.total += totalWeight(d.weights);
    out.set(bucket, e);
  }
  // Fold: prefer the per-workspace sum; use the global doc only when no
  // workspace-scoped data exists for that pool.
  const final = new Map<string, { weights: number[]; total: number }>();
  for (const [k, v] of out.entries()) {
    if (!k.startsWith('#global\u001f')) final.set(k, v);
  }
  for (const [k, v] of out.entries()) {
    if (k.startsWith('#global\u001f')) {
      const poolKey = k.slice('#global\u001f'.length);
      if (!final.has(poolKey)) final.set(poolKey, v);
    }
  }
  return final;
}

// ── Auto-tune audit trail ────────────────────────────────────────────────────

export interface AutoTuneAuditDoc {
  id: string;
  scopeKey: string;
  ttl: number;
  at: number;
  /** 'auto' or the admin UPN for a manual Apply. */
  actor: string;
  recommendationId: string;
  cls: string;
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

/** Append an applied-change audit row (30-day TTL). Best-effort. */
export async function appendAudit(entry: Omit<AutoTuneAuditDoc, 'id' | 'scopeKey' | 'ttl'>): Promise<void> {
  if (!cosmosOn()) return;
  try {
    const c = await container();
    const body: AutoTuneAuditDoc = {
      ...entry,
      id: `audit:${entry.at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      scopeKey: AUDIT_SCOPE,
      ttl: AUDIT_TTL_SECS,
    };
    await c.items.upsert(body);
  } catch {
    /* best-effort */
  }
}

/** Recent applied-change audit rows (newest first). */
export async function listRecentAudit(limit = 20): Promise<AutoTuneAuditDoc[]> {
  if (!cosmosOn()) return [];
  try {
    const c = await container();
    const { resources } = await c.items
      .query<AutoTuneAuditDoc>(
        {
          query: 'SELECT * FROM c WHERE c.scopeKey = @s ORDER BY c.at DESC OFFSET 0 LIMIT @n',
          parameters: [
            { name: '@s', value: AUDIT_SCOPE },
            { name: '@n', value: Math.min(100, Math.max(1, limit)) },
          ],
        },
        { partitionKey: AUDIT_SCOPE },
      )
      .fetchAll();
    return resources || [];
  } catch {
    return [];
  }
}

/** TEST HOOK — reset the in-process cache + buffer. */
export function _resetUsageStore(): void {
  cache.value = defaultTunables();
  cache.loadedAt = 0;
  cache.loading = false;
  buffer.clear();
  g.__loomUsageFlushedAt = 0;
}
