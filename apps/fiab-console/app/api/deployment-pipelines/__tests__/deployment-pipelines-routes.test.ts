/**
 * BFF route tests for /api/deployment-pipelines/*.
 *
 * Imports each handler directly, stubs the session + the underlying Fabric /
 * ARM clients (via @azure/identity + fetch), and asserts:
 *   (1) unauthed → 401 JSON (content-type guard)
 *   (2) happy path → { ok:true, data }
 *   (3) Fabric 401/403 → 200 { ok:false, gate } (honest gate, JSON not HTML)
 *   (4) deploy bad body → 400
 *   (5) deploy forwards source/target/items to the client
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const VALID_SESSION = { claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 };
let sessionValue: any = VALID_SESSION;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => sessionValue),
}));

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  sessionValue = VALID_SESSION;
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_ADMIN_RG = 'rg-admin';
});
afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const fetchMock = vi.fn(async (url: any, init?: RequestInit) => {
    const r = impl(String(url), init);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers || {}) },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

// --------------------------------------------------------------------------
// GET /api/deployment-pipelines
// --------------------------------------------------------------------------

describe('GET /api/deployment-pipelines', () => {
  it('returns JSON list on happy path', async () => {
    stubFetch(() => ({ body: { value: [{ id: 'p1', displayName: 'Sales DP' }] } }));
    const { GET } = await import('@/app/api/deployment-pipelines/route');
    const r = await GET();
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.pipelines[0].displayName).toBe('Sales DP');
  });

  it('Fabric 403 → 200 { ok:false, gate } as JSON (honest gate, not HTML)', async () => {
    stubFetch(() => ({ status: 403, body: { errorCode: 'Unauthorized', message: 'no access' } }));
    const { GET } = await import('@/app/api/deployment-pipelines/route');
    const r = await GET();
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.gate).toBeTruthy();
    expect(j.gate.message).toMatch(/Fabric/i);
  });

  it('unauthenticated → 401 JSON', async () => {
    sessionValue = null;
    const { GET } = await import('@/app/api/deployment-pipelines/route');
    const r = await GET();
    expect(r.status).toBe(401);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect((await r.json()).ok).toBe(false);
  });
});

// --------------------------------------------------------------------------
// GET /api/deployment-pipelines/[id]/stages
// --------------------------------------------------------------------------

describe('GET /api/deployment-pipelines/[id]/stages', () => {
  it('returns ordered stages', async () => {
    stubFetch(() => ({ body: { value: [
      { id: 's2', order: 1, displayName: 'Test' },
      { id: 's1', order: 0, displayName: 'Development', workspaceId: 'w1', workspaceName: 'Dev' },
    ] } }));
    const { GET } = await import('@/app/api/deployment-pipelines/[id]/stages/route');
    const r = await GET(new NextRequest('https://loom.test/api/deployment-pipelines/dp1/stages'), ctx({ id: 'dp1' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.stages[0].displayName).toBe('Development');
  });
});

// --------------------------------------------------------------------------
// GET /api/deployment-pipelines/[id]/stages/[stageId]/items
// --------------------------------------------------------------------------

describe('GET /api/deployment-pipelines/[id]/stages/[stageId]/items', () => {
  it('returns items for an assigned stage', async () => {
    stubFetch(() => ({ body: { value: [{ itemId: 'i1', itemDisplayName: 'Report A', itemType: 'Report' }] } }));
    const { GET } = await import('@/app/api/deployment-pipelines/[id]/stages/[stageId]/items/route');
    const r = await GET(
      new NextRequest('https://loom.test/x'),
      ctx({ id: 'dp1', stageId: 's1' }),
    );
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.items[0].itemType).toBe('Report');
  });

  it('Fabric 400 (no workspace) → empty item list, ok:true', async () => {
    stubFetch(() => ({ status: 400, body: { errorCode: 'BadRequest', message: 'no workspace' } }));
    const { GET } = await import('@/app/api/deployment-pipelines/[id]/stages/[stageId]/items/route');
    const r = await GET(new NextRequest('https://loom.test/x'), ctx({ id: 'dp1', stageId: 's1' }));
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.items).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// POST /api/deployment-pipelines/[id]/deploy
// --------------------------------------------------------------------------

function deployReq(body: unknown) {
  return new NextRequest('https://loom.test/api/deployment-pipelines/dp1/deploy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/deployment-pipelines/[id]/deploy', () => {
  it('rejects missing sourceStageId → 400', async () => {
    const { POST } = await import('@/app/api/deployment-pipelines/[id]/deploy/route');
    const r = await POST(deployReq({ targetStageId: 't' }), ctx({ id: 'dp1' }));
    expect(r.status).toBe(400);
  });

  it('rejects missing targetStageId → 400', async () => {
    const { POST } = await import('@/app/api/deployment-pipelines/[id]/deploy/route');
    const r = await POST(deployReq({ sourceStageId: 's' }), ctx({ id: 'dp1' }));
    expect(r.status).toBe(400);
  });

  it('forwards source/target + items to Fabric deploy and reports accepted', async () => {
    let body: any; let url = '';
    stubFetch((u, init) => { url = u; body = JSON.parse((init?.body as string) || '{}'); return { status: 202, headers: { location: 'https://api.fabric.microsoft.com/v1/operations/op-1' } }; });
    const { POST } = await import('@/app/api/deployment-pipelines/[id]/deploy/route');
    const r = await POST(
      deployReq({ sourceStageId: 's1', targetStageId: 's2', items: [{ sourceItemId: 'i1', itemType: 'Report' }], note: 'go' }),
      ctx({ id: 'dp1' }),
    );
    expect(r.status).toBe(200);
    expect(url).toContain('/v1/deploymentPipelines/dp1/deploy');
    expect(body.sourceStageId).toBe('s1');
    expect(body.targetStageId).toBe('s2');
    expect(body.items).toHaveLength(1);
    expect(body.note).toBe('go');
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.accepted).toBe(true);
    expect(j.data.location).toContain('/operations/op-1');
  });

  it('Fabric 403 → 200 gate JSON', async () => {
    stubFetch(() => ({ status: 403, body: { errorCode: 'Unauthorized', message: 'denied' } }));
    const { POST } = await import('@/app/api/deployment-pipelines/[id]/deploy/route');
    const r = await POST(deployReq({ sourceStageId: 's1', targetStageId: 's2' }), ctx({ id: 'dp1' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.gate).toBeTruthy();
  });
});

// --------------------------------------------------------------------------
// GET /api/deployment-pipelines/[id]/operations
// --------------------------------------------------------------------------

describe('GET /api/deployment-pipelines/[id]/operations', () => {
  it('returns deployment history', async () => {
    stubFetch(() => ({ body: { value: [{ id: 'op1', type: 'Deploy', status: 'Succeeded', note: { content: 'r1' } }] } }));
    const { GET } = await import('@/app/api/deployment-pipelines/[id]/operations/route');
    const r = await GET(new NextRequest('https://loom.test/x'), ctx({ id: 'dp1' }));
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.operations[0].status).toBe('Succeeded');
    expect(j.data.operations[0].note).toBe('r1');
  });
});

// --------------------------------------------------------------------------
// GET /api/deployment-pipelines/arm
// --------------------------------------------------------------------------

describe('GET /api/deployment-pipelines/arm', () => {
  it('returns ARM deployments on happy path', async () => {
    stubFetch(() => ({ body: { value: [{
      id: '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.Resources/deployments/loom-main',
      name: 'loom-main', properties: { provisioningState: 'Succeeded', timestamp: '2026-05-30T10:00:00Z', mode: 'Incremental' },
    }] } }));
    const { GET } = await import('@/app/api/deployment-pipelines/arm/route');
    const r = await GET();
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.deployments[0].name).toBe('loom-main');
  });

  it('unconfigured env → 200 { ok:false, gate } JSON', async () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    const { GET } = await import('@/app/api/deployment-pipelines/arm/route');
    const r = await GET();
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.gate.missing).toContain('LOOM_SUBSCRIPTION_ID');
  });
});
