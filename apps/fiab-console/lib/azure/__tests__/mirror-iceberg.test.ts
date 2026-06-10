import { describe, it, expect, afterEach } from 'vitest';
import {
  normalizeIcebergRoot, abfssToHttps, icebergTablePaths, icebergOpenrowset, buildIcebergResults,
} from '../mirror-iceberg';

const ORIG_LOOM = process.env.LOOM_CLOUD;
afterEach(() => {
  if (ORIG_LOOM === undefined) delete process.env.LOOM_CLOUD;
  else process.env.LOOM_CLOUD = ORIG_LOOM;
});

describe('normalizeIcebergRoot', () => {
  it('passes an abfss URL through (slash-trimmed)', () => {
    expect(normalizeIcebergRoot('abfss://ice@acct.dfs.core.windows.net/snow/'))
      .toBe('abfss://ice@acct.dfs.core.windows.net/snow');
  });
  it('converts an https dfs URL to abfss (Commercial)', () => {
    process.env.LOOM_CLOUD = 'Commercial';
    expect(normalizeIcebergRoot('https://acct.dfs.core.windows.net/ice/snow'))
      .toBe('abfss://ice@acct.dfs.core.windows.net/snow');
  });
  it('converts a GCC-High usgov dfs URL to abfss', () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    expect(normalizeIcebergRoot('https://acct.dfs.core.usgovcloudapi.net/ice/snow'))
      .toBe('abfss://ice@acct.dfs.core.usgovcloudapi.net/snow');
  });
  it('returns null for empty / non-ADLS URLs', () => {
    expect(normalizeIcebergRoot('')).toBeNull();
    expect(normalizeIcebergRoot(undefined)).toBeNull();
    expect(normalizeIcebergRoot('https://example.com/x')).toBeNull();
  });
});

describe('abfssToHttps', () => {
  it('inverts the abfss shape this module produces', () => {
    expect(abfssToHttps('abfss://ice@acct.dfs.core.windows.net/snow/PUBLIC/T'))
      .toBe('https://acct.dfs.core.windows.net/ice/snow/PUBLIC/T');
  });
  it('leaves a non-abfss URL unchanged', () => {
    expect(abfssToHttps('https://acct.dfs.core.windows.net/ice/x')).toBe('https://acct.dfs.core.windows.net/ice/x');
  });
});

describe('icebergTablePaths', () => {
  const root = 'abfss://ice@acct.dfs.core.windows.net/snow';
  it('defaults the folder to schema/table', () => {
    const p = icebergTablePaths(root, { schema: 'PUBLIC', table: 'Orders' });
    expect(p.abfss).toBe('abfss://ice@acct.dfs.core.windows.net/snow/PUBLIC/Orders');
    expect(p.https).toBe('https://acct.dfs.core.windows.net/ice/snow/PUBLIC/Orders');
  });
  it('honors an explicit folder', () => {
    const p = icebergTablePaths(root, { schema: 'PUBLIC', table: 'Orders', folder: 'volumes/orders_v2' });
    expect(p.abfss).toBe('abfss://ice@acct.dfs.core.windows.net/snow/volumes/orders_v2');
  });
});

describe('icebergOpenrowset', () => {
  it('builds a DELTA OPENROWSET over the folder', () => {
    const q = icebergOpenrowset('https://acct.dfs.core.windows.net/ice/snow/PUBLIC/T');
    expect(q).toContain("FORMAT = 'DELTA'");
    expect(q).toContain("OPENROWSET(BULK 'https://acct.dfs.core.windows.net/ice/snow/PUBLIC/T/'");
  });
});

describe('buildIcebergResults', () => {
  it('returns null root + no tables when the storage URL is missing', () => {
    const r = buildIcebergResults({ includeIceberg: true, icebergTables: [{ schema: 'PUBLIC', table: 'T' }] }, 'now');
    expect(r.root).toBeNull();
    expect(r.tables).toHaveLength(0);
  });
  it('produces one registered row per Iceberg table with an in-place accessor', () => {
    const r = buildIcebergResults({
      includeIceberg: true,
      icebergStorageUrl: 'abfss://ice@acct.dfs.core.windows.net/snow',
      icebergTables: [{ schema: 'PUBLIC', table: 'Orders' }, { schema: 'SALES', table: 'Fact' }],
    }, 'ts');
    expect(r.root).toBe('abfss://ice@acct.dfs.core.windows.net/snow');
    expect(r.tables).toHaveLength(2);
    expect(r.tables[0]).toMatchObject({ schema: 'PUBLIC', table: 'Orders', kind: 'iceberg', status: 'registered' });
    expect(r.tables[0].openrowset).toContain("FORMAT = 'DELTA'");
    expect(r.tables[0].path).toContain('abfss://ice@acct.dfs.core.windows.net/snow/PUBLIC/Orders');
    expect(r.tables[0].httpsPath).toContain('https://acct.dfs.core.windows.net/ice/snow/PUBLIC/Orders');
  });
});
