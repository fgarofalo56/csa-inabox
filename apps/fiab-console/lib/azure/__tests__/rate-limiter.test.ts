/**
 * Per-principal token-bucket rate limiter — Phase-2D.
 *
 * Guards: default OFF is a true no-op (additive), and when LOOM_RATE_LIMIT=on
 * the bucket allows the burst then 429s with the right headers + refills over
 * time. Per (oid, class) isolation. Pure CPU — no network.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { SessionPayload } from '../../auth/session';
import { checkRate, withRateLimit, rateLimitEnabled, __resetRateLimiter } from '../rate-limiter';

const SAVED = { ...process.env };
const session = (oid: string): SessionPayload => ({ claims: { oid, name: 'n', upn: 'u' }, exp: 0 });

afterEach(() => {
  process.env = { ...SAVED };
  __resetRateLimiter();
  vi.useRealTimers();
});
beforeEach(() => {
  __resetRateLimiter();
});

describe('default OFF — no-op', () => {
  it('checkRate always ok with LOOM_RATE_LIMIT unset', () => {
    delete process.env.LOOM_RATE_LIMIT;
    expect(rateLimitEnabled()).toBe(false);
    for (let i = 0; i < 100; i++) expect(checkRate('o1', 'query').ok).toBe(true);
  });
  it('withRateLimit returns null when disabled', () => {
    delete process.env.LOOM_RATE_LIMIT;
    for (let i = 0; i < 100; i++) expect(withRateLimit(session('o1'), 'query')).toBeNull();
  });
});

describe('LOOM_RATE_LIMIT=on — token bucket', () => {
  beforeEach(() => { process.env.LOOM_RATE_LIMIT = 'on'; });
  it('allows burst then 429s', () => {
    const limits = { ratePerSec: 1, burst: 3 };
    for (let i = 0; i < 3; i++) expect(checkRate('o1', 'c', limits).ok).toBe(true);
    const r = checkRate('o1', 'c', limits);
    expect(r.ok).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(0);
    expect(r.remaining).toBe(0);
    expect(r.limit).toBe(3);
  });
  it('isolates per oid and per class', () => {
    const limits = { ratePerSec: 1, burst: 2 };
    expect(checkRate('a', 'c', limits).ok).toBe(true);
    expect(checkRate('a', 'c', limits).ok).toBe(true);
    expect(checkRate('a', 'c', limits).ok).toBe(false);
    expect(checkRate('b', 'c', limits).ok).toBe(true);
    expect(checkRate('a', 'other', limits).ok).toBe(true);
  });
  it('withRateLimit returns 429 with headers', () => {
    const limits = { ratePerSec: 1, burst: 1 };
    expect(withRateLimit(session('o1'), 'c', limits)).toBeNull();
    const res = withRateLimit(session('o1'), 'c', limits);
    expect(res?.status).toBe(429);
    expect(res?.headers.get('Retry-After')).toBeTruthy();
    expect(res?.headers.get('x-ratelimit-limit')).toBe('1');
    expect(res?.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(res?.headers.get('x-ratelimit-reset')).toBeTruthy();
  });
  it('refills over time', () => {
    vi.useFakeTimers();
    const limits = { ratePerSec: 10, burst: 1 };
    expect(checkRate('o1', 'c', limits).ok).toBe(true);
    expect(checkRate('o1', 'c', limits).ok).toBe(false);
    vi.advanceTimersByTime(300);
    expect(checkRate('o1', 'c', limits).ok).toBe(true);
  });
});
