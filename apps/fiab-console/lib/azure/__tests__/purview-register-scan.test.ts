/**
 * Vitest specs for the Purview scan-plane REGISTER + SCAN fixes
 * (root causes proven live against purview-csa-loom-eastus2, 2026-07-15):
 *
 *   1. registerDataSource defaults `properties.collection` to the account ROOT
 *      collection — the scan plane answers 404 ResourceNotFound without one.
 *   2. Upstream 404 on the register PUT propagates the REAL Purview error body
 *      (previously swallowed into "Purview returned empty body…" / 502).
 *   3. triggerScanRun uses a GUID runId + scanLevel=Full — a non-GUID id makes
 *      Purview answer 500 `InternalServerError: "Unknown error"`.
 *   4. upsertScan defaults its landing collection to the root collection.
 *   5. purview-source-map derives `properties.resourceId` per kind — the scan
 *      plane answers 403 OperationNotAllowed for endpoint-without-resourceId.
 *   6. Bulk auto-add classification: 409 DataSource_Duplicate → 'exists'
 *      (partial success, never all-or-nothing).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// registerDataSource now resolves ARM coordinates by name via Resource Graph
// when properties carry no resourceId/subscriptionId — mock it out so the
// fetch mocks below keep their exact call ordering. The resolve path itself
// gets its own spec at the bottom of this file.
const discoverCoordsMock = vi.fn(async () => null as { subscriptionId: string; resourceGroup: string } | null);
vi.mock('../resource-graph-coords', () => ({
  discoverResourceCoordsByName: (...args: any[]) => discoverCoordsMock(...args),
}));

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() { return { token: 'fake-token-purview', expiresOnTimestamp: Date.now() + 60_000 }; }
  }
  return {
    ManagedIdentityCredential: FakeCred,
    DefaultAzureCredential: FakeCred,
    ChainedTokenCredential: class { constructor(..._creds: any[]) {} async getToken() { return { token: 'fake-token-purview', expiresOnTimestamp: Date.now() + 60_000 }; } },
  };
});

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLLECTIONS_BODY = JSON.stringify({
  value: [
    { name: 'purview-test', friendlyName: 'purview-test' },                     // root (no parent)
    { name: 'finance', parentCollection: { referenceName: 'purview-test' } },
  ],
});

describe('purview-client scan plane (register + scan fixes)', () => {
  const ORIG_ENV = { ...process.env };
  let fetchMock: any;

  beforeEach(() => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
    process.env.LOOM_UAMI_CLIENT_ID = 'test-uami';
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
    vi.restoreAllMocks();
  });

  it('registerDataSource defaults the collection to the ROOT collection when absent', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(COLLECTIONS_BODY, { status: 200 }))       // GET /collections
      .mockResolvedValueOnce(new Response(JSON.stringify({                          // PUT /scan/datasources/…
        id: 'ds1', name: 'lake', kind: 'AdlsGen2',
        properties: { endpoint: 'https://lake.dfs.core.windows.net/', collection: { referenceName: 'purview-test' } },
      }), { status: 201 }));
    const mod = await import('../purview-client');
    const ds = await mod.registerDataSource({
      name: 'lake', kind: 'AdlsGen2',
      properties: { endpoint: 'https://lake.dfs.core.windows.net/', resourceId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/lake' },
    });
    expect(ds.collectionId).toBe('purview-test');
    // First call reads collections; second is the register PUT with the default.
    const [colUrl] = fetchMock.mock.calls[0];
    expect(colUrl).toContain('/collections');
    const [putUrl, putInit] = fetchMock.mock.calls[1];
    expect(putUrl).toContain('/scan/datasources/lake');
    const body = JSON.parse((putInit as any).body);
    expect(body.properties.collection).toEqual({ referenceName: 'purview-test', type: 'CollectionReference' });
  });

  it('registerDataSource keeps an explicit collection (no collections read)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      name: 'lake', kind: 'AdlsGen2', properties: { collection: { referenceName: 'finance' } },
    }), { status: 201 }));
    const mod = await import('../purview-client');
    const ds = await mod.registerDataSource({
      name: 'lake', kind: 'AdlsGen2',
      properties: { endpoint: 'https://lake.dfs.core.windows.net/', collection: { referenceName: 'finance', type: 'CollectionReference' } },
    });
    expect(ds.collectionId).toBe('finance');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.properties.collection.referenceName).toBe('finance');
  });

  it('registerDataSource resolves the ARM resourceId by name when properties carry none (manual Register dialog)', async () => {
    discoverCoordsMock.mockResolvedValueOnce({ subscriptionId: 'sub-1', resourceGroup: 'rg-1' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      name: 'lake', kind: 'AdlsGen2', properties: { collection: { referenceName: 'finance' } },
    }), { status: 201 }));
    const mod = await import('../purview-client');
    await mod.registerDataSource({
      name: 'lake', kind: 'AdlsGen2',
      properties: { collection: { referenceName: 'finance', type: 'CollectionReference' } },
    });
    expect(discoverCoordsMock).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'Microsoft.Storage/storageAccounts', name: 'lake' }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.properties.resourceId).toBe(
      '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Storage/storageAccounts/lake',
    );
    expect(body.properties.subscriptionId).toBe('sub-1');
    // AdlsGen2 endpoint defaulted from the account name (sovereign-correct).
    expect(body.properties.endpoint).toContain('lake.dfs.core.windows.net');
  });

  it('registerDataSource propagates the REAL upstream 404 body (no "empty body" masking)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(COLLECTIONS_BODY, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'ResourceNotFound', message: 'Resource not found' } }), { status: 404 }));
    const mod = await import('../purview-client');
    await expect(mod.registerDataSource({ name: 'x', kind: 'AdlsGen2', properties: {} }))
      .rejects.toMatchObject({ status: 404, message: expect.stringContaining('ResourceNotFound') });
  });

  it('registerDataSource surfaces the 403 OperationNotAllowed payload error verbatim', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(COLLECTIONS_BODY, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 'OperationNotAllowed', message: 'Azure data source registration requires a valid resourceId when an endpoint is specified.' },
      }), { status: 403 }));
    const mod = await import('../purview-client');
    await expect(mod.registerDataSource({ name: 'x', kind: 'AdlsGen2', properties: { endpoint: 'https://x.dfs.core.windows.net/' } }))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining('requires a valid resourceId') });
  });

  it('triggerScanRun uses a GUID runId and scanLevel=Full', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ scanResultId: 'run-guid', status: 'Accepted' }), { status: 202 }));
    const mod = await import('../purview-client');
    const result = await mod.triggerScanRun('src', 'scan1');
    expect(result.runId).toBe('run-guid');
    const [url, init] = fetchMock.mock.calls[0];
    expect((init as any).method).toBe('PUT');
    expect(url).toContain('scanLevel=Full');
    const runId = String(url).split('/runs/')[1].split('?')[0];
    expect(runId).toMatch(GUID_RE);
  });

  it('triggerScanRun propagates the upstream 500 body (the literal "Unknown error")', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'InternalServerError', message: 'Unknown error' } }), { status: 500 }));
    const mod = await import('../purview-client');
    await expect(mod.triggerScanRun('src', 'scan1'))
      .rejects.toMatchObject({ status: 500, message: expect.stringContaining('Unknown error') });
  });

  it('upsertScan defaults the landing collection to the ROOT collection', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(COLLECTIONS_BODY, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'scan1', kind: 'AdlsGen2Msi', properties: {} }), { status: 201 }));
    const mod = await import('../purview-client');
    await mod.upsertScan({ sourceName: 'src', scanName: 'scan1', kind: 'AdlsGen2Msi', scanRulesetName: 'AdlsGen2' });
    const body = JSON.parse((fetchMock.mock.calls[1][1] as any).body);
    expect(body.properties.collection).toEqual({ referenceName: 'purview-test', type: 'CollectionReference' });
    expect(body.properties.scanRulesetName).toBe('AdlsGen2');
    expect(body.properties.scanRulesetType).toBe('System');
  });

  it('upsertScan propagates a 404 with the real body instead of "empty body"', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(COLLECTIONS_BODY, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'ResourceNotFound', message: 'Resource not found' } }), { status: 404 }));
    const mod = await import('../purview-client');
    await expect(mod.upsertScan({ sourceName: 'nope', scanName: 's', kind: 'AdlsGen2Msi', scanRulesetName: 'AdlsGen2' }))
      .rejects.toMatchObject({ status: 404, message: expect.stringContaining('ResourceNotFound') });
  });
});

describe('purview-source-mapping resourceId derivation', () => {
  it('derives the ARM resource id per kind', async () => {
    const { derivePurviewArmResourceId } = await import('../purview-source-mapping');
    expect(derivePurviewArmResourceId('AdlsGen2', { subscriptionId: 's', resourceGroup: 'rg', resourceName: 'lake' }))
      .toBe('/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/lake');
    expect(derivePurviewArmResourceId('AzureSqlDatabase', { subscriptionId: 's', resourceGroup: 'rg', resourceName: 'srv' }))
      .toBe('/subscriptions/s/resourceGroups/rg/providers/Microsoft.Sql/servers/srv');
    expect(derivePurviewArmResourceId('AzureSynapseWorkspace', { subscriptionId: 's', resourceGroup: 'rg', resourceName: 'ws' }))
      .toBe('/subscriptions/s/resourceGroups/rg/providers/Microsoft.Synapse/workspaces/ws');
    expect(derivePurviewArmResourceId('AzureDataExplorer', { subscriptionId: 's', resourceGroup: 'rg', resourceName: 'adx' }))
      .toBe('/subscriptions/s/resourceGroups/rg/providers/Microsoft.Kusto/clusters/adx');
    expect(derivePurviewArmResourceId('AzureCosmosDb', { subscriptionId: 's', resourceGroup: 'rg', resourceName: 'cos' }))
      .toBe('/subscriptions/s/resourceGroups/rg/providers/Microsoft.DocumentDB/databaseAccounts/cos');
    expect(derivePurviewArmResourceId('AzurePostgreSql', { subscriptionId: 's', resourceGroup: 'rg', resourceName: 'pg' }))
      .toBe('/subscriptions/s/resourceGroups/rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg');
  });

  it('returns undefined when coordinates are incomplete or the kind is unknown (never fabricates)', async () => {
    const { derivePurviewArmResourceId } = await import('../purview-source-mapping');
    expect(derivePurviewArmResourceId('AdlsGen2', { subscriptionId: 's', resourceGroup: 'rg' })).toBeUndefined();
    expect(derivePurviewArmResourceId('AdlsGen2', { resourceGroup: 'rg', resourceName: 'x' })).toBeUndefined();
    expect(derivePurviewArmResourceId('AzureDatabricksUnityCatalog', { subscriptionId: 's', resourceGroup: 'rg', resourceName: 'x' })).toBeUndefined();
  });

  it('SQL scan kind is the real enum value AzureSqlDatabaseMsi', async () => {
    const { PURVIEW_KIND_SPEC } = await import('../purview-source-mapping');
    expect(PURVIEW_KIND_SPEC.AzureSqlDatabase?.scanKind).toBe('AzureSqlDatabaseMsi');
  });
});

describe('purview-source-map resourceId wiring', () => {
  it('attaches the derived resourceId to an ADLS mapping', async () => {
    const { purviewSourceForConnectable, isUnsupportedPurviewSource } = await import('../purview-source-map');
    const mapped = purviewSourceForConnectable({
      connType: 'storage-adls', resourceName: 'lakeacct',
      subscriptionId: 'sub1', resourceGroup: 'rg1', location: 'eastus2',
    });
    expect(isUnsupportedPurviewSource(mapped)).toBe(false);
    if (!isUnsupportedPurviewSource(mapped)) {
      expect(mapped.kind).toBe('AdlsGen2');
      expect(mapped.properties.resourceId)
        .toBe('/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Storage/storageAccounts/lakeacct');
    }
  });

  it('attaches the derived resourceId to an Azure SQL mapping (server grain)', async () => {
    const { purviewSourceForConnectable, isUnsupportedPurviewSource } = await import('../purview-source-map');
    const mapped = purviewSourceForConnectable({
      connType: 'azure-sql', host: 'srv1.database.windows.net',
      subscriptionId: 'sub1', resourceGroup: 'rg1',
    });
    if (!isUnsupportedPurviewSource(mapped)) {
      expect(mapped.properties.resourceId)
        .toBe('/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Sql/servers/srv1');
    } else {
      throw new Error('expected supported mapping');
    }
  });

  it('omits resourceId (no fabrication) when ARM coordinates are missing', async () => {
    const { purviewSourceForConnectable, isUnsupportedPurviewSource } = await import('../purview-source-map');
    const mapped = purviewSourceForConnectable({ connType: 'adx', host: 'https://adx1.eastus.kusto.windows.net' });
    if (!isUnsupportedPurviewSource(mapped)) {
      expect(mapped.properties.resourceId).toBeUndefined();
    } else {
      throw new Error('expected supported mapping');
    }
  });

  it('still reports non-scannable kinds as unsupported (partial success contract)', async () => {
    const { purviewSourceForConnectable, isUnsupportedPurviewSource } = await import('../purview-source-map');
    for (const connType of ['event-hub', 'service-bus', 'key-vault'] as const) {
      const mapped = purviewSourceForConnectable({ connType });
      expect(isUnsupportedPurviewSource(mapped)).toBe(true);
      if (isUnsupportedPurviewSource(mapped)) expect(mapped.reason).toMatch(/not a Microsoft Purview/i);
    }
  });
});

describe('purview-bulk-register classification (auto-add partial success)', () => {
  it('classifies 2xx as ok, 409/duplicate as exists, others as error with the real message', async () => {
    const { classifyBulkRegisterResponse } = await import('../purview-bulk-register');
    expect(classifyBulkRegisterResponse(201, { ok: true }).status).toBe('ok');
    expect(classifyBulkRegisterResponse(409, { ok: false, error: 'DataSource_Duplicate: A data source already exists for this target: x.dfs.core.windows.net' }).status).toBe('exists');
    expect(classifyBulkRegisterResponse(400, { ok: false, error: 'A data source already exists for this target: y' }).status).toBe('exists');
    const err = classifyBulkRegisterResponse(400, { ok: false, error: 'OperationNotAllowed: Azure data source registration requires a valid resourceId when an endpoint is specified.' });
    expect(err.status).toBe('error');
    expect(err.detail).toContain('requires a valid resourceId');
    const fallback = classifyBulkRegisterResponse(502, {});
    expect(fallback.status).toBe('error');
    expect(fallback.detail).toBe('HTTP 502');
  });

  it('aggregates per-item outcomes (never all-or-nothing)', async () => {
    const { summarizeBulkRegister } = await import('../purview-bulk-register');
    const s = summarizeBulkRegister([
      { status: 'ok' }, { status: 'ok' }, { status: 'exists' }, { status: 'error' },
    ]);
    expect(s).toEqual({ total: 4, ok: 2, exists: 1, errors: 1 });
  });
});
