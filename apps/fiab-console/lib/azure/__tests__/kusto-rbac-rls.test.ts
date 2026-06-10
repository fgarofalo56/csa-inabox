/**
 * Contract tests for ADX RBAC principal management + RLS policy authoring.
 *
 * Per .claude/rules/no-vaporware.md these assert the EXACT Kusto control-command
 * shapes emitted against /v1/rest/mgmt — the bracket-quoted db/table, the
 * single-quoted FQN literal, role allow-listing, and the RLS enable/disable verb
 * + double-quote escaping. Nothing is faked beyond stubbing global.fetch + the
 * AAD credential.
 *
 * Grounding:
 *   .add/.drop database|table principal — https://learn.microsoft.com/kusto/management/manage-database-security-roles
 *   .alter/.show table policy row_level_security — https://learn.microsoft.com/kusto/management/row-level-security-policy
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'AAD.ADX.TOKEN', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('../cosmos-client', () => ({ itemsContainer: vi.fn(), workspacesContainer: vi.fn() }));

import {
  buildKustoPrincipalFqn,
  addDatabasePrincipal, dropDatabasePrincipal,
  addTablePrincipal, dropTablePrincipal,
  showDatabasePrincipals, showTablePrincipals,
  alterTableRlsPolicy, showTableRlsPolicy,
} from '../kusto-client';

const realFetch = global.fetch;

function v1(columns: string[], rows: unknown[][]) {
  return {
    ok: true, status: 200,
    text: async () => JSON.stringify({
      Tables: [{ TableName: 'Table_0', Columns: columns.map((c) => ({ ColumnName: c, DataType: 'String' })), Rows: rows }],
    }),
  } as unknown as Response;
}

describe('buildKustoPrincipalFqn', () => {
  it('builds aaduser= for a User', () => {
    expect(buildKustoPrincipalFqn('User', 'user@contoso.com')).toBe('aaduser=user@contoso.com');
  });
  it('builds aadapp= for an App in appId;tenantId form', () => {
    expect(buildKustoPrincipalFqn('App', 'abc-123;tenant-9')).toBe('aadapp=abc-123;tenant-9');
  });
  it('builds aadgroup= for a Group', () => {
    expect(buildKustoPrincipalFqn('Group', 'analysts@contoso.com')).toBe('aadgroup=analysts@contoso.com');
  });
  it('rejects an App value missing the tenant segment', () => {
    expect(() => buildKustoPrincipalFqn('App', 'only-appid')).toThrow();
  });
  it('rejects a value containing a quote (FQN-literal escape attempt)', () => {
    expect(() => buildKustoPrincipalFqn('User', "x') | drop")).toThrow();
  });
});

describe('RBAC add/drop command shapes', () => {
  let lastBody: any;
  beforeEach(() => {
    lastBody = null;
    global.fetch = vi.fn(async (_u: any, init: any) => { lastBody = JSON.parse(init.body); return v1([], []); }) as any;
  });
  afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

  it('addDatabasePrincipal emits .add database ["db"] viewers (\'aaduser=...\')', async () => {
    await addDatabasePrincipal('db1', 'viewers', 'aaduser=user@contoso.com');
    expect(lastBody.csl).toBe(`.add database ["db1"] viewers ('aaduser=user@contoso.com') skip-results`);
  });
  it('dropDatabasePrincipal emits .drop database', async () => {
    await dropDatabasePrincipal('db1', 'admins', 'aadapp=appid;tid');
    expect(lastBody.csl).toBe(`.drop database ["db1"] admins ('aadapp=appid;tid') skip-results`);
  });
  it('addTablePrincipal emits .add table for an allowed table role', async () => {
    await addTablePrincipal('db1', 'Events', 'ingestors', 'aadgroup=g@contoso.com');
    expect(lastBody.csl).toBe(`.add table ["Events"] ingestors ('aadgroup=g@contoso.com') skip-results`);
  });
  it('rejects an unsupported database role', async () => {
    await expect(addDatabasePrincipal('db1', 'superadmin', 'aaduser=x@y.com')).rejects.toThrow(/Unsupported database role/);
  });
  it('rejects a database-only role at table scope', async () => {
    await expect(addTablePrincipal('db1', 'Events', 'viewers', 'aaduser=x@y.com')).rejects.toThrow(/Unsupported table role/);
  });
});

describe('showDatabasePrincipals / showTablePrincipals parse the principals table', () => {
  afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });
  it('maps the standard principal columns', async () => {
    global.fetch = vi.fn(async () => v1(
      ['Role', 'PrincipalType', 'PrincipalDisplayName', 'PrincipalObjectId', 'PrincipalFQN'],
      [['Database Viewer', 'AAD User', 'Ada Lovelace', 'oid-1', 'aaduser=ada@contoso.com']],
    )) as any;
    const rows = await showDatabasePrincipals('db1');
    expect(rows).toHaveLength(1);
    expect(rows[0].displayName).toBe('Ada Lovelace');
    expect(rows[0].fqn).toBe('aaduser=ada@contoso.com');
  });
  it('showTablePrincipals requires a table', async () => {
    await expect(showTablePrincipals('db1', '')).rejects.toThrow(/table is required/);
  });
});

describe('alterTableRlsPolicy', () => {
  let lastBody: any;
  beforeEach(() => {
    lastBody = null;
    global.fetch = vi.fn(async (_u: any, init: any) => { lastBody = JSON.parse(init.body); return v1([], []); }) as any;
  });
  afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

  it('emits enable with the bracket-quoted table + double-quoted query', async () => {
    await alterTableRlsPolicy('db1', 'Events', true, "Events | where current_principal_is_member_of('aadgroup=a@b.com')");
    expect(lastBody.csl).toBe(
      `.alter table ["Events"] policy row_level_security enable "Events | where current_principal_is_member_of('aadgroup=a@b.com')"`,
    );
  });
  it('emits disable', async () => {
    await alterTableRlsPolicy('db1', 'Events', false, 'Events | where false');
    expect(lastBody.csl).toContain('policy row_level_security disable');
  });
  it('escapes embedded double-quotes in the query', async () => {
    await alterTableRlsPolicy('db1', 'T', true, 'T | where col == "x"');
    expect(lastBody.csl).toContain('\\"x\\"');
  });
  it('throws when enabling with an empty query', async () => {
    await expect(alterTableRlsPolicy('db1', 'T', true, '   ')).rejects.toThrow(/required to enable/);
  });
});

describe('showTableRlsPolicy', () => {
  afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });
  it('parses the Policy column { Query, IsEnabled }', async () => {
    const policy = JSON.stringify({ Query: 'T | where x', IsEnabled: true });
    global.fetch = vi.fn(async () => v1(['PolicyName', 'EntityName', 'Policy'], [['RLS', 'T', policy]])) as any;
    const r = await showTableRlsPolicy('db1', 'T');
    expect(r).not.toBeNull();
    expect(r!.isEnabled).toBe(true);
    expect(r!.query).toBe('T | where x');
  });
  it('returns null when no policy rows', async () => {
    global.fetch = vi.fn(async () => v1(['Policy'], [])) as any;
    const r = await showTableRlsPolicy('db1', 'T');
    expect(r).toBeNull();
  });
});
