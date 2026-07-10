/**
 * Tests for the PSR-5 additions to query-result-cache: per-backend TTL
 * resolution, the env-token normalizer, and backend inclusion in the cache key.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  backendEnvToken,
  ttlMsForBackend,
  buildQueryCacheKey,
} from '../query-result-cache';

const ORIG = { ...process.env };
afterEach(() => {
  process.env = { ...ORIG };
});

describe('backendEnvToken', () => {
  it('uppercases and strips to A-Z0-9_', () => {
    expect(backendEnvToken('serverless')).toBe('SERVERLESS');
    expect(backendEnvToken('analysis-services')).toBe('ANALYSIS_SERVICES');
    expect(backendEnvToken('loom native!')).toBe('LOOM_NATIVE');
  });
  it('returns empty for undefined', () => {
    expect(backendEnvToken(undefined)).toBe('');
  });
});

describe('ttlMsForBackend', () => {
  it('prefers the per-backend env override', () => {
    process.env.LOOM_QUERY_CACHE_TTL_MS = '60000';
    process.env.LOOM_QUERY_CACHE_TTL_MS_DEDICATED = '300000';
    expect(ttlMsForBackend('dedicated')).toBe(300000);
  });
  it('falls back to the generic TTL when no per-backend override', () => {
    process.env.LOOM_QUERY_CACHE_TTL_MS = '45000';
    delete process.env.LOOM_QUERY_CACHE_TTL_MS_SERVERLESS;
    expect(ttlMsForBackend('serverless')).toBe(45000);
  });
  it('defaults to 60s when nothing is set', () => {
    delete process.env.LOOM_QUERY_CACHE_TTL_MS;
    expect(ttlMsForBackend()).toBe(60000);
  });
});

describe('buildQueryCacheKey backend isolation', () => {
  it('produces different keys for different backends', () => {
    const base = { modelId: 'm1', sql: 'SELECT 1', storageMode: 'x' };
    const a = buildQueryCacheKey({ ...base, backend: 'serverless' });
    const b = buildQueryCacheKey({ ...base, backend: 'accel' });
    expect(a).not.toBe(b);
  });
  it('is stable for identical parts', () => {
    const parts = { modelId: 'm1', sql: 'SELECT 1', storageMode: 'x', backend: 'adx' };
    expect(buildQueryCacheKey(parts)).toBe(buildQueryCacheKey({ ...parts }));
  });
});
