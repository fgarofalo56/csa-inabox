/**
 * synapse-permissions-client — SQL-plane GRANT / RLS DDL generation.
 *
 * Per no-vaporware.md these assert the *real* T-SQL the client emits against
 * the Synapse Dedicated SQL pool: object/column GRANT SELECT, CREATE SECURITY
 * POLICY + inline TVF, and that every identifier is catalog-sourced and
 * bracket-quoted (no string-injection path, no Fabric dependency).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture every SQL batch the client sends; answer catalog lookups from a
// fixed fixture so resolveTable / resolveColumnNames return deterministic ids.
const sent: string[] = [];

vi.mock('@/lib/azure/synapse-sql-client', () => {
  const executeQuery = vi.fn(async (_target: any, sqlText: string) => {
    sent.push(sqlText);
    // resolveTable — object_id → schema/name
    if (/FROM sys\.objects o JOIN sys\.schemas s/.test(sqlText) && /WHERE o\.object_id/.test(sqlText)) {
      return { columns: ['schema', 'name'], rows: [['dbo', 'Orders']], rowCount: 1, executionMs: 1, truncated: false };
    }
    // resolveColumnNames — column_id IN (...) → names (honors the requested ids)
    if (/FROM sys\.columns c\b/.test(sqlText) && /c\.column_id IN/.test(sqlText)) {
      const fixture: Record<number, string> = { 2: 'SalesRep', 3: 'Region' };
      const ids = (sqlText.match(/c\.column_id IN \(([^)]*)\)/)?.[1] || '')
        .split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n));
      const rows = ids.filter((id) => fixture[id]).map((id) => [id, fixture[id]]);
      return { columns: ['columnId', 'name'], rows, rowCount: rows.length, executionMs: 1, truncated: false };
    }
    return { columns: [], rows: [], rowCount: 0, executionMs: 1, truncated: false };
  });
  return {
    executeQuery,
    dedicatedTarget: () => ({ server: 'ws.sql.azuresynapse.net', database: 'pool', cacheKey: 'k' }),
  };
});

import {
  sqlBracket,
  grantTableSelect,
  revokeTableSelect,
  createRlsPolicy,
} from '@/lib/azure/synapse-permissions-client';

const target = { server: 'ws.sql.azuresynapse.net', database: 'pool', cacheKey: 'k' } as any;

beforeEach(() => { sent.length = 0; });

describe('sqlBracket', () => {
  it('bracket-quotes and escapes a closing bracket (no injection break-out)', () => {
    expect(sqlBracket('Orders')).toBe('[Orders]');
    expect(sqlBracket('we]rd')).toBe('[we]]rd]');
  });
});

describe('grantTableSelect', () => {
  it('emits a table-level GRANT and ensures the EXTERNAL PROVIDER user', async () => {
    await grantTableSelect(target, 'alice@contoso.com', 100, []);
    const grant = sent.find((s) => s.includes('GRANT SELECT'))!;
    expect(grant).toContain('CREATE USER [alice@contoso.com] FROM EXTERNAL PROVIDER');
    expect(grant).toContain('GRANT SELECT ON [dbo].[Orders] TO [alice@contoso.com];');
    expect(grant).not.toContain('([');  // no column list for a table-level grant
  });

  it('emits a column-level GRANT scoped to the catalog-resolved columns', async () => {
    await grantTableSelect(target, 'bob@contoso.com', 100, [2, 3]);
    const grant = sent.find((s) => s.includes('GRANT SELECT'))!;
    expect(grant).toContain('GRANT SELECT ON [dbo].[Orders]([SalesRep], [Region]) TO [bob@contoso.com];');
  });

  it('N-escapes a single-quote in the principal literal', async () => {
    await grantTableSelect(target, "o'brien@contoso.com", 100, []);
    const grant = sent.find((s) => s.includes('GRANT SELECT'))!;
    expect(grant).toContain("WHERE name = N'o''brien@contoso.com'");
  });
});

describe('revokeTableSelect', () => {
  it('emits a column-level REVOKE', async () => {
    await revokeTableSelect(target, 'alice@contoso.com', 100, [2]);
    const revoke = sent.find((s) => s.includes('REVOKE SELECT'))!;
    expect(revoke).toContain('REVOKE SELECT ON [dbo].[Orders]([SalesRep]) FROM [alice@contoso.com];');
  });
});

describe('createRlsPolicy', () => {
  it('creates the LoomSecurity schema, inline TVF and SECURITY POLICY in separate batches', async () => {
    const res = await createRlsPolicy(target, { objectId: 100, filterColumnId: 2, subject: 'USER_NAME()' });
    expect(res.policyName).toBe('LoomSecurity.pol_rls_Orders');
    expect(res.functionName).toBe('LoomSecurity.fn_rls_Orders');

    expect(sent.some((s) => /CREATE SCHEMA LoomSecurity/.test(s))).toBe(true);
    const fn = sent.find((s) => s.includes('CREATE FUNCTION'))!;
    expect(fn).toContain('CREATE FUNCTION [LoomSecurity].[fn_rls_Orders](@cmp sysname)');
    expect(fn).toContain('WHERE @cmp = USER_NAME() OR IS_MEMBER(\'db_owner\') = 1;');
    // CREATE FUNCTION must be the only statement in its batch.
    expect(fn).not.toContain('CREATE SECURITY POLICY');

    const pol = sent.find((s) => s.includes('CREATE SECURITY POLICY'))!;
    expect(pol).toContain('CREATE SECURITY POLICY [LoomSecurity].[pol_rls_Orders]');
    expect(pol).toContain('ADD FILTER PREDICATE [LoomSecurity].[fn_rls_Orders]([SalesRep]) ON [dbo].[Orders]');
    expect(pol).toContain('WITH (STATE = ON);');
  });

  it('rejects an out-of-allow-list subject by falling back to USER_NAME()', async () => {
    await createRlsPolicy(target, { objectId: 100, filterColumnId: 2, subject: 'DROP TABLE x;--' as any });
    const fn = sent.find((s) => s.includes('CREATE FUNCTION'))!;
    expect(fn).toContain('@cmp = USER_NAME()');
    expect(fn).not.toContain('DROP TABLE');
  });
});
