/**
 * estate-autopause — validation bounds, defaults, and the read/write seam.
 * Each `it` names the input that breaks it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const upsert = vi.fn(async (d: unknown) => ({ resource: d }));
const read = vi.fn(async () => ({ resource: undefined as unknown }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  maintenanceJobsContainer: vi.fn(async () => ({ items: { upsert }, item: () => ({ read }) })),
}));

import { defaultAutoPause, loadAutoPause, saveAutoPause, validateAutoPause } from '../estate-autopause';

beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue({ resource: undefined });
});

describe('validateAutoPause bounds [1, 168]', () => {
  // Boundary pairs: each rejected value is the first one OUTSIDE the range, so an
  // off-by-one (<= vs <) flips exactly one of these.
  it.each([
    [0, false], [0.99, false], [1, true], [2, true], [168, true], [168.01, false], [169, false], [-1, false],
  ])('idleHours %s -> ok:%s', (idleHours, ok) => {
    expect(validateAutoPause({ enabled: true, idleHours }).ok).toBe(ok);
  });

  it.each([[NaN], [Infinity], [-Infinity]])('idleHours %s -> refused (non-finite)', (idleHours) => {
    expect(validateAutoPause({ enabled: true, idleHours }).ok).toBe(false);
  });

  it('a numeric STRING "2" is refused, never coerced', () => {
    expect(validateAutoPause({ enabled: true, idleHours: '2' }).ok).toBe(false);
  });

  it('missing idleHours / null idleHours are refused', () => {
    expect(validateAutoPause({ enabled: true }).ok).toBe(false);
    expect(validateAutoPause({ enabled: true, idleHours: null }).ok).toBe(false);
  });

  it('enabled must be a real boolean ("true", 1, missing are refused)', () => {
    expect(validateAutoPause({ enabled: 'true', idleHours: 2 }).ok).toBe(false);
    expect(validateAutoPause({ enabled: 1, idleHours: 2 }).ok).toBe(false);
    expect(validateAutoPause({ idleHours: 2 }).ok).toBe(false);
  });

  it('non-object bodies (null, string, array-less) are refused', () => {
    expect(validateAutoPause(null).ok).toBe(false);
    expect(validateAutoPause('x').ok).toBe(false);
  });

  it('the error for 169 names the bounds and the value', () => {
    const r = validateAutoPause({ enabled: true, idleHours: 169 });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/between 1 and 168.*169/);
  });

  it('a valid body returns exactly {enabled, idleHours} and drops extra fields', () => {
    expect(validateAutoPause({ enabled: false, idleHours: 6, evil: 'x' })).toEqual({
      ok: true, value: { enabled: false, idleHours: 6 },
    });
  });
});

describe('defaults and persistence', () => {
  it('the default is ARMED at 2 hours (operator decision) -- breaks if default flips to disabled', () => {
    expect(defaultAutoPause()).toMatchObject({ enabled: true, idleHours: 2, source: 'default' });
  });

  it('nothing stored -> the default with source "default"', async () => {
    expect(await loadAutoPause('t1')).toMatchObject({ enabled: true, idleHours: 2, source: 'default' });
  });

  it('a stored doc is returned with source "stored"', async () => {
    read.mockResolvedValue({ resource: { kind: 'estate-autopause', enabled: false, idleHours: 6, updatedAt: 'T', updatedBy: 'u' } });
    expect(await loadAutoPause('t1')).toEqual({ enabled: false, idleHours: 6, source: 'stored', updatedAt: 'T', updatedBy: 'u' });
  });

  it('a Cosmos failure -> source "unreadable" (NOT "default": a consumer must not act on it)', async () => {
    read.mockRejectedValueOnce(new Error('down'));
    expect((await loadAutoPause('t1')).source).toBe('unreadable');
  });

  it('a corrupt stored doc (idleHours 9999) -> unreadable, never trusted', async () => {
    read.mockResolvedValue({ resource: { kind: 'estate-autopause', enabled: true, idleHours: 9999 } });
    expect((await loadAutoPause('t1')).source).toBe('unreadable');
  });

  it('save upserts the fixed doc id in the tenant partition and returns source "stored"', async () => {
    const out = await saveAutoPause('t1', { enabled: true, idleHours: 4 }, 'admin@x');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: 'estate-autopause:current', tenantId: 't1', kind: 'estate-autopause', enabled: true, idleHours: 4, updatedBy: 'admin@x',
    }));
    expect(out).toMatchObject({ enabled: true, idleHours: 4, source: 'stored', updatedBy: 'admin@x' });
  });

  it('save PROPAGATES a Cosmos failure (a PUT must not claim success)', async () => {
    upsert.mockRejectedValueOnce(new Error('down'));
    await expect(saveAutoPause('t1', { enabled: true, idleHours: 4 }, 'a')).rejects.toThrow('down');
  });
});
