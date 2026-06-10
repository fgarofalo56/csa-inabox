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

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

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

  it('source + target stages share a workspace → 400 duplicate_workspace (no deploy call)', async () => {
    let deployCalled = false;
    stubFetch((u) => {
      if (u.includes('/stages') && !u.includes('/deploy')) {
        return { body: { value: [
          { id: 's1', order: 0, displayName: 'Development', workspaceId: 'ws-shared' },
          { id: 's2', order: 1, displayName: 'Test', workspaceId: 'ws-shared' },
        ] } };
      }
      if (u.includes('/deploy')) { deployCalled = true; return { status: 202 }; }
      return { body: {} };
    });
    const { POST } = await import('@/app/api/deployment-pipelines/[id]/deploy/route');
    const r = await POST(deployReq({ sourceStageId: 's1', targetStageId: 's2' }), ctx({ id: 'dp1' }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('duplicate_workspace');
    expect(j.error).toMatch(/same workspace/i);
    expect(deployCalled).toBe(false);
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

// --------------------------------------------------------------------------
// GET /api/deployment-pipelines/[id]/compare — stage pairing + sync status
// --------------------------------------------------------------------------

describe('GET /api/deployment-pipelines/[id]/compare', () => {
  it('pairs items and labels Same / Different / OnlyInSource / NotInSource', async () => {
    // Fabric returns source items on the first call, target items on the second.
    let n = 0;
    stubFetch((u) => {
      if (u.includes('/stages/src/items')) {
        n++;
        return { body: { value: [
          { itemId: 's1', itemDisplayName: 'Report A', itemType: 'Report', lastDeploymentTime: '2026-05-01T00:00:00Z' },
          { itemId: 's2', itemDisplayName: 'Only Source', itemType: 'Notebook' },
        ] } };
      }
      if (u.includes('/stages/tgt/items')) {
        return { body: { value: [
          { itemId: 't1', itemDisplayName: 'Report A', itemType: 'Report', lastDeploymentTime: '2026-05-01T00:00:00Z' },
          { itemId: 't3', itemDisplayName: 'Only Target', itemType: 'Dashboard' },
        ] } };
      }
      return { body: { value: [] } };
    });
    const { GET } = await import('@/app/api/deployment-pipelines/[id]/compare/route');
    const r = await GET(
      new NextRequest('https://loom.test/api/deployment-pipelines/dp1/compare?source=src&target=tgt'),
      ctx({ id: 'dp1' }),
    );
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.summary.same).toBe(1);          // Report A paired, same lastDeploymentTime
    expect(j.data.summary.onlyInSource).toBe(1);  // Only Source
    expect(j.data.summary.notInSource).toBe(1);   // Only Target
  });

  it('missing source/target → 400', async () => {
    const { GET } = await import('@/app/api/deployment-pipelines/[id]/compare/route');
    const r = await GET(new NextRequest('https://loom.test/x?source=a'), ctx({ id: 'dp1' }));
    expect(r.status).toBe(400);
  });
});

// --------------------------------------------------------------------------
// POST /api/deployment-pipelines/create
// --------------------------------------------------------------------------

describe('POST /api/deployment-pipelines/create', () => {
  function req(body: unknown) {
    return new NextRequest('https://loom.test/api/deployment-pipelines/create', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  }
  it('creates a pipeline and forwards stages', async () => {
    let sent: any;
    stubFetch((_u, init) => { sent = JSON.parse((init?.body as string) || '{}'); return { status: 201, body: { id: 'np1', displayName: 'X' } }; });
    const { POST } = await import('@/app/api/deployment-pipelines/create/route');
    const r = await POST(req({ displayName: 'X', stages: [{ displayName: 'Dev' }, { displayName: 'Prod', isPublic: true }] }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.pipeline.id).toBe('np1');
    expect(sent.stages).toHaveLength(2);
  });
  it('rejects fewer than 2 stages → 400', async () => {
    const { POST } = await import('@/app/api/deployment-pipelines/create/route');
    const r = await POST(req({ displayName: 'X', stages: [{ displayName: 'Dev' }] }));
    expect(r.status).toBe(400);
  });
});

// --------------------------------------------------------------------------
// Stage workspace assign / unassign
// --------------------------------------------------------------------------

describe('Stage workspace assign / unassign', () => {
  it('POST assigns a workspace', async () => {
    let url = '';
    stubFetch((u) => { url = u; return { status: 200 }; });
    const { POST } = await import('@/app/api/deployment-pipelines/[id]/stages/[stageId]/workspace/route');
    const r = await POST(
      new NextRequest('https://loom.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'ws1' }) }),
      ctx({ id: 'dp1', stageId: 's1' }),
    );
    expect(r.status).toBe(200);
    expect(url).toContain('/stages/s1/assignWorkspace');
    expect((await r.json()).data.assigned).toBe(true);
  });
  it('POST without workspaceId → 400', async () => {
    const { POST } = await import('@/app/api/deployment-pipelines/[id]/stages/[stageId]/workspace/route');
    const r = await POST(
      new NextRequest('https://loom.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      ctx({ id: 'dp1', stageId: 's1' }),
    );
    expect(r.status).toBe(400);
  });
  it('POST rejects a workspace already bound to another stage → 400 duplicate_workspace', async () => {
    let assignCalled = false;
    stubFetch((u) => {
      if (u.includes('assignWorkspace')) { assignCalled = true; return { status: 200 }; }
      if (u.includes('/stages')) {
        return { body: { value: [
          { id: 's1', order: 0, displayName: 'Development' },
          { id: 's2', order: 1, displayName: 'Test', workspaceId: 'ws-busy' },
        ] } };
      }
      return { body: {} };
    });
    const { POST } = await import('@/app/api/deployment-pipelines/[id]/stages/[stageId]/workspace/route');
    const r = await POST(
      new NextRequest('https://loom.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'ws-busy' }) }),
      ctx({ id: 'dp1', stageId: 's1' }),
    );
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.code).toBe('duplicate_workspace');
    expect(j.error).toMatch(/already assigned to stage "Test"/i);
    expect(assignCalled).toBe(false);
  });
  it('DELETE unassigns a workspace', async () => {
    let url = '';
    stubFetch((u) => { url = u; return { status: 200 }; });
    const { DELETE } = await import('@/app/api/deployment-pipelines/[id]/stages/[stageId]/workspace/route');
    const r = await DELETE(new NextRequest('https://loom.test/x'), ctx({ id: 'dp1', stageId: 's1' }));
    expect(r.status).toBe(200);
    expect(url).toContain('/stages/s1/unassignWorkspace');
    expect((await r.json()).data.unassigned).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Git integration routes
// --------------------------------------------------------------------------

describe('Git integration routes', () => {
  it('GET connection returns provider details', async () => {
    stubFetch(() => ({ body: {
      gitConnectionState: 'ConnectedAndInitialized',
      gitProviderDetails: { gitProviderType: 'AzureDevOps', repositoryName: 'Repo', branchName: 'main' },
      gitSyncDetails: { head: 'abc123', lastSyncTime: '2026-05-30T00:00:00Z' },
    } }));
    const { GET } = await import('@/app/api/deployment-pipelines/git/[workspaceId]/connection/route');
    const r = await GET(new NextRequest('https://loom.test/x'), ctx({ workspaceId: 'ws1' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.connection.gitProviderDetails.repositoryName).toBe('Repo');
  });

  it('POST connect forwards AzureDevOps details', async () => {
    let url = ''; let sent: any;
    stubFetch((u, init) => { url = u; sent = JSON.parse((init?.body as string) || '{}'); return { status: 200 }; });
    const { POST } = await import('@/app/api/deployment-pipelines/git/[workspaceId]/connection/route');
    const r = await POST(
      new NextRequest('https://loom.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        provider: 'AzureDevOps', organizationName: 'org', projectName: 'proj', repositoryName: 'repo', branchName: 'main',
      }) }),
      ctx({ workspaceId: 'ws1' }),
    );
    expect(r.status).toBe(200);
    expect(url).toContain('/git/connect');
    expect(sent.gitProviderDetails.organizationName).toBe('org');
  });

  it('GET status returns changes', async () => {
    stubFetch(() => ({ body: { workspaceHead: 'h1', remoteCommitHash: 'r1', changes: [
      { itemMetadata: { itemIdentifier: { objectId: 'o1' }, itemType: 'Report', displayName: 'Rep' }, workspaceChange: 'Modified', conflictType: 'None' },
    ] } }));
    const { GET } = await import('@/app/api/deployment-pipelines/git/[workspaceId]/status/route');
    const r = await GET(new NextRequest('https://loom.test/x'), ctx({ workspaceId: 'ws1' }));
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.status.changes[0].workspaceChange).toBe('Modified');
  });

  it('GET status 202 → pending', async () => {
    stubFetch(() => ({ status: 202, headers: { location: 'https://api.fabric.microsoft.com/v1/operations/op1' } }));
    const { GET } = await import('@/app/api/deployment-pipelines/git/[workspaceId]/status/route');
    const r = await GET(new NextRequest('https://loom.test/x'), ctx({ workspaceId: 'ws1' }));
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.data.pending).toBe(true);
  });

  it('POST commit All forwards mode', async () => {
    let url = ''; let sent: any;
    stubFetch((u, init) => { url = u; sent = JSON.parse((init?.body as string) || '{}'); return { status: 202, headers: { location: 'https://api.fabric.microsoft.com/v1/operations/op1' } }; });
    const { POST } = await import('@/app/api/deployment-pipelines/git/[workspaceId]/commit/route');
    const r = await POST(
      new NextRequest('https://loom.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'All', comment: 'c' }) }),
      ctx({ workspaceId: 'ws1' }),
    );
    expect(r.status).toBe(200);
    expect(url).toContain('/git/commitToGit');
    expect(sent.mode).toBe('All');
    expect((await r.json()).data.accepted).toBe(true);
  });

  it('POST commit Selective without items → 400', async () => {
    const { POST } = await import('@/app/api/deployment-pipelines/git/[workspaceId]/commit/route');
    const r = await POST(
      new NextRequest('https://loom.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'Selective' }) }),
      ctx({ workspaceId: 'ws1' }),
    );
    expect(r.status).toBe(400);
  });

  it('POST update forwards heads', async () => {
    let url = ''; let sent: any;
    stubFetch((u, init) => { url = u; sent = JSON.parse((init?.body as string) || '{}'); return { status: 202, headers: { location: 'https://api.fabric.microsoft.com/v1/operations/op1' } }; });
    const { POST } = await import('@/app/api/deployment-pipelines/git/[workspaceId]/update/route');
    const r = await POST(
      new NextRequest('https://loom.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceHead: 'h1', remoteCommitHash: 'r1' }) }),
      ctx({ workspaceId: 'ws1' }),
    );
    expect(r.status).toBe(200);
    expect(url).toContain('/git/updateFromGit');
    expect(sent.workspaceHead).toBe('h1');
    expect(sent.remoteCommitHash).toBe('r1');
  });

  it('Git 403 → 200 gate JSON', async () => {
    stubFetch(() => ({ status: 403, body: { errorCode: 'Unauthorized', message: 'denied' } }));
    const { GET } = await import('@/app/api/deployment-pipelines/git/[workspaceId]/connection/route');
    const r = await GET(new NextRequest('https://loom.test/x'), ctx({ workspaceId: 'ws1' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.gate).toBeTruthy();
  });
});

// --------------------------------------------------------------------------
// Backward deploy — deploy into an empty earlier stage with createdWorkspaceDetails
// --------------------------------------------------------------------------

describe('POST deploy (backward / empty target)', () => {
  it('forwards createdWorkspaceDetails when target is empty', async () => {
    let sent: any;
    stubFetch((_u, init) => { sent = JSON.parse((init?.body as string) || '{}'); return { status: 202, headers: { location: 'https://api.fabric.microsoft.com/v1/operations/op1' } }; });
    const { POST } = await import('@/app/api/deployment-pipelines/[id]/deploy/route');
    const r = await POST(
      new NextRequest('https://loom.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        sourceStageId: 's2', targetStageId: 's1', createdWorkspaceDetails: { name: 'Dev WS' },
      }) }),
      ctx({ id: 'dp1' }),
    );
    expect(r.status).toBe(200);
    expect(sent.sourceStageId).toBe('s2');
    expect(sent.targetStageId).toBe('s1');
    expect(sent.createdWorkspaceDetails.name).toBe('Dev WS');
  });
});
