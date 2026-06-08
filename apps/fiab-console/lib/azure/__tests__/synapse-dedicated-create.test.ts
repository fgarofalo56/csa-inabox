/**
 * synapse-dev-client — Dedicated SQL pool CREATE / DELETE ARM contract test
 * (the Azure-native Gov warehouse backend, per no-fabric-dependency.md).
 *
 * Real test: proves createDedicatedSqlPool / deleteDedicatedSqlPool issue the
 * actual ARM REST calls (PUT / DELETE .../sqlPools/{name}) with the right
 * method, URL, api-version, and body. Mocks only @azure/identity + fetch.
 *
 * ARM shape (Microsoft Learn Microsoft.Synapse/workspaces/sqlPools 2021-06-01):
 *   PUT    .../sqlPools/{name}?api-version=2021-06-01
 *          { location, sku: { name: 'DWxxxxc' }, properties: { createMode, collation } }
 *   DELETE .../sqlPools/{name}?api-version=2021-06-01
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_DLZ_RG = 'rg-dlz';
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-ws';
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

describe('synapse-dev-client / createDedicatedSqlPool', () => {
  it('rejects an invalid SKU shape', async () => {
    const { createDedicatedSqlPool } = await import('../synapse-dev-client');
    await expect(createDedicatedSqlPool('pool1', 'F100', 'eastus')).rejects.toThrow(/invalid sku/);
  });

  it('requires a location', async () => {
    const { createDedicatedSqlPool } = await import('../synapse-dev-client');
    await expect(createDedicatedSqlPool('pool1', 'DW100c', '')).rejects.toThrow(/location is required/);
  });

  it('PUTs ARM with location + sku + Default createMode', async () => {
    const calls = captureFetch(() => ({ body: { name: 'pool1', sku: { name: 'DW100c' }, properties: { status: 'Provisioning' } } }));
    const { createDedicatedSqlPool } = await import('../synapse-dev-client');
    const out = await createDedicatedSqlPool('pool1', 'DW100c', 'eastus2');
    expect(calls[0].url).toMatch(/sqlPools\/pool1\?api-version=2021-06-01/);
    expect(calls[0].init?.method).toBe('PUT');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.location).toBe('eastus2');
    expect(body.sku).toEqual({ name: 'DW100c' });
    expect(body.properties.createMode).toBe('Default');
    expect(body.properties.collation).toBe('SQL_Latin1_General_CP1_CI_AS');
    expect(out.name).toBe('pool1');
  });
});

describe('synapse-dev-client / deleteDedicatedSqlPool', () => {
  it('issues ARM DELETE and resolves on 202', async () => {
    const calls = captureFetch(() => ({ status: 202, body: {} }));
    const { deleteDedicatedSqlPool } = await import('../synapse-dev-client');
    await expect(deleteDedicatedSqlPool('pool1')).resolves.toBeUndefined();
    expect(calls[0].url).toMatch(/sqlPools\/pool1\?api-version=2021-06-01/);
    expect(calls[0].init?.method).toBe('DELETE');
  });

  it('swallows a 404 (idempotent delete)', async () => {
    captureFetch(() => ({ status: 404, body: { error: 'not found' } }));
    const { deleteDedicatedSqlPool } = await import('../synapse-dev-client');
    await expect(deleteDedicatedSqlPool('gone')).resolves.toBeUndefined();
  });

  it('surfaces a real ARM error verbatim on 403', async () => {
    captureFetch(() => ({ status: 403, body: { error: { code: 'AuthorizationFailed' } } }));
    const { deleteDedicatedSqlPool } = await import('../synapse-dev-client');
    await expect(deleteDedicatedSqlPool('pool1')).rejects.toThrow(/deleteDedicatedSqlPool\(pool1\) failed 403/);
  });
});
