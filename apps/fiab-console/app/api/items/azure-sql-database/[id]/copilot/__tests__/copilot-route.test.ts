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

// #2723 — the Copilot's schema-read target is DERIVED from the OWNED item's
// bound connection (state.connection), not the request body. The item-crud
// owner-scoped loader is mocked so the route's authority check is exercised
// without Cosmos; the default item is bound to server 's' / database 'd'.
const OWNED_ITEM = {
  id: 'item1', workspaceId: 'ws1', itemType: 'azure-sql-database',
  displayName: 'Mine', state: { connection: { family: 'azure-sql', server: 's', database: 'd' } },
} as any;
const loadOwnedItemMock = vi.fn(async () => OWNED_ITEM);
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
}));

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
  loadOwnedItemMock.mockResolvedValue(OWNED_ITEM);
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

// ---------------------------------------------------------------------------
// #2723 — the id conveys authority: the Copilot reads the schema of the OWNED
// item's bound DB, never a body-chosen server/database. Each spec asserts a
// DENIAL or a NON-CALL and names the mutation that turns it red.
// ---------------------------------------------------------------------------
describe('POST /api/items/azure-sql-database/[id]/copilot — authority binding (#2723)', () => {
  // MUTATION: delete the `const item = await loadOwnedSqlItem(...); if (!item) 404`
  // block. → the route reads the schema of a body-chosen DB for a caller who
  // does not own the item.
  //
  // `mockResolvedValue`, NOT `...Once`. The route resolves across every slug in
  // SQL_EDITOR_ITEM_TYPES, so a single-shot null is satisfied by the SECOND
  // candidate and this spec would go green while testing nothing.
  it('404s when the caller does not own the item, and reads NO schema', async () => {
    loadOwnedItemMock.mockResolvedValue(null);
    stubAoaiStream(['SELECT 1']);
    const { POST } = await import('@/app/api/items/azure-sql-database/[id]/copilot/route');
    const r = await POST(postReq({ command: 'explain', server: 'victim-srv', database: 'victim-db', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(404);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  // `UnifiedSqlDatabaseEditor` posts here from all three of its slugs. The
  // hard-coded `'azure-sql-database'` 404'd Copilot for the other two.
  //   MUTATION: narrow the resolution back to a single item type.
  it('runs for an owned item of a sibling slug (postgres-flexible-server)', async () => {
    loadOwnedItemMock.mockImplementation(((_id: string, itemType: string) =>
      Promise.resolve(itemType === 'postgres-flexible-server'
        ? { ...OWNED_ITEM, itemType: 'postgres-flexible-server' }
        : null)) as any);
    stubAoaiStream(['SELECT 1']);
    const { POST } = await import('@/app/api/items/azure-sql-database/[id]/copilot/route');
    const r = await POST(postReq({ command: 'explain', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(200);
  });

  // This Copilot reads INFORMATION_SCHEMA over the LIVE TDS path, so it must stay
  // write-scoped like its /query sibling: a read-only viewer of a shared
  // workspace must not be able to pull another member's schema through it.
  //   MUTATION: loadOwnedItem(id, …, { session, allowReadRoles: true })
  it('stays WRITE-scoped — loads the item without allowReadRoles', async () => {
    stubAoaiStream(['SELECT 1']);
    const { POST } = await import('@/app/api/items/azure-sql-database/[id]/copilot/route');
    await POST(postReq({ command: 'explain', sql: 'SELECT 1' }), PARAMS);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBeFalsy();
  });

  // MUTATION: replace `resolveOwnedSqlTarget(item, {server,database})`-derived
  // server/database with the raw body server/database. → the mismatch is not
  // rejected and the foreign DB's INFORMATION_SCHEMA is read.
  it('403s when the body names a server different from the item’s bound connection', async () => {
    stubAoaiStream(['SELECT 1']);
    const { POST } = await import('@/app/api/items/azure-sql-database/[id]/copilot/route');
    const r = await POST(postReq({ command: 'explain', server: 'attacker-srv', database: 'd', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.code).toBe('server_mismatch');
    // The attacker's DB is never read.
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it('403s when the body names a different database than the bound one', async () => {
    stubAoaiStream(['SELECT 1']);
    const { POST } = await import('@/app/api/items/azure-sql-database/[id]/copilot/route');
    const r = await POST(postReq({ command: 'explain', server: 's', database: 'attacker-db', sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('database_mismatch');
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it('reads the schema of the item’s OWN bound DB — never the body-supplied names', async () => {
    // Item is bound to bound-srv/bound-db; the body tries to smuggle a foreign
    // server that HAPPENS to share the first DNS label so it is not a mismatch —
    // the read must still target the bound coordinates, not the body's.
    loadOwnedItemMock.mockResolvedValueOnce({
      ...OWNED_ITEM, state: { connection: { server: 'bound-srv', database: 'bound-db' } },
    });
    stubAoaiStream(['ok']);
    const { POST } = await import('@/app/api/items/azure-sql-database/[id]/copilot/route');
    const r = await POST(postReq({ command: 'explain', sql: 'SELECT 1' }), PARAMS);
    await readSse(r);
    expect(executeQueryMock).toHaveBeenCalledWith('bound-srv', 'bound-db', expect.stringContaining('INFORMATION_SCHEMA.COLUMNS'));
  });

  // A CONTROL (passing) proving the suite is wired: an unbound item still runs
  // the Copilot (soft-fail to no schema) and never executes a body-chosen read.
  it('an unbound item still streams, with NO schema read against any DB', async () => {
    loadOwnedItemMock.mockResolvedValueOnce({ ...OWNED_ITEM, state: {} });
    stubAoaiStream(['SELECT 1']);
    const { POST } = await import('@/app/api/items/azure-sql-database/[id]/copilot/route');
    const r = await POST(postReq({ command: 'nl2sql', server: 'anything', database: 'anything', sql: 'count rows' }), PARAMS);
    expect(r.status).toBe(200);
    const body = await readSse(r);
    expect(body).toMatch(/event: done/);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });
});
