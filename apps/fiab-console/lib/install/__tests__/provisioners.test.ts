/**
 * Phase 2 — per-provisioner contract tests.
 *
 * Each test stubs fetch (Fabric / AI Search / Kusto REST) and asserts:
 *   - the right Azure endpoint is hit,
 *   - the right body is sent,
 *   - remediation gates surface verbatim (no swallowing).
 *
 * No real Azure traffic.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// Cold-transform budget. The kql-db provisioner (and the engine that imports it)
// transitively pull in `@/lib/azure/kusto-client` → `@azure/cosmos`, a very large
// SDK whose first vitest transform takes ~30-50s on a cold cache. That one-time
// cost — NOT any logic in the provisioner — is what blew the default 5s
// per-test timeout. The provisioner/engine logic itself runs in ~1ms once the
// module graph is loaded (verified: runProvisioning(deploy=false) === 1ms after
// import). We give the suites that touch that module graph a generous timeout so
// the cold transform can finish; assertions below are unchanged.
const COLD_TRANSFORM_TIMEOUT_MS = 120_000;

const ENV_SHARED = {
  LOOM_DEFAULT_FABRIC_WORKSPACE: 'ws-fix-123',
  LOOM_KUSTO_CLUSTER_URI: 'https://adx-fix.kusto.windows.net',
  LOOM_KUSTO_CLUSTER_NAME: 'adx-fix',
  LOOM_KUSTO_RG: 'rg-fix',
  LOOM_SUBSCRIPTION_ID: 'sub-fix',
  LOOM_SYNAPSE_WORKSPACE: 'syn-fix',
  LOOM_SYNAPSE_DEDICATED_POOL: 'dwh01',
  LOOM_AI_SEARCH_SERVICE: 'search-fix',
};

function captureFetch(responses: Array<{ status?: number; body?: any; bodyText?: string; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: typeof url === 'string' ? url : (url as any).toString(), init });
    const r = responses[Math.min(i++, responses.length - 1)] || { status: 200, body: {} };
    const text = r.bodyText ?? JSON.stringify(r.body ?? {});
    return new Response(text, { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers || {}) } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

// Stub credential chain.
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
  for (const [k, v] of Object.entries(ENV_SHARED)) {
    process.env[k] = v;
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const baseSession = {
  claims: { oid: 't-fix', name: 'Fix User', upn: 'fix@example.com', groups: [] },
  exp: Math.floor(Date.now() / 1000) + 3600,
} as any;

const baseTarget = {
  mode: 'shared' as const,
  fabricWorkspaceId: 'ws-fix-123',
};

// ---- Notebook ----
describe('notebookProvisioner', () => {
  it('creates a new Fabric notebook when none exists by displayName', async () => {
    const { calls } = captureFetch([
      { status: 200, body: { value: [] } },                  // list notebooks
      { status: 201, body: { id: 'nb-new', displayName: 'My NB' } }, // create
    ]);
    const { notebookProvisioner } = await import('../provisioners/notebook');
    const r = await notebookProvisioner({
      session: baseSession,
      target: baseTarget,
      cosmosItemId: 'cosmos-1',
      workspaceId: 'loom-ws-1',
      displayName: 'My NB',
      content: { kind: 'notebook', defaultLang: 'pyspark', cells: [{ kind: 'code', source: 'print(1)' }] },
      appId: 'app-test',
    });
    expect(r.status).toBe('created');
    expect(r.resourceId).toBe('nb-new');
    expect(calls[0].url).toContain('/workspaces/ws-fix-123/notebooks');
    expect(calls[1].init?.method).toBe('POST');
    const body = JSON.parse(calls[1].init!.body as string);
    expect(body.displayName).toBe('My NB');
    expect(body.definition.parts[0].path).toBe('notebook-content.ipynb');
    expect(body.definition.parts[0].payloadType).toBe('InlineBase64');
  });

  it('updates definition when notebook with same name exists', async () => {
    const { calls } = captureFetch([
      { status: 200, body: { value: [{ id: 'nb-exist', displayName: 'My NB' }] } },
      { status: 202, body: {}, headers: { location: 'https://api.fabric/long-running-id' } },
    ]);
    const { notebookProvisioner } = await import('../provisioners/notebook');
    const r = await notebookProvisioner({
      session: baseSession,
      target: baseTarget,
      cosmosItemId: 'cosmos-1',
      workspaceId: 'loom-ws-1',
      displayName: 'My NB',
      content: { kind: 'notebook', defaultLang: 'pyspark', cells: [] },
      appId: 'app-test',
    });
    expect(r.status).toBe('exists');
    expect(r.resourceId).toBe('nb-exist');
    expect(calls[1].url).toContain('/notebooks/nb-exist/updateDefinition');
  });

  it('surfaces 403 as a structured remediation gate', async () => {
    captureFetch([{ status: 403, body: { errorCode: 'Unauthorized', message: 'UAMI not Contributor' } }]);
    const { notebookProvisioner } = await import('../provisioners/notebook');
    const r = await notebookProvisioner({
      session: baseSession,
      target: baseTarget,
      cosmosItemId: 'c1',
      workspaceId: 'lw1',
      displayName: 'X',
      content: { kind: 'notebook', defaultLang: 'pyspark', cells: [] },
      appId: 'a',
    });
    expect(r.status).toBe('remediation');
    expect(r.gate?.reason).toContain('403');
    expect(r.gate?.remediation).toMatch(/Contributor/i);
  });

  it('returns remediation when no notebook backend configured at all', async () => {
    // No Fabric workspace bound AND no Azure-native fallback (Synapse/Databricks)
    // configured — the only honest outcome is the combined remediation gate.
    // ENV_SHARED sets LOOM_SYNAPSE_WORKSPACE by default, so clear the fallback
    // env vars here to exercise the truly-unconfigured path.
    delete process.env.LOOM_SYNAPSE_WORKSPACE;
    delete process.env.LOOM_DATABRICKS_HOSTNAME;
    const { notebookProvisioner } = await import('../provisioners/notebook');
    const r = await notebookProvisioner({
      session: baseSession,
      target: { mode: 'shared' },
      cosmosItemId: 'c1',
      workspaceId: 'lw1',
      displayName: 'X',
      content: {},
      appId: 'a',
    });
    expect(r.status).toBe('remediation');
    expect(r.gate?.remediation).toMatch(/LOOM_DEFAULT_FABRIC_WORKSPACE/);
  });

  it('falls back to Synapse notebook artifact when no Fabric workspace bound', async () => {
    // LOOM_SYNAPSE_WORKSPACE is set by ENV_SHARED, so a shared-mode target with
    // no Fabric workspace must import into Synapse (real dev-plane PUT), not gate.
    const { calls } = captureFetch([
      { status: 200, body: { name: 'X', id: 'syn:nb/X' } }, // PUT /notebooks
    ]);
    const { notebookProvisioner } = await import('../provisioners/notebook');
    const r = await notebookProvisioner({
      session: baseSession,
      target: { mode: 'shared' },
      cosmosItemId: 'c1',
      workspaceId: 'lw1',
      displayName: 'X',
      content: { defaultLang: 'pyspark', cells: [] },
      appId: 'a',
    });
    expect(r.status).toBe('created');
    expect(r.secondaryIds?.backend).toBe('synapse');
    expect(calls.some((c) => c.url.includes('.dev.azuresynapse.net'))).toBe(true);
  });
});

// ---- AI Search ----
describe('aiSearchProvisioner', () => {
  it('PUTs index then POSTs sample docs', async () => {
    const { calls } = captureFetch([
      { status: 201, body: { name: 'app-test-idx' } },
      { status: 200, body: { value: [{ status: 201 }] } },
    ]);
    const { aiSearchProvisioner } = await import('../provisioners/ai-search');
    const r = await aiSearchProvisioner({
      session: baseSession,
      target: { ...baseTarget, aiSearchService: 'search-fix' },
      cosmosItemId: 'c1',
      workspaceId: 'lw1',
      displayName: 'App Test Idx',
      content: {
        kind: 'ai-search-index',
        schema: { fields: [{ name: 'id', type: 'Edm.String', key: true }, { name: 'text', type: 'Edm.String', searchable: true }] },
        sampleDocs: [{ id: '1', text: 'hello' }],
      },
      appId: 'app-test',
    });
    expect(r.status).toBe('created');
    expect(calls[0].url).toContain('search-fix.search.windows.net/indexes/app-test-idx');
    expect(calls[0].init?.method).toBe('PUT');
    expect(calls[1].url).toContain('/docs/index?api-version=');
    expect(calls[1].init?.method).toBe('POST');
  });

  it('surfaces 403 with role assignment remediation', async () => {
    captureFetch([{ status: 403, body: { error: { message: 'forbidden' } } }]);
    const { aiSearchProvisioner } = await import('../provisioners/ai-search');
    const r = await aiSearchProvisioner({
      session: baseSession,
      target: { ...baseTarget, aiSearchService: 'search-fix' },
      cosmosItemId: 'c1',
      workspaceId: 'lw1',
      displayName: 'X',
      content: { kind: 'ai-search-index', schema: { fields: [{ name: 'id', type: 'Edm.String', key: true }] } },
      appId: 'a',
    });
    expect(r.status).toBe('remediation');
    expect(r.gate?.remediation).toMatch(/Search Service Contributor/);
  });

  it('skips when no schema in bundle', async () => {
    const { aiSearchProvisioner } = await import('../provisioners/ai-search');
    const r = await aiSearchProvisioner({
      session: baseSession,
      target: { ...baseTarget, aiSearchService: 'search-fix' },
      cosmosItemId: 'c1', workspaceId: 'lw1', displayName: 'X', content: {}, appId: 'a',
    });
    expect(r.status).toBe('skipped');
  });
});

// ---- KQL DB ----
describe('kqlDatabaseProvisioner', () => {
  // Warm the heavy kusto-client → @azure/cosmos module graph once so the cold
  // transform cost is absorbed here rather than inside the first `it`.
  beforeAll(async () => {
    await import('../provisioners/kql-db');
  }, COLD_TRANSFORM_TIMEOUT_MS);

  it('hits ARM PUT then runs .create table mgmt commands', async () => {
    const { calls } = captureFetch([
      { status: 200, body: { properties: { provisioningState: 'Succeeded' }, id: '/subscriptions/sub/.../databases/MyDB' } },
      { status: 200, body: { Tables: [{ TableName: 'Table_0', Columns: [], Rows: [] }] } }, // .create table
    ]);
    const { kqlDatabaseProvisioner } = await import('../provisioners/kql-db');
    const r = await kqlDatabaseProvisioner({
      session: baseSession,
      target: baseTarget,
      cosmosItemId: 'c1',
      workspaceId: 'lw1',
      displayName: 'My DB',
      content: { kind: 'kql-database', tables: [{ name: 'Telemetry', columns: [{ name: 'ts', type: 'datetime' }, { name: 'value', type: 'real' }] }] },
      appId: 'app-test',
    });
    expect(r.status).toBe('created');
    expect(calls[0].url).toContain('Microsoft.Kusto/clusters/adx-fix/databases/My_DB');
    expect(calls[0].init?.method).toBe('PUT');
    expect(calls[1].url).toContain('/v1/rest/mgmt');
    const mgmtBody = JSON.parse(calls[1].init!.body as string);
    expect(mgmtBody.csl).toMatch(/\.create table Telemetry/);
  }, COLD_TRANSFORM_TIMEOUT_MS);

  it('emits remediation when ARM 403', async () => {
    captureFetch([{ status: 403, body: { error: { message: 'forbidden' } } }]);
    const { kqlDatabaseProvisioner } = await import('../provisioners/kql-db');
    const r = await kqlDatabaseProvisioner({
      session: baseSession,
      target: baseTarget,
      cosmosItemId: 'c1', workspaceId: 'lw1', displayName: 'X',
      content: { kind: 'kql-database', tables: [] }, appId: 'a',
    });
    expect(r.status).toBe('remediation');
    expect(r.gate?.remediation).toMatch(/Contributor on the Kusto cluster/);
  });
});

// ---- Engine aggregation ----
describe('runProvisioning engine', () => {
  // provisioning-engine imports every provisioner (incl. kql-db → @azure/cosmos),
  // so warm that graph once before the suite's tests run.
  beforeAll(async () => {
    await import('../provisioning-engine');
  }, COLD_TRANSFORM_TIMEOUT_MS);

  it('returns skipped for every item when deploy=false', async () => {
    const { runProvisioning } = await import('../provisioning-engine');
    const r = await runProvisioning(baseSession, 'app-test', 'ws-1', [
      { itemType: 'notebook', id: 'i1', displayName: 'NB', content: {} },
      { itemType: 'ai-search-index', id: 'i2', displayName: 'IDX', content: {} },
    ], { deploy: false, mode: 'shared' });
    expect(r.outcome).toBe('skipped');
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0].result.status).toBe('skipped');
  }, COLD_TRANSFORM_TIMEOUT_MS);

  it('reports partial when one provisioner remediates and another succeeds', async () => {
    // The engine now provisions items CONCURRENTLY (bounded batches), so the
    // notebook and ai-search provisioners interleave their fetches and a
    // global call-index response queue is no longer deterministic. Route the
    // mock by URL instead: Fabric notebook calls succeed, AI Search PUT 403s.
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : (url as any).toString();
      if (u.includes('search.windows.net')) {
        return new Response(JSON.stringify({ error: { message: 'no' } }), { status: 403, headers: { 'content-type': 'application/json' } });
      }
      // Fabric notebook: list (empty) then create OK. Both surface as
      // success — listing empty drives the create path which returns 201.
      if (/\/notebooks(\?|$)/.test(u) && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ id: 'nb-1', displayName: 'NB' }), { status: 201, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { runProvisioning } = await import('../provisioning-engine');
    const r = await runProvisioning(baseSession, 'app-test', 'ws-1', [
      { itemType: 'notebook', id: 'i1', displayName: 'NB', content: { kind: 'notebook', defaultLang: 'pyspark', cells: [] } },
      { itemType: 'ai-search-index', id: 'i2', displayName: 'IDX', content: { kind: 'ai-search-index', schema: { fields: [{ name: 'id', type: 'Edm.String', key: true }] } } },
    ], { deploy: true, mode: 'shared' });
    expect(r.outcome).toBe('partial');
    expect(r.steps[0].result.status).toBe('created');
    expect(r.steps[1].result.status).toBe('remediation');
  }, COLD_TRANSFORM_TIMEOUT_MS);

  it('marks unsupported itemType as skipped (Cosmos-only)', async () => {
    // 'dataflow' has no Phase-2 backend provisioner — it is Cosmos-only.
    // (Note: 'data-product' was promoted to a real provisioner in the
    // use-case-apps work, so it can no longer stand in for "unsupported".)
    const { runProvisioning } = await import('../provisioning-engine');
    const r = await runProvisioning(baseSession, 'app-test', 'ws-1', [
      { itemType: 'dataflow', id: 'i1', displayName: 'X', content: {} },
    ], { deploy: true, mode: 'shared' });
    expect(r.steps[0].result.status).toBe('skipped');
    expect(r.steps[0].result.steps?.[0]).toContain('No Phase-2 provisioner');
  });
});
