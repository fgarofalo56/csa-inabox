/**
 * Tests for query-cache.ts — passthrough default, opt-in LRU/TTL keyed by oid,
 * cross-tenant isolation, bust, and the concurrency governor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  withQueryCache,
  bustQueryCache,
  runGoverned,
} from '../query-cache';

const ORIG = { ...process.env };

beforeEach(() => {
  bustQueryCache();
  delete process.env.LOOM_QUERY_CACHE;
  delete process.env.LOOM_QUERY_MAX_CONCURRENCY;
});

afterEach(() => {
  process.env = { ...ORIG };
  vi.restoreAllMocks();
});

describe('withQueryCache', () => {
  it('passthrough by default (cache off): always runs fn', async () => {
    const fn = vi.fn(async () => 'v');
    await withQueryCache('oid1', 'k', 1000, fn);
    await withQueryCache('oid1', 'k', 1000, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('caches per (oid,key) when on', async () => {
    process.env.LOOM_QUERY_CACHE = 'on';
    const fn = vi.fn(async () => 'v');
    const a = await withQueryCache('oid1', 'k', 1000, fn);
    const b = await withQueryCache('oid1', 'k', 1000, fn);
    expect(a).toBe('v');
    expect(b).toBe('v');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('isolates by oid — no cross-tenant read', async () => {
    process.env.LOOM_QUERY_CACHE = 'on';
    const fn = vi.fn(async () => 'v');
    await withQueryCache('oidA', 'k', 1000, fn);
    await withQueryCache('oidB', 'k', 1000, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('honors TTL expiry', async () => {
    process.env.LOOM_QUERY_CACHE = 'on';
    const fn = vi.fn(async () => 'v');
    await withQueryCache('oid1', 'k', 50, fn);
    await new Promise((r) => setTimeout(r, 70));
    await withQueryCache('oid1', 'k', 50, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('bustQueryCache(oid) clears only that tenant', async () => {
    process.env.LOOM_QUERY_CACHE = 'on';
    const fn = vi.fn(async () => 'v');
    await withQueryCache('oidA', 'k', 1000, fn);
    await withQueryCache('oidB', 'k', 1000, fn);
    bustQueryCache('oidA');
    await withQueryCache('oidA', 'k', 1000, fn); // re-run
    await withQueryCache('oidB', 'k', 1000, fn); // still cached
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('runGoverned', () => {
  it('passthrough unlimited when unset', async () => {
    const r = await runGoverned(async () => 42);
    expect(r).toBe(42);
  });

  it('caps concurrency and queues', async () => {
    process.env.LOOM_QUERY_MAX_CONCURRENCY = '2';
    let peak = 0;
    let cur = 0;
    const make = () =>
      runGoverned(async () => {
        cur++;
        peak = Math.max(peak, cur);
        await new Promise((r) => setTimeout(r, 20));
        cur--;
      });
    await Promise.all([make(), make(), make(), make()]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
