/**
 * BFF route test for POST /api/items/azure-sql-database/[id]/copilot — the SQL
 * editor Copilot (Fix / Explain / NL→T-SQL).
 *
 * Asserts: (1) unauthed → 401, (2) bad command → 400, (3) missing snippet → 400,
 * (4) honest no_aoai gate → 503 with code + hint naming the env var + role,
 * (5) explain happy path streams SSE chunks + grounds the prompt in the live
 * INFORMATION_SCHEMA catalog, (6) the LOOM_AZURE_OPENAI_ENDPOINT bare-name →
 * per-cloud host (openai.azure.us in Gov) is used to build the AOAI URL,
 * (7) schema read failure soft-fails (turn still streams).
 *
 * AOAI, identity, tenant config, and the TDS executeQuery are all mocked — no
 * live Azure. getOpenAiSuffix is mocked to the Gov suffix to prove the URL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

class NoAoaiDeploymentError extends Error {
  constructor(m: string) { super(m); this.name = 'NoAoaiDeploymentError'; }
}
const resolveAoaiTargetMock = vi.fn(async () => ({ endpoint: 'https://aoai.example.com', deployment: 'chat', apiVersion: '2024-10-21' }));
vi.mock('@/lib/azure/copilot-orchestrator', () => ({
  resolveAoaiTarget: (...a: any[]) => resolveAoaiTargetMock(...a),
  NoAoaiDeploymentError,
}));

vi.mock('@/lib/azure/copilot-config-store', () => ({
  loadTenantCopilotConfig: vi.fn(async () => null),
}));

// Default suffix is Gov so we can prove the bare-name → openai.azure.us host.
const getOpenAiSuffixMock = vi.fn(() => 'openai.azure.us');
vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal() as any),
  cogScope: () => 'https://cognitiveservices.azure.us/.default',
  getOpenAiSuffix: () => getOpenAiSuffixMock(),
}));

const executeQueryMock = vi.fn(async () => ({
  columns: ['TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE'],
  rows: [['dbo', 'Customer', 'CustomerId', 'int'], ['dbo', 'Customer', 'Name', 'nvarchar']],
  rowCount: 2, executionMs: 1, truncated: false,
}));
vi.mock('@/lib/azure/azure-sql-client', () => ({
  executeQuery: (...a: any[]) => executeQueryMock(...a),
}));

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/items/azure-sql-database/item1/copilot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const PARAMS = { params: Promise.resolve({ id: 'item1' }) };

// Build an SSE body matching the AOAI chat-completions stream shape.
function sseStream(deltas: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const d of deltas) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`));
      }
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}

let lastFetchUrl = '';
function stubAoaiStream(deltas: string[], status = 200) {
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    lastFetchUrl = String(url);
    return new Response(sseStream(deltas), { status, headers: { 'content-type': 'text/event-stream' } });
  }));
}

async function readSse(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
  resolveAoaiTargetMock.mockResolvedValue({ endpoint: 'https://aoai.example.com', deployment: 'chat', apiVersion: '2024-10-21' });
  getOpenAiSuffixMock.mockReturnValue('openai.azure.us');
  executeQueryMock.mockResolvedValue({
    columns: ['TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE'],
    rows: [['dbo', 'Customer', 'CustomerId', 'int'], ['dbo', 'Customer', 'Name', 'nvarchar']],
    rowCount: 2, executionMs: 1, truncated: false,
  });
  delete process.env.LOOM_AZURE_OPENAI_ENDPOINT;
  delete process.env.LOOM_AOAI_DEPLOYMENT;
  lastFetchUrl = '';
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('POST /api/items/azure-sql-database/[id]/copilot', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('@/app/api/items/azure-sql-database/[id]/copilot/route');
    const r = await POST(postReq({ command: 'explain', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(401);
  });

  it('400 on an unknown command', async () => {
    const { POST } = await import('@/app/api/items/azure-sql-database/[id]/copilot/route');
    const r = await POST(postReq({ command: 'drop', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(400);
  });

  it('400 when no snippet/prompt is provided', async () => {
    const { POST } = await import('@/app/api/items/azure-sql-database/[id]/copilot/route');
    const r = await POST(postReq({ command: 'fix', server: 's', database: 'd' }), PARAMS);
    expect(r.status).toBe(400);
  });

  it('503 honest no_aoai gate names the env var + role', async () => {
    resolveAoaiTargetMock.mockRejectedValueOnce(new NoAoaiDeploymentError('No AOAI deployment on Foundry hub.'));
    const { POST } = await import('@/app/api/items/azure-sql-database/[id]/copilot/route');
    const r = await POST(postReq({ command: 'explain', server: 's', database: 'd', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(503);
    const j = await r.json();
    expect(j.code).toBe('no_aoai');
    expect(j.hint).toMatch(/LOOM_AZURE_OPENAI_ENDPOINT/);
    expect(j.hint).toMatch(/Cognitive Services OpenAI User/);
  });

  it('explain streams SSE chunks grounded in the live schema catalog', async () => {
    stubAoaiStream(['```sql\n-- top customers\nSELECT TOP 10 * FROM dbo.Customer\n```']);
    const { POST } = await import('@/app/api/items/azure-sql-database/[id]/copilot/route');
    const r = await POST(postReq({ command: 'explain', server: 's', database: 'd', sql: 'SELECT * FROM dbo.Customer' }), PARAMS);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
    const body = await readSse(r);
    expect(body).toMatch(/event: session/);
    expect(body).toMatch(/event: chunk/);
    expect(body).toMatch(/event: done/);
    expect(body).toMatch(/dbo\.Customer/);
    // The schema catalog was read over the live TDS path.
    expect(executeQueryMock).toHaveBeenCalledWith('s', 'd', expect.stringContaining('INFORMATION_SCHEMA.COLUMNS'));
  });

  it('uses the per-cloud Gov host when LOOM_AZURE_OPENAI_ENDPOINT is a bare account name', async () => {
    process.env.LOOM_AZURE_OPENAI_ENDPOINT = 'govacct';
    process.env.LOOM_AOAI_DEPLOYMENT = 'gpt-4o';
    stubAoaiStream(['ok']);
    const { POST } = await import('@/app/api/items/azure-sql-database/[id]/copilot/route');
    const r = await POST(postReq({ command: 'fix', server: 's', database: 'd', sql: 'SELCT 1' }), PARAMS);
    await readSse(r);
    expect(lastFetchUrl).toContain('https://govacct.openai.azure.us/openai/deployments/gpt-4o/');
    // resolveAoaiTarget is NOT consulted when the explicit env var resolves.
    expect(resolveAoaiTargetMock).not.toHaveBeenCalled();
  });

  it('soft-fails when the schema read throws (turn still streams)', async () => {
    executeQueryMock.mockRejectedValueOnce(new Error('login failed'));
    stubAoaiStream(['SELECT 1']);
    const { POST } = await import('@/app/api/items/azure-sql-database/[id]/copilot/route');
    const r = await POST(postReq({ command: 'nl2sql', server: 's', database: 'd', sql: 'count rows' }), PARAMS);
    expect(r.status).toBe(200);
    const body = await readSse(r);
    expect(body).toMatch(/event: done/);
  });
});
