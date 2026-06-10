/**
 * Unit tests for the ADX Security + external-table backend functions:
 *  - listDatabasePrincipals()   parses `.show database <db> principals`
 *  - addDatabasePrincipal()     emits `.add database … <role> ('fqn') 'desc'`
 *  - dropDatabasePrincipal()    emits `.drop database … <role> ('fqn')`
 *  - showTableRlsPolicy()       parses the row_level_security Policy JSON (null when unset)
 *  - setTableRlsPolicy()        emits `.alter table … policy row_level_security enable|disable "q"`
 *  - createExternalStorageTable() emits `.create-or-alter external table … kind=storage`
 *
 * Same captureFetch + mocked @azure/identity + cosmos-client pattern as
 * kusto-databases.test.ts — these functions never touch Cosmos.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

vi.mock('../cosmos-client', () => ({
  itemsContainer: vi.fn(),
  workspacesContainer: vi.fn(),
}));

beforeEach(() => {
  process.env.LOOM_KUSTO_CLUSTER_URI = 'https://adx-test.eastus2.kusto.windows.net';
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function captureFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = impl(String(url), init);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

/** Build a Kusto v1 mgmt response from columns + rows. */
function mgmt(columns: string[], rows: unknown[][]) {
  return {
    body: {
      Tables: [{
        TableName: 'Table_0',
        Columns: columns.map((c) => ({ ColumnName: c, DataType: 'String' })),
        Rows: rows,
      }],
    },
  };
}

const csl = (calls: Array<{ init?: RequestInit }>, i = 0) => JSON.parse(String(calls[i].init?.body)).csl as string;

describe('kusto-client / listDatabasePrincipals', () => {
  it('parses Role/PrincipalType/DisplayName/ObjectId/FQN and derives the role token', async () => {
    const calls = captureFetch(() => mgmt(
      ['Role', 'PrincipalType', 'PrincipalDisplayName', 'PrincipalObjectId', 'PrincipalFQN', 'Notes'],
      [
        ['Database Samples Admin', 'Microsoft Entra user', 'Abbi Atkins', 'cd709aed', 'aaduser=abbi@contoso.com', 'lead'],
        ['Database Samples Viewer', 'Microsoft Entra group', 'Analysts', 'g-123', 'aadgroup=g-123;contoso.com', ''],
      ],
    ));
    const { listDatabasePrincipals } = await import('../kusto-client');
    const out = await listDatabasePrincipals('Samples');

    expect(csl(calls)).toBe('.show database ["Samples"] principals');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: 'admins', principalType: 'Microsoft Entra user', principalFQN: 'aaduser=abbi@contoso.com', notes: 'lead' });
    expect(out[1]).toMatchObject({ role: 'viewers', principalDisplayName: 'Analysts', principalFQN: 'aadgroup=g-123;contoso.com' });
  });
});

describe('kusto-client / addDatabasePrincipal + dropDatabasePrincipal', () => {
  it('add emits .add database <db> users (fqn) with a description', async () => {
    const calls = captureFetch(() => mgmt(['Role'], []));
    const { addDatabasePrincipal } = await import('../kusto-client');
    await addDatabasePrincipal('Samples', 'users', 'aaduser=x@y.com');
    expect(csl(calls)).toBe(".add database [\"Samples\"] users ('aaduser=x@y.com') 'Granted via CSA Loom'");
  });

  it('drop emits .drop database <db> viewers (aadapp fqn)', async () => {
    const calls = captureFetch(() => mgmt(['Role'], []));
    const { dropDatabasePrincipal } = await import('../kusto-client');
    await dropDatabasePrincipal('Samples', 'viewers', 'aadapp=id;tenant');
    expect(csl(calls)).toBe(".drop database [\"Samples\"] viewers ('aadapp=id;tenant')");
  });

  it('rejects an invalid role and a malformed FQN', async () => {
    captureFetch(() => mgmt(['Role'], []));
    const mod = await import('../kusto-client');
    await expect(mod.addDatabasePrincipal('Samples', 'superuser' as any, 'aaduser=x@y.com')).rejects.toBeInstanceOf(mod.KustoError);
    await expect(mod.addDatabasePrincipal('Samples', 'users', 'x@y.com')).rejects.toBeInstanceOf(mod.KustoError);
  });
});

describe('kusto-client / showTableRlsPolicy + setTableRlsPolicy', () => {
  it('parses the Policy JSON {IsEnabled, Query}', async () => {
    const calls = captureFetch(() => mgmt(
      ['PolicyName', 'EntityName', 'Policy'],
      [['RowLevelSecurity', 'Sales', JSON.stringify({ IsEnabled: true, Query: 'Sales | where Owner == current_principal()' })]],
    ));
    const { showTableRlsPolicy } = await import('../kusto-client');
    const out = await showTableRlsPolicy('DB', 'Sales');

    expect(csl(calls)).toBe('.show table ["Sales"] policy row_level_security');
    expect(out).toMatchObject({ enabled: true, query: 'Sales | where Owner == current_principal()' });
  });

  it('returns null when no policy rows come back', async () => {
    captureFetch(() => mgmt(['PolicyName', 'EntityName', 'Policy'], []));
    const { showTableRlsPolicy } = await import('../kusto-client');
    expect(await showTableRlsPolicy('DB', 'Sales')).toBeNull();
  });

  it('enable emits .alter table T policy row_level_security enable "query"', async () => {
    const calls = captureFetch(() => mgmt(['x'], [['ok']]));
    const { setTableRlsPolicy } = await import('../kusto-client');
    await setTableRlsPolicy('DB', 'Sales', true, 'Sales | where SalesPersonAccount == current_principal()');
    expect(csl(calls)).toBe('.alter table ["Sales"] policy row_level_security enable "Sales | where SalesPersonAccount == current_principal()"');
  });

  it('disable emits the disable verb and tolerates an empty query', async () => {
    const calls = captureFetch(() => mgmt(['x'], [['ok']]));
    const { setTableRlsPolicy } = await import('../kusto-client');
    await setTableRlsPolicy('DB', 'Sales', false, '');
    expect(csl(calls)).toBe('.alter table ["Sales"] policy row_level_security disable ""');
  });

  it('rejects enabling RLS without a query', async () => {
    captureFetch(() => mgmt(['x'], []));
    const mod = await import('../kusto-client');
    await expect(mod.setTableRlsPolicy('DB', 'Sales', true, '   ')).rejects.toBeInstanceOf(mod.KustoError);
  });
});

describe('kusto-client / createExternalStorageTable', () => {
  it('emits .create-or-alter external table … kind=storage dataformat=csv (h@conn)', async () => {
    const calls = captureFetch(() => mgmt(['x'], [['ok']]));
    const { createExternalStorageTable } = await import('../kusto-client');
    await createExternalStorageTable('DB', 'archive', 'ts:datetime, v:long', 'csv', 'https://acct.blob.core.windows.net/c;managed_identity=system');
    const c = csl(calls);
    expect(c).toContain('.create-or-alter external table ["archive"] (ts:datetime, v:long)');
    expect(c).toContain('kind=storage');
    expect(c).toContain('dataformat=csv');
    expect(c).toContain("h@'https://acct.blob.core.windows.net/c;managed_identity=system'");
  });

  it('rejects an unsupported data format', async () => {
    captureFetch(() => mgmt(['x'], []));
    const mod = await import('../kusto-client');
    await expect(mod.createExternalStorageTable('DB', 'archive', 'a:string', 'xlsx', 'conn')).rejects.toBeInstanceOf(mod.KustoError);
  });
});
