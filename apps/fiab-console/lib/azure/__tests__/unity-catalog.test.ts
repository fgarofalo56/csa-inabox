/**
 * Unit tests for unity-catalog-client.
 *
 * We stub global.fetch + the @azure/identity credential chain, so the
 * tests don't require an actual Databricks workspace. The intent is
 * to lock down (a) the request shape we send to Databricks REST and
 * (b) the federation / error mapping behaviour.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stub @azure/identity BEFORE importing the module under test so the token
// fetch never tries to hit IMDS.
vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'STUB.TOKEN', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return {
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred,
  };
});

import {
  listWorkspaceHostnames,
  UnityCatalogNotConfiguredError,
  listAllMetastores,
  listCatalogs,
  createCatalog,
  listSchemas,
  listTables,
  grantPrivilegesSQL,
  searchUnity,
  type UCMetastore,
} from '../unity-catalog-client';

const realFetch = global.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const body = await handler(String(url), init);
    if (body instanceof Response) return body;
    const status = body?._status || 200;
    return new Response(JSON.stringify(body), { status });
  }) as any;
}

beforeEach(() => {
  delete process.env.LOOM_DATABRICKS_HOSTNAMES;
  delete process.env.LOOM_DATABRICKS_HOSTNAME;
});

afterEach(() => { global.fetch = realFetch; });

describe('listWorkspaceHostnames', () => {
  it('throws NotConfigured when no env var is set', () => {
    expect(() => listWorkspaceHostnames()).toThrowError(UnityCatalogNotConfiguredError);
  });

  it('uses LOOM_DATABRICKS_HOSTNAMES (comma-split, scheme stripped)', () => {
    process.env.LOOM_DATABRICKS_HOSTNAMES = 'https://a.azuredatabricks.net, b.azuredatabricks.net/';
    expect(listWorkspaceHostnames()).toEqual(['a.azuredatabricks.net', 'b.azuredatabricks.net']);
  });

  it('falls back to LOOM_DATABRICKS_HOSTNAME', () => {
    process.env.LOOM_DATABRICKS_HOSTNAME = 'single.azuredatabricks.net';
    expect(listWorkspaceHostnames()).toEqual(['single.azuredatabricks.net']);
  });
});

describe('listAllMetastores', () => {
  it('federates across workspaces and dedupes by metastore_id', async () => {
    process.env.LOOM_DATABRICKS_HOSTNAMES = 'a.azuredatabricks.net,b.azuredatabricks.net';
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      // Both workspaces share the same metastore_id "shared-meta".
      return { metastores: [{ metastore_id: 'shared-meta', name: 'shared', region: 'eastus2' }] };
    });
    const out = await listAllMetastores();
    expect(out).toHaveLength(1);
    expect(out[0].metastore_id).toBe('shared-meta');
    expect(out[0].workspace_hostname).toBe('a.azuredatabricks.net'); // first wins
    expect(calls).toHaveLength(2);
  });

  it('returns synthetic ERROR_ rows when a workspace is unreachable', async () => {
    process.env.LOOM_DATABRICKS_HOSTNAMES = 'good.azuredatabricks.net,bad.azuredatabricks.net';
    mockFetch((url) => {
      if (url.includes('good.')) return { metastores: [{ metastore_id: 'm1', name: 'good' }] };
      return new Response('{"message":"forbidden"}', { status: 403 });
    });
    const out = await listAllMetastores();
    const errRow = out.find((m: UCMetastore) => m.metastore_id.startsWith('ERROR_'));
    expect(errRow).toBeDefined();
    expect(errRow!.workspace_hostname).toBe('bad.azuredatabricks.net');
  });
});

describe('listCatalogs/createCatalog', () => {
  it('GETs /api/2.1/unity-catalog/catalogs and decorates with host', async () => {
    process.env.LOOM_DATABRICKS_HOSTNAME = 'h.x';
    let observed = '';
    mockFetch((url) => {
      observed = url;
      return { catalogs: [{ name: 'main' }, { name: 'samples' }] };
    });
    const cats = await listCatalogs('h.x');
    expect(observed).toBe('https://h.x/api/2.1/unity-catalog/catalogs');
    expect(cats).toHaveLength(2);
    expect(cats[0].workspace_hostname).toBe('h.x');
  });

  it('POSTs the create body verbatim', async () => {
    let body: any;
    mockFetch((_url, init) => {
      body = JSON.parse((init?.body as string) || '{}');
      return { name: body.name, comment: body.comment };
    });
    const out = await createCatalog('h.x', { name: 'newcat', comment: 'hello' });
    expect(body).toEqual({ name: 'newcat', comment: 'hello' });
    expect(out.name).toBe('newcat');
  });
});

describe('listSchemas / listTables', () => {
  it('passes catalog/schema as query params', async () => {
    let lastUrl = '';
    mockFetch((url) => { lastUrl = url; return { schemas: [{ name: 's', catalog_name: 'c', full_name: 'c.s' }] }; });
    await listSchemas('h.x', 'c');
    expect(lastUrl).toContain('catalog_name=c');

    mockFetch((url) => { lastUrl = url; return { tables: [{ name: 't', catalog_name: 'c', schema_name: 's', full_name: 'c.s.t' }] }; });
    await listTables('h.x', 'c', 's');
    expect(lastUrl).toContain('catalog_name=c');
    expect(lastUrl).toContain('schema_name=s');
  });
});

describe('grantPrivilegesSQL', () => {
  it('issues a real GRANT statement via the statement executor', async () => {
    // executeStatement is in databricks-client; it should POST to /api/2.0/sql/statements.
    let bodySql = '';
    let warehouseInBody = '';
    mockFetch((url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (url.includes('/api/2.0/sql/statements')) {
        bodySql = body.statement;
        warehouseInBody = body.warehouse_id;
        return { statement_id: 'stmt-1', status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [] }, total_row_count: 0 }, result: { data_array: [] } };
      }
      return {};
    });
    await grantPrivilegesSQL('wh-1', ['SELECT', 'USE_SCHEMA'], 'TABLE', 'main.bronze.customers', 'alice@contoso.com');
    expect(bodySql).toBe('GRANT SELECT, USE_SCHEMA ON TABLE main.bronze.customers TO `alice@contoso.com`');
    expect(warehouseInBody).toBe('wh-1');
  });
});

describe('searchUnity', () => {
  it('returns shallow hits across workspaces', async () => {
    process.env.LOOM_DATABRICKS_HOSTNAMES = 'a.x';
    mockFetch((url) => {
      if (url.includes('/catalogs') && !url.includes('schemas')) {
        return { catalogs: [{ name: 'main', comment: 'main catalog' }, { name: 'other' }] };
      }
      if (url.includes('/schemas')) {
        return { schemas: [{ name: 'bronze', catalog_name: 'main', full_name: 'main.bronze' }] };
      }
      return {};
    });
    const hits = await searchUnity('main');
    const cat = hits.find((h) => h.type === 'catalog' && h.name === 'main');
    expect(cat).toBeDefined();
    expect(cat!.source).toBe('unity-catalog');
  });
});
