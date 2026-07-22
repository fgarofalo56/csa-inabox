/**
 * A10 — Spark pool health aggregation (loom-next-level, Spark reliability).
 *
 * PURE mapping shared by the admin BFF route (/api/admin/spark/health) and the
 * Health & Reliability hub's "Spark pools" pane. No Azure calls here — the
 * route reads the REAL clients (spark-session-pool getPoolStatus, ARM
 * listSparkPools, Livy listLivySessions) and this module classifies what came
 * back:
 *
 *   • Pool health state — incl. FAULTED detection. Two flavors, both from real
 *     incidents (memory 2026-07-12 / 2026-07-14): an ARM provisioningState of
 *     Failed/Canceled ("hard" fault), and the sneakier "Succeeded but can't
 *     launch" runtime fault, which we surface as `suspect` whenever the warm
 *     pool's circuit breaker is armed against the pool (consecutive warm
 *     failures / backoff / a recorded failure reason).
 *   • Leaked-session candidates — live Livy sessions the pool does NOT track
 *     that sit in a capacity-holding state (idle / not_started / starting /
 *     recovering — the #1796 + 2026-07-14 leak classes), plus the pool-owned
 *     busy-zombie flavor (a `loom-warmpool-*` session stuck `busy`).
 *   • Quota/capacity — max vCores per pool from node size × max node count
 *     (the standard Synapse memory-optimized vCore ladder).
 *
 * Type-only imports keep this module client-safe (vitest'able with no Azure
 * SDK loading).
 */

import type { PoolStatus, GroupStatus } from '@/lib/azure/spark-session-pool';
import type { SparkPool } from '@/lib/azure/synapse-dev-client';
import type { LivySession } from '@/lib/azure/synapse-livy-client';

// ── Pool health state ──────────────────────────────────────────────────────

export type PoolHealthState =
  | 'ready'
  | 'faulted'
  | 'suspect'
  | 'provisioning'
  | 'deleting'
  | 'unknown';

/** True when the warm pool's per-group circuit breaker is armed for this group. */
export function breakerArmed(g: Pick<GroupStatus, 'consecFails' | 'backoffUntil' | 'lastFailure'>): boolean {
  return Boolean((g.consecFails && g.consecFails > 0) || g.backoffUntil || g.lastFailure);
}

/**
 * Classify a pool's health from its ARM provisioningState + the warm-pool
 * groups that target it. `suspect` = ARM says Succeeded but the breaker is
 * armed — the "Succeeded but can't launch" fault class (2026-07-12 FAULTED
 * incident + the 2026-07-14 name-wedge): ARM alone cannot see it, session
 * launch failures can.
 */
export function poolHealthState(
  provisioningState: string | undefined,
  groupsForPool: Array<Pick<GroupStatus, 'consecFails' | 'backoffUntil' | 'lastFailure'>> = [],
): PoolHealthState {
  const ps = String(provisioningState || '').toLowerCase();
  if (/fail|fault|cancel/.test(ps)) return 'faulted';
  if (/delet/.test(ps)) return 'deleting';
  if (/provision|creat|updat|scal|pausing|resum/.test(ps)) return 'provisioning';
  if (ps === 'succeeded') {
    return groupsForPool.some(breakerArmed) ? 'suspect' : 'ready';
  }
  return 'unknown';
}

// ── Capacity / quota ───────────────────────────────────────────────────────

/** Synapse Spark vCores per node by node size (memory-optimized family). */
export const NODE_SIZE_VCORES: Record<string, number> = {
  Small: 4,
  Medium: 8,
  Large: 16,
  XLarge: 32,
  XXLarge: 64,
};

/** Max node count a pool can reach (autoscale max, else fixed nodeCount). */
export function poolMaxNodes(p: Pick<SparkPool['properties'], 'nodeCount' | 'autoScale'>): number {
  if (p.autoScale?.enabled) return p.autoScale.maxNodeCount || 0;
  return p.nodeCount || 0;
}

/** Max vCores the pool can consume of the workspace quota (0 = unknown size). */
export function poolMaxVCores(p: Pick<SparkPool['properties'], 'nodeCount' | 'autoScale' | 'nodeSize'>): number {
  const perNode = NODE_SIZE_VCORES[String(p.nodeSize || '')] || 0;
  return perNode * poolMaxNodes(p);
}

// ── Livy session classification (leak candidates) ──────────────────────────

/**
 * Livy states that hold pool capacity and are the leak classes the reaper
 * targets (#1796 idle leak; 2026-07-14 queued-zombie leak). Mirror of the
 * reaper's isReapableState — kept here so the dashboard and the reaper agree
 * on what "capacity-holding" means without exporting pool internals.
 */
export function isCapacityHoldingState(state: string): boolean {
  const s = String(state).toLowerCase();
  return s === 'idle' || s === 'not_started' || s === 'starting' || s === 'recovering';
}

/** Pool-owned warm-pool session name (busy-zombie rule scope). */
export function isPoolOwnedSessionName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.startsWith('loom-warmpool-');
}

export interface SessionHealthRow {
  id: number;
  name: string;
  state: string;
  /** Tracked by the warm pool (a slot or cross-replica lease) on this replica. */
  tracked: boolean;
  /** Untracked + capacity-holding — a reaper-eligible leak candidate. */
  leakSuspect: boolean;
  /** Pool-owned session stuck busy (the 2026-07-14 80-core zombie class). */
  busyZombieSuspect: boolean;
  appId?: string;
  /** Age/idle seconds (known only for pool-tracked sessions). */
  ageSecs?: number;
  idleSecs?: number;
  error?: string;
}

/** Summarize a Livy session's errorInfo ('' when none). */
function errorDetail(sess: Pick<LivySession, 'errorInfo'>): string {
  return (sess.errorInfo || [])
    .map((e) => e?.message || e?.errorCode || '')
    .filter(Boolean)
    .join('; ');
}

/**
 * Classify a pool's live Livy sessions against the warm pool's tracked view.
 * `tracked` sessions carry their pool-side age/idle; untracked ones are
 * classified for leak candidacy exactly the way the reaper does.
 */
export function classifyLiveSessions(
  live: LivySession[],
  poolGroups: Array<Pick<GroupStatus, 'sessions'>>,
): SessionHealthRow[] {
  const trackedById = new Map<number, { ageSecs: number; idleSecs: number }>();
  for (const g of poolGroups) {
    for (const s of g.sessions) {
      if (typeof s.sessionId === 'number') {
        trackedById.set(s.sessionId, { ageSecs: s.ageSecs, idleSecs: s.idleSecs });
      }
    }
  }
  return live
    .filter((s): s is LivySession & { id: number } => typeof s.id === 'number')
    .map((s) => {
      const tracked = trackedById.has(s.id);
      const busyZombieSuspect =
        !tracked && String(s.state).toLowerCase() === 'busy' && isPoolOwnedSessionName(s.name);
      const leakSuspect = !tracked && (isCapacityHoldingState(s.state) || busyZombieSuspect);
      const meta = trackedById.get(s.id);
      const err = errorDetail(s);
      return {
        id: s.id,
        name: s.name || '',
        state: String(s.state || ''),
        tracked,
        leakSuspect,
        busyZombieSuspect,
        appId: s.appId || undefined,
        ageSecs: meta?.ageSecs,
        idleSecs: meta?.idleSecs,
        error: err || undefined,
      };
    });
}

// ── The aggregated per-pool view ───────────────────────────────────────────

export interface PoolHealthSummary {
  name: string;
  healthState: PoolHealthState;
  provisioningState: string;
  nodeSize: string;
  sparkVersion: string;
  autoScale?: { enabled: boolean; min: number; max: number };
  autoPauseMinutes?: number;
  maxNodes: number;
  maxVCores: number;
  /** Warm-pool groups targeting this pool (counts + breaker). */
  warm: number;
  leased: number;
  shared: number;
  warming: number;
  breakerArmed: boolean;
  lastFailure?: string;
  backoffUntil?: number;
  /** Live Livy census (absent when the Livy list failed / wasn't probed). */
  sessions?: SessionHealthRow[];
  liveTotal?: number;
  leakSuspects?: number;
  sessionsError?: string;
}

/**
 * Join one ARM pool + the warm-pool groups that target it + its live Livy
 * census into the dashboard row. Pure — the route supplies the real data.
 */
export function summarizePool(
  arm: SparkPool,
  allGroups: GroupStatus[],
  live?: { sessions?: LivySession[]; error?: string },
): PoolHealthSummary {
  const groups = allGroups.filter((g) => g.poolName === arm.name);
  const p = arm.properties || {};
  const rows = live?.sessions ? classifyLiveSessions(live.sessions, groups) : undefined;
  const lastFailure = groups.map((g) => g.lastFailure).filter(Boolean)[0];
  const backoffUntil = groups.map((g) => g.backoffUntil).filter(Boolean)[0];
  return {
    name: arm.name,
    healthState: poolHealthState(p.provisioningState, groups),
    provisioningState: String(p.provisioningState || ''),
    nodeSize: String(p.nodeSize || ''),
    sparkVersion: String(p.sparkVersion || ''),
    autoScale: p.autoScale
      ? { enabled: p.autoScale.enabled, min: p.autoScale.minNodeCount, max: p.autoScale.maxNodeCount }
      : undefined,
    autoPauseMinutes: p.autoPause?.enabled ? p.autoPause.delayInMinutes : undefined,
    maxNodes: poolMaxNodes(p),
    maxVCores: poolMaxVCores(p),
    warm: groups.reduce((n, g) => n + g.warm, 0),
    leased: groups.reduce((n, g) => n + g.leased, 0),
    shared: groups.reduce((n, g) => n + g.shared, 0),
    warming: groups.reduce((n, g) => n + g.warming, 0),
    breakerArmed: groups.some(breakerArmed),
    lastFailure,
    backoffUntil,
    sessions: rows,
    liveTotal: rows?.length,
    leakSuspects: rows ? rows.filter((r) => r.leakSuspect).length : undefined,
    sessionsError: live?.error,
  };
}

/** The full BFF payload the pane renders (route assembles, pane consumes). */
export interface SparkHealthPayload {
  generatedAt: string;
  backend: { backend: string; configured: boolean; missing?: string };
  /** Warm-pool snapshot: totals + config + cross-replica store mode. */
  pool: Pick<PoolStatus, 'enabled' | 'totals' | 'groups'> & {
    store: { mode: string; container?: string; replicaId?: string };
    config: { min: number; max: number; idleTtlMs: number; reapEnabled: boolean; reapGraceMs: number };
  };
  /** Warm-acquire counters (hit = a run adopted a warm session). */
  counters: { hits: number; misses: number; total: number; missRate: number; hitAcquireP50Ms: number | null };
  /** ARM pools joined with groups + live census (synapse backend only). */
  pools: PoolHealthSummary[];
  /** Honest per-source errors (ARM list failed etc.) — never silent. */
  armError?: string;
  /** Databricks backend: ARM pool census is n/a — pool snapshot only. */
  note?: string;
}
