import { describe, it, expect, afterEach } from 'vitest';
import { buildDeltaOpenRowsetSql, goldDeltaBulkUrl } from '../synapse-sql-client';

/**
 * Unit tests for the Direct Lake Serverless-fallback primitives:
 *  - buildDeltaOpenRowsetSql() emits the T-SQL OPENROWSET(...FORMAT='DELTA')
 *    statement the BFF runs against Synapse Serverless over the Gold Delta files.
 *  - goldDeltaBulkUrl() composes the ADLS Gen2 DFS BULK URL from LOOM_GOLD_URL.
 *
 * Both are pure (no Azure SDK / credential calls), so they run on the bare node
 * pool. They are the Azure-native analog of Fabric "Direct Lake on SQL"
 * DirectQuery fallback — no Fabric capacity required.
 */

const ORIG_GOLD = process.env.LOOM_GOLD_URL;
afterEach(() => {
  if (ORIG_GOLD === undefined) delete process.env.LOOM_GOLD_URL;
  else process.env.LOOM_GOLD_URL = ORIG_GOLD;
});

describe('buildDeltaOpenRowsetSql', () => {
  it('generates well-formed OPENROWSET DELTA SQL', () => {
    const sql = buildDeltaOpenRowsetSql('https://acct.dfs.core.windows.net/gold/Tables/fact_sales', 1000);
    expect(sql).toMatch(/OPENROWSET/);
    expect(sql).toMatch(/FORMAT = 'DELTA'/);
    expect(sql).toMatch(/TOP 1000/);
    expect(sql).toContain('fact_sales');
  });

  it('caps maxRows at 5000', () => {
    const sql = buildDeltaOpenRowsetSql('https://acct.dfs.core.windows.net/gold/Tables/x', 99999);
    expect(sql).toMatch(/TOP 5000/);
  });

  it('floors maxRows to at least 1', () => {
    const sql = buildDeltaOpenRowsetSql('https://acct.dfs.core.windows.net/gold/Tables/x', 0);
    expect(sql).toMatch(/TOP 1\b/);
  });

  it('preserves a Gov cloud DFS suffix', () => {
    const sql = buildDeltaOpenRowsetSql('https://acct.dfs.core.usgovcloudapi.net/gold/Tables/dim_customer', 500);
    expect(sql).toMatch(/usgovcloudapi\.net/);
    expect(sql).toContain('dim_customer');
  });
});

describe('goldDeltaBulkUrl', () => {
  it('builds the BULK url from LOOM_GOLD_URL', () => {
    process.env.LOOM_GOLD_URL = 'https://loomlake.dfs.core.windows.net/gold';
    expect(goldDeltaBulkUrl('fact_sales')).toBe(
      'https://loomlake.dfs.core.windows.net/gold/Tables/fact_sales',
    );
  });

  it('strips a trailing slash from LOOM_GOLD_URL', () => {
    process.env.LOOM_GOLD_URL = 'https://loomlake.dfs.core.windows.net/gold/';
    expect(goldDeltaBulkUrl('dim_date')).toBe(
      'https://loomlake.dfs.core.windows.net/gold/Tables/dim_date',
    );
  });

  it('throws an honest, var-named error when LOOM_GOLD_URL is missing', () => {
    delete process.env.LOOM_GOLD_URL;
    expect(() => goldDeltaBulkUrl('fact_sales')).toThrow('LOOM_GOLD_URL');
  });

  it('uses a Gov cloud URL unchanged', () => {
    process.env.LOOM_GOLD_URL = 'https://loomlakegov.dfs.core.usgovcloudapi.net/gold';
    expect(goldDeltaBulkUrl('fact_sales')).toMatch(/usgovcloudapi\.net/);
  });

  it('sanitizes hostile characters out of the table name', () => {
    process.env.LOOM_GOLD_URL = 'https://loomlake.dfs.core.windows.net/gold';
    // path traversal / quote injection chars are stripped, not passed through
    expect(goldDeltaBulkUrl("fact'; DROP")).not.toMatch(/['; ]/);
  });
});
