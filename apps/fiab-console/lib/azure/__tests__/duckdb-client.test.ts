/**
 * N2b — DuckDB serving-tier client: the honest fallback, the audit row, and the
 * server-built lake-scan SQL (a browser never invents a storage URL).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const auditRows: any[] = [];
const streamed: any[] = [];
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({
    items: { create: async (doc: any) => { auditRows.push(doc); return { resource: doc }; } },
  }),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: (e: any) => { streamed.push(e); } }));

const upstream: Array<{ url: string; init: any }> = [];
let respond: () => Response = () => new Response('{}', { status: 200 });
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: async (url: string, init: any) => { upstream.push({ url, init }); return respond(); },
}));

const synapse: string[] = [];
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  serverlessTargetResolved: async () => ({ server: 's', database: 'master', cacheKey: 'k' }),
  executeQuery: async (_t: any, sql: string) => {
    synapse.push(sql);
    return { columns: ['a'], rows: [[1]], rowCount: 1, executionMs: 7, truncated: false, messages: [], recordsAffected: 0 };
  },
}));

import {
  DuckDbError,
  buildLakeScanSql,
  duckdbBase,
  duckdbConfigGate,
  inferLakeFormat,
  isDuckDbConfigured,
  logDuckDbAccess,
  runSqlLabQuery,
} from '../duckdb-client';

beforeEach(() => {
  upstream.length = 0;
  auditRows.length = 0;
  streamed.length = 0;
  synapse.length = 0;
  delete process.env.LOOM_DUCKDB_URL;
});

afterEach(() => { delete process.env.LOOM_DUCKDB_URL; });

describe('configuration', () => {
  it('reports the exact missing var when unwired', () => {
    expect(duckdbConfigGate()).toEqual({ missing: 'LOOM_DUCKDB_URL' });
    expect(isDuckDbConfigured()).toBe(false);
  });

  it('normalizes a scheme-less base and trims trailing slashes', () => {
    process.env.LOOM_DUCKDB_URL = 'loom-duckdb.internal.example.net/';
    expect(duckdbBase()).toBe('https://loom-duckdb.internal.example.net');
  });
});

describe('runSqlLabQuery', () => {
  it('executes on the DuckDB tier and labels it', async () => {
    process.env.LOOM_DUCKDB_URL = 'https://tier.internal';
    respond = () => new Response(JSON.stringify({
      ok: true, columns: [{ name: 'n', type: 'BIGINT' }], rows: [[1]], rowCount: 1,
      elapsedMs: 5, truncated: false, maxRows: 5000, extensions: ['delta'],
    }), { status: 200 });

    const result = await runSqlLabQuery('SELECT 1 AS n', { tenantId: 't' });
    expect(result.engine).toBe('duckdb');
    expect(result.extensions).toEqual(['delta']);
    expect(upstream[0].url).toBe('https://tier.internal/query');
    expect(synapse).toHaveLength(0);
  });

  it('falls back to Synapse Serverless with the SAME statement and says why', async () => {
    const result = await runSqlLabQuery('SELECT 1 AS n', { tenantId: 't' });
    expect(result.engine).toBe('synapse-serverless');
    expect(result.note).toContain('LOOM_DUCKDB_URL is unset');
    expect(synapse).toEqual(['SELECT 1 AS n']);
    expect(upstream).toHaveLength(0);
  });

  it('surfaces an upstream failure as a typed error, not a fabricated empty result', async () => {
    process.env.LOOM_DUCKDB_URL = 'https://tier.internal';
    respond = () => new Response(JSON.stringify({ ok: false, error: 'boom', code: 'query_failed' }), { status: 400 });
    await expect(runSqlLabQuery('SELECT 1', { tenantId: 't' })).rejects.toBeInstanceOf(DuckDbError);
  });
});

describe('buildLakeScanSql', () => {
  const ACCOUNT = 'stloom';

  it('builds a real delta_scan over the deployment\'s own lake', () => {
    const sql = buildLakeScanSql(ACCOUNT, { container: 'gold', path: 'Tables/sales', limit: 1000 });
    expect(sql).toBe(
      "SELECT * FROM delta_scan('abfss://gold@stloom.dfs.core.windows.net/Tables/sales') LIMIT 1000",
    );
  });

  it('picks the reader from the path when the caller does not say', () => {
    expect(inferLakeFormat('events/part-0.parquet')).toBe('parquet');
    expect(inferLakeFormat('raw/customers.csv')).toBe('csv');
    expect(inferLakeFormat('Tables/orders')).toBe('delta');
    expect(buildLakeScanSql(ACCOUNT, { container: 'bronze', path: 'e/part-0.parquet' })).toContain('read_parquet(');
    expect(buildLakeScanSql(ACCOUNT, { container: 'bronze', path: 'r/c.csv' })).toContain('read_csv_auto(');
  });

  it('reads an Iceberg table when asked — the format N1 publishes', () => {
    expect(buildLakeScanSql(ACCOUNT, { container: 'gold', path: 'Tables/sales', format: 'iceberg' }))
      .toContain('iceberg_scan(');
  });

  it('refuses a path that could break out of the SQL literal', () => {
    for (const path of ["a'; DROP TABLE t; --", 'a\\b', 'x"y', "it's"]) {
      expect(() => buildLakeScanSql(ACCOUNT, { container: 'gold', path })).toThrow(DuckDbError);
    }
  });

  it('refuses an invalid container name', () => {
    expect(() => buildLakeScanSql(ACCOUNT, { container: 'Gold!', path: 'x' })).toThrow(DuckDbError);
  });

  it('refuses when no lake account is configured rather than emitting a broken URI', () => {
    expect(() => buildLakeScanSql('', { container: 'gold', path: 'Tables/sales' })).toThrow(/LOOM_ADLS_ACCOUNT/);
  });

  it('clamps the row limit', () => {
    expect(buildLakeScanSql(ACCOUNT, { container: 'gold', path: 'a', limit: 10_000_000 })).toContain('LIMIT 200000');
    expect(buildLakeScanSql(ACCOUNT, { container: 'gold', path: 'a', limit: 0 })).toContain('LIMIT 1');
  });
});

describe('logDuckDbAccess', () => {
  it('writes one audit row naming the engine that answered and fans it out', async () => {
    await logDuckDbAccess({
      actorOid: 'oid-1', actorUpn: 'a@b.c', tenantId: 't', operation: 'sql.query',
      engine: 'duckdb', sql: 'SELECT   1\n  FROM t', outcome: 'success', rowCount: 3, elapsedMs: 11,
      itemId: 'lab-1',
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      itemType: 'sql-lab', itemId: 'lab-1', action: 'duckdb.sql.query', engine: 'duckdb', outcome: 'success',
    });
    // The statement is normalized (whitespace collapsed) so the row is greppable.
    expect(auditRows[0].statement).toBe('SELECT 1 FROM t');
    expect(streamed).toHaveLength(1);
  });

  it('records a failure with its reason rather than dropping it', async () => {
    await logDuckDbAccess({
      actorOid: 'oid-1', actorUpn: 'a@b.c', tenantId: 't', operation: 'sql.query',
      engine: 'synapse-serverless', sql: 'SELECT 1', outcome: 'failure', detail: 'login failed',
    });
    expect(auditRows[0].outcome).toBe('failure');
    expect(auditRows[0].summary).toContain('login failed');
  });
});
