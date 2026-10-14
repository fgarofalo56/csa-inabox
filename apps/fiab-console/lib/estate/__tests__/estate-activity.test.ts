/**
 * estate-activity — the throttled human-activity recorder and its reader.
 * Each `it` names the input that breaks it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const upsert = vi.fn(async (d: unknown) => ({ resource: d }));
const read = vi.fn(async () => ({ resource: undefined as unknown }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  maintenanceJobsContainer: vi.fn(async () => ({ items: { upsert }, item: () => ({ read }) })),
}));

import {
  ACTIVITY_WRITE_WINDOW_MS,
  __resetEstateActivityThrottleForTest,
  countsAsHumanActivity,
  loadActivity,
  recordHumanActivity,
} from '../estate-activity';

const human = { claims: { tid: 'tenant-1', oid: 'u1' } };
const T0 = Date.parse('2026-10-13T10:00:00.000Z');

/** The recorder's write is fire-and-forget; let the microtask queue drain. */
const flush = async () => { await new Promise<void>((r) => setTimeout(r, 30)); };

beforeEach(() => {
  vi.clearAllMocks();
  __resetEstateActivityThrottleForTest();
  read.mockResolvedValue({ resource: undefined });
});

describe('recordHumanActivity throttle', () => {
  it('100 requests inside one window produce exactly ONE upsert (breaks if the throttle is removed: 100)', async () => {
    for (let i = 0; i < 100; i += 1) recordHumanActivity(human, '/api/items', T0 + i * 1000);
    await flush();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({
      id: 'estate-activity:current', tenantId: 'tenant-1', kind: 'estate-activity',
      lastActivityAt: new Date(T0).toISOString(),
    });
  });

  it('a request exactly ONE window later writes again (breaks if the window is infinite: 1)', async () => {
    recordHumanActivity(human, '/api/items', T0);
    recordHumanActivity(human, '/api/items', T0 + ACTIVITY_WRITE_WINDOW_MS - 1); // still inside
    recordHumanActivity(human, '/api/items', T0 + ACTIVITY_WRITE_WINDOW_MS); // boundary: due
    await flush();
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('works under fake timers on the real clock default (Date.now)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); // Date only: setImmediate stays real so flush() can drain
    try {
      vi.setSystemTime(T0);
      recordHumanActivity(human, '/api/items');
      vi.setSystemTime(T0 + 60_000);
      recordHumanActivity(human, '/api/items');
      vi.setSystemTime(T0 + ACTIVITY_WRITE_WINDOW_MS + 1);
      recordHumanActivity(human, '/api/items');
      await flush();
      expect(upsert).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('two tenants do not share a window (breaks if the throttle is global: 1)', async () => {
    recordHumanActivity(human, '/api/items', T0);
    recordHumanActivity({ claims: { tid: 'tenant-2', oid: 'u2' } }, '/api/items', T0 + 1);
    await flush();
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('a Cosmos failure never throws into the request path and does not retry inside the window', async () => {
    upsert.mockRejectedValueOnce(new Error('cosmos down'));
    expect(() => recordHumanActivity(human, '/api/items', T0)).not.toThrow();
    recordHumanActivity(human, '/api/items', T0 + 1000);
    await flush();
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('returns whether a write was started (true then false inside the window)', () => {
    expect(recordHumanActivity(human, '/api/items', T0)).toBe(true);
    expect(recordHumanActivity(human, '/api/items', T0 + 1)).toBe(false);
  });
});

describe('what counts as a human', () => {
  it('a PAT (API-token) session is NOT human activity (breaks if `pat` is ignored: writes)', async () => {
    expect(recordHumanActivity({ ...human, pat: { tokenId: 't', scope: 'read-only' } }, '/api/items', T0)).toBe(false);
    await flush();
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([
    '/api/health', '/api/health/deep', '/api/auth/refresh', '/api/estate/power',
    '/api/admin/estate/state', '/api/internal/copilot/tools',
  ])('%s is not activity', async (path) => {
    expect(countsAsHumanActivity(path)).toBe(false);
    expect(recordHumanActivity(human, path, T0)).toBe(false);
    await flush();
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each(['/api/items/lakehouse/1', '/api/admin/estate/pause', '/api/healthcheck-ui', '/admin/scaling'])(
    '%s IS activity (a prefix match without a boundary would wrongly exclude /api/healthcheck-ui)',
    (path) => {
      expect(countsAsHumanActivity(path)).toBe(true);
    },
  );
});

describe('loadActivity', () => {
  const NOW = T0 + 3 * 3600 * 1000;

  it('computes idleForSeconds from the stored time (3h later = 10800, breaks if now/at are swapped: -10800 clamped to 0)', async () => {
    read.mockResolvedValue({ resource: { kind: 'estate-activity', lastActivityAt: new Date(T0).toISOString() } });
    expect(await loadActivity('tenant-1', NOW)).toEqual({
      lastActivityAt: new Date(T0).toISOString(), idleForSeconds: 10800, unreadable: false,
    });
  });

  it('nothing stored -> null/null and NOT unreadable (none recorded, not a failure)', async () => {
    expect(await loadActivity('tenant-1', NOW)).toEqual({ lastActivityAt: null, idleForSeconds: null, unreadable: false });
  });

  it('a Cosmos failure -> null/null and unreadable:true (so null can be told apart from none)', async () => {
    read.mockRejectedValueOnce(new Error('cosmos down'));
    expect(await loadActivity('tenant-1', NOW)).toEqual({ lastActivityAt: null, idleForSeconds: null, unreadable: true });
  });

  it('a corrupt timestamp -> unreadable, never a number', async () => {
    read.mockResolvedValue({ resource: { kind: 'estate-activity', lastActivityAt: 'not-a-date' } });
    const r = await loadActivity('tenant-1', NOW);
    expect(r.idleForSeconds).toBeNull();
    expect(r.unreadable).toBe(true);
  });

  it('a doc of another kind at that id is ignored', async () => {
    read.mockResolvedValue({ resource: { kind: 'something-else', lastActivityAt: new Date(T0).toISOString() } });
    expect((await loadActivity('tenant-1', NOW)).lastActivityAt).toBeNull();
  });
});
