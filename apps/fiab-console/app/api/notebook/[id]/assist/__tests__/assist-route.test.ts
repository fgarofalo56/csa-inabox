/**
 * BFF route test for POST /api/notebook/[id]/assist (F21 — Notebook Copilot edges).
 *
 * Asserts: (1) unauthed → 401, (2) bad mode → 400, (3) generate without prompt → 400,
 * (4) honest no_aoai gate → 503 with hint, (5) generate happy path → runnable code
 * with stray ```fences stripped, (6) fix mode → corrected code from the AOAI call.
 *
 * AOAI, identity, schema grounding are all mocked — no live Azure calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

// Schema grounding is best-effort; force it empty so tests don't touch Synapse.
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  serverlessTarget: () => ({ server: 's', database: 'master', cacheKey: 'k' }),
  executeQuery: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0, executionMs: 1, truncated: false })),
}));

// Controllable AOAI target resolver + the honest-gate error class.
class NoAoaiDeploymentError extends Error {
  constructor(m: string) { super(m); this.name = 'NoAoaiDeploymentError'; }
}
const resolveAoaiTargetMock = vi.fn(async () => ({ endpoint: 'https://aoai.example.com', deployment: 'chat', apiVersion: '2024-10-21' }));
vi.mock('@/lib/azure/copilot-orchestrator', () => ({
  resolveAoaiTarget: () => resolveAoaiTargetMock(),
  NoAoaiDeploymentError,
}));

const ctx = { params: Promise.resolve({ id: 'nb-1' }) };
function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/notebook/nb-1/assist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  delete process.env.LOOM_SYNAPSE_WORKSPACE;
  delete process.env.LOOM_BRONZE_URL;
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
  resolveAoaiTargetMock.mockResolvedValue({ endpoint: 'https://aoai.example.com', deployment: 'chat', apiVersion: '2024-10-21' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function stubAoai(content: string, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status, headers: { 'content-type': 'application/json' },
    }),
  ));
}

describe('POST /api/notebook/[id]/assist', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('@/app/api/notebook/[id]/assist/route');
    const r = await POST(postReq({ mode: 'generate', prompt: 'x' }), ctx);
    expect(r.status).toBe(401);
  });

  it('400 on an invalid mode', async () => {
    const { POST } = await import('@/app/api/notebook/[id]/assist/route');
    const r = await POST(postReq({ mode: 'wat' }), ctx);
    expect(r.status).toBe(400);
  });

  it('400 when generate is missing a prompt', async () => {
    const { POST } = await import('@/app/api/notebook/[id]/assist/route');
    const r = await POST(postReq({ mode: 'generate' }), ctx);
    expect(r.status).toBe(400);
  });

  it('503 honest no_aoai gate when AOAI is unresolved', async () => {
    resolveAoaiTargetMock.mockRejectedValueOnce(new NoAoaiDeploymentError('No AOAI deployment on Foundry hub.'));
    const { POST } = await import('@/app/api/notebook/[id]/assist/route');
    const r = await POST(postReq({ mode: 'generate', prompt: 'count rows in bronze.orders' }), ctx);
    expect(r.status).toBe(503);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('no_aoai');
    expect(j.hint).toMatch(/No AOAI deployment/);
  });

  it('generate returns runnable code with stray fences stripped', async () => {
    stubAoai('```python\nspark.table("bronze.orders").count()\n```');
    const { POST } = await import('@/app/api/notebook/[id]/assist/route');
    const r = await POST(postReq({ mode: 'generate', lang: 'pyspark', prompt: 'count rows in bronze.orders' }), ctx);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.mode).toBe('generate');
    expect(j.result).toBe('spark.table("bronze.orders").count()');
  });

  it('fix mode returns corrected code from the AOAI call', async () => {
    stubAoai('df = spark.read.parquet("abfss://bronze@acct.dfs.core.windows.net/orders")');
    const { POST } = await import('@/app/api/notebook/[id]/assist/route');
    const r = await POST(postReq({ mode: 'fix', lang: 'pyspark', source: 'df = spark.red.parquet(...)', errorText: "AttributeError: 'SparkSession' object has no attribute 'red'" }), ctx);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.result).toContain('spark.read.parquet');
  });
});
