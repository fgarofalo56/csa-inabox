/**
 * BFF route tests for /api/workspaces/[id]/powerbi-mapping (WS-PBIMAP).
 *
 * Pins: read/write ACL gating (mirrors the sibling workspace PATCH), GUID
 * validation, set + clear, and the pbiConfigured flag. Cosmos + access are
 * mocked; the mapping persists on the workspace doc.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Workspace } from '@/lib/types/workspace';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'owner-oid', upn: 'owner@contoso.com' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

let workspaceDoc: Workspace;
const replaced: Workspace[] = [];
const fakeWorkspaces = {
  item: (_id: string, _pk: string) => ({
    replace: async (doc: Workspace) => { replaced.push(doc); workspaceDoc = doc; return { resource: doc }; },
  }),
};
vi.mock('@/lib/azure/cosmos-client', () => ({ workspacesContainer: async () => fakeWorkspaces }));

let accessImpl: () => any;
vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: async () => accessImpl(),
}));

let pbiGate: any = null;
vi.mock('@/lib/azure/powerbi-client', () => ({ powerbiConfigGate: () => pbiGate }));

const GUID = '11111111-2222-3333-4444-555555555555';

function req(method: string, body?: unknown) {
  return new NextRequest('https://loom.test/api/workspaces/ws1/powerbi-mapping', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = { params: Promise.resolve({ id: 'ws1' }) };

beforeEach(() => {
  replaced.length = 0;
  pbiGate = null;
  workspaceDoc = { id: 'ws1', tenantId: 'owner-oid', name: 'WS', createdBy: 'owner-oid', createdAt: '', updatedAt: '' };
  getSessionMock.mockReturnValue({ claims: { oid: 'owner-oid', upn: 'owner@contoso.com' }, exp: Date.now() / 1000 + 3600 });
  accessImpl = () => ({ workspace: workspaceDoc, role: 'Owner', via: 'owner', canWrite: true });
});

describe('GET /api/workspaces/[id]/powerbi-mapping', () => {
  it('401s when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null);
    const { GET } = await import('../route');
    expect((await GET(req('GET'), params)).status).toBe(401);
  });

  it('404s when the caller has no access', async () => {
    accessImpl = () => null;
    const { GET } = await import('../route');
    expect((await GET(req('GET'), params)).status).toBe(404);
  });

  it('returns the current mapping + pbiConfigured', async () => {
    workspaceDoc.pbiWorkspaceMapping = { pbiWorkspaceId: GUID, pbiWorkspaceName: 'Finance', mappedBy: 'x', mappedAt: 'y' };
    const { GET } = await import('../route');
    const j = await (await GET(req('GET'), params)).json();
    expect(j.ok).toBe(true);
    expect(j.mapping.pbiWorkspaceId).toBe(GUID);
    expect(j.pbiConfigured).toBe(true); // gate null → configured
  });

  it('reports pbiConfigured=false when the PBI gate is present', async () => {
    pbiGate = { missing: 'LOOM_UAMI_CLIENT_ID', detail: 'no cred' };
    const { GET } = await import('../route');
    const j = await (await GET(req('GET'), params)).json();
    expect(j.pbiConfigured).toBe(false);
  });
});

describe('PUT /api/workspaces/[id]/powerbi-mapping', () => {
  it('403s a read-only role', async () => {
    accessImpl = () => ({ workspace: workspaceDoc, role: 'Viewer', via: 'acl', canWrite: false });
    const { PUT } = await import('../route');
    expect((await PUT(req('PUT', { pbiWorkspaceId: GUID }), params)).status).toBe(403);
    expect(replaced).toHaveLength(0);
  });

  it('rejects a non-GUID workspace id (400)', async () => {
    const { PUT } = await import('../route');
    const res = await PUT(req('PUT', { pbiWorkspaceId: 'not-a-guid' }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_guid');
    expect(replaced).toHaveLength(0);
  });

  it('persists a valid mapping with mappedBy/mappedAt stamped', async () => {
    const { PUT } = await import('../route');
    const j = await (await PUT(req('PUT', { pbiWorkspaceId: GUID, pbiWorkspaceName: 'Finance PBI' }), params)).json();
    expect(j.ok).toBe(true);
    expect(j.mapping).toMatchObject({ pbiWorkspaceId: GUID, pbiWorkspaceName: 'Finance PBI', mappedBy: 'owner@contoso.com' });
    expect(j.mapping.mappedAt).toBeTruthy();
    expect(replaced[0].pbiWorkspaceMapping?.pbiWorkspaceId).toBe(GUID);
  });

  it('clears the mapping when pbiWorkspaceId is empty', async () => {
    workspaceDoc.pbiWorkspaceMapping = { pbiWorkspaceId: GUID, mappedBy: 'x', mappedAt: 'y' };
    const { PUT } = await import('../route');
    const j = await (await PUT(req('PUT', { pbiWorkspaceId: '' }), params)).json();
    expect(j.ok).toBe(true);
    expect(j.mapping).toBeNull();
    expect(replaced[0].pbiWorkspaceMapping).toBeUndefined();
  });
});
