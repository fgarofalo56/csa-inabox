/**
 * read-warmer — keeps the EXPENSIVE deployment-scoped dashboard reads warm so
 * no user ever pays the cold aggregation.
 *
 * WHY (perf directive 2026-07-15): the cold Cost Management aggregation takes
 * longer than Front Door's ~30s edge budget even in a small estate — measured
 * live: the first /api/monitor/cost read 504s at the edge while the server is
 * still aggregating, and because the request dies the cache stays empty for
 * the next user. SWR only helps once a copy EXISTS. This warmer populates and
 * re-populates the shared tier from the server side, off the request path:
 *
 *   • at startup (after a settle delay so boot isn't slowed), then
 *   • every WARM_INTERVAL_MS (default 10 min — inside every route TTL's
 *     stale-floor so served copies stay fresh-ish).
 *
 * The warm list mirrors the ROUTE cache keys exactly (same buildScopedCacheKey
 * inputs + modelId) — keep them in sync when a route's key changes. Failures
 * are logged and swallowed: warming is an optimization, never a fault source.
 * Escape hatch: LOOM_READ_WARMER_DISABLED=1.
 *
 * ── #4244 — WHY THIS FILE NOW HAS A BUDGET, PACING AND A CIRCUIT BREAKER ────
 *
 * Measured live 2026-08-31/09-01: ~1,700 ARM throttle lines per 30 minutes,
 * SUSTAINED over a 7-hour window, attributed to this warmer under the console
 * UAMI — verbatim from the control plane:
 *
 *   {"error":{"code":"SubscriptionRequestsThrottled","message":"Number of
 *    'read' requests for subscription 'e093f4fd-…' actor '85e5d083-…'
 *    exceeded. Please try again after '10' seconds…"}}
 *
 * ARM's read limit is per (subscription, principal). Every interactive console
 * read runs as the SAME principal, so whatever the warmer spends, an operator
 * action does not have. On 2026-09-01, with the estate PAUSED and IDLE,
 * `/api/admin/estate/state` could not read one resource's power state for this
 * exact reason and reported `confirmed: 2 of 3` — the warmer had eaten the
 * quota that the operator's own action needed.
 *
 * The defect was not the volume of one cycle. It was that NOTHING stopped:
 * `warmOnce` caught each failure, logged it, and moved straight on to the next
 * target — so a throttled cycle kept issuing reads into a control plane that
 * had already said "stop", and ten minutes later did it all again, forever.
 *
 * So the warmer is now explicitly a STRICTLY-BACKGROUND consumer that yields:
 *
 *   1. BUDGET — a per-subscription, per-window ceiling on warm reads it cannot
 *      exceed, no matter how it is triggered (see `ReadWarmerBudget`).
 *   2. PACING — a minimum gap between two warm reads, so a cycle can never
 *      land as one burst against the per-principal limit.
 *   3. CIRCUIT BREAKER — the FIRST 429 aborts the whole cycle (it does not
 *      "log and continue") and puts that subscription into a cooldown that is
 *      never shorter than the Retry-After ARM asked for, escalating while
 *      throttling persists.
 *   4. OBSERVABILITY — `getReadWarmerState()` reports what ran, what was
 *      skipped and WHY, so the next incident is diagnosable without a live log
 *      pull.
 *
 * deploy-integrity R7: every reason string states only what was established.
 * When ARM sent no Retry-After, the state says so rather than inventing one.
 */

import { buildScopedCacheKey, getOrComputeCached, resolveBackendTtl } from '@/lib/azure/query-result-cache';
import type { ArmThrottledError } from '@/lib/azure/arm-client';

const SETTLE_MS = 90_000;
const WARM_INTERVAL_MS = Number(process.env.LOOM_READ_WARMER_INTERVAL_MS) || 10 * 60_000;

// ---------------------------------------------------------------------------
// Budget configuration
// ---------------------------------------------------------------------------

/**
 * The warmer's self-imposed ceiling.
 *
 * UNIT, stated precisely so the number is not read as something it is not:
 * one budget unit is ONE WARM TARGET EXECUTION. A target fans out to a
 * client-defined number of ARM requests (`monitor/health` walks whole-
 * subscription Resource Health; `monitor/defender` crawls secure score), and
 * this module cannot count those without instrumenting every client. So the
 * budget bounds warm READS AND CYCLES — it is not a claim about the raw ARM
 * request count. Pacing bounds the instantaneous rate; the circuit breaker
 * bounds what happens once ARM pushes back.
 */
export interface ReadWarmerBudget {
  /** Rolling window the read ceiling is measured over. */
  windowMs: number;
  /** Max warm target executions per subscription per window. */
  maxReadsPerWindow: number;
  /** Minimum gap between two warm reads inside a cycle. */
  paceMs: number;
  /** Floor on the post-429 cooldown. Never shortens ARM's Retry-After. */
  minCooldownMs: number;
  /** Ceiling on the escalated cooldown. Never shortens ARM's Retry-After. */
  maxCooldownMs: number;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Defaults are sized so ONE healthy cycle of the current target list fits
 * inside one warm interval with a little headroom, and a second cycle in the
 * same window cannot run. They are tunable, never required: with no env set at
 * all the warmer is already bounded (ux-baseline G2 — no day-one gate).
 */
export function resolveReadWarmerBudget(): ReadWarmerBudget {
  return {
    windowMs: envInt('LOOM_READ_WARMER_WINDOW_MS', WARM_INTERVAL_MS, 60_000, 6 * 60 * 60_000),
    maxReadsPerWindow: envInt('LOOM_READ_WARMER_MAX_READS', 16, 1, 500),
    paceMs: envInt('LOOM_READ_WARMER_PACE_MS', 2_000, 0, 60_000),
    // A throttled subscription stays out for at least one and a half warm
    // intervals — long enough that the next scheduled cycle is genuinely
    // skipped rather than immediately re-competing for the same quota.
    minCooldownMs: envInt('LOOM_READ_WARMER_MIN_COOLDOWN_MS', 15 * 60_000, 1_000, 24 * 60 * 60_000),
    maxCooldownMs: envInt('LOOM_READ_WARMER_MAX_COOLDOWN_MS', 60 * 60_000, 1_000, 24 * 60 * 60_000),
  };
}

/** The subscription whose ARM read budget a warm read spends from. */
function homeSubscription(): string {
  return process.env.LOOM_SUBSCRIPTION_ID || 'unknown-subscription';
}

// ---------------------------------------------------------------------------
// Failure classification (deploy-integrity R6)
// ---------------------------------------------------------------------------

// Structural contract shared with `ArmThrottledError` in lib/azure/arm-client.ts
// (added for #4243). Matched STRUCTURALLY rather than with `instanceof` on
// purpose: arm-client builds an @azure/identity credential chain at MODULE
// scope, and the warmer must not drag that construction into
// instrumentation.ts's (or a unit test's) import graph merely to name a class.
// The type import below is erased at runtime; the assignment is a compile-time
// drift guard, so if that error ever stops carrying `status` /
// `retryAfterSeconds` this file fails to build instead of silently missing 429s.
type ArmThrottleShape = { status: number; retryAfterSeconds?: number };
const _armThrottleShapeIsStable: (e: ArmThrottledError) => ArmThrottleShape = (e) => e;
void _armThrottleShapeIsStable;

/** ARM error codes that mean "you are over the read limit", verbatim. */
const ARM_THROTTLE_CODES = [
  'SubscriptionRequestsThrottled',
  'TenantRequestsThrottled',
  'ResourceRequestsThrottled',
  'RequestThrottled',
  'TooManyRequests',
];

export type WarmFailureKind = 'throttled' | 'other';

export interface WarmFailure {
  kind: WarmFailureKind;
  /**
   * How long ARM asked us to wait, in ms — or null when ARM did not say.
   * null is never silently replaced by a guess (R7).
   */
  retryAfterMs: number | null;
  /** The observed failure text, truncated. */
  message: string;
}

function readNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Classify a warm-read failure. `throttled` is asserted ONLY on positive
 * evidence: a 429 status carried structurally, the `ARM … failed 429:` shape
 * `arm-client.jsonOrThrow` produces, or a named ARM throttle code in the body.
 * Everything else is `other` — never guessed into `throttled`.
 */
export function classifyWarmFailure(err: unknown): WarmFailure {
  const e = (err ?? {}) as Record<string, unknown>;
  const message = String((e as { message?: unknown }).message ?? err ?? '').slice(0, 600);

  const status =
    readNumber(e['status'])
    ?? readNumber(e['statusCode'])
    ?? readNumber((e['response'] as Record<string, unknown> | undefined)?.['status']);

  const throttled =
    status === 429
    || /\bfailed 429\b/.test(message)
    || ARM_THROTTLE_CODES.some((code) => message.includes(code));

  if (!throttled) return { kind: 'other', retryAfterMs: null, message };

  // Retry-After, in order of how directly ARM stated it.
  const structural = readNumber(e['retryAfterSeconds']);
  if (structural !== null) {
    return { kind: 'throttled', retryAfterMs: Math.max(0, Math.round(structural * 1000)), message };
  }
  // The verbatim ARM body: "Please try again after '10' seconds".
  const spoken = /try again after '(\d+)' seconds/i.exec(message);
  if (spoken) {
    return { kind: 'throttled', retryAfterMs: Math.max(0, Number(spoken[1]) * 1000), message };
  }
  const header = /retry-after["'\s:]+(\d+)/i.exec(message);
  if (header) {
    return { kind: 'throttled', retryAfterMs: Math.max(0, Number(header[1]) * 1000), message };
  }
  return { kind: 'throttled', retryAfterMs: null, message };
}

// ---------------------------------------------------------------------------
// Observable state (#4244 requirement 4)
// ---------------------------------------------------------------------------

export type ReadWarmerEventKind = 'warmed' | 'skipped' | 'throttled' | 'failed';

export interface ReadWarmerEvent {
  at: string;
  kind: ReadWarmerEventKind;
  label: string;
  /** Human-readable, and only ever what was actually established. */
  detail: string;
}

export interface ReadWarmerSkip {
  label: string;
  reason: string;
}

export interface ReadWarmerCycleReport {
  startedAt: string;
  finishedAt: string;
  /** Targets the cycle actually executed (each spent one budget unit). */
  attempted: number;
  succeeded: number;
  skipped: ReadWarmerSkip[];
  failed: { label: string; kind: WarmFailureKind; message: string }[];
  /** Set when a 429 tripped the breaker and ended the cycle early. */
  abortedBy: { label: string; retryAfterMs: number | null; cooldownUntil: string } | null;
}

export interface ReadWarmerBucketState {
  subscriptionId: string;
  readsUsedInWindow: number;
  windowStartedAt: string;
  windowResetsAt: string;
  cooldownUntil: string | null;
  consecutiveThrottles: number;
  lastThrottle: { at: string; label: string; retryAfterMs: number | null; message: string } | null;
}

export interface ReadWarmerState {
  enabled: boolean;
  running: boolean;
  cyclesStarted: number;
  budget: ReadWarmerBudget;
  buckets: ReadWarmerBucketState[];
  lastCycle: ReadWarmerCycleReport | null;
  recentEvents: ReadWarmerEvent[];
}

const MAX_EVENTS = 50;

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export interface WarmTarget {
  label: string;
  key: string;
  modelId: string;
  ttlMs: number;
  produce: () => Promise<unknown>;
  /**
   * Which per-subscription budget bucket this read spends from. Omitted =
   * the console's home subscription. Cross-subscription targets are attributed
   * here too (see `chargebackTargets`) because the console's own subscription
   * is always in their fan-out, and over-attributing spends the budget SOONER,
   * which is the safe direction.
   */
  budgetKey?: string;
}

async function targets(): Promise<WarmTarget[]> {
  // Dynamic imports keep the warmer out of every route's module graph.
  const [{ computeLoomCostSummary, costKey, loomScopeLabel }, monitor, { getDefenderSummary }] = await Promise.all([
    import('@/lib/azure/cost-client'),
    import('@/lib/azure/monitor-client'),
    import('@/lib/azure/defender-client'),
  ]);
  return [
    {
      // C1: warm the CANONICAL cost-client cache key (the same key
      // getLoomCostSummaryCached reads) with the RAW compute — warming through
      // the cached wrapper would just read its own fresh copy back.
      label: 'monitor/cost MonthToDate',
      key: costKey(loomScopeLabel(), 'MonthToDate', 'summary'),
      modelId: 'cost-mgmt',
      ttlMs: 15 * 60_000,
      produce: () => computeLoomCostSummary({ timeframe: 'MonthToDate' }),
    },
    {
      label: 'monitor/alerts metric',
      key: buildScopedCacheKey('monitor/alerts', { kind: 'metric' }),
      modelId: 'monitor',
      ttlMs: 2 * 60_000,
      produce: () => monitor.listAlertRules(),
    },
    {
      label: 'monitor/diagnostics',
      key: buildScopedCacheKey('monitor/diagnostics', {}),
      modelId: 'monitor',
      ttlMs: 5 * 60_000,
      produce: () => monitor.getDiagnosticsCoverage(),
    },
    {
      label: 'monitor/action-groups',
      key: buildScopedCacheKey('monitor/action-groups', {}),
      modelId: 'monitor',
      ttlMs: 5 * 60_000,
      produce: () => monitor.listActionGroups(),
    },
    // 2026-07-16 live receipt: defender (secure score crawl) and health
    // (whole-subscription Resource Health, ~20 serial paginated calls) both
    // measured ~12s on a cache miss — the slowest monitor first-paints left.
    {
      label: 'monitor/defender',
      key: buildScopedCacheKey('monitor/defender', {}),
      modelId: 'monitor',
      ttlMs: 10 * 60_000,
      produce: () => getDefenderSummary(),
    },
    {
      label: 'monitor/health',
      key: buildScopedCacheKey('monitor/health', {}),
      modelId: 'monitor',
      ttlMs: 90_000,
      produce: async () => ({ statuses: Object.values(await monitor.listResourceHealth()) }),
    },
    {
      label: 'monitor/activities default',
      // Mirrors the route's DEFAULT param set (days=30, limit=200,
      // synapse on, arm off) — the shape the Monitor page first-paints with.
      key: buildScopedCacheKey('monitor/activities', { days: 30, limit: 200, includeSynapse: true, includeArmLog: false }),
      modelId: 'monitor',
      ttlMs: 3 * 60_000,
      produce: () => monitor.queryActivityFeed({ days: 30, limit: 200, includeSynapse: true, includeArmLog: false }),
    },
    ...(await chargebackTargets()),
  ];
}

/**
 * Chargeback warm targets (operator report 2026-07-17: the cross-subscription
 * Cost Management aggregation exceeds the 25s inline budget under QPU throttle,
 * so users kept landing on 202-"warming" — the cache only populated if someone
 * waited out the background compute). Warming server-side means the first user
 * click always finds a copy.
 *
 * The routes scope their keys AND modelId by tenantScopeId (= session tid) —
 * every real signed-in user shares the AAD tenant id, which the server knows as
 * AZURE_TENANT_ID. No tenant id → skip (keys would never match a real session).
 */
async function chargebackTargets(): Promise<WarmTarget[]> {
  const tenantId = process.env.AZURE_TENANT_ID;
  if (!tenantId) return [];
  const timeframe = 'MonthToDate';
  const [{ getChargebackModel }, { getDomainChargeback }, { loadOrSeedDomains }, { tenantSettingsContainer }] = await Promise.all([
    import('@/lib/azure/cost-management-client'),
    import('@/lib/azure/domain-chargeback'),
    import('@/lib/azure/domain-registry'),
    import('@/lib/azure/cosmos-client'),
  ]);
  return [
    {
      label: 'admin/capacity/chargeback MonthToDate',
      key: buildScopedCacheKey('admin/capacity/chargeback', { tenantId, timeframe }),
      modelId: tenantId,
      ttlMs: resolveBackendTtl('costmgmt', 10 * 60_000),
      produce: () => getChargebackModel({ timeframe }),
    },
    {
      label: 'admin/chargeback MonthToDate',
      key: buildScopedCacheKey('admin/chargeback', { tenantId, timeframe }),
      modelId: tenantId,
      ttlMs: resolveBackendTtl('costmgmt', 20 * 60_000),
      // Mirrors the route's closure shape { data, taggingEnabled } exactly.
      produce: async () => {
        const [domainDoc, tagging] = await Promise.all([
          loadOrSeedDomains(tenantId, 'system:read-warmer').catch(() => null),
          (async () => {
            try {
              const c = await tenantSettingsContainer();
              const { resource } = await c.item(tenantId, tenantId).read<{ settings?: Record<string, boolean> }>();
              return resource?.settings?.['billing.chargebackTagging'] === true;
            } catch { return false; }
          })(),
        ]);
        const domainNames: Record<string, string> = {};
        for (const d of domainDoc?.items || []) domainNames[d.id] = d.name;
        const data = await getDomainChargeback({ timeframe, domainNames });
        return { data, taggingEnabled: tagging };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// The warmer
// ---------------------------------------------------------------------------

export interface ReadWarmerDeps {
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable sleep. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable target list. Defaults to the real warm list above. */
  loadTargets?: () => Promise<WarmTarget[]>;
  /** Injectable executor for ONE target. Defaults to the real cache write. */
  runTarget?: (t: WarmTarget) => Promise<unknown>;
  budget?: ReadWarmerBudget;
  /** Injectable logger so specs do not spam the reporter. */
  warn?: (message: string) => void;
}

interface BucketState {
  readsUsed: number;
  windowStartedAt: number;
  cooldownUntil: number;
  consecutiveThrottles: number;
  lastThrottle: { at: number; label: string; retryAfterMs: number | null; message: string } | null;
}

export interface ReadWarmer {
  runCycle: () => Promise<ReadWarmerCycleReport>;
  state: () => ReadWarmerState;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function createReadWarmer(deps: ReadWarmerDeps = {}): ReadWarmer {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const loadTargets = deps.loadTargets ?? targets;
  const runTarget = deps.runTarget
    ?? ((t: WarmTarget) => getOrComputeCached(t.key, t.modelId, t.produce, { ttlMs: t.ttlMs, bypass: true }));
  const budget = deps.budget ?? resolveReadWarmerBudget();
  const warn = deps.warn ?? ((m: string) => { console.warn(m); });

  const buckets = new Map<string, BucketState>();
  const events: ReadWarmerEvent[] = [];
  let running = false;
  let cyclesStarted = 0;
  let lastCycle: ReadWarmerCycleReport | null = null;

  function record(kind: ReadWarmerEventKind, label: string, detail: string): void {
    events.push({ at: iso(now()), kind, label, detail });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  }

  function bucketFor(t: WarmTarget): { id: string; b: BucketState } {
    const id = t.budgetKey || homeSubscription();
    let b = buckets.get(id);
    if (!b) {
      b = { readsUsed: 0, windowStartedAt: now(), cooldownUntil: 0, consecutiveThrottles: 0, lastThrottle: null };
      buckets.set(id, b);
    }
    // Roll the window forward. A window is a fixed-length slot, not a sliding
    // one: simple, and it can only ever be MORE restrictive than a sliding
    // window at the moment of a burst.
    if (now() - b.windowStartedAt >= budget.windowMs) {
      b.windowStartedAt = now();
      b.readsUsed = 0;
    }
    return { id, b };
  }

  /**
   * Cooldown after a 429. NEVER shorter than the Retry-After ARM asked for —
   * that is the honoring requirement — and escalated while throttling
   * persists, so a control plane that keeps saying "stop" gets progressively
   * more room rather than the same 10-minute re-attempt forever.
   */
  function cooldownMsFor(retryAfterMs: number | null, consecutiveThrottles: number): number {
    const escalated = budget.minCooldownMs * 2 ** Math.max(0, consecutiveThrottles - 1);
    const bounded = Math.min(budget.maxCooldownMs, escalated);
    return Math.max(bounded, retryAfterMs ?? 0);
  }

  async function runCycle(): Promise<ReadWarmerCycleReport> {
    const startedAt = now();
    const report: ReadWarmerCycleReport = {
      startedAt: iso(startedAt),
      finishedAt: iso(startedAt),
      attempted: 0,
      succeeded: 0,
      skipped: [],
      failed: [],
      abortedBy: null,
    };
    if (running) {
      report.skipped.push({ label: '(cycle)', reason: 'a warm cycle was already running' });
      report.finishedAt = iso(now());
      lastCycle = report;
      return report;
    }
    running = true;
    cyclesStarted += 1;
    try {
      let list: WarmTarget[];
      try {
        list = await loadTargets();
      } catch (e) {
        const detail = `warm target list could not be built: ${(e as Error)?.message}`;
        report.failed.push({ label: '(targets)', kind: 'other', message: detail });
        record('failed', '(targets)', detail);
        warn(`[read-warmer] ${detail}`);
        report.finishedAt = iso(now());
        lastCycle = report;
        return report;
      }

      let executed = 0;
      let aborted = false;
      const cleanBuckets = new Set<string>();
      for (const t of list) {
        if (aborted) {
          report.skipped.push({ label: t.label, reason: 'cycle aborted after ARM throttled an earlier read' });
          continue;
        }
        const { id, b } = bucketFor(t);

        if (b.cooldownUntil > now()) {
          const reason = `subscription ${id} is in warm cooldown until ${iso(b.cooldownUntil)} after ARM throttled a warm read`;
          report.skipped.push({ label: t.label, reason });
          record('skipped', t.label, reason);
          continue;
        }
        if (b.readsUsed >= budget.maxReadsPerWindow) {
          const reason = `subscription ${id} spent its warm read budget (${b.readsUsed}/${budget.maxReadsPerWindow}) for the window starting ${iso(b.windowStartedAt)}`;
          report.skipped.push({ label: t.label, reason });
          record('skipped', t.label, reason);
          continue;
        }

        // Pace BEFORE every read after the first, so a cycle never lands as a
        // burst against the per-principal ARM limit.
        if (executed > 0 && budget.paceMs > 0) await sleep(budget.paceMs);

        b.readsUsed += 1;
        executed += 1;
        report.attempted += 1;
        try {
          // bypass:true recomputes + rewrites the tiers even when a fresh copy
          // exists — the warmer's job is keeping copies YOUNG, not reading them.
          await runTarget(t);
          report.succeeded += 1;
          cleanBuckets.add(id);
          record('warmed', t.label, `warmed (${b.readsUsed}/${budget.maxReadsPerWindow} of the window budget for ${id})`);
        } catch (e) {
          const failure = classifyWarmFailure(e);
          report.failed.push({ label: t.label, kind: failure.kind, message: failure.message });
          if (failure.kind !== 'throttled') {
            record('failed', t.label, failure.message);
            warn(`[read-warmer] ${t.label} failed: ${failure.message}`);
            continue;
          }
          // ── The circuit breaker. ARM said stop; the warmer stops. ──
          b.consecutiveThrottles += 1;
          const cooldown = cooldownMsFor(failure.retryAfterMs, b.consecutiveThrottles);
          b.cooldownUntil = now() + cooldown;
          b.lastThrottle = { at: now(), label: t.label, retryAfterMs: failure.retryAfterMs, message: failure.message };
          const asked = failure.retryAfterMs === null
            ? 'ARM did not state a Retry-After, so the configured minimum applies'
            : `ARM asked for ${Math.round(failure.retryAfterMs / 1000)}s`;
          const detail = `ARM throttled this warm read; ${asked}. Aborting the cycle and holding subscription ${id} out until ${iso(b.cooldownUntil)}.`;
          report.abortedBy = { label: t.label, retryAfterMs: failure.retryAfterMs, cooldownUntil: iso(b.cooldownUntil) };
          record('throttled', t.label, detail);
          warn(`[read-warmer] ${t.label} throttled: ${detail}`);
          aborted = true;
        }
      }
      if (!aborted) {
        // Escalation is cleared ONLY for a bucket that actually completed a
        // warm read in this cycle — a bucket that was skipped (still cooling
        // down, or out of budget) established nothing, so its escalation
        // stands. Anything else would let a skipped cycle "prove" health.
        for (const id of cleanBuckets) {
          const b = buckets.get(id);
          if (b && b.cooldownUntil <= now()) b.consecutiveThrottles = 0;
        }
      }
      report.finishedAt = iso(now());
      lastCycle = report;
      return report;
    } finally {
      running = false;
    }
  }

  function state(): ReadWarmerState {
    return {
      enabled: process.env.LOOM_READ_WARMER_DISABLED !== '1',
      running,
      cyclesStarted,
      budget: { ...budget },
      buckets: [...buckets.entries()].map(([subscriptionId, b]) => ({
        subscriptionId,
        readsUsedInWindow: b.readsUsed,
        windowStartedAt: iso(b.windowStartedAt),
        windowResetsAt: iso(b.windowStartedAt + budget.windowMs),
        cooldownUntil: b.cooldownUntil > now() ? iso(b.cooldownUntil) : null,
        consecutiveThrottles: b.consecutiveThrottles,
        lastThrottle: b.lastThrottle
          ? {
              at: iso(b.lastThrottle.at),
              label: b.lastThrottle.label,
              retryAfterMs: b.lastThrottle.retryAfterMs,
              message: b.lastThrottle.message,
            }
          : null,
      })),
      lastCycle,
      recentEvents: [...events],
    };
  }

  return { runCycle, state };
}

const defaultWarmer = createReadWarmer();

/**
 * What the warmer is doing, what it skipped, and why — the diagnostic the
 * 2026-08-31 incident had to be reconstructed from a live log pull to answer.
 */
export function getReadWarmerState(): ReadWarmerState {
  return defaultWarmer.state();
}

/** Start the warmer loop (idempotent; called from instrumentation.ts). */
let started = false;
export function startReadWarmer(): void {
  if (started) return;
  if (process.env.LOOM_READ_WARMER_DISABLED === '1') return;
  started = true;
  const t1 = setTimeout(() => { void defaultWarmer.runCycle(); }, SETTLE_MS);
  const t2 = setInterval(() => { void defaultWarmer.runCycle(); }, WARM_INTERVAL_MS);
  // Never keep the process alive just for warming.
  t1.unref?.(); t2.unref?.();
}
