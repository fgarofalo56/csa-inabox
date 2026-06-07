/**
 * Unit tests for synapse-catalog-client.scanLakehouseTables.
 *
 * Mocks the adls-client (directory scan + _delta_log) and synapse-sql-client
 * (OPENROWSET COUNT(*)) so the scan logic — Delta detection, version parsing,
 * status grading, size aggregation, honest-null row counts — is exercised
 * without touching real Azure. Per no-vaporware: these assert the REAL parsing
 * behavior, not a stubbed shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// p.name from ADLS DataLake listPaths is relative to the filesystem (container),
// i.e. NO container prefix — e.g. 'Tables/sales_orders/_delta_log/...json'.
const DATA: Record<string, Record<string, any[]>> = {
  bronze: {
    'N:Tables': [
      { name: 'Tables/sales_orders', isDirectory: true },
      { name: 'Tables/broken_tbl', isDirectory: true },
      { name: 'Tables/raw_parquet', isDirectory: true },
      { name: 'Tables/empty_tbl', isDirectory: true },
    ],
    'R:Tables/sales_orders': [
      { name: 'Tables/sales_orders/_delta_log', isDirectory: true },
      { name: 'Tables/sales_orders/_delta_log/00000000000000000000.json', isDirectory: false, contentLength: 100 },
      { name: 'Tables/sales_orders/_delta_log/00000000000000000007.json', isDirectory: false, contentLength: 120 },
      { name: 'Tables/sales_orders/part-0001.parquet', isDirectory: false, contentLength: 50000, lastModified: '2026-06-05T22:14:00.000Z' },
      { name: 'Tables/sales_orders/part-0002.parquet', isDirectory: false, contentLength: 2428800, lastModified: '2026-06-05T22:10:00.000Z' },
    ],
    'R:Tables/broken_tbl': [
      { name: 'Tables/broken_tbl/_delta_log', isDirectory: true },
      { name: 'Tables/broken_tbl/_delta_log/.tmp', isDirectory: false, contentLength: 0 },
    ],
    'R:Tables/raw_parquet': [
      { name: 'Tables/raw_parquet/data.parquet', isDirectory: false, contentLength: 999, lastModified: '2026-06-01T00:00:00.000Z' },
    ],
    'R:Tables/empty_tbl': [],
  },
  silver: {
    'N:Tables': [], // Tables/ exists but has no table dirs
  },
};

function makeFs(container: string) {
  return {
    listPaths({ path, recursive }: { path?: string; recursive?: boolean }) {
      const key = `${recursive ? 'R' : 'N'}:${path}`;
      const entries = DATA[container]?.[key];
      if (entries === undefined) {
        // Simulate a 404 (Tables/ missing) for containers with no data.
        const err: any = new Error('PathNotFound');
        err.statusCode = 404;
        return (async function* () { throw err; })();
      }
      return (async function* () { for (const e of entries) yield e; })();
    },
  };
}

vi.mock('../adls-client', () => ({
  KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing'],
  getAccountName: () => 'acct',
  getServiceClientFor: () => ({ getFileSystemClient: (c: string) => makeFs(c) }),
  pathToHttpsUrl: (container: string, path: string) =>
    `https://acct.dfs.core.windows.net/${container}/${path}`,
}));

const executeQueryMock = vi.fn();
vi.mock('../synapse-sql-client', () => ({
  executeQuery: (...args: any[]) => executeQueryMock(...args),
  serverlessTarget: () => ({ server: 'ws-ondemand.sql.azuresynapse.net', database: 'master', cacheKey: 'k' }),
}));

import { scanLakehouseTables } from '../synapse-catalog-client';

beforeEach(() => {
  executeQueryMock.mockReset();
});

describe('scanLakehouseTables', () => {
  it('returns a real Delta table with ok status, version, and aggregated size (excluding _delta_log)', async () => {
    const tables = await scanLakehouseTables({ containers: ['bronze'] });
    const t = tables.find((x) => x.name === 'sales_orders')!;
    expect(t).toBeTruthy();
    expect(t.schema).toBe('bronze');
    expect(t.adlsPath).toBe('bronze/Tables/sales_orders');
    expect(t.bulkUrl).toBe('https://acct.dfs.core.windows.net/bronze/Tables/sales_orders');
    expect(t.format).toBe('delta');
    expect(t.status).toBe('ok');
    expect(t.latestVersion).toBe(7);
    // 50000 + 2428800; _delta_log json bytes (100 + 120) excluded.
    expect(t.sizeBytes).toBe(2478800);
    expect(t.lastModified).toBe('2026-06-05T22:14:00.000Z');
    // No rowCounts requested → null, never fabricated 0.
    expect(t.rowCount).toBeNull();
  });

  it('grades a Delta dir with _delta_log but no commit json as broken', async () => {
    const tables = await scanLakehouseTables({ containers: ['bronze'] });
    const t = tables.find((x) => x.name === 'broken_tbl')!;
    expect(t.format).toBe('delta');
    expect(t.status).toBe('broken');
    expect(t.latestVersion).toBeNull();
  });

  it('classifies a non-Delta parquet directory as parquet/ok', async () => {
    const tables = await scanLakehouseTables({ containers: ['bronze'] });
    const t = tables.find((x) => x.name === 'raw_parquet')!;
    expect(t.format).toBe('parquet');
    expect(t.status).toBe('ok');
    expect(t.sizeBytes).toBe(999);
  });

  it('classifies an empty directory as unknown/empty', async () => {
    const tables = await scanLakehouseTables({ containers: ['bronze'] });
    const t = tables.find((x) => x.name === 'empty_tbl')!;
    expect(t.format).toBe('unknown');
    expect(t.status).toBe('empty');
  });

  it('returns honest [] for a lakehouse whose Tables/ has no table dirs', async () => {
    const tables = await scanLakehouseTables({ containers: ['silver'] });
    expect(tables).toEqual([]);
  });

  it('skips containers whose Tables/ is missing (404) without throwing', async () => {
    const tables = await scanLakehouseTables({ containers: ['gold'] });
    expect(tables).toEqual([]);
  });

  it('runs OPENROWSET COUNT(*) only for ok Delta tables when rowCounts=true', async () => {
    executeQueryMock.mockResolvedValue({ columns: ['n'], rows: [[124800]], rowCount: 1, executionMs: 5, truncated: false });
    const tables = await scanLakehouseTables({ containers: ['bronze'], rowCounts: true });
    const sales = tables.find((x) => x.name === 'sales_orders')!;
    expect(sales.rowCount).toBe(124800);
    // broken / parquet / empty tables are not counted.
    expect(tables.find((x) => x.name === 'broken_tbl')!.rowCount).toBeNull();
    expect(tables.find((x) => x.name === 'raw_parquet')!.rowCount).toBeNull();
    // Exactly one COUNT(*) issued (sales_orders only).
    expect(executeQueryMock).toHaveBeenCalledTimes(1);
    expect(String(executeQueryMock.mock.calls[0][1])).toContain("FORMAT = 'DELTA'");
  });

  it('returns null rowCount when Serverless errors (no fabricated 0)', async () => {
    executeQueryMock.mockRejectedValue(new Error('serverless cold'));
    const tables = await scanLakehouseTables({ containers: ['bronze'], rowCounts: true });
    expect(tables.find((x) => x.name === 'sales_orders')!.rowCount).toBeNull();
  });

  it('sorts results by schema then name', async () => {
    const tables = await scanLakehouseTables({ containers: ['bronze'] });
    const names = tables.map((t) => t.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
