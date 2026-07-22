/**
 * RUM1 — PII-scrub + batch-validation unit tests (rum-shared.ts).
 * The scrub is the privacy boundary: these tests pin that ids, emails,
 * tokens and query strings can never survive into a beacon.
 */
import { describe, it, expect } from 'vitest';
import {
  RUM_MAX_ITEMS,
  clampMs,
  clampScore,
  isIdLikeSegment,
  parseRumBatch,
  parseSampleRate,
  scrubSurfacePath,
  scrubText,
} from '../rum-shared';

describe('scrubSurfacePath', () => {
  it('collapses GUID / hex / numeric segments to :id', () => {
    expect(scrubSurfacePath('/items/data-pipeline/0f8fad5b-d9cb-469f-a165-70867728950e/edit'))
      .toBe('/items/data-pipeline/:id/edit');
    expect(scrubSurfacePath('/workspaces/1234567890')).toBe('/workspaces/:id');
    expect(scrubSurfacePath('/x/deadbeefdeadbeefdeadbeef')).toBe('/x/:id');
  });

  it('drops query strings and fragments wholesale', () => {
    expect(scrubSurfacePath('/browse?email=user@contoso.com&token=abc#frag')).toBe('/browse');
  });

  it('strips a full-URL origin', () => {
    expect(scrubSurfacePath('https://loom.example.com/admin/rum')).toBe('/admin/rum');
  });

  it('keeps static route literals intact', () => {
    expect(scrubSurfacePath('/admin/runtime-flags')).toBe('/admin/runtime-flags');
    expect(scrubSurfacePath('/items/data-pipeline')).toBe('/items/data-pipeline');
    expect(scrubSurfacePath('/')).toBe('/');
  });

  it('scrubs @-ish and long random segments', () => {
    expect(scrubSurfacePath('/users/someone@contoso.com/profile')).toBe('/users/:id/profile');
    expect(scrubSurfacePath('/x/a1b2c3d4e5f6g7h8i9j0k1')).toBe('/x/:id');
  });

  it('bounds depth and length', () => {
    const deep = `/${Array.from({ length: 20 }, (_, i) => `seg${i}`).join('/')}`;
    expect(scrubSurfacePath(deep).split('/').filter(Boolean).length).toBeLessThanOrEqual(8);
    expect(scrubSurfacePath(`/${'a'.repeat(500)}`).length).toBeLessThanOrEqual(200);
  });
});

describe('isIdLikeSegment', () => {
  it('recognizes ids, not literals', () => {
    expect(isIdLikeSegment('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
    expect(isIdLikeSegment('12345678')).toBe(true);
    expect(isIdLikeSegment('report-designer')).toBe(false);
    expect(isIdLikeSegment('phase4')).toBe(false);
    expect(isIdLikeSegment('v1')).toBe(false);
  });
});

describe('scrubText', () => {
  it('scrubs emails, GUIDs, JWTs, bearer tokens and URL queries', () => {
    const s = scrubText(
      'user fgarofalo@contoso.com hit 0f8fad5b-d9cb-469f-a165-70867728950e with ' +
        'Bearer abc.def.ghi and eyJhbGciOi.eyJzdWIi.c2lnbmF0dXJl at /api/x?secret=1',
    );
    expect(s).not.toContain('fgarofalo@contoso.com');
    expect(s).not.toContain('0f8fad5b');
    expect(s).not.toContain('secret=1');
    expect(s).not.toContain('eyJhbGciOi.eyJzdWIi');
    expect(s).toContain('[email]');
    expect(s).toContain('[id]');
  });

  it('caps length', () => {
    expect(scrubText('x'.repeat(1000)).length).toBeLessThanOrEqual(301);
  });
});

describe('clamps + sample rate', () => {
  it('clampMs bounds to [0, 10min] and rejects junk', () => {
    expect(clampMs(1234.6)).toBe(1235);
    expect(clampMs(-5)).toBeUndefined();
    expect(clampMs(NaN)).toBeUndefined();
    expect(clampMs('x' as unknown)).toBeUndefined();
    expect(clampMs(99_999_999)).toBe(600_000);
  });

  it('clampScore bounds CLS', () => {
    expect(clampScore(0.1234)).toBe(0.123);
    expect(clampScore(99)).toBe(10);
  });

  it('parseSampleRate defaults 100 and clamps 0-100', () => {
    expect(parseSampleRate(undefined)).toBe(100);
    expect(parseSampleRate('')).toBe(100);
    expect(parseSampleRate('25')).toBe(25);
    expect(parseSampleRate('-3')).toBe(0);
    expect(parseSampleRate('250')).toBe(100);
  });
});

describe('parseRumBatch', () => {
  it('accepts {items:[...]} and bare arrays, drops junk, re-scrubs', () => {
    const items = parseRumBatch({
      items: [
        { kind: 'pageLoad', surface: '/items/x/0f8fad5b-d9cb-469f-a165-70867728950e', at: new Date().toISOString(), totalMs: 812.4, networkMs: 20 },
        { kind: 'error', surface: '/a?q=1', name: 'TypeError', message: 'user@x.com boom', at: 'not-a-date' },
        { kind: 'nonsense', surface: '/x' },
        null,
        { kind: 'pageLoad', surface: '/y' }, // no totalMs → dropped
        { kind: 'vitals', surface: '/z', lcpMs: 1500, cls: 0.02 },
        { kind: 'routeChange', surface: '/browse' },
      ],
    });
    expect(items.map((i) => i.kind)).toEqual(['pageLoad', 'error', 'vitals', 'routeChange']);
    const load = items[0] as Extract<(typeof items)[number], { kind: 'pageLoad' }>;
    expect(load.surface).toBe('/items/x/:id');
    expect(load.totalMs).toBe(812);
    const err = items[1] as Extract<(typeof items)[number], { kind: 'error' }>;
    expect(err.message).not.toContain('user@x.com');
    expect(err.surface).toBe('/a');
    expect(Date.parse(err.at)).not.toBeNaN();
  });

  it('caps at RUM_MAX_ITEMS', () => {
    const many = Array.from({ length: 100 }, () => ({ kind: 'routeChange', surface: '/x' }));
    expect(parseRumBatch(many).length).toBe(RUM_MAX_ITEMS);
  });

  it('returns [] for non-batches', () => {
    expect(parseRumBatch(null)).toEqual([]);
    expect(parseRumBatch('x')).toEqual([]);
    expect(parseRumBatch({})).toEqual([]);
  });

  it('drops vitals items with no measurements', () => {
    expect(parseRumBatch([{ kind: 'vitals', surface: '/x' }])).toEqual([]);
  });
});
