/**
 * Unit tests for the F21 usage telemetry client. queryLogs (the Log Analytics
 * REST call) is mocked so we exercise the pure KQL-row → typed-array shaping
 * and the MonitorNotConfiguredError propagation. No network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factory (itself hoisted) can reference them safely.
const { queryLogs, MonitorNotConfiguredError } = vi.hoisted(() => {
  class MonitorNotConfiguredError extends Error {
    constructor(public missing: string[]) {
      super(`Monitor not configured. Missing env: ${missing.join(', ')}`);
      this.name = 'MonitorNotConfiguredError';
    }
  }
  return { queryLogs: vi.fn(), MonitorNotConfiguredError };
});

vi.mock('@/lib/azure/monitor-client', () => ({
  queryLogs: (...args: unknown[]) => queryLogs(...args),
  MonitorNotConfiguredError,
}));

import {
  fetchActiveUsersTrend,
  fetchFeatureAdoption,
  fetchTopItemsFromLa,
} from '../usage-client';

beforeEach(() => {
  queryLogs.mockReset();
});

describe('fetchActiveUsersTrend', () => {
  it('shapes day/dau rows by column index regardless of column order', async () => {
    queryLogs.mockResolvedValue({
      columns: ['day', 'dau'],
      rows: [['2026-06-01', 4], ['2026-06-02', 7]],
      rowCount: 2,
    });
    const out = await fetchActiveUsersTrend(14);
    expect(out).toEqual([
      { day: '2026-06-01', dau: 4 },
      { day: '2026-06-02', dau: 7 },
    ]);
    // timespan is the clamped window as an ISO duration.
    expect(queryLogs).toHaveBeenCalledWith(expect.stringContaining('AppRequests'), 'P14D');
  });

  it('clamps the window to 1..90 days', async () => {
    queryLogs.mockResolvedValue({ columns: ['day', 'dau'], rows: [], rowCount: 0 });
    await fetchActiveUsersTrend(999);
    expect(queryLogs).toHaveBeenCalledWith(expect.any(String), 'P90D');
    await fetchActiveUsersTrend(0);
    expect(queryLogs).toHaveBeenLastCalledWith(expect.any(String), 'P1D');
  });

  it('propagates MonitorNotConfiguredError so the route can gate honestly', async () => {
    queryLogs.mockRejectedValue(new MonitorNotConfiguredError(['LOOM_LOG_ANALYTICS_WORKSPACE_ID']));
    await expect(fetchActiveUsersTrend()).rejects.toBeInstanceOf(MonitorNotConfiguredError);
  });
});

describe('fetchFeatureAdoption', () => {
  it('returns feature/events/users rows and drops empty features', async () => {
    queryLogs.mockResolvedValue({
      columns: ['feature', 'events', 'users'],
      rows: [['items', 120, 9], ['monitor', 30, 4], ['', 5, 1]],
      rowCount: 3,
    });
    const out = await fetchFeatureAdoption(30);
    expect(out).toEqual([
      { feature: 'items', events: 120, users: 9 },
      { feature: 'monitor', events: 30, users: 4 },
    ]);
  });

  it('injects a sanitized feature filter for drill-through', async () => {
    queryLogs.mockResolvedValue({ columns: ['feature', 'events', 'users'], rows: [], rowCount: 0 });
    await fetchFeatureAdoption(7, "items'; drop");
    const kql = queryLogs.mock.calls[0][0] as string;
    // single quotes are doubled (KQL escaping) — no raw injection.
    expect(kql).toContain("feature == 'items''; drop'");
  });
});

describe('fetchTopItemsFromLa', () => {
  it('shapes itemId/events rows', async () => {
    queryLogs.mockResolvedValue({
      columns: ['itemId', 'events'],
      rows: [['11111111-1111-1111-1111-111111111111', 42]],
      rowCount: 1,
    });
    const out = await fetchTopItemsFromLa();
    expect(out).toEqual([{ itemId: '11111111-1111-1111-1111-111111111111', events: 42 }]);
  });

  it('returns [] when the expected column is absent', async () => {
    queryLogs.mockResolvedValue({ columns: ['somethingElse'], rows: [['x']], rowCount: 1 });
    expect(await fetchTopItemsFromLa()).toEqual([]);
  });
});
