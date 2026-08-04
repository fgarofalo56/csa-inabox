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

// #2941 — the route's workspace guard is now UNSKIPPABLE: with no `workspaceId`
// in the body it resolves the notebook's workspace from Cosmos, so it can no
// longer be a no-op just because the test body omits the field. These are AOAI
// assist-logic tests, not authorization tests (and they mock no Cosmos), so the
// guard is armed to AUTHORIZE. It is deliberately NOT stubbed out of existence:
// `invokes the workspace guard` below asserts the route still calls it, so
// dropping the adoption fails here too. The guard's own behaviour is covered in
// lib/auth/__tests__/authorize-item-workspace.test.ts.
const authorizeItemWorkspaceMock = vi.fn(async () => null);
vi.mock('@/lib/auth/workspace-guard', () => ({
  authorizeItemWorkspace: (...a: any[]) => authorizeItemWorkspaceMock(...(a as [])),
}));

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
// Spread the real orchestrator so the unified aoai-chat-client keeps its
// aoaiToken / isUnsupportedSamplingParam / describeFetchError helpers; only
// resolveAoaiTarget + NoAoaiDeploymentError are overridden for the test.
vi.mock('@/lib/azure/copilot-orchestrator', async (importOriginal) => ({
  ...(await importOriginal() as any),
  resolveAoaiTarget: (...a: any[]) => resolveAoaiTargetMock(...(a as [])),
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
  authorizeItemWorkspaceMock.mockClear();
  authorizeItemWorkspaceMock.mockResolvedValue(null);
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

  // #2941 — the route MUST authorize the caller against the notebook's
  // workspace, and must do so even when the body carries no `workspaceId`
  // (the old `workspaceId && assertOwner(...)` shape skipped it entirely).
  it('invokes the workspace guard with the notebook identity even with no workspaceId in the body', async () => {
    stubAoai('spark.range(1).count()');
    const { POST } = await import('@/app/api/notebook/[id]/assist/route');
    await POST(postReq({ mode: 'generate', lang: 'pyspark', prompt: 'count' }), ctx);
    expect(authorizeItemWorkspaceMock).toHaveBeenCalledTimes(1);
    const opts = (authorizeItemWorkspaceMock.mock.calls[0] as any[])[1];
    expect(opts.itemId).toBe('nb-1');
    expect(opts.itemType).toBe('notebook');
    expect(opts.notFound).toBe('notebook not found');
    // WRITE-scoped: this assist reads the notebook's live Livy session state.
    expect(opts.allowReadRoles).toBeFalsy();
  });

  it('404s (not 200) when the guard denies', async () => {
    authorizeItemWorkspaceMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'notebook not found' }), { status: 404 }) as any,
    );
    stubAoai('spark.range(1).count()');
    const { POST } = await import('@/app/api/notebook/[id]/assist/route');
    const r = await POST(postReq({ mode: 'generate', lang: 'pyspark', prompt: 'count' }), ctx);
    expect(r.status).toBe(404);
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
