/**
 * arm-read-gate — per-caller ARM read accounting + the warmer read gate.
 *
 * WHY (measured 2026-10-20/21, temp/arm-reads-report.md): the Console UAMI's ARM
 * READ bucket is 250 tokens, 25/s refill, per principal per subscription. The
 * read-warmer diagnostics sweep fired one `diagnosticSettings` GET per estate
 * resource inside an unbounded `Promise.all` (~450 near-simultaneous reads for
 * 678 eligible resources), twice (one warmer per replica). That empties the
 * bucket in a burst and every operator read inside the next seconds gets
 * `SubscriptionRequestsThrottled`.
 *
 * Two independent facilities live here because they ride the same hook point in
 * the ARM transports (`monitor-arm.armGet`, `arm-client.armFetch`):
 *
 *   1. COUNTERS — every GET is attributed to a caller LABEL (AsyncLocalStorage,
 *      set by whoever started the work: `warmer.diagnostics`, `estate.state`, …;
 *      unlabelled work counts as `unlabeled`). One structured line per minute:
 *      `[arm-reads] {...}`. This is observation only: it never changes a request.
 *   2. THE GATE — only for work that runs inside a warmer CYCLE GUARD. A process
 *      wide concurrency cap + token bucket, shared by ALL warmer work, so a sweep
 *      spreads over time. Interactive reads (no guard) bypass it entirely: the
 *      gate exists to protect them, not to queue them.
 *
 * Leaf module ON PURPOSE: no `@azure/identity`, no transport import, so the
 * warmer and unit tests can use it without building a credential chain.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Upper bound on how long ONE 429 can hold the whole warmer gate shut. */
export const MAX_GATE_BACKOFF_MS = 60_000;

export interface ArmReadGateConfig {
  /** Max warmer ARM reads in flight at once. LOOM_WARMER_ARM_CONCURRENCY, 1..32, default 8. */
  maxConcurrent: number;
  /** Sustained warmer reads per second AND bucket capacity. LOOM_WARMER_ARM_READS_PER_SEC, 1..25, default 10. */
  readsPerSec: number;
}

export function resolveArmReadGateConfig(): ArmReadGateConfig {
  return {
    maxConcurrent: envInt('LOOM_WARMER_ARM_CONCURRENCY', 8, 1, 32),
    readsPerSec: envInt('LOOM_WARMER_ARM_READS_PER_SEC', 10, 1, 25),
  };
}

// ---------------------------------------------------------------------------
// Cycle guard + the error a queued read gets when its cycle is abandoned
// ---------------------------------------------------------------------------

export interface CycleAbandonment {
  reason: string;
  /** Label of the caller whose read drew the 429. */
  byLabel: string;
  retryAfterSeconds?: number;
}

/** One per warmer cycle. Reads started under it queue in the gate. */
export class WarmerCycleGuard {
  abandoned: CycleAbandonment | null = null;
}

/**
 * Thrown to a read that was waiting in the gate when its cycle was abandoned
 * (ARM said 429 to an earlier read). NO request was sent for it. It carries
 * `status: 429` so callers that degrade errors structurally still see a throttle
 * verdict, and its message says exactly that this read never reached ARM (R7).
 */
export class ArmReadAbandonedError extends Error {
  readonly status = 429 as const;
  readonly code = 'WarmerCycleAbandoned';
  readonly retryAfterSeconds?: number;
  constructor(abandonment: CycleAbandonment) {
    super(
      `Read not sent: the warm cycle was abandoned after ARM throttled an earlier read (${abandonment.byLabel}); `
        + 'this resource was not queried.',
    );
    this.name = 'ArmReadAbandonedError';
    if (abandonment.retryAfterSeconds !== undefined) this.retryAfterSeconds = abandonment.retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// The gate: concurrency semaphore + token bucket + 429 backoff
// ---------------------------------------------------------------------------

interface Waiter {
  guard: WarmerCycleGuard;
  tokenOnly: boolean;
  resolve: (release: () => void) => void;
  reject: (e: unknown) => void;
}

export interface ArmReadGateDeps {
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface ArmReadGate {
  /** Wait for a slot + a token. The returned function MUST be called when the read ends. */
  acquire: (guard: WarmerCycleGuard) => Promise<() => void>;
  /** Wait for a token only (no slot held) — for a unit of work that issues its own reads. */
  consume: (guard: WarmerCycleGuard) => Promise<void>;
  /** ARM returned 429: shut the gate for `retryAfterSeconds` (bounded) and abandon the guard's cycle. */
  onThrottled: (guard: WarmerCycleGuard, byLabel: string, retryAfterSeconds?: number) => void;
  /** Reject every queued read of `guard`. Idempotent. */
  abandon: (guard: WarmerCycleGuard, a: CycleAbandonment) => void;
  stats: () => { inFlight: number; queued: number; tokens: number; maxInFlightSeen: number };
}

export function createArmReadGate(cfg: ArmReadGateConfig, deps: ArmReadGateDeps = {}): ArmReadGate {
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  });
  const cancel = deps.cancel ?? ((h: unknown) => { clearTimeout(h as ReturnType<typeof setTimeout>); });

  const capacity = cfg.readsPerSec; // burst never exceeds one second of refill
  let tokens = capacity;
  let lastRefill = now();
  let blockedUntil = 0;
  let inFlight = 0;
  let maxInFlightSeen = 0;
  let queue: Waiter[] = [];
  let timer: unknown = null;

  function refill(): void {
    const t = now();
    const elapsed = t - lastRefill;
    if (elapsed > 0) {
      tokens = Math.min(capacity, tokens + (elapsed / 1000) * cfg.readsPerSec);
      lastRefill = t;
    }
  }

  function arm(ms: number): void {
    if (timer !== null) return;
    timer = schedule(() => { timer = null; pump(); }, Math.max(1, Math.ceil(ms)));
  }

  function pump(): void {
    while (queue.length > 0) {
      const head = queue[0]!;
      if (head.guard.abandoned) {
        queue.shift();
        head.reject(new ArmReadAbandonedError(head.guard.abandoned));
        continue;
      }
      if (!head.tokenOnly && inFlight >= cfg.maxConcurrent) return; // release() re-pumps
      const t = now();
      if (t < blockedUntil) { arm(blockedUntil - t); return; }
      refill();
      if (tokens < 1) { arm(((1 - tokens) / cfg.readsPerSec) * 1000); return; }
      queue.shift();
      tokens -= 1;
      if (head.tokenOnly) { head.resolve(() => {}); continue; }
      inFlight += 1;
      if (inFlight > maxInFlightSeen) maxInFlightSeen = inFlight;
      let released = false;
      head.resolve(() => {
        if (released) return;
        released = true;
        inFlight -= 1;
        pump();
      });
    }
  }

  function enqueue(guard: WarmerCycleGuard, tokenOnly: boolean): Promise<() => void> {
    if (guard.abandoned) return Promise.reject(new ArmReadAbandonedError(guard.abandoned));
    return new Promise<() => void>((resolve, reject) => {
      queue.push({ guard, tokenOnly, resolve, reject });
      pump();
    });
  }

  function abandon(guard: WarmerCycleGuard, a: CycleAbandonment): void {
    if (!guard.abandoned) guard.abandoned = a;
    const keep: Waiter[] = [];
    for (const w of queue) {
      if (w.guard === guard) w.reject(new ArmReadAbandonedError(guard.abandoned));
      else keep.push(w);
    }
    queue = keep;
    if (queue.length === 0 && timer !== null) { cancel(timer); timer = null; }
  }

  return {
    acquire: (guard) => enqueue(guard, false),
    consume: async (guard) => { (await enqueue(guard, true))(); },
    onThrottled(guard, byLabel, retryAfterSeconds) {
      const waitMs = Math.min(MAX_GATE_BACKOFF_MS, Math.max(0, (retryAfterSeconds ?? 0) * 1000));
      blockedUntil = Math.max(blockedUntil, now() + waitMs);
      tokens = 0;
      abandon(guard, {
        reason: `ARM returned 429 to ${byLabel}${retryAfterSeconds !== undefined ? ` and asked for ${retryAfterSeconds}s` : ' without a Retry-After'}`,
        byLabel,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      });
    },
    abandon,
    stats: () => ({ inFlight, queued: queue.length, tokens, maxInFlightSeen }),
  };
}

let defaultGate: ArmReadGate | null = null;
/** The process-wide gate every warmer read shares (lazily built from env). */
export function getWarmerArmReadGate(): ArmReadGate {
  if (!defaultGate) defaultGate = createArmReadGate(resolveArmReadGateConfig());
  return defaultGate;
}
/** Test hook. */
export function resetWarmerArmReadGate(): void { defaultGate = null; }

// ---------------------------------------------------------------------------
// Caller context (AsyncLocalStorage)
// ---------------------------------------------------------------------------

interface ArmCallerCtx {
  label: string;
  guard?: WarmerCycleGuard;
  gate?: ArmReadGate;
}

const callerStore = new AsyncLocalStorage<ArmCallerCtx>();

/**
 * Run `fn` with every ARM GET inside it attributed to `label`. With a `guard`,
 * those GETs also queue in the warmer gate (`gate` defaults to the shared one).
 */
export function runWithArmCaller<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: { guard?: WarmerCycleGuard; gate?: ArmReadGate },
): Promise<T> {
  const ctx: ArmCallerCtx = { label };
  if (opts?.guard) {
    ctx.guard = opts.guard;
    ctx.gate = opts.gate ?? getWarmerArmReadGate();
  }
  return callerStore.run(ctx, fn);
}

// ---------------------------------------------------------------------------
// Counters + the once-a-minute line
// ---------------------------------------------------------------------------

interface Count { n: number; s429: number }
const counts = new Map<string, Count>();
const LOG_INTERVAL_MS = 60_000;
let loggerStarted = false;

export interface ArmReadsSnapshot {
  reads: Record<string, number>;
  s429: Record<string, number>;
}

/** Counts since the last flush (does not reset). */
export function getArmReadCounts(): ArmReadsSnapshot {
  const reads: Record<string, number> = {};
  const s429: Record<string, number> = {};
  for (const [label, c] of counts) {
    reads[label] = c.n;
    if (c.s429 > 0) s429[label] = c.s429;
  }
  return { reads, s429 };
}

/**
 * Emit ONE `[arm-reads] {...}` line for the window since the last flush and
 * reset. Silent when nothing was read (a quiet minute costs nothing).
 */
export function flushArmReadCounts(emit: (line: string) => void = (l) => { console.log(l); }): void {
  if (counts.size === 0) return;
  const snap = getArmReadCounts();
  counts.clear();
  emit(`[arm-reads] ${JSON.stringify({ windowSec: LOG_INTERVAL_MS / 1000, ...snap })}`);
}

function ensureLogger(): void {
  if (loggerStarted) return;
  loggerStarted = true;
  const t = setInterval(() => { flushArmReadCounts(); }, LOG_INTERVAL_MS);
  (t as { unref?: () => void }).unref?.();
}

/** Test hook. */
export function resetArmReadCounts(): void { counts.clear(); }

function bump(label: string, status: number | null): void {
  let c = counts.get(label);
  if (!c) { c = { n: 0, s429: 0 }; counts.set(label, c); }
  c.n += 1;
  if (status === 429) c.s429 += 1;
}

// ---------------------------------------------------------------------------
// Transport hook
// ---------------------------------------------------------------------------

export interface ArmReadTicket {
  /** Call once the response status is known (or with null if the fetch threw). */
  done: (status: number | null, retryAfterHeader?: string | null) => void;
}

function parseRetryAfterSeconds(h: string | null | undefined): number | undefined {
  if (!h || h.trim() === '') return undefined;
  const n = Number(h);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Called by the ARM transports right before a GET. Inside a warmer cycle it
 * waits for the gate (and rejects with `ArmReadAbandonedError` if the cycle was
 * abandoned); everywhere else it returns immediately. Never alters the request.
 */
export async function beginArmRead(): Promise<ArmReadTicket> {
  ensureLogger();
  const ctx = callerStore.getStore();
  const label = ctx?.label ?? 'unlabeled';
  let release: (() => void) | null = null;
  if (ctx?.guard && ctx.gate) release = await ctx.gate.acquire(ctx.guard);
  return {
    done(status, retryAfterHeader) {
      bump(label, status);
      if (release) { release(); release = null; }
      if (status === 429 && ctx?.guard && ctx.gate) {
        ctx.gate.onThrottled(ctx.guard, label, parseRetryAfterSeconds(retryAfterHeader));
      }
    },
  };
}

/**
 * Take one warmer token for a unit of work whose reads this module cannot see
 * (Cost Management queries use a transport outside this hook). No-op outside a
 * warmer cycle.
 */
export async function consumeWarmerToken(): Promise<void> {
  const ctx = callerStore.getStore();
  if (ctx?.guard && ctx.gate) await ctx.gate.consume(ctx.guard);
}

/** Attribute reads the transport hook cannot wrap (call after the fetch resolves). */
export function noteArmRead(label: string, status: number | null): void {
  ensureLogger();
  bump(label, status);
}
