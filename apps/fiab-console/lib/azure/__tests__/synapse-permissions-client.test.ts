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
    // listSqlColumns — full column list for one object (object_id, no IN-list)
    if (/FROM sys\.columns c\b/.test(sqlText) && /c\.object_id =/.test(sqlText)) {
      return {
        columns: ['columnId', 'name', 'dataType'],
        rows: [[1, 'OrderId', 'int'], [2, 'SalesRep', 'nvarchar'], [3, 'Region', 'nvarchar']],
        rowCount: 3, executionMs: 1, truncated: false,
      };
    }
    return { columns: [], rows: [], rowCount: 0, executionMs: 1, truncated: false };
  });
  return {
    executeQuery,
    dedicatedTarget: () => ({ server: 'ws.sql.azuresynapse.net', database: 'pool', cacheKey: 'k' }),
    serverlessTarget: () => ({ server: 'ws-ondemand.sql.azuresynapse.net', database: 'master', cacheKey: 'sk' }),
  };
});

import {
  sqlBracket,
  grantTableSelect,
  revokeTableSelect,
  createRlsPolicy,
  createRlsPolicyWithPredicate,
  testRlsPredicate,
  denyColumnSelect,
  revokeColumnDeny,
  listColumnDenyGrants,
  generateMaskedView,
} from '@/lib/azure/synapse-permissions-client';
import { validateWhereClause, RLS_WHERE_MAX } from '@/lib/azure/rls-predicate';

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

// ── F8 — free-form WHERE-predicate RLS ────────────────────────────────────────

describe('validateWhereClause (F8 sanitizer)', () => {
  it('accepts the canonical identity predicate', () => {
    expect(validateWhereClause('@cmp = USER_NAME()')).toEqual({ ok: true });
  });

  it('requires a reference to @cmp', () => {
    expect(validateWhereClause('USER_NAME() = SUSER_SNAME()').ok).toBe(false);
  });

  it('blocks the injection vectors (;, comments, quotes, DDL/DML, subqueries)', () => {
    for (const bad of [
      '@cmp = USER_NAME(); DROP TABLE x',
      '@cmp = USER_NAME() -- bypass',
      "@cmp = 'alice@contoso.com'",
      '@cmp = USER_NAME() UNION SELECT 1',
      '@cmp IN (SELECT id FROM t)',
      '@cmp = USER_NAME() EXEC xp_cmdshell',
    ]) {
      expect(validateWhereClause(bad).ok, bad).toBe(false);
    }
  });

  it('enforces the length cap', () => {
    expect(validateWhereClause('@cmp = ' + 'A'.repeat(RLS_WHERE_MAX)).ok).toBe(false);
  });
});

describe('createRlsPolicyWithPredicate', () => {
  it('probes, then emits the TVF wrapping the user predicate with the owner-bypass', async () => {
    const res = await createRlsPolicyWithPredicate(target, {
      objectId: 100,
      filterColumnId: 3,
      whereClause: '@cmp = USER_NAME()',
    });
    expect(res.policyName).toBe('LoomSecurity.pol_rls_Orders');
    expect(res.predicate).toBe('@cmp = USER_NAME()');

    // A parse/bind probe runs BEFORE any DROP so an invalid predicate can't
    // leave the table unprotected.
    const probe = sent.find((s) => /SELECT TOP 0 1 AS rls_result WHERE/.test(s))!;
    expect(probe).toContain("WHERE (@cmp = USER_NAME()) OR IS_MEMBER('db_owner') = 1;");
    const probeIdx = sent.indexOf(probe);
    const dropIdx = sent.findIndex((s) => s.includes('DROP SECURITY POLICY'));
    expect(probeIdx).toBeLessThan(dropIdx);

    const fn = sent.find((s) => s.includes('CREATE FUNCTION'))!;
    expect(fn).toContain('CREATE FUNCTION [LoomSecurity].[fn_rls_Orders](@cmp sysname)');
    expect(fn).toContain("WHERE (@cmp = USER_NAME()) OR IS_MEMBER('db_owner') = 1;");

    const pol = sent.find((s) => s.includes('CREATE SECURITY POLICY'))!;
    expect(pol).toContain('ADD FILTER PREDICATE [LoomSecurity].[fn_rls_Orders]([Region]) ON [dbo].[Orders]');
  });

  it('rejects an invalid predicate WITHOUT emitting any DDL', async () => {
    await expect(
      createRlsPolicyWithPredicate(target, { objectId: 100, filterColumnId: 3, whereClause: '@cmp = USER_NAME(); DROP TABLE x' }),
    ).rejects.toThrow(/semicolon/i);
    expect(sent.some((s) => s.includes('CREATE FUNCTION'))).toBe(false);
    expect(sent.some((s) => s.includes('DROP SECURITY POLICY'))).toBe(false);
  });
});

describe('testRlsPredicate', () => {
  it('substitutes @cmp with the filter column and identity functions with the test identity', async () => {
    const { result } = await testRlsPredicate(target, {
      objectId: 100,
      filterColumnId: 2,
      whereClause: '@cmp = USER_NAME()',
      testIdentity: "o'brien@contoso.com",
    });
    expect(result).toBeDefined();
    const select = sent.find((s) => /^SELECT TOP \d+ \* FROM/.test(s))!;
    // @cmp → t.[SalesRep]; USER_NAME() → N'…' (single-quote escaped); owner-bypass omitted.
    expect(select).toContain('FROM [dbo].[Orders] AS t');
    expect(select).toContain("WHERE (t.[SalesRep] = N'o''brien@contoso.com');");
    expect(select).not.toContain('IS_MEMBER');
  });

  it('rejects an invalid predicate before touching the table', async () => {
    await expect(
      testRlsPredicate(target, { objectId: 100, filterColumnId: 2, whereClause: 'no cmp here', testIdentity: 'x' }),
    ).rejects.toThrow(/@cmp/i);
    expect(sent.some((s) => /^SELECT TOP/.test(s))).toBe(false);
  });
});

describe('denyColumnSelect (column-level security — hide columns)', () => {
  it('emits a table GRANT + column-scope DENY and ensures the EXTERNAL PROVIDER user', async () => {
    const res = await denyColumnSelect(target, 'analyst@contoso.com', 100, [2, 3]);
    const ddl = sent.find((s) => s.includes('DENY SELECT'))!;
    expect(ddl).toContain('CREATE USER [analyst@contoso.com] FROM EXTERNAL PROVIDER');
    // table-level GRANT so the role can still query the table
    expect(ddl).toContain('GRANT SELECT ON [dbo].[Orders] TO [analyst@contoso.com];');
    // column-scope DENY hides the named columns
    expect(ddl).toContain('DENY SELECT ON [dbo].[Orders]([SalesRep], [Region]) TO [analyst@contoso.com];');
    expect(res.hiddenColumns).toEqual(['SalesRep', 'Region']);
  });

  it('throws when no columns are supplied (a column-level DENY needs ≥1 column)', async () => {
    await expect(denyColumnSelect(target, 'analyst@contoso.com', 100, [])).rejects.toThrow(/at least one column/i);
  });
});

describe('revokeColumnDeny (un-hide columns)', () => {
  it('emits a column-level REVOKE that clears the DENY', async () => {
    await revokeColumnDeny(target, 'analyst@contoso.com', 100, [2]);
    const revoke = sent.find((s) => s.includes('REVOKE SELECT'))!;
    expect(revoke).toContain('REVOKE SELECT ON [dbo].[Orders]([SalesRep]) FROM [analyst@contoso.com];');
  });
});

describe('listColumnDenyGrants', () => {
  it('queries column-level DENY rows only (state DENY, minor_id > 0)', async () => {
    await listColumnDenyGrants(target);
    const q = sent.find((s) => /sys\.database_permissions/.test(s))!;
    expect(q).toContain("perm.state_desc = 'DENY'");
    expect(q).toContain('perm.minor_id > 0');
  });
});

describe('generateMaskedView (Serverless parity path)', () => {
  it('CREATE OR ALTER VIEW NULL-projects the hidden columns, keeps the rest', async () => {
    const res = await generateMaskedView(target, 100, [2], 'analyst');
    const view = sent.find((s) => s.includes('CREATE OR ALTER VIEW'))!;
    expect(view).toContain('CREATE OR ALTER VIEW [dbo].[v_Orders_analyst] AS');
    expect(view).toContain('[OrderId], NULL AS [SalesRep], [Region]');
    expect(view).toContain('FROM [dbo].[Orders];');
    expect(res.viewFqn).toBe('dbo.v_Orders_analyst');
    expect(res.hiddenColumns).toEqual(['SalesRep']);
  });
});
