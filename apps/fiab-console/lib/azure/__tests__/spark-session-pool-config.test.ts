/**
 * PSR-3 — warm Spark pool config: DEFAULT-ON / opt-out + FGC-10 concurrent mode.
 *
 * Pure config resolution (reads env, no backend). Asserts the die-hard
 * default-ON posture (loom_default_on_opt_out): enabled unless explicitly
 * disabled, plus the high-concurrency shared-session toggle + its lease cap.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sparkPoolConfig, sparkPoolEnabled } from '../spark-session-pool';

const KEYS = [
  'LOOM_SPARK_POOL_ENABLED',
  'LOOM_SPARK_POOL_MIN',
  'LOOM_SPARK_POOL_MAX',
  'LOOM_SPARK_POOL_IDLE_TTL',
  'LOOM_SPARK_POOL_CONCURRENT',
  'LOOM_SPARK_POOL_SHARED_MAX',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('sparkPoolConfig — default-ON / opt-out', () => {
  it('is ENABLED by default (no env)', () => {
    expect(sparkPoolConfig().enabled).toBe(true);
    expect(sparkPoolEnabled()).toBe(true);
  });

  it('stays enabled for truthy-ish values', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
      process.env.LOOM_SPARK_POOL_ENABLED = v;
      expect(sparkPoolConfig().enabled).toBe(true);
    }
  });

  it('is disabled ONLY by an explicit opt-out value (kill switch)', () => {
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
      process.env.LOOM_SPARK_POOL_ENABLED = v;
      expect(sparkPoolConfig().enabled).toBe(false);
    }
  });

  it('defaults min/max/idle to the documented values', () => {
    const c = sparkPoolConfig();
    expect(c.min).toBe(1);
    expect(c.max).toBe(3);
    expect(c.idleTtlMs).toBe(900_000);
  });

  it('keeps max >= min', () => {
    process.env.LOOM_SPARK_POOL_MIN = '5';
    process.env.LOOM_SPARK_POOL_MAX = '2';
    expect(sparkPoolConfig().max).toBeGreaterThanOrEqual(5);
  });
});

describe('sparkPoolConfig — FGC-10 concurrent shared-session mode', () => {
  it('concurrent mode is ON by default', () => {
    expect(sparkPoolConfig().concurrent).toBe(true);
  });

  it('concurrent mode opts out with 0/false', () => {
    process.env.LOOM_SPARK_POOL_CONCURRENT = '0';
    expect(sparkPoolConfig().concurrent).toBe(false);
    process.env.LOOM_SPARK_POOL_CONCURRENT = 'false';
    expect(sparkPoolConfig().concurrent).toBe(false);
  });

  it('maxLeasesPerSession defaults to 4 and never drops below 1', () => {
    expect(sparkPoolConfig().maxLeasesPerSession).toBe(4);
    process.env.LOOM_SPARK_POOL_SHARED_MAX = '8';
    expect(sparkPoolConfig().maxLeasesPerSession).toBe(8);
    process.env.LOOM_SPARK_POOL_SHARED_MAX = '0';
    expect(sparkPoolConfig().maxLeasesPerSession).toBeGreaterThanOrEqual(1);
  });
});
