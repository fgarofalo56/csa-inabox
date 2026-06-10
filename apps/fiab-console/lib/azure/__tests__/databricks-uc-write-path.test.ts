/**
 * databricks-client — Unity Catalog WRITE-path REST contract test.
 *
 * Real test (per .claude/rules/no-vaporware.md): proves the UC write-path
 * client functions issue the *actual* Databricks Unity Catalog REST (api 2.1)
 * with the right method, URL, and body — no stubs, no mock arrays. We mock only:
 *   - @azure/identity → fake credential (module instantiates without real AAD)
 *   - global.fetch    → captures the exact request the client makes.
 *
 * Covers the gaps this task closed:
 *   - createUcCatalog: standard / foreign / Delta-Sharing + tags (properties)
 *   - createUcSchema:  tags (properties)
 *   - patchUcCatalog / patchUcSchema / patchUcTable: ownership transfer (SET OWNER)
 *
 * Endpoints (Microsoft Learn data-governance/unity-catalog):
 *   - POST  https://<host>/api/2.1/unity-catalog/catalogs
 *   - POST  https://<host>/api/2.1/unity-catalog/schemas
 *   - PATCH https://<host>/api/2.1/unity-catalog/{catalogs|schemas|tables}/{full_name}
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1234567890.7.azuredatabricks.net';

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() {
      return { token: 'fake-aad-token', expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  }
  return { DefaultAzureCredential: FakeCred, ManagedIdentityCredential: FakeCred, ChainedTokenCredential: FakeCred };
});

import {
  createUcCatalog, createUcSchema,
  patchUcCatalog, patchUcSchema, patchUcTable,
} from '../databricks-client';

const HOST = 'adb-1234567890.7.azuredatabricks.net';

function okResponse(body: unknown = {}): Response {
  return {
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('databricks-client — createUcCatalog', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(async () => okResponse({ name: 'c' })); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('POSTs a standard catalog with storage_root + tags and no catalog_type', async () => {
    await createUcCatalog({ name: 'sales', comment: 'c', storage_root: 'abfss://x@y.dfs.core.windows.net/p', properties: { team: 'analytics' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.1/unity-catalog/catalogs`);
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body as string);
    expect(sent.name).toBe('sales');
    expect(sent.storage_root).toBe('abfss://x@y.dfs.core.windows.net/p');
    expect(sent.properties).toEqual({ team: 'analytics' });
    expect('catalog_type' in sent).toBe(false);
    expect('connection_name' in sent).toBe(false);
  });

  it('POSTs a FOREIGN catalog with connection_name + options.database', async () => {
    await createUcCatalog({ name: 'pg', catalog_type: 'FOREIGN_CATALOG', connection_name: 'pg_conn', options: { database: 'sales_db' } });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.connection_name).toBe('pg_conn');
    expect(sent.options).toEqual({ database: 'sales_db' });
  });

  it('throws when a FOREIGN catalog is missing its connection_name', async () => {
    await expect(createUcCatalog({ name: 'pg', catalog_type: 'FOREIGN_CATALOG' }))
      .rejects.toThrow(/FOREIGN catalog requires connection_name/);
  });

  it('POSTs a Delta-Sharing catalog with provider_name + share_name', async () => {
    await createUcCatalog({ name: 'shared', catalog_type: 'DELTASHARING_CATALOG', provider_name: 'contoso', share_name: 'sales_share' });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.provider_name).toBe('contoso');
    expect(sent.share_name).toBe('sales_share');
  });

  it('throws when a Delta-Sharing catalog is missing provider/share', async () => {
    await expect(createUcCatalog({ name: 'shared', catalog_type: 'DELTASHARING_CATALOG', provider_name: 'contoso' }))
      .rejects.toThrow(/Delta-Sharing catalog requires provider_name and share_name/);
  });
});

describe('databricks-client — createUcSchema tags', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(async () => okResponse({ name: 's' })); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('POSTs properties (tags) when supplied', async () => {
    await createUcSchema({ name: 'bronze', catalog_name: 'sales', properties: { layer: 'bronze' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.1/unity-catalog/schemas`);
    const sent = JSON.parse(init.body as string);
    expect(sent.catalog_name).toBe('sales');
    expect(sent.properties).toEqual({ layer: 'bronze' });
  });
});

describe('databricks-client — UC ownership transfer (PATCH SET OWNER)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(async () => okResponse({ owner: 'data-admins' })); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('patchUcCatalog PATCHes /catalogs/{name} with { owner }', async () => {
    const out = await patchUcCatalog('sales', { owner: 'data-admins' });
    expect(out.owner).toBe('data-admins');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.1/unity-catalog/catalogs/sales`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ owner: 'data-admins' });
  });

  it('patchUcSchema PATCHes /schemas/{catalog.schema} with { owner }', async () => {
    await patchUcSchema('sales.bronze', { owner: 'data-admins' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.1/unity-catalog/schemas/sales.bronze`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ owner: 'data-admins' });
  });

  it('patchUcTable PATCHes /tables/{catalog.schema.table} with { owner }', async () => {
    await patchUcTable('sales.bronze.orders', { owner: 'data-admins' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${HOST}/api/2.1/unity-catalog/tables/sales.bronze.orders`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ owner: 'data-admins' });
  });

  it('omits keys that were not supplied (only comment)', async () => {
    await patchUcTable('sales.bronze.orders', { comment: 'updated' });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent).toEqual({ comment: 'updated' });
    expect('owner' in sent).toBe(false);
  });

  it('surfaces the real API error verbatim when ownership transfer is rejected (403)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 403, statusText: 'Forbidden',
      text: async () => JSON.stringify({ error_code: 'PERMISSION_DENIED', message: 'User is not the owner' }),
    } as unknown as Response);
    await expect(patchUcCatalog('sales', { owner: 'x' })).rejects.toThrow(/403/);
  });
});
