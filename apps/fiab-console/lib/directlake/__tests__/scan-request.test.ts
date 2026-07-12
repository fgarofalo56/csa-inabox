import { describe, it, expect } from 'vitest';
import {
  normalizeScanBody,
  normalizeFrameBody,
  buildScanUrl,
  buildFrameUrl,
  buildServiceUrl,
  MAX_SCAN_LIMIT,
} from '../scan-request';

describe('directlake/scan-request normalization (HYP-5)', () => {
  it('requires a non-empty path', () => {
    for (const body of [null, {}, { path: '' }, { path: '   ' }, { path: 42 }]) {
      const r = normalizeScanBody(body as any);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/path.*required/i);
    }
  });

  it('accepts fixture / file / abfss sources and trims the path', () => {
    for (const p of [
      'fixture://sales',
      'file:///app/fixtures/sales.parquet',
      'abfss://c@acct.dfs.core.windows.net/sales',
    ]) {
      const r = normalizeScanBody({ path: `  ${p}  ` });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.path).toBe(p);
    }
  });

  it('keeps only non-empty string projection columns, else drops the key', () => {
    const r = normalizeScanBody({
      path: 'fixture://sales',
      projection: ['region', '', '  ', 7, null, 'amount'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.projection).toEqual(['region', 'amount']);

    const none = normalizeScanBody({ path: 'fixture://sales', projection: ['', '  '] });
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.value.projection).toBeUndefined();

    const absent = normalizeScanBody({ path: 'fixture://sales' });
    if (absent.ok) expect(absent.value.projection).toBeUndefined();
  });

  it('coerces + clamps the limit; drops invalid limits so the service default applies', () => {
    const clamp = normalizeScanBody({ path: 'fixture://sales', limit: 9e9 });
    if (clamp.ok) expect(clamp.value.limit).toBe(MAX_SCAN_LIMIT);

    const floor = normalizeScanBody({ path: 'fixture://sales', limit: 3.9 });
    if (floor.ok) expect(floor.value.limit).toBe(3);

    for (const bad of [0, -1, NaN, Infinity, '10', undefined]) {
      const r = normalizeScanBody({ path: 'fixture://sales', limit: bad as any });
      if (r.ok) expect(r.value.limit).toBeUndefined();
    }
  });

  it('builds the /scan URL, adding https:// when scheme-less and trimming a trailing slash', () => {
    expect(buildScanUrl('loom-directlake.internal')).toBe('https://loom-directlake.internal/scan');
    expect(buildScanUrl('https://loom-directlake.internal/')).toBe('https://loom-directlake.internal/scan');
    expect(buildScanUrl('http://localhost:8080')).toBe('http://localhost:8080/scan');
  });
});

describe('directlake/frame-request normalization (framing = metadata-only version pin)', () => {
  it('requires a non-empty path, with the same message as scan', () => {
    for (const body of [null, {}, { path: '' }, { path: '   ' }, { path: 42 }]) {
      const r = normalizeFrameBody(body as any);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/path.*required/i);
    }
  });

  it('accepts fixture / file / abfss sources and trims the path (no projection/limit)', () => {
    for (const p of [
      'fixture://sales',
      'file:///app/fixtures/sales.parquet',
      'abfss://c@acct.dfs.core.windows.net/sales',
    ]) {
      const r = normalizeFrameBody({ path: `  ${p}  ` });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.path).toBe(p);
        // Framing carries ONLY a path — no projection/limit keys leak through.
        expect(Object.keys(r.value)).toEqual(['path']);
      }
    }
  });

  it('ignores extra fields (projection/limit) that only apply to a scan', () => {
    const r = normalizeFrameBody({ path: 'fixture://sales', projection: ['region'], limit: 5 } as any);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ path: 'fixture://sales' });
  });

  it('builds the /frame URL, adding https:// when scheme-less and trimming a trailing slash', () => {
    expect(buildFrameUrl('loom-directlake.internal')).toBe('https://loom-directlake.internal/frame');
    expect(buildFrameUrl('https://loom-directlake.internal/')).toBe('https://loom-directlake.internal/frame');
    expect(buildFrameUrl('http://localhost:8080')).toBe('http://localhost:8080/frame');
  });

  it('buildServiceUrl derives scan + frame from the shared builder', () => {
    expect(buildServiceUrl('loom-directlake.internal', 'scan')).toBe('https://loom-directlake.internal/scan');
    expect(buildServiceUrl('loom-directlake.internal', 'frame')).toBe('https://loom-directlake.internal/frame');
  });
});
