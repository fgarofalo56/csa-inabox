/**
 * #1576 defect 2 — Synapse notebook import must survive a TRANSIENT dev-plane
 * 5xx (e.g. "500 Unhandled BlobStorageClient Exception, ErrorCode=1311") rather
 * than hard-failing the whole app install.
 *
 * Asserts:
 *   - upsertNotebook retries on 5xx (2s/5s backoff, 3 attempts) then succeeds,
 *   - upsertNotebook does NOT retry a deterministic 4xx (single PUT),
 *   - the notebook provisioner maps a persistent 5xx to an honest storage
 *     remediation gate (status:'remediation') — NOT a bare status:'failed'.
 *
 * No real Azure traffic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function captureFetch(router: (url: string, init?: RequestInit) => { status?: number; body?: any }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: any, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push({ url: u, init });
    const r = router(u, init) || { status: 200, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

vi.mock('@azure/identity', async () => {
  class Cred {
    async getToken() { return { token: 'test-token', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const SYN_ENV = { LOOM_SUBSCRIPTION_ID: 'sub-x', LOOM_DLZ_RG: 'rg-x', LOOM_SYNAPSE_WORKSPACE: 'syn-x' };

function clearEnv() {
  for (const k of ['LOOM_SUBSCRIPTION_ID', 'LOOM_DLZ_RG', 'LOOM_SYNAPSE_WORKSPACE', 'LOOM_DATABRICKS_HOSTNAME', 'LOOM_NOTEBOOK_BACKEND']) {
    delete process.env[k];
  }
}

beforeEach(() => { clearEnv(); for (const [k, v] of Object.entries(SYN_ENV)) process.env[k] = v; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); clearEnv(); });

const NB_CONTENT = {
  defaultLang: 'pyspark',
  cells: [
    { type: 'markdown', source: '# Medallion bootstrap' },
    { type: 'code', lang: 'pyspark', source: "print('hi')" },
  ],
};

const baseInput = (content: any) => ({
  session: { claims: { oid: 't', name: 'n', upn: 'u', groups: [] }, exp: 0 } as any,
  target: { mode: 'shared' as const },
  cosmosItemId: 'c1',
  workspaceId: 'lw1',
  displayName: '01 Medallion Schemas ADLS Bootstrap',
  content,
  appId: 'app-realtime-analytics',
});

describe('upsertNotebook 5xx retry', () => {
  it('retries a transient 5xx then succeeds', async () => {
    let n = 0;
    const { calls } = captureFetch((u, init) => {
      if (u.includes('/notebooks/') && init?.method === 'PUT') {
        n += 1;
        return n === 1 ? { status: 500, body: { error: 'transient blob' } } : { status: 200, body: { name: 'nb', id: 'nb-1' } };
      }
      return { status: 200, body: {} };
    });
    const { upsertNotebook } = await import('@/lib/azure/synapse-artifacts-client');
    const saved = await upsertNotebook('nb', { name: 'nb', properties: { cells: [] } });
    expect(saved.id).toBe('nb-1');
    // one failed PUT + one retry PUT.
    expect(calls.filter((c) => c.url.includes('/notebooks/') && c.init?.method === 'PUT')).toHaveLength(2);
  }, 15_000);

  it('does NOT retry a deterministic 4xx', async () => {
    const { calls } = captureFetch((u, init) => {
      if (u.includes('/notebooks/') && init?.method === 'PUT') return { status: 400, body: { error: 'bad request' } };
      return { status: 200, body: {} };
    });
    const { upsertNotebook } = await import('@/lib/azure/synapse-artifacts-client');
    await expect(upsertNotebook('nb', { name: 'nb', properties: { cells: [] } })).rejects.toThrow(/400/);
    expect(calls.filter((c) => c.url.includes('/notebooks/') && c.init?.method === 'PUT')).toHaveLength(1);
  });
});

describe('notebookProvisioner persistent 5xx', () => {
  it('surfaces an honest storage remediation gate (not failed)', async () => {
    captureFetch((u, init) => {
      if (u.includes('/notebooks/') && init?.method === 'PUT') return { status: 500, body: { error: { message: 'Unhandled BlobStorageClient Exception, ErrorCode=1311' } } };
      return { status: 200, body: {} };
    });
    const { notebookProvisioner } = await import('../provisioners/notebook');
    const r = await notebookProvisioner(baseInput(NB_CONTENT) as any);
    expect(r.status).toBe('remediation');
    expect(r.gate?.reason).toContain('500');
    expect(r.gate?.remediation).toMatch(/Storage Blob Data Contributor|storage account/i);
  }, 15_000);
});
