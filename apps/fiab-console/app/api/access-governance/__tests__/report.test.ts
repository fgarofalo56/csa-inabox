/**
 * BFF contract test for GET /api/access-governance/report (access-governance W1).
 * Covers the admin gate, per-principal + per-resource merges, and CSV export.
 * Cosmos containers, the admin gate, and Graph are stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  accessAssignmentsContainer: vi.fn(),
  workspaceRolesContainer: vi.fn(),
}));
vi.mock('@/lib/azure/graph-identity-client', () => ({ getGroupTransitiveMembers: vi.fn() }));

import { GET } from '../report/route';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { accessAssignmentsContainer, workspaceRolesContainer } from '@/lib/azure/cosmos-client';
import { getGroupTransitiveMembers } from '@/lib/azure/graph-identity-client';

function queryContainer(resources: any[]) {
  return { items: { query: () => ({ fetchAll: async () => ({ resources }) }) } };
}
function req(qs = '') {
  const u = new URL(`http://x/api/access-governance/report${qs}`);
  return { nextUrl: u } as any;
}

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'admin-oid' } });
  (requireTenantAdmin as any).mockReturnValue(null); // admin by default
  (getGroupTransitiveMembers as any).mockRejectedValue(new Error('graph off'));
});

describe('GET /api/access-governance/report', () => {
  it('403s a non-admin (delegates to requireTenantAdmin)', async () => {
    (requireTenantAdmin as any).mockReturnValue(NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }));
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it('per-principal: returns that principal\'s grants', async () => {
    (accessAssignmentsContainer as any).mockResolvedValue(queryContainer([
      { id: 'a1', principalId: 'p1', principalType: 'User', tenantId: 't', resourceType: 'kql-database', resourceRef: 'db-1', role: 'viewer', source: 'direct', grantedAt: '2026-07-02T00:00:00Z', state: 'active' },
    ]));
    (workspaceRolesContainer as any).mockResolvedValue(queryContainer([
      { id: 'ws-1:p1', workspaceId: 'ws-1', principalId: 'p1', principalType: 'User', displayName: 'Ann', role: 'Admin', addedBy: 'boss', addedAt: '2026-07-03T00:00:00Z' },
    ]));
    const res = await GET(req('?principalId=p1'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.mode).toBe('principal');
    expect(j.count).toBe(2);
    expect(j.entries.every((e: any) => e.principalId === 'p1')).toBe(true);
  });

  it('per-resource: merges ledger + workspace ACL for the resource', async () => {
    (accessAssignmentsContainer as any).mockResolvedValue(queryContainer([
      { id: 'a1', principalId: 'p2', principalType: 'User', tenantId: 't', resourceType: 'workspace', resourceRef: 'ws-9', role: 'Viewer', source: 'workspace-acl', grantedAt: '2026-07-01T00:00:00Z', state: 'active' },
    ]));
    (workspaceRolesContainer as any).mockResolvedValue(queryContainer([
      { id: 'ws-9:p3', workspaceId: 'ws-9', principalId: 'p3', principalType: 'User', displayName: 'Cy', role: 'Member', addedBy: 'x', addedAt: '2026-07-04T00:00:00Z' },
    ]));
    const res = await GET(req('?resourceRef=ws-9&resourceType=workspace'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.mode).toBe('resource');
    expect(j.groupExpansion).toBe('n/a'); // no group principals present → nothing to expand
    expect(j.entries.map((e: any) => e.principalId).sort()).toEqual(['p2', 'p3']);
  });

  it('exports CSV with the attachment header', async () => {
    (accessAssignmentsContainer as any).mockResolvedValue(queryContainer([
      { id: 'a1', principalId: 'p1', principalType: 'User', tenantId: 't', resourceType: 'workspace', resourceRef: 'ws-1', role: 'Viewer', source: 'workspace-acl', grantedAt: '2026-07-02T00:00:00Z', state: 'active' },
    ]));
    (workspaceRolesContainer as any).mockResolvedValue(queryContainer([]));
    const res = await GET(req('?format=csv'));
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const body = await res.text();
    expect(body.split('\r\n')[0]).toContain('principalUpn');
  });
});
