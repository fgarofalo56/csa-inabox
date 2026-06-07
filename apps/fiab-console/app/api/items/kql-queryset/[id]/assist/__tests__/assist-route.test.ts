/**
 * BFF route test for POST /api/items/kql-queryset/[id]/assist (NL2KQL Copilot edge).
 *
 * Asserts: (1) unauthed → 401, (2) bad mode → 400, (3) generate without prompt → 400,
 * (4) explain without kql → 400, (5) fix without errorText → 400, (6) item not found → 404,
 * (7) honest no_aoai gate → 503 with hint, (8) generate happy path → runnable KQL with
 * stray ```fences stripped, (9) schema-grounding failure still returns 200 (soft-fail),
 * (10) explain → plain summary (fences NOT stripped).
 *
 * AOAI, identity, Cosmos item guard, and ADX schema grounding are all mocked —
 * no live Azure calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

// Kusto client: controllable item guard + schema grounding.
const loadKustoItemMock = vi.fn(async () => ({ id: 'qs-1', workspaceId: 'ws-1', itemType: 'kql-queryset', displayName: 'QS', state: {} }) as any);
const getDatabaseSchemaJsonMock = vi.fn(async () => ({ Databases: { db1: { Tables: { Events: { OrderedColumns: [{ Name: 'ts', Type: 'datetime' }] } } } } }) as any);
vi.mock('@/lib/azure/kusto-client', () => ({
  loadKustoItem: () => loadKustoItemMock(),
  resolveDatabase: () => 'loomdb-default',
  getDatabaseSchemaJson: () => getDatabaseSchemaJsonMock(),
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

const ctx = { params: Promise.resolve({ id: 'qs-1' }) };
function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/items/kql-queryset/qs-1/assist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
  resolveAoaiTargetMock.mockResolvedValue({ endpoint: 'https://aoai.example.com', deployment: 'chat', apiVersion: '2024-10-21' });
  loadKustoItemMock.mockResolvedValue({ id: 'qs-1', workspaceId: 'ws-1', itemType: 'kql-queryset', displayName: 'QS', state: {} } as any);
  getDatabaseSchemaJsonMock.mockResolvedValue({ Databases: { db1: { Tables: { Events: { OrderedColumns: [{ Name: 'ts', Type: 'datetime' }] } } } } } as any);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function stubAoai(content: string, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status, headers: { 'content-type': 'application/json' },
    }),
  ));
}

describe('POST /api/items/kql-queryset/[id]/assist', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('@/app/api/items/kql-queryset/[id]/assist/route');
    const r = await POST(postReq({ mode: 'generate', prompt: 'x' }), ctx);
    expect(r.status).toBe(401);
  });

  it('400 on an invalid mode', async () => {
    const { POST } = await import('@/app/api/items/kql-queryset/[id]/assist/route');
    const r = await POST(postReq({ mode: 'wat' }), ctx);
    expect(r.status).toBe(400);
  });

  it('400 when generate is missing a prompt', async () => {
    const { POST } = await import('@/app/api/items/kql-queryset/[id]/assist/route');
    const r = await POST(postReq({ mode: 'generate' }), ctx);
    expect(r.status).toBe(400);
  });

  it('400 when explain is missing kql', async () => {
    const { POST } = await import('@/app/api/items/kql-queryset/[id]/assist/route');
    const r = await POST(postReq({ mode: 'explain' }), ctx);
    expect(r.status).toBe(400);
  });

  it('400 when fix is missing errorText', async () => {
    const { POST } = await import('@/app/api/items/kql-queryset/[id]/assist/route');
    const r = await POST(postReq({ mode: 'fix', kql: 'Events | take 1' }), ctx);
    expect(r.status).toBe(400);
  });

  it('404 when the item is not found / not owned', async () => {
    loadKustoItemMock.mockResolvedValueOnce(null as any);
    const { POST } = await import('@/app/api/items/kql-queryset/[id]/assist/route');
    const r = await POST(postReq({ mode: 'generate', prompt: 'count rows' }), ctx);
    expect(r.status).toBe(404);
  });

  it('503 honest no_aoai gate when AOAI is unresolved', async () => {
    resolveAoaiTargetMock.mockRejectedValueOnce(new NoAoaiDeploymentError('No AOAI deployment on Foundry hub.'));
    const { POST } = await import('@/app/api/items/kql-queryset/[id]/assist/route');
    const r = await POST(postReq({ mode: 'generate', prompt: 'count events by source' }), ctx);
    expect(r.status).toBe(503);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('no_aoai');
    expect(j.hint).toMatch(/No AOAI deployment/);
  });

  it('generate returns runnable KQL with stray fences stripped', async () => {
    stubAoai('```kql\nEvents | summarize count() by source\n```');
    const { POST } = await import('@/app/api/items/kql-queryset/[id]/assist/route');
    const r = await POST(postReq({ mode: 'generate', prompt: 'count events by source' }), ctx);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.mode).toBe('generate');
    expect(j.result).toBe('Events | summarize count() by source');
    expect(j.result).not.toContain('```');
  });

  it('still returns 200 when schema grounding fails (soft-fail)', async () => {
    getDatabaseSchemaJsonMock.mockRejectedValueOnce(new Error('cluster cold'));
    stubAoai('Events | take 10');
    const { POST } = await import('@/app/api/items/kql-queryset/[id]/assist/route');
    const r = await POST(postReq({ mode: 'generate', prompt: 'first 10' }), ctx);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.result).toBe('Events | take 10');
  });

  it('explain returns a plain-language summary (prose preserved)', async () => {
    stubAoai('This query counts events grouped by their source column.');
    const { POST } = await import('@/app/api/items/kql-queryset/[id]/assist/route');
    const r = await POST(postReq({ mode: 'explain', kql: 'Events | summarize count() by source' }), ctx);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.mode).toBe('explain');
    expect(j.result).toContain('counts events');
  });

  it('fix mode returns corrected KQL from the AOAI call', async () => {
    stubAoai('Events | summarize count() by source');
    const { POST } = await import('@/app/api/items/kql-queryset/[id]/assist/route');
    const r = await POST(postReq({ mode: 'fix', kql: 'Events | sumarize count() by source', errorText: "Syntax error: 'sumarize' is not recognized" }), ctx);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.result).toContain('summarize');
  });
});
