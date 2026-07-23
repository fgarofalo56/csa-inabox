/**
 * A11 — FAULTED Spark-pool detection + auto-recovery.
 *
 * A Synapse Spark Big Data pool can enter two failure classes (both seen live —
 * memory 2026-07-12 / 2026-07-14):
 *   • HARD fault  — ARM provisioningState is Failed / Canceled.
 *   • "Succeeded but can't launch" — ARM reports Succeeded yet no Spark
 *     application will start; the warm pool sees it as repeated session-create
 *     failures and ARMS its per-group circuit breaker. `poolHealthState()`
 *     classifies this as `suspect` — a fault ARM alone cannot see.
 *
 * The ONLY reliable fix for either is delete + recreate the pool (and, if
 * sessions still wedge, a new pool NAME — that stays a manual runbook step). This
 * module automates the delete+recreate on the Azure-native Synapse control plane
 * (synapse-dev-client ARM bigDataPools), driven by the keep-warm heartbeat so it
 * works on serverless ACA where the in-process sweeper is unreliable.
 *
 * Safety:
 *   • THRASH GUARD — a per-pool sliding window caps recreate attempts
 *     (LOOM_SPARK_RECOVER_MAX_ATTEMPTS, default 3, in a 6h window) so a
 *     genuinely-broken pool backs off instead of delete/recreate-looping.
 *   • IN-FLIGHT LOCK — one recreate per pool at a time (a concurrent heartbeat
 *     never double-deletes).
 *   • EXPONENTIAL BACKOFF on transient recreate errors.
 *   • OPERATOR ALERT — every recreate (success OR failure) fires the unified
 *     dispatchAlert (O1 shared action group) + an in-product notification.
 *
 * Default-ON / opt-out (loom_default_on_opt_out): LOOM_SPARK_AUTORECOVER_ENABLED
 * unset = on; set to 0/false (or flip the a11-spark-autorecover runtime flag) to
 * keep detection + alerting but require the manual /admin/health "Recreate pool"
 * action.
 *
 * DEPENDENCY INJECTION: every Azure boundary is an injectable dep so the vitest
 * drill exercises the REAL detect/backoff/thrash/alert logic against stubs — no
 * live Azure in unit tests (no-vaporware: production uses the real clients).
 *
 * Per-cloud: Synapse bigDataPools ARM is GA Commercial + Gov (GCC-High) + IL5;
 * only the ARM host differs (handled by cloud-endpoints in synapse-dev-client).
 * IL5 note: same UAMI ARM path; the O1 action group is fully in-boundary.
 */

import {
  listSparkPools as realListSparkPools,
  getSparkPool as realGetSparkPool,
  deleteSparkPool as realDeleteSparkPool,
  upsertSparkPool as realUpsertSparkPool,
  type SparkPool,
} from '@/lib/azure/synapse-dev-client';
import {
  getPoolStatus as realGetPoolStatus,
  sparkPoolBackendStatus as realBackendStatus,
  type PoolStatus,
} from '@/lib/azure/spark-session-pool';
import { poolHealthState, type PoolHealthState } from '@/lib/admin/spark-health';
import { dispatchAlert as realDispatchAlert, type AlertInput } from '@/lib/azure/alert-dispatch';

// ── Config ──────────────────────────────────────────────────────────────────

export interface SparkAutoRecoverConfig {
  enabled: boolean;
  /** Max recreate attempts per pool within THRASH_WINDOW_MS. */
  maxAttempts: number;
}

/** Rolling window the thrash guard counts recreate attempts over. */
export const THRASH_WINDOW_MS = 6 * 60 * 60_000; // 6h

function envBoolDefaultOn(v: string | undefined): boolean {
  if (typeof v !== 'string') return true;
  const t = v.trim().toLowerCase();
  return !(t === '0' || t === 'false' || t === 'off' || t === 'no');
}
function envInt(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

export function sparkAutoRecoverConfig(): SparkAutoRecoverConfig {
  return {
    enabled: envBoolDefaultOn(process.env.LOOM_SPARK_AUTORECOVER_ENABLED),
    maxAttempts: Math.max(1, envInt(process.env.LOOM_SPARK_RECOVER_MAX_ATTEMPTS, 3)),
  };
}

// ── Injectable deps (real clients by default) ───────────────────────────────

export interface RecoverDeps {
  listSparkPools: () => Promise<SparkPool[]>;
  getSparkPool: (name: string) => Promise<SparkPool>;
  deleteSparkPool: (name: string) => Promise<void>;
  upsertSparkPool: (name: string, spec: Partial<SparkPool>) => Promise<SparkPool>;
  getPoolStatus: () => PoolStatus;
  backendStatus: () => { backend: string; configured: boolean; missing?: string };
  dispatchAlert: (input: AlertInput) => Promise<unknown>;
  notify: (title: string, body: string, severity: 'warning' | 'error') => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** Write an in-product admin notification (best-effort; honest skip when there
 * is no admin oid to key it to — dispatchAlert remains the primary channel). */
async function defaultNotify(title: string, body: string, severity: 'warning' | 'error'): Promise<void> {
  const adminOid = (process.env.LOOM_TENANT_ADMIN_OID || '').trim();
  if (!adminOid) return; // no in-app recipient; the alert leg still fires
  try {
    const { notificationsContainer } = await import('@/lib/azure/cosmos-client');
    const c = await notificationsContainer();
    await c.items.create({
      id: `spark-autorecover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId: adminOid,
      title,
      body,
      severity,
      link: '/admin/health?tab=spark',
      read: false,
      createdAt: new Date().toISOString(),
    });
  } catch {
    /* best-effort — the dispatchAlert leg is the durable operator channel */
  }
}

export function defaultRecoverDeps(): RecoverDeps {
  return {
    listSparkPools: realListSparkPools,
    getSparkPool: realGetSparkPool,
    deleteSparkPool: realDeleteSparkPool,
    upsertSparkPool: realUpsertSparkPool,
    getPoolStatus: realGetPoolStatus,
    backendStatus: realBackendStatus,
    dispatchAlert: realDispatchAlert,
    notify: defaultNotify,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

// ── Thrash-guard state (per replica, on globalThis so hot-reload keeps one) ──

interface RecoverState {
  /** poolName → recreate-attempt epoch-ms timestamps (pruned to the window). */
  attempts: Map<string, number[]>;
  /** Pools with an in-flight recreate (the concurrency lock). */
  inFlight: Set<string>;
}
const g = globalThis as unknown as { __loomSparkRecover?: RecoverState };
const rstate: RecoverState =
  g.__loomSparkRecover ?? (g.__loomSparkRecover = { attempts: new Map(), inFlight: new Set() });

/** Recreate attempts for a pool still inside the thrash window (prunes older). */
export function recentAttempts(poolName: string, now = Date.now()): number[] {
  const arr = (rstate.attempts.get(poolName) || []).filter((t) => now - t < THRASH_WINDOW_MS);
  rstate.attempts.set(poolName, arr);
  return arr;
}

/** True when the pool has hit its recreate ceiling for the current window. */
export function thrashGuardTripped(poolName: string, maxAttempts: number, now = Date.now()): boolean {
  return recentAttempts(poolName, now).length >= maxAttempts;
}

/** TEST-ONLY: clear the thrash/in-flight state between drills. */
export function __resetRecoverState(): void {
  rstate.attempts.clear();
  rstate.inFlight.clear();
}

// ── Detection ───────────────────────────────────────────────────────────────

export interface FaultedPool {
  name: string;
  /** 'faulted' (hard ARM fault) or 'suspect' (Succeeded but breaker armed). */
  healthState: Extract<PoolHealthState, 'faulted' | 'suspect'>;
  provisioningState: string;
  lastFailure?: string;
}

export interface DetectResult {
  scanned: number;
  pools: FaultedPool[];
  /** Honest error when the ARM census could not be read (no silent empty). */
  error?: string;
}

/**
 * Enumerate the workspace's Spark pools and classify each against the warm
 * pool's circuit-breaker state. Returns the FAULTED (hard ARM fault) and SUSPECT
 * (Succeeded-but-can't-launch) pools — the recovery targets. Best-effort on the
 * ARM read: a list failure returns an honest `error`, never a fabricated empty.
 */
export async function detectFaultedPools(deps: RecoverDeps): Promise<DetectResult> {
  let arm: SparkPool[];
  try {
    arm = await deps.listSparkPools();
  } catch (e) {
    return { scanned: 0, pools: [], error: e instanceof Error ? e.message : String(e) };
  }
  const groups = deps.getPoolStatus().groups;
  const pools: FaultedPool[] = [];
  for (const p of arm) {
    const forPool = groups.filter((x) => x.poolName === p.name);
    const state = poolHealthState(p.properties?.provisioningState, forPool);
    if (state === 'faulted' || state === 'suspect') {
      pools.push({
        name: p.name,
        healthState: state,
        provisioningState: String(p.properties?.provisioningState || ''),
        lastFailure: forPool.map((x) => x.lastFailure).filter(Boolean)[0],
      });
    }
  }
  return { scanned: arm.length, pools };
}

// ── Recreate (delete + recreate one pool) ───────────────────────────────────

export interface RecreateResult {
  ok: boolean;
  poolName: string;
  action: 'recreated' | 'skipped' | 'error';
  reason?: string;
  /** Recreate attempts recorded in the current window (incl. this one). */
  attempts: number;
  provisioningState?: string;
  durationMs?: number;
}

/** Output-only ARM fields we must NOT echo back on the recreate PUT. */
function specFromExisting(existing: SparkPool): Partial<SparkPool> {
  const props = { ...(existing.properties || {}) };
  delete (props as Record<string, unknown>).provisioningState;
  delete (props as Record<string, unknown>).creationDate;
  return { location: existing.location, properties: props };
}

function looksGone(msg: string): boolean {
  return /\b404\b|NotFound|could not be found|ResourceNotFound/i.test(msg);
}
function isTerminalProvisioning(state: string): boolean {
  return /succeeded|failed|cancell?ed/i.test(state);
}

/** Poll the pool until ARM stops returning it (delete committed) or a cap. */
async function pollDeleted(poolName: string, deps: RecoverDeps): Promise<void> {
  const deadline = deps.now() + 5 * 60_000;
  let delay = 4000;
  while (deps.now() < deadline) {
    try {
      await deps.getSparkPool(poolName);
    } catch (e) {
      if (looksGone(e instanceof Error ? e.message : String(e))) return;
    }
    await deps.sleep(delay);
    delay = Math.min(Math.floor(delay * 1.5), 15000);
  }
  // Couldn't confirm deletion — the recreate PUT is idempotent, so proceed.
}

/** Poll the pool to a terminal provisioningState after the recreate PUT. */
async function pollProvisioned(poolName: string, deps: RecoverDeps): Promise<string> {
  const deadline = deps.now() + 10 * 60_000;
  let delay = 5000;
  let last = '';
  while (deps.now() < deadline) {
    try {
      const p = await deps.getSparkPool(poolName);
      last = String(p.properties?.provisioningState || '');
      if (isTerminalProvisioning(last)) return last;
    } catch {
      /* transient during provisioning — keep polling */
    }
    await deps.sleep(delay);
    delay = Math.min(Math.floor(delay * 1.5), 20000);
  }
  return last || 'Unknown';
}

/**
 * Delete + recreate one Spark pool identically (same location + node spec).
 * Honors the thrash guard + in-flight lock unless `force` (the manual operator
 * action). Returns a structured result; never throws.
 */
export async function recreateSparkPool(
  poolName: string,
  opts: { force?: boolean; deps?: RecoverDeps } = {},
): Promise<RecreateResult> {
  const deps = opts.deps ?? defaultRecoverDeps();
  const cfg = sparkAutoRecoverConfig();
  const now = deps.now();

  if (rstate.inFlight.has(poolName)) {
    return {
      ok: false, poolName, action: 'skipped',
      reason: 'a recreate is already in flight for this pool',
      attempts: recentAttempts(poolName, now).length,
    };
  }
  if (!opts.force && thrashGuardTripped(poolName, cfg.maxAttempts, now)) {
    return {
      ok: false, poolName, action: 'skipped',
      reason: `thrash guard: ${cfg.maxAttempts} recreate attempts within the last ${Math.round(THRASH_WINDOW_MS / 3_600_000)}h — backing off`,
      attempts: recentAttempts(poolName, now).length,
    };
  }

  rstate.inFlight.add(poolName);
  const attempts = recentAttempts(poolName, now);
  attempts.push(now);
  rstate.attempts.set(poolName, attempts);
  const t0 = now;

  try {
    // 1) Capture the spec so we recreate the pool identically.
    const existing = await deps.getSparkPool(poolName);
    const spec = specFromExisting(existing);

    // 2) Delete + confirm gone.
    await deps.deleteSparkPool(poolName);
    await pollDeleted(poolName, deps);

    // 3) Recreate with exponential backoff on transient failures.
    let delay = 5000;
    let created = false;
    let lastErr = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await deps.upsertSparkPool(poolName, spec);
        created = true;
        break;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        if (attempt === 4) break;
        await deps.sleep(delay);
        delay = Math.min(delay * 2, 60_000);
      }
    }
    if (!created) {
      return {
        ok: false, poolName, action: 'error',
        reason: `recreate PUT failed after retries: ${lastErr}`,
        attempts: attempts.length, durationMs: deps.now() - t0,
      };
    }

    // 4) Poll to a terminal provisioningState.
    const ps = await pollProvisioned(poolName, deps);
    const ok = /succeeded/i.test(ps);
    return {
      ok, poolName, action: ok ? 'recreated' : 'error',
      reason: ok ? undefined : `pool provisioning ended in '${ps}'`,
      attempts: attempts.length, provisioningState: ps, durationMs: deps.now() - t0,
    };
  } catch (e) {
    return {
      ok: false, poolName, action: 'error',
      reason: e instanceof Error ? e.message : String(e),
      attempts: attempts.length, durationMs: deps.now() - t0,
    };
  } finally {
    rstate.inFlight.delete(poolName);
  }
}

// ── Alerting (unified dispatchAlert + in-product notification) ───────────────

async function alertRecreate(pool: FaultedPool, res: RecreateResult, deps: RecoverDeps): Promise<void> {
  const success = res.ok && res.action === 'recreated';
  // Success is informational (P3 = email band only); a failed recovery pages (P1).
  const severity: AlertInput['severity'] = success ? 'P3' : 'P1';
  const title = success
    ? `Spark pool ${pool.name} auto-recreated (was ${pool.healthState})`
    : `Spark pool ${pool.name} auto-recovery FAILED (${pool.healthState})`;
  const body = success
    ? `The FAULTED/suspect Spark pool "${pool.name}" (${pool.provisioningState || 'n/a'}${pool.lastFailure ? `; last failure: ${pool.lastFailure}` : ''}) was automatically delete+recreated and is now ${res.provisioningState || 'provisioned'} (attempt ${res.attempts}, ${Math.round((res.durationMs || 0) / 1000)}s). Notebook runs should attach to a healthy pool again.`
    : `Auto-recovery of Spark pool "${pool.name}" did not succeed: ${res.reason || 'unknown'}. Attempt ${res.attempts} of the thrash window. Follow the spark-pools runbook (delete + recreate, and if sessions still wedge, a NEW pool name).`;
  await deps.dispatchAlert({ source: 'spark-autorecover', severity, title, body, dedupKey: `spark-autorecover:${pool.name}` }).catch(() => {});
  await deps.notify(title, body, success ? 'warning' : 'error').catch(() => {});
}

// ── Auto-recover tick (driven by the keep-warm heartbeat) ────────────────────

export interface AutoRecoverOutcome {
  enabled: boolean;
  scanned: number;
  faulted: string[];
  recovered: string[];
  skipped: Array<{ pool: string; reason: string }>;
  errors: Array<{ pool: string; reason: string }>;
  /** Honest note when nothing ran (disabled / wrong backend / ARM read failed). */
  note?: string;
}

/**
 * One auto-recovery pass: detect FAULTED/suspect pools and delete+recreate each
 * (thrash-guarded), alerting on every recreate. No-op when disabled, on a
 * non-Synapse backend, or when the Spark backend isn't configured. Best-effort
 * and never throws — a recovery hiccup must not fail the keep-warm heartbeat.
 */
export async function autoRecoverTick(deps: RecoverDeps = defaultRecoverDeps()): Promise<AutoRecoverOutcome> {
  const cfg = sparkAutoRecoverConfig();
  const out: AutoRecoverOutcome = {
    enabled: cfg.enabled, scanned: 0, faulted: [], recovered: [], skipped: [], errors: [],
  };
  if (!cfg.enabled) { out.note = 'auto-recovery disabled (LOOM_SPARK_AUTORECOVER_ENABLED=0)'; return out; }

  const backend = deps.backendStatus();
  if (backend.backend !== 'synapse') { out.note = `auto-recovery is Synapse-only (backend=${backend.backend})`; return out; }
  if (!backend.configured) { out.note = `Spark backend not configured — ${backend.missing || 'set the Synapse env'}`; return out; }

  const detected = await detectFaultedPools(deps);
  out.scanned = detected.scanned;
  if (detected.error) { out.note = `ARM pool census unavailable: ${detected.error}`; return out; }

  for (const pool of detected.pools) {
    out.faulted.push(pool.name);
    const res = await recreateSparkPool(pool.name, { deps });
    if (res.action === 'recreated') {
      out.recovered.push(pool.name);
      await alertRecreate(pool, res, deps);
    } else if (res.action === 'skipped') {
      out.skipped.push({ pool: pool.name, reason: res.reason || '' });
    } else {
      out.errors.push({ pool: pool.name, reason: res.reason || '' });
      await alertRecreate(pool, res, deps);
    }
  }
  return out;
}
