/**
 * Warm Spark session pool — kills notebook cold starts.
 *
 * A Synapse Spark pool cold-starts in ~2-4 minutes; Fabric's "starter pools"
 * feel instant (<10s) because Microsoft keeps a warm pool of pre-provisioned
 * sessions on standby. This module gives CSA Loom the same behaviour on the
 * Azure-native default backend: it keeps N idle Livy (Synapse) sessions — or a
 * warmed Databricks all-purpose cluster — on standby, and on a notebook run it
 * hands off a warm session instead of paying the cold start. The pool refills
 * itself in the background so the *next* run is warm too.
 *
 * ── Lease / return model (safe hand-off) ──────────────────────────────────
 *   • Every pooled session is a slot with a state:
 *       warming → warm → leased → (returned→warm | dead)
 *   • `acquireWarmSession()` atomically flips exactly ONE `warm` slot to
 *     `leased` and stamps it with the acting user's oid. Because Node runs the
 *     synchronous flip on a single event-loop tick, two concurrent runs can
 *     NEVER receive the same slot — a session is never shared across users
 *     concurrently. The caller "owns" the leased session for the life of the
 *     notebook (it becomes the notebook's reused Livy session, exactly like the
 *     existing per-notebook reuse). A background refill immediately replaces the
 *     drained slot so the pool stays at `min`.
 *   • `releaseSession(leaseId)` returns a still-healthy slot to `warm` (resets
 *     its idle clock via Livy keepalive) or, with `{ dead:true }`, evicts it.
 *   • On a miss (`acquireWarmSession` → null) the caller cold-starts as it does
 *     today — the pool is a pure accelerator, never a hard dependency.
 *
 * ── Config (env + admin override) ────────────────────────────────────────
 *   LOOM_SPARK_POOL_ENABLED   DEFAULT ON (default-ON / opt-out posture). Set to
 *                             "0"/"false" to disable → today's cold-start path.
 *                             Cost is bounded by the idle TTL (warm-above-min
 *                             sessions expire) + the Synapse pool auto-pause.
 *   LOOM_SPARK_POOL_MIN       min warm sessions to keep per pool/kind/sizing
 *                             group (default 1).
 *   LOOM_SPARK_POOL_MAX       max total sessions per group (default 3).
 *   LOOM_SPARK_POOL_IDLE_TTL  seconds a warm-above-min session may sit idle
 *                             before eviction (default 900 = 15 min) — the cost
 *                             bound for the default-ON posture.
 *   LOOM_SPARK_POOL_CONCURRENT  DEFAULT ON. High-concurrency shared-session mode
 *                             (FGC-10): read-only runs share ONE warm session
 *                             (N leases per session). "0" forces exclusive
 *                             one-lease-per-user.
 *   LOOM_SPARK_POOL_SHARED_MAX  max concurrent read-only leases per shared
 *                             session (default 4).
 * Admin can override any of these at runtime via the /api/spark/session-pool
 * POST config action (in-memory, per replica).
 *
 * No mocks: every warm/keepalive/evict call hits the REAL Synapse Livy REST
 * surface (createLivySessionAsync / getLivySession / keepaliveLivySession /
 * killLivySession) or the REAL Databricks clusters API (startCluster/getCluster)
 * per no-vaporware.md + no-fabric-dependency.md (Synapse is the default; the
 * Fabric backend is never on this path).
 *
 * Cross-replica (PSR-3): the warm REGISTRY is lifted into a shared store
 * (`spark-lease-store.ts`) so a session warmed on replica A can be claimed by a
 * request routed to replica B — the Livy session id is global to the Synapse
 * pool, not replica-local. The store is a real Cosmos `spark-warm-leases`
 * container, activated when the shared H-band substrate is signalled by env
 * (LOOM_SPARK_POOL_LEASE_CONTAINER or the shared-Redis markers
 * LOOM_SPARK_POOL_REDIS / LOOM_BROKER_REDIS); otherwise it falls back honestly to
 * the in-process per-replica registry (status `store.mode:'memory'`). Every store
 * call is best-effort — a failure degrades to the local registry / a cold start.
 */

import {
  createLivySessionAsync,
  getLivySession,
  synapseConfigGate,
  type LivySessionSizing,
} from '@/lib/azure/synapse-dev-client';
import {
  keepaliveLivySession,
  killLivySession,
  listLivySessions,
  defaultSparkPool,
  type LivyKind,
} from '@/lib/azure/synapse-livy-client';

/** Summarize a session's Livy errorInfo (detailed=true) — '' when none. */
function livyErrorDetail(sess: { errorInfo?: Array<{ message?: string; errorCode?: string }> | null }): string {
  return (sess.errorInfo || [])
    .map((e) => e?.message || e?.errorCode || '')
    .filter(Boolean)
    .join('; ');
}
import { defaultSynapseSizing as computeDefaultSynapseSizing } from '@/lib/spark/spark-sizing';
import {
  leaseStoreMode,
  leaseStoreStatus,
  publishSlot,
  removeSlot,
  claimSlot,
  releaseInStore,
  listAllDocs,
  mintLeaseId,
  readPoolConfigDoc,
  writePoolConfigDoc,
  replicaId,
  type LeaseRec,
  type LeaseStoreStatus,
  type LeaseStoreMode,
} from '@/lib/azure/spark-lease-store';

export type SparkPoolBackend = 'synapse' | 'databricks';
type SlotState = 'warming' | 'warm' | 'leased' | 'shared' | 'dead';

interface PooledSlot {
  /** Stable id for this slot (also the shared-store doc id). */
  leaseId: string;
  backend: SparkPoolBackend;
  /** Synapse Spark-pool name, or the Databricks clusterId. */
  poolName: string;
  /** Livy session kind (Synapse). For Databricks a fixed 'pyspark' placeholder. */
  kind: LivyKind;
  /** Sizing fingerprint — a warm session only matches a run with the same sizing. */
  sizingKey: string;
  /** Livy session id (Synapse). Undefined for a Databricks cluster-warm slot. */
  sessionId?: number;
  state: SlotState;
  createdAt: number;
  warmedAt?: number;
  lastActivityAt: number;
  /**
   * Active sub-leases against this slot. Exclusive = exactly one (readOnly:false);
   * shared (FGC-10 concurrent mode) = up to `maxLeasesPerSession` read-only leases.
   */
  leases: LeaseRec[];
  /** The group key this slot belongs to (for the shared store PK). */
  groupKey: string;
  /** True when this slot was CLAIMED from the shared store (another replica warmed it). */
  fromStore?: boolean;
  /** Real Livy session-create body (Synapse) — surfaced in the run receipt. */
  request?: Record<string, unknown>;
  error?: string;
}

/** A pool/kind/sizing group the sweeper keeps warm at `min`. */
interface PoolGroup {
  key: string;
  backend: SparkPoolBackend;
  poolName: string;
  kind: LivyKind;
  sizingKey: string;
  /** The exact sizing to warm with (so warm sessions match runs). */
  sizing?: LivySessionSizing;
  /**
   * Warm-failure circuit breaker (2026-07-14 loompool queue-jam incident):
   * consecutive warm failures back the group off exponentially instead of
   * re-warming every 30s sweep tick forever — the old behaviour submitted a new
   * Livy session every tick against a jammed pool, feeding the very queue jam
   * (MAX_QUEUED_JOBS_PER_COMPUTE_EXCEEDED) that made the warms fail.
   */
  consecFails?: number;
  /** Epoch ms until which refill skips this group (0/undefined = not backing off). */
  backoffUntil?: number;
  /** Last warm-failure reason (surfaced in GET /api/spark/session-pool). */
  lastFailure?: string;
}

export interface PoolConfig {
  enabled: boolean;
  min: number;
  max: number;
  idleTtlMs: number;
  /** FGC-10 — high-concurrency shared-session mode (read-only runs share a session). */
  concurrent: boolean;
  /** Max concurrent read-only leases per shared session. */
  maxLeasesPerSession: number;
  /** #1796 — reap leaked/untracked idle Livy sessions on the pool. DEFAULT ON. */
  reapEnabled: boolean;
  /**
   * Grace (ms) a session must sit IDLE + untracked + un-heartbeated before the
   * reaper kills it. Also the window a keepalive heartbeat protects an in-use
   * (cold-started) notebook session. Default = max(idleTtl, 30 min).
   */
  reapGraceMs: number;
}

interface PoolStore {
  slots: PooledSlot[];
  groups: Map<string, PoolGroup>;
  override: Partial<PoolConfig>;
  /** Epoch ms of the last override apply (local or adopted from the shared config doc). */
  overrideUpdatedAt?: number;
  sweeper: ReturnType<typeof setInterval> | null;
  warming: number; // in-flight warm operations (concurrency guard)
  /** True once this replica has run the default-group pre-registration + startup kick. */
  started: boolean;
  /** True once this replica has adopted persisted warm slots from the shared store. */
  adopted: boolean;
  /**
   * #1796 reaper state (per replica):
   *  - inUse: `${pool}#${sessionId}` → last-heartbeat ms (keepalive / active run).
   *    A session heartbeated within reapGraceMs is a live notebook — never reaped.
   *  - firstSeenUntracked: `${pool}#${sessionId}` → ms first seen idle+untracked.
   *    A session is only killed after it has been untracked for a full grace
   *    window, so a just-created session (not yet leased/heartbeated) is spared.
   */
  inUse: Map<string, number>;
  firstSeenUntracked: Map<string, number>;
}

// Singleton on globalThis so Next.js dev hot-reload / route re-eval keeps ONE
// pool per process instead of leaking a fresh pool (and orphaned Livy sessions)
// on every module reload.
const g = globalThis as unknown as { __loomSparkPool?: PoolStore };
const store: PoolStore =
  g.__loomSparkPool ??
  (g.__loomSparkPool = {
    slots: [],
    groups: new Map(),
    override: {},
    sweeper: null,
    warming: 0,
    started: false,
    adopted: false,
    inUse: new Map(),
    firstSeenUntracked: new Map(),
  });

const SWEEP_INTERVAL_MS = 30_000;

// ============================================================
// Config
// ============================================================

function envBool(v: string | undefined): boolean {
  return v === '1' || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
}
/** DEFAULT-ON / opt-out: true unless explicitly "0" / "false" / "off" / "no". */
function envBoolDefaultOn(v: string | undefined): boolean {
  if (typeof v !== 'string') return true;
  const t = v.trim().toLowerCase();
  return !(t === '0' || t === 'false' || t === 'off' || t === 'no');
}
function envInt(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Effective config: env baseline overlaid with the admin runtime override. */
export function sparkPoolConfig(): PoolConfig {
  const base: PoolConfig = {
    // DEFAULT ON (die-hard default-ON / opt-out) — disabled only by an explicit
    // "0"/"false" or the tenant-admin kill switch (setSparkPoolConfig).
    enabled: envBoolDefaultOn(process.env.LOOM_SPARK_POOL_ENABLED),
    min: envInt(process.env.LOOM_SPARK_POOL_MIN, 1),
    max: envInt(process.env.LOOM_SPARK_POOL_MAX, 3),
    idleTtlMs: envInt(process.env.LOOM_SPARK_POOL_IDLE_TTL, 900) * 1000,
    concurrent: envBoolDefaultOn(process.env.LOOM_SPARK_POOL_CONCURRENT),
    maxLeasesPerSession: Math.max(1, envInt(process.env.LOOM_SPARK_POOL_SHARED_MAX, 4)),
    // #1796 — leaked-session reaper. DEFAULT ON; opt out with LOOM_SPARK_POOL_REAP=0.
    reapEnabled: envBoolDefaultOn(process.env.LOOM_SPARK_POOL_REAP),
    // Grace before reaping an untracked idle session (secs). Default = max(idleTtl,
    // 30 min) so a leaked session is cleaned but a live notebook (keepalive every
    // ~4 min) and a just-created session are always safe.
    reapGraceMs: Math.max(
      envInt(process.env.LOOM_SPARK_POOL_IDLE_TTL, 900) * 1000,
      envInt(process.env.LOOM_SPARK_POOL_REAP_GRACE, 1800) * 1000,
    ),
  };
  const o = store.override;
  const cfg: PoolConfig = {
    enabled: o.enabled ?? base.enabled,
    min: o.min ?? base.min,
    max: o.max ?? base.max,
    idleTtlMs: o.idleTtlMs ?? base.idleTtlMs,
    concurrent: o.concurrent ?? base.concurrent,
    maxLeasesPerSession: o.maxLeasesPerSession ?? base.maxLeasesPerSession,
    reapEnabled: o.reapEnabled ?? base.reapEnabled,
    reapGraceMs: o.reapGraceMs ?? base.reapGraceMs,
  };
  // Keep max >= min so a group can always reach its target.
  if (cfg.max < cfg.min) cfg.max = cfg.min;
  if (cfg.maxLeasesPerSession < 1) cfg.maxLeasesPerSession = 1;
  return cfg;
}

export function sparkPoolEnabled(): boolean {
  return sparkPoolConfig().enabled;
}

/**
 * Admin runtime override. Applies to THIS replica immediately and persists to
 * the shared lease store's config doc so every other replica converges on the
 * next sweep tick (~30s) — the old in-memory-only override left the admin kill
 * switch active on a single replica while its siblings kept warming (observed
 * live during the 2026-07-14 loompool queue-jam incident). Returns the new
 * effective config.
 */
export function setSparkPoolConfig(partial: Partial<PoolConfig>): PoolConfig {
  if (typeof partial.enabled === 'boolean') store.override.enabled = partial.enabled;
  if (typeof partial.min === 'number' && partial.min >= 0) store.override.min = Math.floor(partial.min);
  if (typeof partial.max === 'number' && partial.max >= 0) store.override.max = Math.floor(partial.max);
  if (typeof partial.idleTtlMs === 'number' && partial.idleTtlMs >= 0) store.override.idleTtlMs = Math.floor(partial.idleTtlMs);
  if (typeof partial.concurrent === 'boolean') store.override.concurrent = partial.concurrent;
  if (typeof partial.maxLeasesPerSession === 'number' && partial.maxLeasesPerSession >= 1)
    store.override.maxLeasesPerSession = Math.floor(partial.maxLeasesPerSession);
  if (typeof partial.reapEnabled === 'boolean') store.override.reapEnabled = partial.reapEnabled;
  if (typeof partial.reapGraceMs === 'number' && partial.reapGraceMs >= 0)
    store.override.reapGraceMs = Math.floor(partial.reapGraceMs);
  const cfg = sparkPoolConfig();
  // Persist the override cross-replica (best-effort; local apply is already done).
  store.overrideUpdatedAt = Date.now();
  void writePoolConfigDoc({ ...store.override, __updatedAt: store.overrideUpdatedAt }).catch(() => {});
  // Arm the pool: pre-register the default group, adopt store slots, start the
  // sweeper, and kick an immediate refill (not just the next 30s tick).
  if (cfg.enabled) ensureWarmPoolStarted();
  return cfg;
}

/**
 * Merge the shared config doc into this replica's override (newer-wins). Called
 * from sweep() so an admin change lands console-wide within one tick.
 */
async function syncConfigFromStore(): Promise<void> {
  try {
    const doc = await readPoolConfigDoc();
    if (!doc || typeof doc.updatedAt !== 'number') return;
    if (doc.updatedAt <= (store.overrideUpdatedAt ?? 0)) return;
    const { __updatedAt, ...override } = (doc.override ?? {}) as Record<string, unknown>;
    void __updatedAt;
    store.override = override as Partial<PoolConfig>;
    store.overrideUpdatedAt = doc.updatedAt;
  } catch {
    /* best-effort */
  }
}

// ============================================================
// Backend gate (honest — no Spark backend configured)
// ============================================================

export interface SparkBackendStatus {
  backend: SparkPoolBackend;
  configured: boolean;
  /** Env var / gate to satisfy when not configured. */
  missing?: string;
}

/**
 * Resolve the active Spark backend + whether it is actually configured. The
 * pool defaults to Synapse (Azure-native); Databricks is used only when
 * LOOM_NOTEBOOK_BACKEND=databricks. Returns an honest `missing` gate string so
 * the BFF can surface exactly what to provision.
 */
export function sparkPoolBackendStatus(): SparkBackendStatus {
  const isDbx = (process.env.LOOM_NOTEBOOK_BACKEND || '').trim().toLowerCase() === 'databricks';
  if (isDbx) {
    const missing = process.env.LOOM_DATABRICKS_HOSTNAME ? undefined : 'LOOM_DATABRICKS_HOSTNAME';
    return { backend: 'databricks', configured: !missing, missing };
  }
  const gate = synapseConfigGate();
  return { backend: 'synapse', configured: !gate, missing: gate?.missing };
}

// ============================================================
// Sizing helpers (must match the notebook run route so warm sessions match)
// ============================================================

/**
 * The default Synapse sizing the run route computes when a notebook run carries
 * NO custom session config. Kept 1:1 with the run route (both call
 * `computeEffectiveSizing` in lib/spark/spark-sizing) so a warm session's
 * sizingKey matches a default run and the hand-off actually hits.
 */
export function defaultSynapseSizing(): { sizing?: LivySessionSizing; sizingKey: string } {
  // Delegate to the shared source of truth (lib/spark/spark-sizing) so the warm
  // pool keys on the SAME sizing a default run computes — otherwise a pre-warmed
  // session is never leasable (R3 #1). The default now carries the editor's
  // default executor sizing (2 · 4g · 3600s) + the env-gated LA conf.
  return computeDefaultSynapseSizing();
}

function groupKey(backend: SparkPoolBackend, poolName: string, kind: LivyKind, sizingKey: string): string {
  return `${backend}|${poolName}|${kind}|${sizingKey}`;
}

/**
 * Register a pool/kind/sizing combination the sweeper should keep warm at
 * `min`. Called on every acquire (hit or miss) and on explicit warm requests,
 * so the pool learns which sessions the workload actually needs.
 */
function registerGroup(g: PoolGroup): PoolGroup {
  const existing = store.groups.get(g.key);
  if (existing) {
    // A later registration may carry the concrete `sizing` (e.g. the default
    // group registered at startup) that an earlier sizing-less adoption lacked —
    // fill it in so refill warms replacement sessions with the right sizing.
    if (!existing.sizing && g.sizing) existing.sizing = g.sizing;
    return existing;
  }
  store.groups.set(g.key, g);
  return g;
}

/**
 * The canonical DEFAULT pool/kind/sizing group — the exact combination a plain
 * notebook cell run uses (backend=active Spark backend, poolName=default Spark
 * pool, kind=pyspark, sizing=`defaultSynapseSizing()`). Pre-registering this at
 * startup (below) gives the sweeper a target IMMEDIATELY so the FIRST user's
 * FIRST run is warm — instead of the old lazy path where the first run merely
 * registered the group and cold-started (R3 root cause #1).
 */
function defaultBackendGroup(): PoolGroup {
  const gate = sparkPoolBackendStatus();
  if (gate.backend === 'databricks') {
    const poolName = process.env.LOOM_DATABRICKS_DEFAULT_CLUSTER || '';
    const key = groupKey('databricks', poolName, 'pyspark', '');
    return { key, backend: 'databricks', poolName, kind: 'pyspark', sizingKey: '' };
  }
  const poolName = defaultSparkPool();
  const { sizing, sizingKey } = defaultSynapseSizing();
  const key = groupKey('synapse', poolName, 'pyspark', sizingKey);
  return { key, backend: 'synapse', poolName, kind: 'pyspark', sizingKey, sizing };
}

/** Register the default group so the sweeper always has a warm target. */
function registerDefaultGroup(): void {
  const gate = sparkPoolBackendStatus();
  // A Databricks default group needs a concrete default cluster; skip when unset
  // (nothing to warm against) — the Synapse default (loompool) is always present.
  if (gate.backend === 'databricks' && !process.env.LOOM_DATABRICKS_DEFAULT_CLUSTER) return;
  registerGroup(defaultBackendGroup());
}

/**
 * Reconstruct the LivySessionSizing for an adopted group. We only truly know the
 * sizing for the DEFAULT group (its key matches `defaultSynapseSizing()`); for a
 * custom-sizing group warmed by another replica we leave it undefined (the slot
 * is still leasable — it is labelled with the group's sizingKey — and a
 * replacement warm falls back to the Livy default, an acceptable rare edge).
 */
function sizingForAdoptedGroup(sizingKey: string): LivySessionSizing | undefined {
  const d = defaultSynapseSizing();
  return sizingKey === d.sizingKey ? d.sizing : undefined;
}

/**
 * Survive scale-to-zero: on a FRESH replica (empty in-memory store) adopt the
 * warm/leased/shared slots a PRIOR replica persisted to the shared Cosmos store,
 * and register their groups so the sweeper maintains `min` for them. Without this
 * a recycled replica boots with `store.groups` empty → warm stays 0 → the next
 * run cold-starts even though a warm session is standing by in the store (R3 root
 * cause #2/#3). Best-effort — a store miss simply leaves the local registry empty.
 * Idempotent: runs at most once per replica.
 */
export async function adoptFromStore(): Promise<void> {
  if (store.adopted) return;
  if (leaseStoreMode() !== 'cosmos') { store.adopted = true; return; }
  store.adopted = true; // set first so a concurrent boot doesn't double-adopt
  let docs: Awaited<ReturnType<typeof listAllDocs>>;
  try {
    docs = await listAllDocs();
  } catch {
    store.adopted = false; // let a later sweep retry adoption
    return;
  }
  const me = replicaId();
  for (const doc of docs) {
    // Register the group so refill keeps this sizing at `min`.
    registerGroup({
      key: doc.groupKey,
      backend: doc.backend,
      poolName: doc.poolName,
      kind: doc.kind,
      sizingKey: doc.sizingKey,
      sizing: sizingForAdoptedGroup(doc.sizingKey),
    });
    // Mirror the persisted slot locally (for status + keepalive) unless already tracked.
    if (store.slots.some((s) => s.leaseId === doc.id)) continue;
    store.slots.push({
      leaseId: doc.id,
      backend: doc.backend,
      poolName: doc.poolName,
      kind: doc.kind,
      sizingKey: doc.sizingKey,
      sessionId: doc.sessionId,
      state: doc.state === 'leased' ? 'leased' : doc.state === 'shared' ? 'shared' : 'warm',
      createdAt: doc.warmedAt,
      warmedAt: doc.warmedAt,
      lastActivityAt: doc.lastActivityAt,
      leases: doc.leases || [],
      groupKey: doc.groupKey,
      // Owned here only if THIS replica warmed it; otherwise it's a claimed mirror
      // (evictSlot/publish honour fromStore → never tears down another replica's session).
      fromStore: me !== doc.ownerReplica,
      request: doc.request,
    });
  }
}

/**
 * Start the warm pool for THIS replica: pre-register the default group, adopt any
 * store-persisted warm slots, start the sweeper, and kick an immediate refill so
 * warming begins NOW rather than on the first 30s sweep tick. Idempotent + cheap
 * — called at module load and on every config-apply so a scale-to-zero recycle
 * re-arms warming as soon as the replica handles its first request.
 */
export function ensureWarmPoolStarted(): void {
  if (!sparkPoolConfig().enabled) return;
  registerDefaultGroup();
  ensureSweeper();
  if (store.started) {
    // Already armed on this replica — still make sure adoption ran (store may have
    // become configured after boot) and top up.
    void adoptFromStore().then(() => refillPool()).catch(() => {});
    return;
  }
  store.started = true;
  // Adopt persisted warm slots first (so refill counts them and doesn't re-warm),
  // then top up to `min` immediately.
  void adoptFromStore()
    .then(() => refillPool())
    .catch(() => {});
}

// ============================================================
// Warm one session (REAL backend calls)
// ============================================================

/** Detects the Synapse job-service queue-jam rejection in a failure reason. */
function isQueueJamError(reason: string): boolean {
  return /MAX_QUEUED_JOBS|number of queued jobs|cannot exceed \[?\d+\]?/i.test(reason);
}

/**
 * Record a warm failure for the slot's group and arm the circuit breaker.
 * Queue-jam rejections back off hard immediately (15 min, doubling to 60 min);
 * other failures back off from the 2nd consecutive failure (5 min, doubling).
 */
function noteWarmFailure(groupKey: string, reason: string): void {
  const grp = store.groups.get(groupKey);
  if (!grp) return;
  grp.consecFails = (grp.consecFails ?? 0) + 1;
  grp.lastFailure = reason.slice(0, 300);
  const jam = isQueueJamError(reason);
  if (jam || grp.consecFails >= 2) {
    const baseMs = jam ? 15 * 60_000 : 5 * 60_000;
    const doublings = Math.max(0, grp.consecFails - (jam ? 1 : 2));
    grp.backoffUntil = Date.now() + Math.min(baseMs * 2 ** Math.min(doublings, 4), 60 * 60_000);
  }
}

/** Reset the group's circuit breaker after a successful warm. */
function noteWarmSuccess(groupKey: string): void {
  const grp = store.groups.get(groupKey);
  if (!grp) return;
  grp.consecFails = 0;
  grp.backoffUntil = 0;
  grp.lastFailure = undefined;
}

/**
 * Mark a warming slot dead AND tear down its backend Livy session + lease doc.
 * The teardown is the load-bearing half: a failed/stuck warm attempt used to
 * leave its Livy job QUEUED on the pool forever (pollLivyToIdle only flipped
 * the local slot state) — 153 such zombies filled loompool's 200-job queue on
 * 2026-07-14 and every new session was hard-rejected. Best-effort kill; 404 =
 * already gone = fine.
 */
function markWarmingDead(slot: PooledSlot, reason: string): void {
  slot.state = 'dead';
  slot.error = reason;
  noteWarmFailure(slot.groupKey, reason);
  if (slot.backend === 'synapse' && typeof slot.sessionId === 'number' && !slot.fromStore) {
    void killLivySession(slot.poolName, slot.sessionId).catch(() => {});
  }
  void removeSlot(slot.leaseId, slot.groupKey);
}

function rndId(): string {
  return `lease-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function slotsForGroup(key: string): PooledSlot[] {
  const grp = store.groups.get(key);
  if (!grp) return [];
  return store.slots.filter(
    (sl) => sl.backend === grp.backend && sl.poolName === grp.poolName && sl.kind === grp.kind && sl.sizingKey === grp.sizingKey,
  );
}

/** Project a live slot into the cross-replica shared-store doc + publish it. */
function publishWarmSlot(slot: PooledSlot): Promise<void> {
  if (leaseStoreMode() !== 'cosmos') return Promise.resolve();
  if (typeof slot.sessionId !== 'number') return Promise.resolve();
  return publishSlot({
    id: slot.leaseId,
    groupKey: slot.groupKey,
    backend: slot.backend,
    poolName: slot.poolName,
    kind: slot.kind,
    sizingKey: slot.sizingKey,
    sessionId: slot.sessionId,
    state:
      slot.state === 'warm' || slot.state === 'leased' || slot.state === 'shared'
        ? slot.state
        : 'warm',
    leases: slot.leases,
    ownerReplica: replicaId(),
    warmedAt: slot.warmedAt ?? slot.createdAt,
    lastActivityAt: slot.lastActivityAt,
    request: slot.request,
  });
}

async function pollLivyToIdle(poolName: string, sessionId: number, slot: PooledSlot): Promise<void> {
  // Cold start of a Synapse Spark pool can take 2-4 min. Poll in the
  // background; the slot stays 'warming' until Livy reports 'idle'.
  for (let i = 0; i < 90; i++) {
    let state = 'starting';
    let errDetail = '';
    try {
      const live = await getLivySession(poolName, sessionId);
      state = live.state;
      errDetail = livyErrorDetail(live);
    } catch {
      markWarmingDead(slot, 'session unreachable while warming');
      return;
    }
    if (state === 'idle') {
      // A lease may have raced in and grabbed this slot the instant it warmed;
      // only promote to 'warm' if it is still warming.
      if (slot.state === 'warming') {
        slot.state = 'warm';
        slot.warmedAt = Date.now();
        slot.lastActivityAt = Date.now();
        // PUBLISH the now-warm slot to the shared cross-replica store. Without
        // this the slot flips to 'warm' only in THIS replica's memory: the
        // shared store keeps showing it 'warming', every other replica (and the
        // external keep-warm heartbeat, which round-robins across replicas)
        // never sees a warm session, and each hit spawns ANOTHER warming slot
        // that also never publishes — the pool is perpetually 'warming' and the
        // first user run always cold-starts. (Root cause of the stuck warm-pool
        // seen 2026-07-12.)
        void publishWarmSlot(slot).catch(() => {});
        noteWarmSuccess(slot.groupKey);
      }
      return;
    }
    if (['error', 'dead', 'killed', 'shutting_down'].includes(state)) {
      markWarmingDead(
        slot,
        `session entered terminal state '${state}' while warming${errDetail ? ` — ${errDetail}` : ''}`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  markWarmingDead(slot, 'session did not reach idle within warm timeout');
}

async function warmOneSynapse(grp: PoolGroup): Promise<void> {
  const slot: PooledSlot = {
    leaseId: rndId(),
    backend: 'synapse',
    poolName: grp.poolName,
    kind: grp.kind,
    sizingKey: grp.sizingKey,
    state: 'warming',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    leases: [],
    groupKey: grp.key,
  };
  store.slots.push(slot);
  store.warming++;
  try {
    const sess = await createLivySessionAsync(grp.poolName, grp.kind, `loom-warmpool-${Date.now()}`, grp.sizing);
    slot.sessionId = sess.id;
    slot.request = sess.request;
    await pollLivyToIdle(grp.poolName, sess.id, slot);
    if (slot.state === 'warm') void publishWarmSlot(slot);
  } catch (e: unknown) {
    // Create/poll threw — mark dead AND tear down any session that did get
    // created, so the failed attempt can't leave a queued zombie on the pool.
    markWarmingDead(slot, e instanceof Error ? e.message : String(e));
  } finally {
    store.warming--;
  }
}

async function warmOneDatabricks(grp: PoolGroup): Promise<void> {
  // A warmed Databricks all-purpose cluster is what removes cold-start for the
  // notebook's one-time job runs — start it and confirm RUNNING. One cluster
  // serves concurrent runs, so a Databricks warm slot is "cluster warmth"
  // rather than a per-user session (release is a no-op for it).
  const slot: PooledSlot = {
    leaseId: rndId(),
    backend: 'databricks',
    poolName: grp.poolName,
    kind: grp.kind,
    sizingKey: grp.sizingKey,
    state: 'warming',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    leases: [],
    groupKey: grp.key,
  };
  store.slots.push(slot);
  store.warming++;
  try {
    const { startCluster, getCluster } = await import('@/lib/azure/databricks-client');
    await startCluster(grp.poolName);
    for (let i = 0; i < 90; i++) {
      const c = await getCluster(grp.poolName);
      const st = (c.state || '').toUpperCase();
      if (st === 'RUNNING') {
        if (slot.state === 'warming') {
          slot.state = 'warm';
          slot.warmedAt = Date.now();
          slot.lastActivityAt = Date.now();
          void publishWarmSlot(slot);
        }
        return;
      }
      if (['TERMINATED', 'ERROR', 'UNKNOWN'].includes(st)) {
        slot.state = 'dead';
        slot.error = `cluster entered '${st}' while warming`;
        noteWarmFailure(slot.groupKey, slot.error);
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    slot.state = 'dead';
    slot.error = 'cluster did not reach RUNNING within warm timeout';
    noteWarmFailure(slot.groupKey, slot.error);
  } catch (e: unknown) {
    slot.state = 'dead';
    slot.error = e instanceof Error ? e.message : String(e);
    noteWarmFailure(slot.groupKey, slot.error);
  } finally {
    store.warming--;
  }
}

async function warmOne(grp: PoolGroup): Promise<void> {
  if (grp.backend === 'databricks') return warmOneDatabricks(grp);
  return warmOneSynapse(grp);
}

/**
 * SYNCHRONOUS reconcile of every 'warming' slot against its live backend state,
 * promoting idle→warm (and publishing) or terminal→dead — all within the calling
 * request.
 *
 * WHY this is needed on top of the background `pollLivyToIdle`: a warm session is
 * created fire-and-forget (`warmOne` → `pollLivyToIdle`) with a `setTimeout(3000)`
 * poll loop. In a serverless Container App the Node process is CPU-throttled to
 * ~zero BETWEEN requests, so that background loop does NOT advance once the
 * creating request returns — the slot is frozen at 'warming' forever and every
 * keep-warm tick reports `warming:1 / warm:0` (exactly the stuck pool seen live
 * 2026-07-12: same replica, two ticks 5 min apart, still warming). The external
 * keep-warm heartbeat gives us a live request on a cadence; doing ONE real
 * liveness check per warming slot inside that request makes forward progress
 * every tick regardless of between-request throttling. A Synapse session reaches
 * idle in ~2-3 min, so the slot promotes within a tick or two of creation.
 *
 * Best-effort + bounded: one backend call per warming slot, errors leave the slot
 * warming for the next tick to retry rather than throwing.
 */
export async function reconcileWarmingSlots(): Promise<{ promoted: number; died: number; stillWarming: number }> {
  const warming = store.slots.filter((s) => s.state === 'warming');
  let promoted = 0;
  let died = 0;
  let stillWarming = 0;
  await Promise.all(
    warming.map(async (slot) => {
      try {
        if (slot.backend === 'databricks') {
          if (!slot.poolName) { stillWarming++; return; }
          const { getCluster } = await import('@/lib/azure/databricks-client');
          const c = await getCluster(slot.poolName);
          const st = (c.state || '').toUpperCase();
          if (st === 'RUNNING') {
            slot.state = 'warm'; slot.warmedAt = Date.now(); slot.lastActivityAt = Date.now();
            await publishWarmSlot(slot).catch(() => {}); promoted++;
            noteWarmSuccess(slot.groupKey);
          } else if (['TERMINATED', 'ERROR', 'UNKNOWN'].includes(st)) {
            slot.state = 'dead'; slot.error = `cluster '${st}' on reconcile`; died++;
            noteWarmFailure(slot.groupKey, slot.error);
          } else { stillWarming++; }
          return;
        }
        // Synapse Livy session.
        if (typeof slot.sessionId !== 'number') { stillWarming++; return; }
        const live = await getLivySession(slot.poolName, slot.sessionId);
        if (live.state === 'idle') {
          slot.state = 'warm'; slot.warmedAt = Date.now(); slot.lastActivityAt = Date.now();
          await publishWarmSlot(slot).catch(() => {}); promoted++;
          noteWarmSuccess(slot.groupKey);
        } else if (['error', 'dead', 'killed', 'shutting_down'].includes(live.state)) {
          const detail = livyErrorDetail(live);
          markWarmingDead(slot, `session '${live.state}' on reconcile${detail ? ` — ${detail}` : ''}`);
          died++;
        } else { stillWarming++; }
      } catch {
        // A single failed liveness check shouldn't kill the slot — the backend may
        // be briefly unreachable; leave it warming for the next tick to retry.
        stillWarming++;
      }
    }),
  );
  return { promoted, died, stillWarming };
}

// ============================================================
// Refill + sweep
// ============================================================

/**
 * Bring every registered group up to `min` warm sessions (counting warming +
 * warm toward the target, and never exceeding `max`). Fire-and-forget: warms
 * happen in the background. Safe to call frequently — it is a no-op when every
 * group is already at target.
 */
export async function refillPool(): Promise<void> {
  const cfg = sparkPoolConfig();
  if (!cfg.enabled) return;
  const gate = sparkPoolBackendStatus();
  if (!gate.configured) return; // honest — nothing to warm against
  const tasks: Promise<void>[] = [];
  const now = Date.now();
  for (const grp of store.groups.values()) {
    // Circuit breaker: a group whose warms keep failing (or that hit the
    // Synapse queue-jam rejection) sits out until its backoff expires instead
    // of feeding the jam with a fresh session every sweep tick.
    if (typeof grp.backoffUntil === 'number' && grp.backoffUntil > now) continue;
    const slots = slotsForGroup(grp.key);
    const active = slots.filter((s) => s.state === 'warming' || s.state === 'warm').length;
    const warmingOrWarm = active;
    const total = slots.filter((s) => s.state !== 'dead').length;
    const need = Math.min(cfg.min - warmingOrWarm, cfg.max - total);
    for (let i = 0; i < need; i++) tasks.push(warmOne(grp));
  }
  // Don't await sequentially-blocking; kick them and let the caller move on.
  await Promise.allSettled(tasks);
}

/** Kill a warm Livy session on eviction (best-effort — 404 is fine). */
function evictSlot(slot: PooledSlot): void {
  slot.state = 'dead';
  // Remove its cross-replica lease doc so no other replica claims a dead session.
  void removeSlot(slot.leaseId, slot.groupKey);
  // Only the owning replica (the one that warmed the real session) tears down the
  // backend session; a slot merely CLAIMED from the shared store must not kill a
  // session another replica owns.
  if (slot.fromStore) return;
  if (slot.backend === 'synapse' && typeof slot.sessionId === 'number') {
    void killLivySession(slot.poolName, slot.sessionId).catch(() => {});
  }
  // Databricks cluster warmth is shared infra — never terminate it here.
}

function pruneDead(): void {
  store.slots = store.slots.filter((s) => s.state !== 'dead');
}

// ============================================================
// #1796 — leaked stale-session reaper
// ============================================================

function sessKey(poolName: string, sessionId: number): string {
  return `${poolName}#${sessionId}`;
}

/**
 * Mark a Livy session as ACTIVELY IN USE (heartbeat). Called by the notebook
 * session keepalive route (every ~4 min while a notebook is open) and the run
 * route when it reuses/creates a session — so the reaper never kills a live
 * (possibly cold-started, pool-untracked) notebook session. Cheap in-memory
 * stamp; the reaper treats a heartbeat within `reapGraceMs` as "in use".
 */
export function markSessionInUse(poolName: string, sessionId: number | string): void {
  const id = Number(sessionId);
  if (!poolName || !Number.isFinite(id)) return;
  store.inUse.set(sessKey(poolName, id), Date.now());
}

/** Session ids this replica considers protected for `poolName` (never reaped). */
function protectedSessionIds(poolName: string, storeDocSessionIds: Set<number>): Set<number> {
  const ids = new Set<number>();
  // Local pool slots (warm / leased / shared / warming) for this pool.
  for (const s of store.slots) {
    if (s.poolName === poolName && s.state !== 'dead' && typeof s.sessionId === 'number') ids.add(s.sessionId);
  }
  // Cross-replica store docs — a session warmed/leased on ANOTHER replica.
  for (const id of storeDocSessionIds) ids.add(id);
  return ids;
}

/**
 * States that hold pool capacity and are safe to reap when leaked.
 *   • idle — holds executors/vcores (#1796: ~700 leaked idle sessions).
 *   • not_started / starting / recovering — holds a JOB-QUEUE slot. The
 *     2026-07-14 loompool jam was 153 untracked queued sessions filling the
 *     pool's 200-job queue cap, hard-rejecting every new session. A genuinely
 *     cold-starting user session is protected by the same heartbeat +
 *     full-grace-window guards (grace ≥ 30 min ≫ any real cold start).
 * `busy` (an actively-running cell) is never reaped by the NORMAL grace — but
 * see the busy-zombie rule in reapStaleSessions: a POOL-OWNED (loom-warmpool-*)
 * session stuck `busy` + untracked for the extended grace is a wedged keepalive
 * (2026-07-14: one held 80 cores on loombatch for 2 days, starving the whole
 * workspace's vCore quota so no other pool could start a session).
 */
function isReapableState(state: string): boolean {
  const s = String(state).toLowerCase();
  return s === 'idle' || s === 'not_started' || s === 'starting' || s === 'recovering';
}

/**
 * Extended grace for reaping a POOL-OWNED `busy` zombie: 4× the normal grace,
 * floor 2 h. A warm-pool session only ever runs sub-second keepalive
 * statements, so `busy` + untracked + un-heartbeated this long is a wedged
 * Spark context, never a real workload.
 */
function busyZombieGraceMs(cfg: PoolConfig): number {
  return Math.max(cfg.reapGraceMs * 4, 2 * 60 * 60_000);
}

/** Pool-owned session name prefix — only these are eligible for the busy-zombie rule. */
function isPoolOwnedName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.startsWith('loom-warmpool-');
}

/**
 * Reap leaked, untracked, idle Livy sessions that starve the pool (#1796 — the
 * loompool was jammed with ~700 leaked sessions, so a fresh cell run's session
 * never started). On each sweep this enumerates the pool's live sessions and
 * kills any that are ALL of: `idle`, NOT a pool slot / cross-replica lease, NOT
 * heartbeated within `reapGraceMs` (so live notebooks are safe), AND have been
 * observed idle+untracked for a FULL `reapGraceMs` window (so a just-created
 * session about to be leased/heartbeated is never killed).
 *
 * NEVER kills: a warm / leased / shared / warming slot, a cross-replica leased
 * session, a session younger than the grace since first seen untracked, an
 * in-use (heartbeated) session, or a non-idle (busy / starting / …) session.
 * Best-effort — a list/kill failure degrades to a no-op (never breaks the sweep).
 */
export async function reapStaleSessions(poolName: string, storeDocSessionIds: Set<number> = new Set()): Promise<number> {
  const cfg = sparkPoolConfig();
  if (!cfg.reapEnabled) return 0;
  let live: Awaited<ReturnType<typeof listLivySessions>>;
  try {
    live = await listLivySessions(poolName);
  } catch {
    return 0; // honest no-op — can't enumerate, don't guess
  }
  const now = Date.now();
  const protectedIds = protectedSessionIds(poolName, storeDocSessionIds);
  const liveIds = new Set<number>();
  let killed = 0;

  for (const sess of live) {
    if (typeof sess.id !== 'number') continue;
    liveIds.add(sess.id);
    const key = sessKey(poolName, sess.id);

    // Guard 1 — tracked as a pool slot or a cross-replica lease → never reap.
    if (protectedIds.has(sess.id)) { store.firstSeenUntracked.delete(key); continue; }
    // Guard 2 — reapable-state sessions hold reclaimable capacity. A `busy`
    // session is spared UNLESS it is pool-owned (loom-warmpool-*): those only
    // run sub-second keepalives, so a long-busy one is a wedged context holding
    // executors (the 2026-07-14 loombatch 80-core / 2-day zombie). It uses the
    // EXTENDED grace below instead of the normal one.
    const busyZombieCandidate =
      String(sess.state).toLowerCase() === 'busy' && isPoolOwnedName(sess.name);
    if (!isReapableState(sess.state) && !busyZombieCandidate) {
      store.firstSeenUntracked.delete(key);
      continue;
    }
    const graceMs = busyZombieCandidate ? busyZombieGraceMs(cfg) : cfg.reapGraceMs;
    // Guard 3 — heartbeated (live notebook keepalive / active run) within grace.
    const lastUse = store.inUse.get(key);
    if (typeof lastUse === 'number' && now - lastUse < graceMs) { store.firstSeenUntracked.delete(key); continue; }
    // Guard 4 — must have been untracked for a FULL grace window. Record on
    // first sight and defer; a session only just created (not yet leased/kept) is
    // therefore never reaped on the first pass.
    const firstSeen = store.firstSeenUntracked.get(key);
    if (firstSeen === undefined) { store.firstSeenUntracked.set(key, now); continue; }
    if (now - firstSeen < graceMs) continue;

    // All guards passed → leaked. Kill it (best-effort) and forget it.
    try {
      await killLivySession(poolName, sess.id);
      killed++;
    } catch {
      /* 404 / race — fine; drop the tracker so we don't spin on it */
    }
    store.firstSeenUntracked.delete(key);
    store.inUse.delete(key);
  }

  // GC trackers for sessions no longer present on the pool.
  for (const key of store.firstSeenUntracked.keys()) {
    const idPart = Number(key.slice(poolName.length + 1));
    if (key.startsWith(`${poolName}#`) && !liveIds.has(idPart)) store.firstSeenUntracked.delete(key);
  }
  for (const key of store.inUse.keys()) {
    const idPart = Number(key.slice(poolName.length + 1));
    if (key.startsWith(`${poolName}#`) && !liveIds.has(idPart)) store.inUse.delete(key);
  }
  return killed;
}

/** The distinct Synapse Spark pools the reaper should scan (registered groups). */
function reapablePools(): string[] {
  const pools = new Set<string>();
  for (const grp of store.groups.values()) {
    if (grp.backend === 'synapse' && grp.poolName) pools.add(grp.poolName);
  }
  return [...pools];
}

/**
 * Periodic maintenance: prune dead slots, keepalive warm Synapse sessions
 * (reset their Livy idle clock so they survive between runs), evict warm slots
 * that have sat idle past the TTL beyond `min`, then refill to `min`.
 */
async function sweep(): Promise<void> {
  // Converge on the shared admin override FIRST so a kill switch / config change
  // set via any replica applies here this tick.
  await syncConfigFromStore();
  const cfg = sparkPoolConfig();
  pruneDead();
  if (!cfg.enabled) return;
  // A fresh (recycled) replica may have started the sweeper with an empty
  // registry — adopt any store-persisted warm slots + ensure the default group
  // is registered so warm doesn't stay 0 after a scale-to-zero recycle.
  registerDefaultGroup();
  await adoptFromStore();
  // Promote any 'warming' slot whose backend session already reached idle — the
  // fire-and-forget pollLivyToIdle loop stalls between requests under serverless
  // CPU throttling, so reconcile it here on any live request too (not only the
  // external keep-warm tick).
  await reconcileWarmingSlots().catch(() => {});
  const now = Date.now();
  for (const grp of store.groups.values()) {
    const warm = slotsForGroup(grp.key).filter((s) => s.state === 'warm');
    // Keepalive every warm Synapse session so Livy's own idle timeout doesn't
    // reap it while it waits to be leased.
    for (const s of warm) {
      if (s.backend === 'synapse' && typeof s.sessionId === 'number') {
        void keepaliveLivySession(s.poolName, s.sessionId).catch(() => {});
      }
      // Refresh the cross-replica lease doc's TTL so another replica keeps seeing
      // this warm session as claimable (owner replicas only — claimed slots are
      // republished by their owner).
      if (!s.fromStore) void publishWarmSlot(s);
    }
    // Evict warm-above-min sessions idle past the TTL (oldest-idle first).
    const overMin = warm
      .filter((s) => now - s.lastActivityAt > cfg.idleTtlMs)
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    const evictable = Math.max(0, warm.length - cfg.min);
    for (let i = 0; i < Math.min(evictable, overMin.length); i++) evictSlot(overMin[i]);
  }
  pruneDead();

  // #1796 — reap leaked/untracked idle sessions so the pool self-cleans and
  // never re-jams to the point of starving new sessions. Only when a real Spark
  // backend is configured (otherwise listing would just 404). Cross-replica
  // leases are protected via the shared store's session ids.
  if (cfg.reapEnabled && sparkPoolBackendStatus().configured) {
    let storeDocSessionIds = new Set<number>();
    if (leaseStoreMode() === 'cosmos') {
      try {
        const docs = await listAllDocs();
        storeDocSessionIds = new Set(docs.map((d) => d.sessionId).filter((x): x is number => typeof x === 'number'));
      } catch { /* best-effort — local slots still protect this replica's sessions */ }
    }
    for (const pool of reapablePools()) {
      await reapStaleSessions(pool, storeDocSessionIds).catch(() => 0);
    }
  }

  await refillPool();
}

function ensureSweeper(): void {
  if (store.sweeper) return;
  const t = setInterval(() => {
    void sweep().catch(() => {});
  }, SWEEP_INTERVAL_MS);
  // Don't keep the process alive just for the sweeper.
  if (typeof (t as unknown as { unref?: () => void }).unref === 'function') {
    (t as unknown as { unref: () => void }).unref();
  }
  store.sweeper = t;
}

// ============================================================
// Acquire / release (the lease/return model)
// ============================================================

export interface AcquireRequest {
  backend: SparkPoolBackend;
  poolName: string;
  kind: LivyKind;
  sizingKey: string;
  /** The exact sizing so a fresh warm session matches this run's config. */
  sizing?: LivySessionSizing;
  /** Acting user's oid — stamped on the lease (never share a WRITE session across users). */
  userOid?: string;
  /**
   * FGC-10 — the run is read-only (no writes / no shared mutable state), so it may
   * SHARE a warm session with other concurrent read-only runs when concurrent mode
   * is on. Write runs (omit / false) always get an exclusive session.
   */
  readOnly?: boolean;
}

export interface Lease {
  leaseId: string;
  backend: SparkPoolBackend;
  poolName: string;
  sessionId?: number;
  sizingKey: string;
  request?: Record<string, unknown>;
  /** True when this lease SHARES its session with other concurrent read-only runs. */
  shared?: boolean;
  /** Which store served the lease: 'memory' (this replica) | 'cosmos' (cross-replica claim). */
  via?: LeaseStoreMode;
}

function mkLeaseRec(oid: string | undefined, readOnly: boolean): LeaseRec {
  return { id: mintLeaseId(), oid, readOnly, at: Date.now() };
}

function leaseFromSlot(slot: PooledSlot, leaseId: string, shared: boolean, via: LeaseStoreMode): Lease {
  return {
    leaseId,
    backend: slot.backend,
    poolName: slot.poolName,
    sessionId: slot.sessionId,
    sizingKey: slot.sizingKey,
    request: slot.request,
    shared,
    via,
  };
}

/** Live-check a Synapse slot; returns false (and marks it dead) if Livy reaped it. */
async function synapseSlotLive(slot: PooledSlot): Promise<boolean> {
  if (slot.backend !== 'synapse') return true;
  if (typeof slot.sessionId !== 'number') { slot.state = 'dead'; return false; }
  try {
    const live = await getLivySession(slot.poolName, slot.sessionId);
    if (!['idle', 'busy'].includes(live.state)) { slot.state = 'dead'; return false; }
  } catch {
    slot.state = 'dead';
    return false;
  }
  return true;
}

/**
 * Hand off a warm session matching (backend, pool, kind, sizing).
 *
 * Exclusive (default): flips exactly ONE warm session to `leased`, stamped with
 * the caller — never shared across users. FGC-10 concurrent mode (`readOnly`):
 * a read-only run may instead SHARE a warm session, taking one of up to
 * `maxLeasesPerSession` read-only leases on it. Cross-replica (PSR-3): when the
 * shared Cosmos store is active, the claim is an atomic ETag flip on the shared
 * doc so a session warmed on ANY replica can be handed off here. Returns null on
 * a miss — the caller then cold-starts (pure accelerator, never a dependency).
 */
export async function acquireWarmSession(req: AcquireRequest): Promise<Lease | null> {
  const cfg = sparkPoolConfig();
  const key = groupKey(req.backend, req.poolName, req.kind, req.sizingKey);
  registerGroup({
    key,
    backend: req.backend,
    poolName: req.poolName,
    kind: req.kind,
    sizingKey: req.sizingKey,
    sizing: req.sizing,
  });
  if (!cfg.enabled) return null;
  ensureSweeper();
  const shareable = cfg.concurrent && req.readOnly === true;

  // ── Cross-replica path (shared Cosmos store) ──
  // The store is the source of truth: an atomic ETag claim prevents two replicas
  // (or two runs) from taking the same exclusive session. Local warm slots are
  // published to the store, so this path also claims sessions THIS replica warmed.
  if (leaseStoreMode() === 'cosmos') {
    for (let attempt = 0; attempt < 3; attempt++) {
      let claimed;
      try {
        claimed = await claimSlot({ groupKey: key, shared: shareable, maxLeasesPerSession: cfg.maxLeasesPerSession, oid: req.userOid });
      } catch {
        claimed = null;
      }
      if (!claimed) break;
      // Mirror the claim into a local slot so releaseSession + status track it.
      let slot = store.slots.find((s) => s.leaseId === claimed!.doc.id);
      if (!slot) {
        slot = {
          leaseId: claimed.doc.id,
          backend: claimed.doc.backend,
          poolName: claimed.doc.poolName,
          kind: claimed.doc.kind,
          sizingKey: claimed.doc.sizingKey,
          sessionId: claimed.doc.sessionId,
          state: claimed.doc.state,
          createdAt: claimed.doc.warmedAt,
          warmedAt: claimed.doc.warmedAt,
          lastActivityAt: claimed.doc.lastActivityAt,
          leases: claimed.doc.leases,
          groupKey: key,
          fromStore: replicaId() !== claimed.doc.ownerReplica,
          request: claimed.doc.request,
        };
        store.slots.push(slot);
      } else {
        slot.state = claimed.doc.state;
        slot.leases = claimed.doc.leases;
        slot.sessionId = claimed.doc.sessionId;
        slot.lastActivityAt = claimed.doc.lastActivityAt;
      }
      // Guard against handing off a session Livy already reaped.
      if (!(await synapseSlotLive(slot))) {
        void removeSlot(slot.leaseId, key);
        pruneDead();
        continue; // try the next claimable doc
      }
      void refillPool().catch(() => {});
      pruneDead();
      return leaseFromSlot(slot, claimed.leaseId, claimed.doc.state === 'shared', 'cosmos');
    }
    pruneDead();
    void refillPool().catch(() => {});
    return null;
  }

  // ── Local (in-process per-replica) path ──
  // Concurrent read-only run: first try to SHARE an already-live shared session.
  if (shareable) {
    const shared = slotsForGroup(key).filter(
      (s) => s.state === 'shared' && s.leases.length < cfg.maxLeasesPerSession,
    );
    for (const slot of shared) {
      const rec = mkLeaseRec(req.userOid, true);
      slot.leases.push(rec);
      slot.lastActivityAt = Date.now();
      return leaseFromSlot(slot, rec.id, true, 'memory');
    }
  }

  // Scan warm slots for this exact group. Verify Synapse liveness before
  // handing off; skip (and mark dead) any the backend has already reaped.
  const candidates = store.slots.filter(
    (s) =>
      s.state === 'warm' &&
      s.backend === req.backend &&
      s.poolName === req.poolName &&
      s.kind === req.kind &&
      s.sizingKey === req.sizingKey,
  );
  for (const slot of candidates) {
    if (!(await synapseSlotLive(slot))) continue;
    // A concurrent acquire may have flipped it while we awaited the liveness
    // probe — re-check under the (single-threaded) sync flip.
    if (slot.state !== 'warm') continue;
    const rec = mkLeaseRec(req.userOid, shareable);
    slot.leases = [rec];
    slot.state = shareable ? 'shared' : 'leased';
    slot.lastActivityAt = Date.now();
    // Replace the drained slot in the background.
    void refillPool().catch(() => {});
    pruneDead();
    return leaseFromSlot(slot, rec.id, shareable, 'memory');
  }

  pruneDead();
  // Miss — warm up for next time, then let the caller cold-start.
  void refillPool().catch(() => {});
  return null;
}

/**
 * Return a lease. Drops this sub-lease; when the LAST sub-lease is returned the
 * session goes back to `warm` (idle clock reset via Livy keepalive) so it can be
 * re-leased. `{ dead:true }` evicts the whole session (used when the notebook's
 * session died / was recreated). Unknown leaseIds are ignored. The shared store
 * is updated so a cross-replica claim releases correctly.
 */
export function releaseSession(leaseId: string, opts?: { dead?: boolean }): void {
  const slot = store.slots.find((s) => s.leaseId === leaseId || s.leases.some((l) => l.id === leaseId));
  if (!slot) return;
  if (opts?.dead) {
    evictSlot(slot);
    pruneDead();
    return;
  }
  // Drop just this sub-lease (a shared session may keep other read-only leases).
  slot.leases = slot.leases.filter((l) => l.id !== leaseId);
  slot.lastActivityAt = Date.now();
  slot.state = slot.leases.length === 0 ? 'warm' : slot.leases.every((l) => l.readOnly) ? 'shared' : 'leased';
  if (slot.backend === 'synapse' && typeof slot.sessionId === 'number') {
    void keepaliveLivySession(slot.poolName, slot.sessionId).catch(() => {});
  }
  // Reflect in the shared store: fromStore slots read-modify-write the doc; owner
  // slots republish (no-downgrade publish preserves any concurrent claim).
  if (slot.fromStore) void releaseInStore(slot.leaseId, slot.groupKey, leaseId, opts);
  else void publishWarmSlot(slot);
}

// ============================================================
// Pre-provision (POST warm)
// ============================================================

export interface WarmTarget {
  backend?: SparkPoolBackend;
  poolName?: string;
  kind?: LivyKind;
}

/**
 * Explicitly pre-provision a group to `min` (the POST warm action). Defaults to
 * the active backend's default Spark pool + pyspark + default sizing — the same
 * combination a plain notebook run uses — so warming here directly benefits the
 * next real run. Returns the resolved group + a snapshot of its counts.
 */
export async function warmPool(target?: WarmTarget): Promise<{ group: Omit<PoolGroup, 'sizing'>; status: GroupStatus | null }> {
  const gate = sparkPoolBackendStatus();
  const backend = target?.backend || gate.backend;
  const kind: LivyKind = target?.kind || 'pyspark';
  let poolName: string;
  let sizing: LivySessionSizing | undefined;
  let sizingKey: string;
  if (backend === 'databricks') {
    poolName = target?.poolName || process.env.LOOM_DATABRICKS_DEFAULT_CLUSTER || '';
    sizingKey = '';
  } else {
    poolName = target?.poolName || defaultSparkPool();
    const d = defaultSynapseSizing();
    sizing = d.sizing;
    sizingKey = d.sizingKey;
  }
  const key = groupKey(backend, poolName, kind, sizingKey);
  registerGroup({ key, backend, poolName, kind, sizingKey, sizing });
  ensureSweeper();
  await refillPool();
  const status = getPoolStatus();
  const grp = status.groups.find((x) => x.key === key) || null;
  return { group: { key, backend, poolName, kind, sizingKey }, status: grp };
}

// ============================================================
// Status
// ============================================================

export interface GroupStatus {
  key: string;
  backend: SparkPoolBackend;
  poolName: string;
  kind: LivyKind;
  sizingKey: string;
  warm: number;
  leased: number;
  /** Sessions serving one or more concurrent read-only leases (FGC-10 shared mode). */
  shared: number;
  /** Sessions still cold-starting (warming toward idle). */
  warming: number;
  /** Target warm count (config.min). */
  target: number;
  /** Circuit breaker — consecutive warm failures for this group (0 = healthy). */
  consecFails?: number;
  /** Epoch ms until which refill skips this group (absent = not backing off). */
  backoffUntil?: number;
  /** Last warm-failure reason (why the breaker armed). */
  lastFailure?: string;
  sessions: Array<{
    leaseId: string;
    state: SlotState;
    sessionId?: number;
    /** Active sub-leases on this session (>1 only in shared mode). */
    leaseCount: number;
    /** True when this session was claimed from another replica's warm pool. */
    fromStore?: boolean;
    ageSecs: number;
    idleSecs: number;
    error?: string;
  }>;
}

export interface PoolStatus {
  enabled: boolean;
  config: PoolConfig;
  backend: SparkBackendStatus;
  totals: { warm: number; leased: number; shared: number; warming: number };
  /** Cross-replica lease store mode + honest gate info (PSR-3). */
  store: LeaseStoreStatus;
  groups: GroupStatus[];
}

/** Snapshot of the pool for the BFF status endpoint + the editor indicator. */
export function getPoolStatus(): PoolStatus {
  const cfg = sparkPoolConfig();
  const backend = sparkPoolBackendStatus();
  pruneDead();
  const now = Date.now();
  const groups: GroupStatus[] = [];
  const totals = { warm: 0, leased: 0, shared: 0, warming: 0 };
  for (const grp of store.groups.values()) {
    const slots = slotsForGroup(grp.key);
    const warm = slots.filter((s) => s.state === 'warm').length;
    const leased = slots.filter((s) => s.state === 'leased').length;
    const shared = slots.filter((s) => s.state === 'shared').length;
    const warming = slots.filter((s) => s.state === 'warming').length;
    totals.warm += warm;
    totals.leased += leased;
    totals.shared += shared;
    totals.warming += warming;
    groups.push({
      key: grp.key,
      backend: grp.backend,
      poolName: grp.poolName,
      kind: grp.kind,
      sizingKey: grp.sizingKey,
      warm,
      leased,
      shared,
      warming,
      target: cfg.min,
      consecFails: grp.consecFails || undefined,
      backoffUntil: grp.backoffUntil && grp.backoffUntil > now ? grp.backoffUntil : undefined,
      lastFailure: grp.lastFailure,
      sessions: slots.map((s) => ({
        leaseId: s.leaseId,
        state: s.state,
        sessionId: s.sessionId,
        leaseCount: s.leases.length,
        fromStore: s.fromStore || undefined,
        ageSecs: Math.floor((now - s.createdAt) / 1000),
        idleSecs: Math.floor((now - s.lastActivityAt) / 1000),
        error: s.error,
      })),
    });
  }
  return { enabled: cfg.enabled, config: cfg, backend, totals, store: leaseStoreStatus(), groups };
}

// ============================================================
// Startup — arm the warm pool as soon as this replica loads the module
// ============================================================

// ACA scales the Console to zero; on the next request a FRESH replica loads this
// module with an empty in-memory pool and no running sweeper. Arm it at module
// load so the default group is pre-registered, store-persisted warm slots are
// adopted, the sweeper runs, and warming starts NOW — the FIRST user's FIRST run
// is warm instead of registering the group and cold-starting (R3). Guarded +
// best-effort: refill no-ops when the Spark backend isn't configured (e.g. build
// time), and any throw is swallowed so import never fails.
try {
  ensureWarmPoolStarted();
} catch {
  /* best-effort — the sweeper/config-apply path will arm it on first request */
}
