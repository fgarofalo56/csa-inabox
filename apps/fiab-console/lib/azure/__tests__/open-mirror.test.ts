/**
 * Open-mirroring engine helpers — pure path/allowlist logic.
 *
 * These exercise the real exported functions from mirror-engine.ts (no mocks of
 * the module under test). The abfss builders derive their host suffix from the
 * configured LOOM_{LANDING,BRONZE}_URL, so this also pins the sovereign-cloud
 * correctness (Commercial vs USGov) of the resolved paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MERGE_SCHEDULE_OPTIONS,
  openMirrorLandingAbfss,
  openMirrorDeltaAbfss,
  openMirrorOpenrowset,
} from '../mirror-engine';

const ENV_KEYS = ['LOOM_LANDING_URL', 'LOOM_BRONZE_URL'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('MERGE_SCHEDULE_OPTIONS', () => {
  it('is a fixed allowlist (no free-form config)', () => {
    expect(MERGE_SCHEDULE_OPTIONS).toEqual(['on-demand', '15min', '1h', '4h', 'daily']);
  });
});

describe('openMirrorLandingAbfss', () => {
  it('builds the abfss landing root for the configured (commercial) account', () => {
    process.env.LOOM_LANDING_URL = 'https://loomdlz.dfs.core.windows.net/landing';
    expect(openMirrorLandingAbfss('mir-123')).toBe('abfss://landing@loomdlz.dfs.core.windows.net/mir-123');
  });

  it('honours the sovereign (USGov) dfs suffix from the configured URL', () => {
    process.env.LOOM_LANDING_URL = 'https://loomdlz.dfs.core.usgovcloudapi.net/landing';
    expect(openMirrorLandingAbfss('mir-123')).toBe('abfss://landing@loomdlz.dfs.core.usgovcloudapi.net/mir-123');
  });

  it('returns null when LOOM_LANDING_URL is unset (honest gate upstream)', () => {
    delete process.env.LOOM_LANDING_URL;
    expect(openMirrorLandingAbfss('mir-123')).toBeNull();
  });
});

describe('openMirrorDeltaAbfss', () => {
  it('builds the managed-Delta Tables root under bronze', () => {
    process.env.LOOM_BRONZE_URL = 'https://loomdlz.dfs.core.windows.net/bronze';
    expect(openMirrorDeltaAbfss('ws-9', 'mir-123')).toBe(
      'abfss://bronze@loomdlz.dfs.core.windows.net/mirrors/ws-9/mir-123/Tables',
    );
  });
});

describe('openMirrorOpenrowset', () => {
  it('emits a SELECT COUNT(*) over the managed Delta table (FORMAT=DELTA)', () => {
    process.env.LOOM_BRONZE_URL = 'https://loomdlz.dfs.core.windows.net/bronze';
    const sql = openMirrorOpenrowset('ws-9', 'mir-123', 'orders');
    expect(sql).toContain('SELECT COUNT(*)');
    expect(sql).toContain("FORMAT = 'DELTA'");
    expect(sql).toContain('https://loomdlz.dfs.core.windows.net/bronze/mirrors/ws-9/mir-123/Tables/orders');
  });
});
