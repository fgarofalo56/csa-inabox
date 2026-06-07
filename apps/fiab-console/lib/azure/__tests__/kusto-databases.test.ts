/**
 * Unit tests for the Databases-browser backend:
 *  - listDatabasesWithDetails() parses `.show databases details` (size,
 *    retention, hot-cache, table count) from the Kusto v1 mgmt response.
 *  - deleteKustoDatabase() issues an ARM DELETE and maps 200/202 to a
 *    provisioning state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

// kusto-client imports cosmos-client at module load (which pulls in @azure/cosmos
// ESM). The Databases-browser functions under test never touch Cosmos, so stub
// the module to keep the import graph light and ESM-resolution-free under vitest.
vi.mock('../cosmos-client', () => ({
  itemsContainer: vi.fn(),
  workspacesContainer: vi.fn(),
}));

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_KUSTO_SUB = 'sub-1';
  process.env.LOOM_KUSTO_RG = 'rg-admin';
  process.env.LOOM_KUSTO_CLUSTER_NAME = 'adx-test';
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

describe('kusto-client / listDatabasesWithDetails', () => {
  it('parses size, retention days, hot-cache days, and table count', async () => {
    const calls = captureFetch(() => ({
      body: {
        Tables: [{
          Columns: [
            { ColumnName: 'DatabaseName', DataType: 'String' },
            { ColumnName: 'PersistentStorage', DataType: 'String' },
            { ColumnName: 'TotalSize', DataType: 'Real' },
            { ColumnName: 'PrettyName', DataType: 'String' },
            { ColumnName: 'RetentionPolicy', DataType: 'String' },
            { ColumnName: 'CachingPolicy', DataType: 'String' },
            { ColumnName: 'NumberOfTables', DataType: 'Int64' },
          ],
          Rows: [
            ['Telemetry', 'https://store', 2 * 1024 * 1024 * 1024, '',
              JSON.stringify({ SoftDeletePeriod: '365.00:00:00' }),
              JSON.stringify({ DataHotSpan: '31.00:00:00' }), 12],
            ['Tiny', 'https://store', 512 * 1024, '',
              JSON.stringify({ SoftDeletePeriod: '06:00:00' }),
              JSON.stringify({ DataHotSpan: '06:00:00' }), 0],
          ],
        }],
      },
    }));
    const { listDatabasesWithDetails } = await import('../kusto-client');
    const out = await listDatabasesWithDetails();

    expect(calls[0].url).toMatch(/\/v1\/rest\/mgmt$/);
    expect(JSON.parse(String(calls[0].init?.body)).csl).toBe('.show databases details');

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      name: 'Telemetry',
      totalSizeMb: 2048,        // 2 GiB → 2048 MB
      retentionDays: 365,
      hotCacheDays: 31,
      tableCount: 12,
    });
    // Pure-time timespans (no day component) parse to 0 days.
    expect(out[1]).toMatchObject({
      name: 'Tiny',
      retentionDays: 0,
      hotCacheDays: 0,
      tableCount: 0,
    });
    expect(out[1].totalSizeMb).toBeCloseTo(0.5, 5); // 512 KB → 0.5 MB
  });
});

describe('kusto-arm-client / deleteKustoDatabase', () => {
  it('issues ARM DELETE against the database resource and returns Succeeded on 200', async () => {
    const calls = captureFetch(() => ({ status: 200, body: {} }));
    const { deleteKustoDatabase } = await import('../kusto-arm-client');
    const out = await deleteKustoDatabase('Telemetry');

    expect(calls[0].init?.method).toBe('DELETE');
    expect(calls[0].url).toMatch(/Microsoft\.Kusto\/clusters\/adx-test\/databases\/Telemetry\?api-version=/);
    expect(out.provisioningState).toBe('Succeeded');
  });

  it('maps 202 (async) to Deleting', async () => {
    captureFetch(() => ({ status: 202, body: {} }));
    const { deleteKustoDatabase } = await import('../kusto-arm-client');
    const out = await deleteKustoDatabase('Telemetry');
    expect(out.provisioningState).toBe('Deleting');
  });

  it('throws KustoArmError on a 403', async () => {
    captureFetch(() => ({ status: 403, body: { error: { message: 'forbidden' } } }));
    const mod = await import('../kusto-arm-client');
    await expect(mod.deleteKustoDatabase('Telemetry')).rejects.toBeInstanceOf(mod.KustoArmError);
  });
});
