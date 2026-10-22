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

describe('validateAutoPause containerApps policy', () => {
  const base = { enabled: true, idleHours: 2 };

  it('absent -> value has NO containerApps key (so a save without it leaves stored opt-outs alone)', () => {
    const r = validateAutoPause(base);
    expect(r).toEqual({ ok: true, value: { enabled: true, idleHours: 2 } });
    expect('containerApps' in (r as { value: object }).value).toBe(false);
  });

  it('exempt names are trimmed, lower-cased and de-duplicated', () => {
    const r = validateAutoPause({ ...base, containerApps: { enabled: true, exempt: [' Loom-UDF-Runtime ', 'loom-udf-runtime', 'loom-dab-preview'] } });
    expect(r).toEqual({ ok: true, value: { ...base, containerApps: { enabled: true, exempt: ['loom-udf-runtime', 'loom-dab-preview'] } } });
  });

  it.each([
    ['null', null], ['array', []], ['string', 'x'],
    ['enabled as string', { enabled: 'true', exempt: [] }],
    ['enabled missing', { exempt: [] }],
    ['exempt missing', { enabled: true }],
    ['exempt not an array', { enabled: true, exempt: 'loom-udf-runtime' }],
    ['non-string name', { enabled: true, exempt: [7] }],
    ['underscore (not a valid ACA name char)',{ enabled: true, exempt: ['loom_mcp'] }],
    ['single char (ACA names are 2-32)', { enabled: true, exempt: ['a'] }],
    ['33 chars', { enabled: true, exempt: ['a'.repeat(33)] }],
    ['empty string', { enabled: true, exempt: [''] }],
    ['101 names', { enabled: true, exempt: Array.from({ length: 101 }, (_, i) => `app-${i}`) }],
  ])('containerApps %s -> refused, never coerced or dropped', (_label, containerApps) => {
    expect(validateAutoPause({ ...base, containerApps }).ok).toBe(false);
  });

  it('32 chars and exactly 100 names are accepted (the boundary, one inside each limit)', () => {
    const r = validateAutoPause({ ...base, containerApps: { enabled: false, exempt: ['a'.repeat(32)] } });
    expect(r.ok).toBe(true);
    const many = validateAutoPause({ ...base, containerApps: { enabled: true, exempt: Array.from({ length: 100 }, (_, i) => `app-${i}`) } });
    expect(many.ok).toBe(true);
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
    // A doc written BEFORE 2026-10-22 has no containerApps field: it must read as the
    // default (ON, nothing exempt), not as "off". Breaks if a missing field is read as disabled.
    expect(await loadAutoPause('t1')).toEqual({
      enabled: false, idleHours: 6, containerApps: { enabled: true, exempt: [] },
      source: 'stored', updatedAt: 'T', updatedBy: 'u',
    });
  });

  it('a stored containerApps policy round-trips (opt-out + exemptions are read back, not defaulted)', async () => {
    read.mockResolvedValue({ resource: {
      kind: 'estate-autopause', enabled: true, idleHours: 2, updatedAt: 'T', updatedBy: 'u',
      containerApps: { enabled: false, exempt: ['loom-udf-runtime', 'loom-dab-preview'] },
    } });
    expect((await loadAutoPause('t1')).containerApps).toEqual({ enabled: false, exempt: ['loom-udf-runtime', 'loom-dab-preview'] });
  });

  it('a stored doc whose containerApps is malformed -> unreadable (never partially trusted)', async () => {
    read.mockResolvedValue({ resource: { kind: 'estate-autopause', enabled: true, idleHours: 2, containerApps: { enabled: 'yes', exempt: [] } } });
    const out = await loadAutoPause('t1');
    expect(out.source).toBe('unreadable');
    expect(out.containerApps).toEqual({ enabled: true, exempt: [] });
  });

  it('the default policy includes Container Apps (ON) with nothing exempt -- breaks if the default flips to opt-in', () => {
    expect(defaultAutoPause().containerApps).toEqual({ enabled: true, exempt: [] });
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

  it('save persists the supplied containerApps policy in the doc (global opt-out + exemptions)', async () => {
    const policy = { enabled: false, exempt: ['loom-udf-runtime'] };
    const out = await saveAutoPause('t1', { enabled: true, idleHours: 4, containerApps: policy }, 'admin@x');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ containerApps: policy }));
    expect(out.containerApps).toEqual(policy);
  });

  it('save without a policy writes the DEFAULT (on, nothing exempt), never an absent field', async () => {
    await saveAutoPause('t1', { enabled: true, idleHours: 4 }, 'admin@x');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ containerApps: { enabled: true, exempt: [] } }));
  });

  it('save PROPAGATES a Cosmos failure (a PUT must not claim success)', async () => {
    upsert.mockRejectedValueOnce(new Error('down'));
    await expect(saveAutoPause('t1', { enabled: true, idleHours: 4 }, 'a')).rejects.toThrow('down');
  });
});
