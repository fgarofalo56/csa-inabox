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
 * Default: OFF. With LOOM_RATE_LIMIT unset (or anything other than 'on'),
 * checkRate() ALWAYS returns ok=true and withRateLimit() ALWAYS returns null —
 * a pure no-op so this is additive and safe to merge before any route opts in.
 * Set LOOM_RATE_LIMIT=on to engage the token bucket.
 *
 * Storage: in-process LRU map of buckets, capped + idle-evicted. This is
 * per-pod and resets on restart — fine for coarse abuse protection on a single
 * Container App replica. A durable, cross-replica limiter (Redis token bucket)
 * is the follow-up; this module's surface (checkRate/withRateLimit) is the
 * seam a Redis backend would slot behind unchanged.
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

/** Per-class default budgets; tuned coarse — real limits passed by callers. */
const DEFAULTS: Record<string, RateLimits> = {
  default: { ratePerSec: 5, burst: 10 },
  provision: { ratePerSec: 1, burst: 3 },
  query: { ratePerSec: 5, burst: 15 },
  chat: { ratePerSec: 2, burst: 6 },
};

const MAX_BUCKETS = 5000;
/** In-proc LRU. JS Map preserves insertion order → oldest key is first. */
const buckets = new Map<string, Bucket>();

export function rateLimitEnabled(): boolean {
  return (process.env.LOOM_RATE_LIMIT ?? '').toLowerCase() === 'on';
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

/**
 * Route helper. Returns a 429 NextResponse (with x-ratelimit-* + Retry-After
 * headers) when the caller is over budget, or null to proceed. Always null when
 * disabled. Use: `const limited = withRateLimit(session, 'query'); if (limited) return limited;`
 */
export function withRateLimit(
  session: SessionPayload | null,
  routeClass: string,
  limits?: RateLimits,
): NextResponse | null {
  const oid = session?.claims?.oid ?? '';
  const r = checkRate(oid, routeClass, limits);
  if (r.ok) return null;
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

/** Test-only: clear the in-proc bucket store. */
export function __resetRateLimiter(): void {
  buckets.clear();
}
