/**
 * Snowflake "Include Iceberg tables" — unit tests for the Azure-native path.
 *
 * Covers the pure URL parser (parseAdlsUrl), the honest gates + a positive
 * registration in registerIcebergTables, and runMirrorSnapshot's Snowflake
 * branch (Iceberg off → copy-runtime gate with the new hint; Iceberg on but no
 * path → an honest Iceberg-path gate; Iceberg on with a path → real listPaths
 * enumeration → registered tables with Synapse OPENROWSET).
 *
 * Every Azure-SDK-importing module of mirror-engine is mocked so the real SDKs
 * (@azure/identity, @azure/cosmos, mssql) never load — the shared pnpm store
 * omits some of their transitive packages under vitest's ESM loader
 * (documented broken-harness workaround). No live Azure, no fabricated data on
 * the code path under test (listPaths is stubbed to mimic a real ADLS listing).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const listPathsMock = vi.fn(async () => [] as any[]);

vi.mock('../adls-client', () => ({
  getAccountName: () => 'acct',
  pathToHttpsUrl: (c: string, p: string) => `https://acct.dfs.core.windows.net/${c}/${p}`,
  pathToHttpsUrlFor: (acct: string, c: string, p: string) => `https://${acct}.dfs.core.windows.net/${c}/${p}`,
  resolveAbfssRoot: (c: string, p: string) => `abfss://${c}@acct.dfs.core.windows.net/${p}`,
  uploadFile: vi.fn(async () => {}),
  listPaths: (...a: any[]) => listPathsMock(...a),
}));
vi.mock('../cloud-endpoints', () => ({ dfsSuffix: () => 'dfs.core.windows.net', httpsToAbfss: (u: string) => u }));
vi.mock('../azure-sql-client', () => ({ executeParameterized: vi.fn(), enableMirroring: vi.fn() }));
vi.mock('../sql-objects-client', () => ({ listTables: vi.fn(async () => []), sqlConfigGate: () => null }));
vi.mock('../postgres-flex-client', () => ({ executePostgresQuery: vi.fn(), listPostgresTables: vi.fn(async () => []), postgresQueryGate: () => null }));
vi.mock('../cosmos-data-client', () => ({ queryItems: vi.fn() }));
vi.mock('../cosmos-account-client', () => ({ listContainers: vi.fn(async () => []) }));
vi.mock('../synapse-dev-client', () => ({ submitSparkBatchJob: vi.fn() }));
vi.mock('../adf-client', () => ({
  upsertAdfCdc: vi.fn(), startAdfCdc: vi.fn(), adfCdcConfigGate: () => ({ missing: 'LOOM_ADF_NAME' }),
  listPipelineRuns: vi.fn(async () => []), adfConfigGate: () => ({ missing: 'LOOM_ADF_NAME' }),
  adfCdcConfigured: () => false,
}));

import {
  parseAdlsUrl, registerIcebergTables, runMirrorSnapshot,
  MIRROR_ICEBERG_FAMILY, type MirrorSource,
} from '../mirror-engine';

beforeEach(() => {
  listPathsMock.mockReset();
  listPathsMock.mockResolvedValue([]);
});

describe('parseAdlsUrl', () => {
  it('parses an abfss:// URL into account/container/path', () => {
    expect(parseAdlsUrl('abfss://iceberg@acct.dfs.core.windows.net/db/schema/'))
      .toEqual({ container: 'iceberg', account: 'acct', path: 'db/schema' });
  });
  it('parses an https:// dfs URL into account/container/path', () => {
    expect(parseAdlsUrl('https://acct.dfs.core.windows.net/iceberg/db/'))
      .toEqual({ account: 'acct', container: 'iceberg', path: 'db' });
  });
  it('parses a sovereign-cloud (Gov) https URL', () => {
    expect(parseAdlsUrl('https://acct.dfs.core.usgovcloudapi.net/iceberg/db'))
      .toEqual({ account: 'acct', container: 'iceberg', path: 'db' });
  });
  it('returns null for a non-ADLS URL', () => {
    expect(parseAdlsUrl('https://example.com/foo')).toBeNull();
    expect(parseAdlsUrl('')).toBeNull();
  });
});

describe('MIRROR_ICEBERG_FAMILY', () => {
  it('includes Snowflake and excludes SQL sources', () => {
    expect(MIRROR_ICEBERG_FAMILY.has('Snowflake')).toBe(true);
    expect(MIRROR_ICEBERG_FAMILY.has('AzureSqlDatabase')).toBe(false);
  });
});

describe('registerIcebergTables', () => {
  it('returns [] when includeIceberg is off', async () => {
    expect(await registerIcebergTables({ sourceType: 'Snowflake', server: 's', database: 'd', includeIceberg: false })).toEqual([]);
  });
  it('returns [] for a non-Iceberg-family source even with includeIceberg on', async () => {
    expect(await registerIcebergTables({ sourceType: 'AzureSqlDatabase', server: 's', database: 'd', includeIceberg: true, icebergStorageUrl: 'abfss://c@a.dfs.core.windows.net/x' })).toEqual([]);
  });
  it('honestly errors when the storage path is not a valid ADLS URL', async () => {
    const out = await registerIcebergTables({ sourceType: 'Snowflake', server: 's', database: 'd', includeIceberg: true, icebergStorageUrl: 'not-a-url' });
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('error');
    expect(out[0].error).toMatch(/ADLS Gen2/);
  });
  it('registers each external-volume sub-folder as one Iceberg table', async () => {
    listPathsMock.mockResolvedValue([
      { name: 'db/CUSTOMERS', isDirectory: true, size: 0 },
      { name: 'db/ORDERS', isDirectory: true, size: 0 },
      { name: 'db/readme.txt', isDirectory: false, size: 10 },
    ]);
    const out = await registerIcebergTables({ sourceType: 'Snowflake', server: 's', database: 'd', includeIceberg: true, icebergStorageUrl: 'abfss://iceberg@acct.dfs.core.windows.net/db/' });
    expect(out).toHaveLength(2);
    expect(out.map((t) => t.table)).toEqual(['CUSTOMERS', 'ORDERS']);
    expect(out.every((t) => t.status === 'registered')).toBe(true);
    expect(out[0].openrowset).toMatch(/OPENROWSET/);
    expect(out[0].openrowset).toMatch(/FORMAT = 'PARQUET'/);
    // listed the parsed container/path on the right account.
    expect(listPathsMock).toHaveBeenCalledWith('iceberg', 'db', expect.any(Number), 'acct');
  });
});

describe('runMirrorSnapshot — Snowflake Iceberg branch', () => {
  it('gates with the Iceberg hint when includeIceberg is off', async () => {
    const run = await runMirrorSnapshot('m', 'ws', { sourceType: 'Snowflake', server: 's', database: 'd', includeIceberg: false });
    expect(run.status).toBe('Gated');
    expect(run.gate?.message).toMatch(/Include Iceberg tables/);
  });
  it('gates for a missing storage path when includeIceberg is on', async () => {
    const run = await runMirrorSnapshot('m', 'ws', { sourceType: 'Snowflake', server: 's', database: 'd', includeIceberg: true, icebergStorageUrl: '' });
    expect(run.status).toBe('Gated');
    expect(run.gate?.missing).toBe('Iceberg storage path');
  });
  it('runs and registers Iceberg tables when includeIceberg + path are set', async () => {
    listPathsMock.mockResolvedValue([{ name: 'db/SALES', isDirectory: true, size: 0 }]);
    const src: MirrorSource = { sourceType: 'Snowflake', server: 's', database: 'd', includeIceberg: true, icebergStorageUrl: 'https://acct.dfs.core.windows.net/iceberg/db/' };
    const run = await runMirrorSnapshot('m', 'ws', src);
    expect(run.status).toBe('Running');
    expect(run.ok).toBe(true);
    expect(run.iceberg).toHaveLength(1);
    expect(run.iceberg?.[0].table).toBe('SALES');
  });
});
