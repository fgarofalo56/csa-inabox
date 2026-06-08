/**
 * Unit tests for azure-sql-client.scaleDatabase — the Compute & Storage scale
 * tab's backend. Stubs `fetch` and verifies the ARM PATCH on
 * Microsoft.Sql/servers/databases (SKU + serverless properties), the LRO poll,
 * and the before/after SKU receipt. No live ARM is touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

// mssql is imported at module top of azure-sql-client; stub it so the import
// graph resolves without a real TDS driver in the test runner.
vi.mock('mssql', () => ({ default: { ConnectionPool: class {} } }));

const SERVER_ID =
  '/subscriptions/sub-1/resourceGroups/rg-sql/providers/Microsoft.Sql/servers/srv1';

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_UAMI_CLIENT_ID = 'uami-1';
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

/**
 * Drives a GET (before) → PATCH (202 + async-op header) → GET (poll Succeeded)
 * → GET (after) sequence keyed by the request, so scaleDatabase walks its full
 * happy path.
 */
function sequenceFetch(handlers: {
  before: any;
  patchStatus?: number;
  asyncOp?: string;
  lro?: any;
  after: any;
}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let dbGetCount = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const method = (init?.method || 'GET').toUpperCase();
    if (method === 'PATCH') {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (handlers.asyncOp) headers['azure-asyncoperation'] = handlers.asyncOp;
      return new Response(JSON.stringify({}), { status: handlers.patchStatus ?? 202, headers });
    }
    if (handlers.asyncOp && u === handlers.asyncOp) {
      return new Response(JSON.stringify(handlers.lro ?? { status: 'Succeeded' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    // database GET — first is before, subsequent is after.
    dbGetCount += 1;
    const body = dbGetCount === 1 ? handlers.before : handlers.after;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('azure-sql-client / scaleDatabase', () => {
  it('PATCHes the new SKU and returns the before/after receipt (S0 → S1)', async () => {
    const calls = sequenceFetch({
      before: { sku: { name: 'S0', tier: 'Standard', capacity: 10 }, properties: { status: 'Online' } },
      asyncOp: 'https://management.azure.com/lro/op1',
      lro: { status: 'Succeeded' },
      after: { sku: { name: 'S1', tier: 'Standard', capacity: 20 }, properties: { status: 'Online' } },
    });
    const { scaleDatabase } = await import('../azure-sql-client');
    const out = await scaleDatabase({ serverId: SERVER_ID, database: 'appdb', skuName: 'S1', tier: 'Standard' });

    const patch = calls.find((c) => (c.init?.method || '').toUpperCase() === 'PATCH')!;
    expect(patch.url).toMatch(/Microsoft\.Sql\/servers\/srv1\/databases\/appdb/);
    expect(JSON.parse(String(patch.init?.body))).toEqual({ sku: { name: 'S1', tier: 'Standard' } });
    expect(out.ok).toBe(true);
    expect(out.beforeSku.name).toBe('S0');
    expect(out.afterSku.name).toBe('S1');
    expect(out.afterSku.capacity).toBe(20);
    expect(out.lroStatus).toBe('Succeeded');
  });

  it('includes serverless properties (provisioned → serverless)', async () => {
    const calls = sequenceFetch({
      before: { sku: { name: 'GP_Gen5_2', tier: 'GeneralPurpose', family: 'Gen5', capacity: 2 }, properties: { status: 'Online' } },
      asyncOp: 'https://management.azure.com/lro/op2',
      after: { sku: { name: 'GP_S_Gen5_2', tier: 'GeneralPurpose', family: 'Gen5', capacity: 2 }, properties: { status: 'Online', autoPauseDelay: 60, minCapacity: 0.5 } },
    });
    const { scaleDatabase } = await import('../azure-sql-client');
    const out = await scaleDatabase({
      serverId: SERVER_ID, database: 'appdb', skuName: 'GP_S_Gen5_2', tier: 'GeneralPurpose',
      family: 'Gen5', capacity: 2, autoPauseDelay: 60, minCapacity: 0.5, maxSizeBytes: 1_073_741_824 * 32,
    });
    const patch = calls.find((c) => (c.init?.method || '').toUpperCase() === 'PATCH')!;
    const body = JSON.parse(String(patch.init?.body));
    expect(body.sku).toEqual({ name: 'GP_S_Gen5_2', tier: 'GeneralPurpose', family: 'Gen5', capacity: 2 });
    expect(body.properties.autoPauseDelay).toBe(60);
    expect(body.properties.minCapacity).toBe(0.5);
    expect(body.properties.maxSizeBytes).toBe(1_073_741_824 * 32);
    expect(out.afterAutoPauseDelay).toBe(60);
    expect(out.afterMinCapacity).toBe(0.5);
  });

  it('rejects a maxSizeBytes that is not a multiple of 1 GiB', async () => {
    sequenceFetch({ before: {}, after: {} });
    const { scaleDatabase } = await import('../azure-sql-client');
    await expect(
      scaleDatabase({ serverId: SERVER_ID, database: 'appdb', skuName: 'S1', tier: 'Standard', maxSizeBytes: 12345 }),
    ).rejects.toThrow(/multiple of/);
  });

  it('throws AzureSqlError carrying the ARM status on a 403 (honest gate)', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'PATCH') {
        return new Response(JSON.stringify({ error: { message: 'Authorization failed' } }), {
          status: 403, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ sku: { name: 'S0', tier: 'Standard' }, properties: {} }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { scaleDatabase, AzureSqlError } = await import('../azure-sql-client');
    await expect(
      scaleDatabase({ serverId: SERVER_ID, database: 'appdb', skuName: 'S1', tier: 'Standard' }),
    ).rejects.toMatchObject({ status: 403 });
    // Confirm the thrown error is the typed AzureSqlError (route maps 403 → hint).
    try {
      await scaleDatabase({ serverId: SERVER_ID, database: 'appdb', skuName: 'S1', tier: 'Standard' });
    } catch (e) {
      expect(e).toBeInstanceOf(AzureSqlError);
    }
  });
});
