/**
 * BFF test for the Lakeflow DLT pipeline spec route (Wave 10, DBX-3).
 *
 * Proves: (1) honest-gate 503 `not_configured` when no Databricks workspace is
 * wired, (2) 400 on an invalid model, (3) the happy path compiles the canvas to
 * real DLT SQL, imports it as a workspace notebook, and creates the pipeline via
 * POST /api/2.0/pipelines — asserting the compiled SQL actually travels to the
 * Workspace Import REST. fetch is stubbed so the real client runs end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({ claims: { oid: 'oid', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 })),
}));
vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function stubFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : (url as any).toString();
    calls.push({ url: u, init });
    const r = impl(u, init);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function postReq(body: unknown) {
  return new NextRequest('https://loom.test/api/items/databricks-pipeline/p1/spec', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validModel = {
  name: 'sales_pipeline',
  continuous: false, development: true, photon: true, serverless: true, channel: 'CURRENT',
  catalog: 'main', target: 'bronze',
  nodes: [
    { id: 'src1', kind: 'source', name: 'raw', sourceKind: 'files', path: 'abfss://raw@a.dfs.core.windows.net/e/', fileFormat: 'json' },
    { id: 'st1', kind: 'streaming_table', name: 'events_bronze' },
  ],
  edges: [{ id: 'e1', source: 'src1', target: 'st1' }],
};

describe('POST /databricks-pipeline/[id]/spec', () => {
  it('honest-gates 503 not_configured when no workspace is wired', async () => {
    delete process.env.LOOM_DATABRICKS_HOSTNAME;
    const { POST } = await import('@/app/api/items/databricks-pipeline/[id]/spec/route');
    const res = await POST(postReq({ model: validModel }));
    const j = await res.json();
    expect(res.status).toBe(503);
    expect(j.code).toBe('not_configured');
    expect(j.missing).toBe('LOOM_DATABRICKS_HOSTNAME');
  });

  it('rejects an invalid model with 400 + problems', async () => {
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb.azuredatabricks.net';
    const { POST } = await import('@/app/api/items/databricks-pipeline/[id]/spec/route');
    const res = await POST(postReq({ model: { ...validModel, nodes: [], edges: [] } }));
    const j = await res.json();
    expect(res.status).toBe(400);
    expect(Array.isArray(j.problems)).toBe(true);
  });

  it('compiles to DLT SQL, imports it, and creates the pipeline', async () => {
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb.azuredatabricks.net';
    const calls = stubFetch((u) => {
      if (u.includes('/api/2.0/pipelines')) return { body: { pipeline_id: 'pl-123' } };
      return { body: {} }; // mkdirs + import
    });
    const { POST } = await import('@/app/api/items/databricks-pipeline/[id]/spec/route');
    const res = await POST(postReq({ model: validModel }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.pipeline_id).toBe('pl-123');
    expect(j.libraryPath).toBe('/Shared/loom-dlt/sales_pipeline');

    // The compiled SQL reached the Workspace Import REST (base64 of DLT SQL).
    const importCall = calls.find((c) => c.url.includes('/api/2.0/workspace/import'));
    expect(importCall).toBeTruthy();
    const importedBody = JSON.parse(String(importCall!.init!.body));
    const decoded = Buffer.from(importedBody.content, 'base64').toString('utf-8');
    expect(decoded).toContain('CREATE OR REFRESH STREAMING TABLE `events_bronze`');
    expect(decoded).toContain("read_files('abfss://raw@a.dfs.core.windows.net/e/', format => 'json')");

    // The create-pipeline POST carried the notebook library + Azure-first flags.
    const createCall = calls.find((c) => c.url.includes('/api/2.0/pipelines') && c.init?.method === 'POST');
    expect(createCall).toBeTruthy();
    const createBody = JSON.parse(String(createCall!.init!.body));
    expect(createBody.serverless).toBe(true);
    expect(createBody.catalog).toBe('main');
    expect(createBody.libraries[0].notebook.path).toBe('/Shared/loom-dlt/sales_pipeline');
  });
});
