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
 *   LOOM_SPARK_POOL_ENABLED   "1"/"true" to enable (DEFAULT off → today's
 *                             cold-start behaviour is preserved out of the box).
 *   LOOM_SPARK_POOL_MIN       min warm sessions to keep per pool/kind/sizing
 *                             group (default 1).
 *   LOOM_SPARK_POOL_MAX       max total sessions per group (default 3).
 *   LOOM_SPARK_POOL_IDLE_TTL  seconds a warm-above-min session may sit idle
 *                             before eviction (default 900 = 15 min).
 * Admin can override any of these at runtime via the /api/spark/session-pool
 * POST config action (in-memory, per replica).
 *
 * No mocks: every warm/keepalive/evict call hits the REAL Synapse Livy REST
 * surface (createLivySessionAsync / getLivySession / keepaliveLivySession /
 * killLivySession) or the REAL Databricks clusters API (startCluster/getCluster)
 * per no-vaporware.md + no-fabric-dependency.md (Synapse is the default; the
 * Fabric backend is never on this path).
 *
 * Scope note: the pool is per-process (in-memory). On a multi-replica ACA app
 * each replica keeps its own warm pool — acceptable (each still warms REAL
 * sessions; the min is per replica). A shared cross-replica pool would need a
 * distributed lease store and is intentionally out of scope here.
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
  defaultSparkPool,
  type LivyKind,
} from '@/lib/azure/synapse-livy-client';
import { synapseLogAnalyticsConf } from '@/lib/spark/config-presets';

export type SparkPoolBackend = 'synapse' | 'databricks';
type SlotState = 'warming' | 'warm' | 'leased' | 'dead';

interface PooledSlot {
  /** Stable id for this slot — the lease handle returned to callers. */
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
  leasedBy?: string;
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
}

export interface PoolConfig {
  enabled: boolean;
  min: number;
  max: number;
  idleTtlMs: number;
}

interface PoolStore {
  slots: PooledSlot[];
  groups: Map<string, PoolGroup>;
  override: Partial<PoolConfig>;
  sweeper: ReturnType<typeof setInterval> | null;
  warming: number; // in-flight warm operations (concurrency guard)
}

// Singleton on globalThis so Next.js dev hot-reload / route re-eval keeps ONE
// pool per process instead of leaking a fresh pool (and orphaned Livy sessions)
// on every module reload.
const g = globalThis as unknown as { __loomSparkPool?: PoolStore };
const store: PoolStore =
  g.__loomSparkPool ??
  (g.__loomSparkPool = { slots: [], groups: new Map(), override: {}, sweeper: null, warming: 0 });

const SWEEP_INTERVAL_MS = 30_000;

// ============================================================
// Config
// ============================================================

function envBool(v: string | undefined): boolean {
  return v === '1' || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
}
function envInt(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Effective config: env baseline overlaid with the admin runtime override. */
export function sparkPoolConfig(): PoolConfig {
  const base: PoolConfig = {
    enabled: envBool(process.env.LOOM_SPARK_POOL_ENABLED),
    min: envInt(process.env.LOOM_SPARK_POOL_MIN, 1),
    max: envInt(process.env.LOOM_SPARK_POOL_MAX, 3),
    idleTtlMs: envInt(process.env.LOOM_SPARK_POOL_IDLE_TTL, 900) * 1000,
  };
  const o = store.override;
  const cfg: PoolConfig = {
    enabled: o.enabled ?? base.enabled,
    min: o.min ?? base.min,
    max: o.max ?? base.max,
    idleTtlMs: o.idleTtlMs ?? base.idleTtlMs,
  };
  // Keep max >= min so a group can always reach its target.
  if (cfg.max < cfg.min) cfg.max = cfg.min;
  return cfg;
}

export function sparkPoolEnabled(): boolean {
  return sparkPoolConfig().enabled;
}

/** Admin runtime override (per replica, in-memory). Returns the new config. */
export function setSparkPoolConfig(partial: Partial<PoolConfig>): PoolConfig {
  if (typeof partial.enabled === 'boolean') store.override.enabled = partial.enabled;
  if (typeof partial.min === 'number' && partial.min >= 0) store.override.min = Math.floor(partial.min);
  if (typeof partial.max === 'number' && partial.max >= 0) store.override.max = Math.floor(partial.max);
  if (typeof partial.idleTtlMs === 'number' && partial.idleTtlMs >= 0) store.override.idleTtlMs = Math.floor(partial.idleTtlMs);
  const cfg = sparkPoolConfig();
  if (cfg.enabled) ensureSweeper();
  return cfg;
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
 * NO custom session config. Mirrors app/api/items/notebook/[id]/run: sizing is
 * `undefined` (sizingKey '') when Log-Analytics diagnostics are off, or
 * `{ conf: <LA conf> }` when they are on. Kept 1:1 with the run route so a warm
 * session's sizingKey matches a default run and the hand-off actually hits.
 */
export function defaultSynapseSizing(): { sizing?: LivySessionSizing; sizingKey: string } {
  const laConf = synapseLogAnalyticsConf();
  const sizing: LivySessionSizing | undefined = Object.keys(laConf).length ? { conf: laConf } : undefined;
  const sizingKey = sizing ? JSON.stringify(sizing) : '';
  return { sizing, sizingKey };
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
  if (existing) return existing;
  store.groups.set(g.key, g);
  return g;
}

// ============================================================
// Warm one session (REAL backend calls)
// ============================================================

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

async function pollLivyToIdle(poolName: string, sessionId: number, slot: PooledSlot): Promise<void> {
  // Cold start of a Synapse Spark pool can take 2-4 min. Poll in the
  // background; the slot stays 'warming' until Livy reports 'idle'.
  for (let i = 0; i < 90; i++) {
    let state = 'starting';
    try {
      const live = await getLivySession(poolName, sessionId);
      state = live.state;
    } catch {
      slot.state = 'dead';
      slot.error = 'session unreachable while warming';
      return;
    }
    if (state === 'idle') {
      // A lease may have raced in and grabbed this slot the instant it warmed;
      // only promote to 'warm' if it is still warming.
      if (slot.state === 'warming') {
        slot.state = 'warm';
        slot.warmedAt = Date.now();
        slot.lastActivityAt = Date.now();
      }
      return;
    }
    if (['error', 'dead', 'killed', 'shutting_down'].includes(state)) {
      slot.state = 'dead';
      slot.error = `session entered terminal state '${state}' while warming`;
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  slot.state = 'dead';
  slot.error = 'session did not reach idle within warm timeout';
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
  };
  store.slots.push(slot);
  store.warming++;
  try {
    const sess = await createLivySessionAsync(grp.poolName, grp.kind, `loom-warmpool-${Date.now()}`, grp.sizing);
    slot.sessionId = sess.id;
    slot.request = sess.request;
    await pollLivyToIdle(grp.poolName, sess.id, slot);
  } catch (e: unknown) {
    slot.state = 'dead';
    slot.error = e instanceof Error ? e.message : String(e);
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
        }
        return;
      }
      if (['TERMINATED', 'ERROR', 'UNKNOWN'].includes(st)) {
        slot.state = 'dead';
        slot.error = `cluster entered '${st}' while warming`;
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    slot.state = 'dead';
    slot.error = 'cluster did not reach RUNNING within warm timeout';
  } catch (e: unknown) {
    slot.state = 'dead';
    slot.error = e instanceof Error ? e.message : String(e);
  } finally {
    store.warming--;
  }
}

async function warmOne(grp: PoolGroup): Promise<void> {
  if (grp.backend === 'databricks') return warmOneDatabricks(grp);
  return warmOneSynapse(grp);
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
  for (const grp of store.groups.values()) {
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
  if (slot.backend === 'synapse' && typeof slot.sessionId === 'number') {
    void killLivySession(slot.poolName, slot.sessionId).catch(() => {});
  }
  // Databricks cluster warmth is shared infra — never terminate it here.
}

function pruneDead(): void {
  store.slots = store.slots.filter((s) => s.state !== 'dead');
}

/**
 * Periodic maintenance: prune dead slots, keepalive warm Synapse sessions
 * (reset their Livy idle clock so they survive between runs), evict warm slots
 * that have sat idle past the TTL beyond `min`, then refill to `min`.
 */
async function sweep(): Promise<void> {
  const cfg = sparkPoolConfig();
  pruneDead();
  if (!cfg.enabled) return;
  const now = Date.now();
  for (const grp of store.groups.values()) {
    const warm = slotsForGroup(grp.key).filter((s) => s.state === 'warm');
    // Keepalive every warm Synapse session so Livy's own idle timeout doesn't
    // reap it while it waits to be leased.
    for (const s of warm) {
      if (s.backend === 'synapse' && typeof s.sessionId === 'number') {
        void keepaliveLivySession(s.poolName, s.sessionId).catch(() => {});
      }
    }
    // Evict warm-above-min sessions idle past the TTL (oldest-idle first).
    const overMin = warm
      .filter((s) => now - s.lastActivityAt > cfg.idleTtlMs)
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    const evictable = Math.max(0, warm.length - cfg.min);
    for (let i = 0; i < Math.min(evictable, overMin.length); i++) evictSlot(overMin[i]);
  }
  pruneDead();
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
  /** Acting user's oid — stamped on the lease (never share across users). */
  userOid?: string;
}

export interface Lease {
  leaseId: string;
  backend: SparkPoolBackend;
  poolName: string;
  sessionId?: number;
  sizingKey: string;
  request?: Record<string, unknown>;
}

/**
 * Atomically hand off ONE warm session matching (backend, pool, kind, sizing).
 * Flips it to `leased` (stamped with the caller's oid) and kicks a background
 * refill to replace it. Returns null on a miss — the caller then cold-starts,
 * so the pool is a pure accelerator, never a dependency. For Synapse a live
 * liveness check (getLivySession) guards against handing off a session Livy
 * reaped out from under the pool.
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
    if (slot.backend === 'synapse') {
      if (typeof slot.sessionId !== 'number') { slot.state = 'dead'; continue; }
      try {
        const live = await getLivySession(slot.poolName, slot.sessionId);
        if (!['idle', 'busy'].includes(live.state)) { slot.state = 'dead'; continue; }
      } catch {
        slot.state = 'dead';
        continue;
      }
    }
    // A concurrent acquire may have flipped it while we awaited the liveness
    // probe — re-check under the (single-threaded) sync flip.
    if (slot.state !== 'warm') continue;
    slot.state = 'leased';
    slot.leasedBy = req.userOid;
    slot.lastActivityAt = Date.now();
    // Replace the drained slot in the background.
    void refillPool().catch(() => {});
    pruneDead();
    return {
      leaseId: slot.leaseId,
      backend: slot.backend,
      poolName: slot.poolName,
      sessionId: slot.sessionId,
      sizingKey: slot.sizingKey,
      request: slot.request,
    };
  }

  pruneDead();
  // Miss — warm up for next time, then let the caller cold-start.
  void refillPool().catch(() => {});
  return null;
}

/**
 * Return a leased slot. By default it goes back to `warm` (idle clock reset via
 * Livy keepalive) so it can be re-leased. `{ dead:true }` evicts it (used when
 * the notebook's session died / was recreated). Unknown leaseIds are ignored.
 */
export function releaseSession(leaseId: string, opts?: { dead?: boolean }): void {
  const slot = store.slots.find((s) => s.leaseId === leaseId);
  if (!slot) return;
  if (opts?.dead) {
    evictSlot(slot);
    pruneDead();
    return;
  }
  slot.state = 'warm';
  slot.leasedBy = undefined;
  slot.lastActivityAt = Date.now();
  if (slot.backend === 'synapse' && typeof slot.sessionId === 'number') {
    void keepaliveLivySession(slot.poolName, slot.sessionId).catch(() => {});
  }
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
  /** Sessions still cold-starting (warming toward idle). */
  warming: number;
  /** Target warm count (config.min). */
  target: number;
  sessions: Array<{
    leaseId: string;
    state: SlotState;
    sessionId?: number;
    ageSecs: number;
    idleSecs: number;
    error?: string;
  }>;
}

export interface PoolStatus {
  enabled: boolean;
  config: PoolConfig;
  backend: SparkBackendStatus;
  totals: { warm: number; leased: number; warming: number };
  groups: GroupStatus[];
}

/** Snapshot of the pool for the BFF status endpoint + the editor indicator. */
export function getPoolStatus(): PoolStatus {
  const cfg = sparkPoolConfig();
  const backend = sparkPoolBackendStatus();
  pruneDead();
  const now = Date.now();
  const groups: GroupStatus[] = [];
  const totals = { warm: 0, leased: 0, warming: 0 };
  for (const grp of store.groups.values()) {
    const slots = slotsForGroup(grp.key);
    const warm = slots.filter((s) => s.state === 'warm').length;
    const leased = slots.filter((s) => s.state === 'leased').length;
    const warming = slots.filter((s) => s.state === 'warming').length;
    totals.warm += warm;
    totals.leased += leased;
    totals.warming += warming;
    groups.push({
      key: grp.key,
      backend: grp.backend,
      poolName: grp.poolName,
      kind: grp.kind,
      sizingKey: grp.sizingKey,
      warm,
      leased,
      warming,
      target: cfg.min,
      sessions: slots.map((s) => ({
        leaseId: s.leaseId,
        state: s.state,
        sessionId: s.sessionId,
        ageSecs: Math.floor((now - s.createdAt) / 1000),
        idleSecs: Math.floor((now - s.lastActivityAt) / 1000),
        error: s.error,
      })),
    });
  }
  return { enabled: cfg.enabled, config: cfg, backend, totals, groups };
}
