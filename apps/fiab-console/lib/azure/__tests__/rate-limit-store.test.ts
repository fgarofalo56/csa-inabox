/**
 * Durable rate-limit tier (tier-2) + the two-tier enforce/clientIp helpers.
 *
 * These exercise the DISABLED / fail-open path only — no live Cosmos. With the
 * durable backend forced off (LOOM_RATE_LIMIT_BACKEND=memory) incrementWindow /
 * seenRecently short-circuit to null BEFORE touching Cosmos, so enforce()
 * degrades to the pure in-memory tier-1 and stays deterministic in CI.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { SessionPayload } from '../../auth/session';
import { durableEnabled, incrementWindow, seenRecently } from '../rate-limit-store';
import { enforceRateLimit, enforceRateLimitForKey, clientIp, __resetRateLimiter } from '../rate-limiter';

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

describe('durable tier — disabled / fail-open', () => {
  it('durableEnabled() is false when backend=memory', () => {
    process.env.LOOM_RATE_LIMIT_BACKEND = 'memory';
    process.env.LOOM_COSMOS_ENDPOINT = 'https://x.documents.azure.com:443/';
    expect(durableEnabled()).toBe(false);
  });
  it('durableEnabled() is false when Cosmos is not configured', () => {
    delete process.env.LOOM_RATE_LIMIT_BACKEND;
    delete process.env.LOOM_COSMOS_ENDPOINT;
    expect(durableEnabled()).toBe(false);
  });
  it('incrementWindow / seenRecently return null when disabled (no Cosmos call)', async () => {
    process.env.LOOM_RATE_LIMIT_BACKEND = 'memory';
    expect(await incrementWindow('k', { windowSec: 60, max: 10 })).toBeNull();
    expect(await seenRecently('h', 3600)).toBeNull();
  });
});

describe('two-tier enforce — tier-1 only (durable off)', () => {
  beforeEach(() => {
    delete process.env.LOOM_RATE_LIMIT;        // default ON
    process.env.LOOM_RATE_LIMIT_BACKEND = 'memory'; // tier-1 only in CI
  });
  it('enforceRateLimit 429s after the in-memory burst', async () => {
    const limits = { ratePerSec: 1, burst: 1 };
    expect(await enforceRateLimit(session('o1'), 'c', limits)).toBeNull();
    const r = await enforceRateLimit(session('o1'), 'c', limits);
    expect(r?.status).toBe(429);
    expect(r?.headers.get('Retry-After')).toBeTruthy();
  });
  it('is a no-op when LOOM_RATE_LIMIT=off', async () => {
    process.env.LOOM_RATE_LIMIT = 'off';
    const limits = { ratePerSec: 1, burst: 1 };
    for (let i = 0; i < 20; i++) expect(await enforceRateLimit(session('o1'), 'c', limits)).toBeNull();
  });
  it('enforceRateLimitForKey isolates by key', async () => {
    const limits = { ratePerSec: 1, burst: 1 };
    expect(await enforceRateLimitForKey('1.2.3.4', 'auth', limits)).toBeNull();
    expect((await enforceRateLimitForKey('1.2.3.4', 'auth', limits))?.status).toBe(429);
    expect(await enforceRateLimitForKey('5.6.7.8', 'auth', limits)).toBeNull();
  });
});

describe('clientIp', () => {
  it('takes the first hop of x-forwarded-for', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }))).toBe('9.9.9.9');
  });
  it('falls back to x-real-ip then a constant', () => {
    expect(clientIp(new Headers({ 'x-real-ip': '8.8.8.8' }))).toBe('8.8.8.8');
    expect(clientIp(new Headers({}))).toBe('unknown-ip');
  });
});
