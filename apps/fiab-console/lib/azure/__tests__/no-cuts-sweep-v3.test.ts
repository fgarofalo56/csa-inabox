/**
 * No-cuts sweep v3 — exercises the new client methods + BFF route handlers
 * for the previously `disabled: true` ribbon buttons. Each test stubs the
 * underlying fetch call (ARM, Synapse dev, Databricks REST) and asserts:
 *   - the right HTTP method + URL is invoked,
 *   - the right body is sent,
 *   - errors surface verbatim.
 *
 * No real Azure traffic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV = {
  LOOM_SUBSCRIPTION_ID: 'sub-fixture',
  LOOM_DLZ_RG: 'rg-fixture',
  LOOM_SYNAPSE_WORKSPACE: 'syn-fixture',
  LOOM_DATABRICKS_HOSTNAME: 'adb-fixture.azuredatabricks.net',
  LOOM_BRONZE_URL: 'https://storfixture.dfs.core.windows.net/bronze',
};

function captureFetch(responses: Array<{ status?: number; body?: unknown; bodyText?: string }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: typeof url === 'string' ? url : (url as any).toString(), init });
    const r = responses[Math.min(i++, responses.length - 1)] || { status: 200, body: {} };
    const text = r.bodyText ?? JSON.stringify(r.body ?? {});
    return new Response(text, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

// Stub the Azure credential chain so the client modules don't try to call
// real IMDS / az login. Each client uses ChainedTokenCredential or
// DefaultAzureCredential — we make .getToken return a static token.
vi.mock('@azure/identity', async () => {
  class Cred {
    async getToken() { return { token: 'test-token', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return {
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred,
  };
});

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('synapse-dev-client — scaleSparkPool / setSparkPoolAutoPause / debugPipeline / triggers', () => {
  it('scaleSparkPool PATCHes nodeCount via ARM', async () => {
    const { calls } = captureFetch([{ body: { name: 'pool-x', properties: { nodeCount: 5 } } }]);
    const { scaleSparkPool } = await import('../synapse-dev-client');
    const out = await scaleSparkPool('pool-x', { nodeCount: 5 });
    expect(out.properties.nodeCount).toBe(5);
    expect(calls[0].init?.method).toBe('PATCH');
    expect(calls[0].url).toContain('/bigDataPools/pool-x');
    expect(JSON.parse(calls[0].init!.body as string)).toMatchObject({ properties: { nodeCount: 5 } });
  });

  it('setSparkPoolAutoPause PATCHes autoPause with delayInMinutes', async () => {
    const { calls } = captureFetch([{ body: { properties: { autoPause: { enabled: true, delayInMinutes: 15 } } } }]);
    const { setSparkPoolAutoPause } = await import('../synapse-dev-client');
    await setSparkPoolAutoPause('pool-x', { enabled: true, delayInMinutes: 15 });
    expect(calls[0].init?.method).toBe('PATCH');
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({
      properties: { autoPause: { enabled: true, delayInMinutes: 15 } },
    });
  });

  it('setSparkPoolAutoPause rejects enabled without delay >= 5', async () => {
    captureFetch([{ body: {} }]);
    const { setSparkPoolAutoPause } = await import('../synapse-dev-client');
    await expect(setSparkPoolAutoPause('pool-x', { enabled: true, delayInMinutes: 1 })).rejects.toThrow(/delayInMinutes/);
  });

  it('debugPipeline POSTs to createRun?isDebugRun=true', async () => {
    const { calls } = captureFetch([{ body: { runId: 'r-debug' } }]);
    const { debugPipeline } = await import('../synapse-dev-client');
    const out = await debugPipeline('pl-x', { foo: 'bar' });
    expect(out.runId).toBe('r-debug');
    expect(calls[0].url).toContain('/pipelines/pl-x/createRun');
    expect(calls[0].url).toContain('isDebugRun=true');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('listTriggersForPipeline filters by pipelineReference.referenceName', async () => {
    captureFetch([{
      body: {
        value: [
          { name: 't1', properties: { pipelines: [{ pipelineReference: { referenceName: 'pl-a', type: 'PipelineReference' } }] } },
          { name: 't2', properties: { pipelines: [{ pipelineReference: { referenceName: 'pl-b', type: 'PipelineReference' } }] } },
          { name: 't3', properties: { pipelines: [{ pipelineReference: { referenceName: 'pl-a', type: 'PipelineReference' } }] } },
        ],
      },
    }]);
    const { listTriggersForPipeline } = await import('../synapse-dev-client');
    const out = await listTriggersForPipeline('pl-a');
    expect(out.map((t) => t.name)).toEqual(['t1', 't3']);
  });

  it('startTrigger / stopTrigger / deleteTrigger hit the right Synapse dev endpoints', async () => {
    const { calls } = captureFetch([{}, {}, {}]);
    const c = await import('../synapse-dev-client');
    await c.startTrigger('t1');
    await c.stopTrigger('t1');
    await c.deleteTrigger('t1');
    expect(calls[0].url).toMatch(/triggers\/t1\/start/);
    expect(calls[1].url).toMatch(/triggers\/t1\/stop/);
    expect(calls[2].init?.method).toBe('DELETE');
  });
});

describe('azure-sql-client — firewall + AAD admin', () => {
  it('listFirewallRules normalises ARM shape', async () => {
    captureFetch([
      { body: { value: [{ name: 'AllowAll', properties: { startIpAddress: '0.0.0.0', endIpAddress: '255.255.255.255' } }] } },
    ]);
    const { listFirewallRules } = await import('../azure-sql-client');
    // Use a full ARM id to skip the server-lookup round-trip.
    const out = await listFirewallRules('/subscriptions/x/resourceGroups/y/providers/Microsoft.Sql/servers/sv1');
    expect(out).toEqual([{ name: 'AllowAll', startIpAddress: '0.0.0.0', endIpAddress: '255.255.255.255' }]);
  });

  it('upsertFirewallRule PUTs properties.startIpAddress / endIpAddress', async () => {
    const { calls } = captureFetch([
      { body: { name: 'corp', properties: { startIpAddress: '10.0.0.1', endIpAddress: '10.0.0.255' } } },
    ]);
    const { upsertFirewallRule } = await import('../azure-sql-client');
    await upsertFirewallRule('/subscriptions/x/resourceGroups/y/providers/Microsoft.Sql/servers/sv1', {
      name: 'corp', startIpAddress: '10.0.0.1', endIpAddress: '10.0.0.255',
    });
    expect(calls[0].init?.method).toBe('PUT');
    expect(JSON.parse(calls[0].init!.body as string)).toMatchObject({
      properties: { startIpAddress: '10.0.0.1', endIpAddress: '10.0.0.255' },
    });
  });

  it('setAadAdmin PUTs administrators/ActiveDirectory with login + sid', async () => {
    const { calls } = captureFetch([
      { body: { properties: { login: 'u@t.com', sid: 'oid-1', tenantId: 'ten-1' } } },
    ]);
    const { setAadAdmin } = await import('../azure-sql-client');
    await setAadAdmin('/subscriptions/x/resourceGroups/y/providers/Microsoft.Sql/servers/sv1', {
      login: 'u@t.com', sid: 'oid-1',
    });
    expect(calls[0].url).toMatch(/administrators\/ActiveDirectory/);
    expect(calls[0].init?.method).toBe('PUT');
    expect(JSON.parse(calls[0].init!.body as string)).toMatchObject({
      properties: { administratorType: 'ActiveDirectory', login: 'u@t.com', sid: 'oid-1' },
    });
  });

  it('getAadAdmin returns null on 404', async () => {
    captureFetch([{ status: 404, body: { error: { message: 'not found' } } }]);
    const { getAadAdmin } = await import('../azure-sql-client');
    const out = await getAadAdmin('/subscriptions/x/resourceGroups/y/providers/Microsoft.Sql/servers/sv1');
    expect(out).toBeNull();
  });
});

describe('databricks-client — listQueryHistory', () => {
  it('GETs /api/2.0/sql/history/queries with warehouse filter', async () => {
    const { calls } = captureFetch([{
      body: { res: [{ query_id: 'q1', status: 'FINISHED', query_text: 'SELECT 1', duration: 42 }], next_page_token: 'nxt' },
    }]);
    const { listQueryHistory } = await import('../databricks-client');
    const out = await listQueryHistory({ warehouseId: 'wh-1', maxResults: 5 });
    expect(out.entries[0].query_id).toBe('q1');
    expect(out.nextPageToken).toBe('nxt');
    expect(calls[0].url).toMatch(/\/api\/2\.0\/sql\/history\/queries\?/);
    expect(calls[0].url).toMatch(/filter_by\.warehouse_ids=wh-1/);
    expect(calls[0].url).toMatch(/max_results=5/);
  });
});

describe('adls-client — listKnownBlobDataRoles', () => {
  // NOTE on timeout: this test body is trivial (a synchronous map over a 3-entry
  // table), but `await import('../adls-client')` pulls in the heavy
  // `@azure/storage-file-datalake` package, which vitest must transform/load on
  // first import. Under the jsdom render harness that cold import can exceed the
  // default 5s timeout (~30s observed on Windows), so we give this test room.
  // The assertions below remain meaningful — they pin the exact role names and
  // the stable Reader GUID emitted by adls-client.ts.
  it('exposes the three Storage Blob Data roles with their GUIDs', async () => {
    const { listKnownBlobDataRoles } = await import('../adls-client');
    const roles = listKnownBlobDataRoles();
    const names = roles.map((r) => r.name).sort();
    expect(names).toEqual([
      'Storage Blob Data Contributor',
      'Storage Blob Data Owner',
      'Storage Blob Data Reader',
    ]);
    // GUIDs are global across all Azure tenants — pin all three.
    const byName = Object.fromEntries(roles.map((r) => [r.name, r.id]));
    expect(byName['Storage Blob Data Reader']).toBe('2a2b9908-6ea1-4ae2-8e65-a410df84e7d1');
    expect(byName['Storage Blob Data Contributor']).toBe('ba92f5b4-2d11-453d-a403-e96b0029c9fe');
    expect(byName['Storage Blob Data Owner']).toBe('b7e6dc6d-f1e8-4753-8033-0f276bb0955b');
  }, 60_000);
});
