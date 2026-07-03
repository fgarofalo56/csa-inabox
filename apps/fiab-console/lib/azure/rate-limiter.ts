/**
 * Per-principal token-bucket rate limiter for BFF routes — Phase-2D.
 *
 * Scope: NODE route handlers only. There is NO middleware.ts / Edge usage —
 * Loom's OpenTelemetry stack is node-only, and the in-proc state below would be
 * meaningless on the edge runtime. Import + call this at the top of a route's
 * `export async function POST/...` handler, never in middleware.
 *
 * Key: (oid, routeClass). `oid` is the caller's object id from the session
 * (UserClaims.oid). `routeClass` groups routes that should share a budget
 * (e.g. 'provision', 'query', 'chat') so a noisy class can't starve others.
 *
 * Default: ON (rel-T16 / blocker B16). Rate limiting is engaged unless
 * LOOM_RATE_LIMIT=off. `checkRate()` / `withRateLimit()` remain the SYNC,
 * in-memory tier (tier-1) and are a pure no-op only when explicitly disabled.
 * The async `enforceRateLimit()` / `enforceRateLimitForKey()` wrappers add the
 * DURABLE, cross-replica tier (tier-2) on top of tier-1 — use those in routes.
 *
 * Two-tier storage:
 *   Tier-1 (fast, local) — in-process LRU token bucket, capped + idle-evicted.
 *     Per-pod, resets on restart; catches burst abuse instantly with zero I/O.
 *   Tier-2 (durable, cross-replica) — a Cosmos fixed-window counter with TTL
 *     (see rate-limit-store.ts), so a client that spreads requests across
 *     Container App replicas is still bounded in aggregate. Best-effort +
 *     bounded (AbortController budget) + fail-open: a Cosmos blip never breaks a
 *     request — tier-1 has already enforced the per-replica burst cap. This is
 *     the "Redis seam" this module always documented, realized on the lightest
 *     already-deployed cross-replica store (Cosmos) rather than adding Redis.
 *     Force tier-1-only with LOOM_RATE_LIMIT_BACKEND=memory.
 */

import { NextResponse } from 'next/server';
import type { SessionPayload } from '../auth/session';

/** Refill/burst config for a bucket. */
export interface RateLimits {
  /** Sustained requests per second (token refill rate). */
  ratePerSec: number;
  /** Max tokens (burst). Defaults to ratePerSec when omitted. */
  burst?: number;
}

/** Outcome of a {@link checkRate} call. */
export interface RateResult {
  ok: boolean;
  /** Configured burst capacity. */
  limit: number;
  /** Whole tokens left after this request. */
  remaining: number;
  /** Unix seconds when the bucket is fully refilled. */
  reset: number;
  /** Seconds to wait before retrying (0 when ok). */
  retryAfter: number;
}

interface Bucket {
  tokens: number;
  /** ms epoch of last refill. */
  ts: number;
  burst: number;
  rate: number;
}

/** Tier-1 per-class burst budgets (in-memory token bucket). Coarse; a caller
 *  may pass explicit limits. Generous enough not to trip the UAT suite. */
const DEFAULTS: Record<string, RateLimits> = {
  default: { ratePerSec: 5, burst: 10 },
  auth: { ratePerSec: 0.5, burst: 12 },     // sign-in / callback — per-IP, anonymous
  provision: { ratePerSec: 1, burst: 3 },   // install / provision
  query: { ratePerSec: 5, burst: 20 },      // sql / kql / dax executors
  chat: { ratePerSec: 2, burst: 6 },
  aoai: { ratePerSec: 1, burst: 10 },        // copilot / ai-assist
  export: { ratePerSec: 1, burst: 8 },       // export / download
  feedback: { ratePerSec: 0.2, burst: 5 },   // authed bug / feature reports
  'feedback-anon': { ratePerSec: 0.05, burst: 5 }, // anonymous auto-error reports
};

/** Tier-2 durable fixed-window budgets (Cosmos). windowSec + max requests per
 *  window per key. Coarser than tier-1 — the cross-replica aggregate backstop. */
export interface DurableLimit {
  windowSec: number;
  max: number;
}
const DURABLE_DEFAULTS: Record<string, DurableLimit> = {
  default: { windowSec: 60, max: 120 },
  auth: { windowSec: 300, max: 40 },              // per-IP: 40 sign-ins / 5 min
  provision: { windowSec: 60, max: 30 },
  query: { windowSec: 60, max: 120 },             // 120 queries / min / user
  chat: { windowSec: 60, max: 90 },
  aoai: { windowSec: 60, max: 90 },
  export: { windowSec: 60, max: 60 },
  feedback: { windowSec: 3600, max: 30 },         // authed: 30 reports / hr / user
  'feedback-anon': { windowSec: 3600, max: 5 },   // anonymous: 5 auto-errors / hr / IP
};

const MAX_BUCKETS = 5000;
/** In-proc LRU. JS Map preserves insertion order → oldest key is first. */
const buckets = new Map<string, Bucket>();

export function rateLimitEnabled(): boolean {
  // Default ON (rel-T16 / B16). Only an explicit LOOM_RATE_LIMIT=off disables it.
  return (process.env.LOOM_RATE_LIMIT ?? '').toLowerCase() !== 'off';
}

function touch(key: string, b: Bucket): void {
  buckets.delete(key);
  buckets.set(key, b);
  while (buckets.size > MAX_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

/**
 * Token-bucket check for (oid, routeClass). When disabled, returns a
 * permissive ok=true result with no bookkeeping. Pure CPU/memory; no I/O.
 */
export function checkRate(oid: string, routeClass: string, limits?: RateLimits): RateResult {
  const cfg = limits ?? DEFAULTS[routeClass] ?? DEFAULTS.default;
  const burst = Math.max(1, cfg.burst ?? cfg.ratePerSec);
  const rate = Math.max(0.0001, cfg.ratePerSec);

  if (!rateLimitEnabled()) {
    return { ok: true, limit: burst, remaining: burst, reset: Math.ceil(Date.now() / 1000), retryAfter: 0 };
  }

  const key = `${oid || 'anon'}::${routeClass}`;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: burst, ts: now, burst, rate };
  } else {
    b.tokens = Math.min(b.burst, b.tokens + ((now - b.ts) / 1000) * b.rate);
    b.ts = now;
    b.burst = burst;
    b.rate = rate;
  }

  let ok: boolean;
  let retryAfter = 0;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    ok = true;
  } else {
    ok = false;
    retryAfter = Math.ceil((1 - b.tokens) / rate);
  }
  touch(key, b);

  const deficit = burst - b.tokens;
  return {
    ok,
    limit: burst,
    remaining: Math.max(0, Math.floor(b.tokens)),
    reset: Math.ceil(now / 1000 + deficit / rate),
    retryAfter,
  };
}

/** Shape shared by tier-1 (RateResult) and tier-2 429 responses. */
interface Over {
  limit: number;
  remaining: number;
  reset: number;
  retryAfter: number;
}

/** Build the 429 NextResponse with the x-ratelimit-* + Retry-After headers. */
function tooMany(r: Over): NextResponse {
  const res = NextResponse.json(
    { ok: false, error: 'rate_limited', retryAfter: r.retryAfter },
    { status: 429 },
  );
  res.headers.set('x-ratelimit-limit', String(r.limit));
  res.headers.set('x-ratelimit-remaining', String(r.remaining));
  res.headers.set('x-ratelimit-reset', String(r.reset));
  res.headers.set('Retry-After', String(r.retryAfter));
  return res;
}

/**
 * TIER-1-ONLY route helper (sync). Returns a 429 NextResponse when the caller is
 * over the in-memory burst budget, or null to proceed. Prefer the async
 * {@link enforceRateLimit} in routes — it layers the durable cross-replica tier
 * on top of this. Kept for callers that must stay synchronous and as the tier-1
 * primitive. Always null when disabled.
 */
export function withRateLimit(
  session: SessionPayload | null,
  routeClass: string,
  limits?: RateLimits,
): NextResponse | null {
  const oid = session?.claims?.oid ?? '';
  const r = checkRate(oid, routeClass, limits);
  return r.ok ? null : tooMany(r);
}

/**
 * Two-tier enforce (async). Runs the sync in-memory token bucket first (zero
 * I/O; instant burst cap), then — when the durable backend is available — a
 * Cosmos fixed-window counter for cross-replica aggregate enforcement. Returns a
 * 429 NextResponse when over budget at EITHER tier, or null to proceed. The
 * durable tier is best-effort + fail-open: a Cosmos error/timeout never blocks a
 * request (tier-1 already enforced the per-replica cap). No-op when disabled.
 */
async function enforce(bucketKey: string, routeClass: string, limits?: RateLimits): Promise<NextResponse | null> {
  if (!rateLimitEnabled()) return null;
  // Tier-1: in-memory token bucket (per-replica, zero I/O).
  const local = checkRate(bucketKey, routeClass, limits);
  if (!local.ok) return tooMany(local);
  // Tier-2: durable cross-replica fixed-window (Cosmos), best-effort. Dynamic
  // import so the pure tier-1 unit tests never pull the Cosmos SDK at load time.
  const dl = DURABLE_DEFAULTS[routeClass] ?? DURABLE_DEFAULTS.default;
  try {
    const { incrementWindow } = await import('./rate-limit-store');
    const durable = await incrementWindow(`${bucketKey}::${routeClass}`, dl);
    if (durable && durable.count > durable.max) {
      const now = Math.floor(Date.now() / 1000);
      const windowEnd = now - (now % dl.windowSec) + dl.windowSec;
      return tooMany({ limit: dl.max, remaining: 0, reset: windowEnd, retryAfter: Math.max(1, windowEnd - now) });
    }
  } catch {
    /* fail open — tier-1 already enforced the per-replica burst cap */
  }
  return null;
}

/** Two-tier enforce keyed by the session principal (oid). Use in authed routes. */
export function enforceRateLimit(
  session: SessionPayload | null,
  routeClass: string,
  limits?: RateLimits,
): Promise<NextResponse | null> {
  return enforce(session?.claims?.oid || 'anon', routeClass, limits);
}

/**
 * Two-tier enforce keyed by an arbitrary string (e.g. client IP) — for
 * anonymous routes (sign-in, auto-error feedback) that have no session yet.
 */
export function enforceRateLimitForKey(
  key: string,
  routeClass: string,
  limits?: RateLimits,
): Promise<NextResponse | null> {
  return enforce(key || 'anon', routeClass, limits);
}

/**
 * Best-effort client IP from proxy headers (Front Door → Container Apps set
 * `x-forwarded-for`). Takes the first (client-most) hop. Falls back to
 * `x-real-ip`, then a constant so anonymous limiting still shares one bucket
 * rather than throwing.
 */
export function clientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() || 'unknown-ip';
}

/** Test-only: clear the in-proc bucket store. */
export function __resetRateLimiter(): void {
  buckets.clear();
}
