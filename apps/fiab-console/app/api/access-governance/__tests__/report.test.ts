/**
 * BFF contract test for GET /api/access-governance/report (access-governance W1).
 * Covers the admin gate, per-principal + per-resource merges, and CSV export.
 * Cosmos containers, the admin gate, and Graph are stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  getSession: vi.fn(),
}));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  accessAssignmentsContainer: vi.fn(),
  workspaceRolesContainer: vi.fn(),
  accessRequestWorkflowContainer: vi.fn(),
}));
vi.mock('@/lib/azure/graph-identity-client', () => ({ getGroupTransitiveMembers: vi.fn() }));

import { GET } from '../report/route';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { accessAssignmentsContainer, workspaceRolesContainer, accessRequestWorkflowContainer } from '@/lib/azure/cosmos-client';
import { getGroupTransitiveMembers } from '@/lib/azure/graph-identity-client';
import { makePartitionedContainer } from '../../access-requests/__tests__/partitioned-cosmos-fake';

function queryContainer(resources: any[]) {
  return { items: { query: () => ({ fetchAll: async () => ({ resources }) }) } };
}
function req(qs = '') {
  const u = new URL(`http://x/api/access-governance/report${qs}`);
  return { nextUrl: u } as any;
}

/** A grant-ledger row as lib/access/grant-intents.ts writes it. */
function intent(id: string, patch: Record<string, unknown>) {
  return {
    id, kind: 'grant-intent', tenantId: 'tenant-7', requestId: `req-${id}`, attemptId: 'a1',
    principalId: 'p1', principalName: 'p1@x', scopeType: 'adls-container', scopeRef: 'gold',
    permission: 'read', assetName: 'Gold sales', by: 'approver@x',
    createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z', state: 'pending', ...patch,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'admin-oid', tid: 'tenant-7' } });
  (requireTenantAdmin as any).mockReturnValue(null); // admin by default
  (getGroupTransitiveMembers as any).mockRejectedValue(new Error('graph off'));
  (accessRequestWorkflowContainer as any).mockResolvedValue(makePartitionedContainer({ partitionKeyPath: '/tenantId' }));
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

  it("lists the tenant's grant records that are not settled, with state and age, and nothing else", async () => {
    // Breaks if the report never read the grant ledger (grantRecords absent or
    // empty: a pending grant, possibly live, is visible nowhere), if it listed
    // settled rows (active/preexisting/revoked), or another tenant's rows.
    (accessAssignmentsContainer as any).mockResolvedValue(queryContainer([]));
    (workspaceRolesContainer as any).mockResolvedValue(queryContainer([]));
    (accessRequestWorkflowContainer as any).mockResolvedValue(makePartitionedContainer({
      partitionKeyPath: '/tenantId',
      seed: [
        intent('i-pending', { state: 'pending', createdAt: '2026-09-30T12:00:00.000Z' }),
        intent('i-failed', { state: 'failed', detail: 'ARM 403', createdAt: '2026-09-30T11:00:00.000Z' }),
        intent('i-absent', { state: 'absent', createdAt: '2026-09-30T10:00:00.000Z' }),
        intent('i-active', { state: 'active', created: true }),
        intent('i-pre', { state: 'preexisting', created: false }),
        intent('i-revoked', { state: 'revoked' }),
        intent('i-other-tenant', { state: 'pending', tenantId: 'tenant-9' }),
        { id: 'req-x', kind: 'access-request', tenantId: 'tenant-7', status: 'open' },
      ],
    }));
    const j = await (await GET(req())).json();
    expect(j.ok).toBe(true);
    expect(j.grantRecords.map((r: any) => [r.id, r.state, r.createdAt])).toEqual([
      ['i-pending', 'pending', '2026-09-30T12:00:00.000Z'],
      ['i-failed', 'failed', '2026-09-30T11:00:00.000Z'],
      ['i-absent', 'absent', '2026-09-30T10:00:00.000Z'],
    ]);
    expect(j.grantRecords[1]).toMatchObject({ requestId: 'req-i-failed', principalName: 'p1@x', scopeRef: 'gold', detail: 'ARM 403' });
    expect(j.grantRecordsError).toBeUndefined();
  });

  it('filters grant records by principal and by resource, like the grants', async () => {
    (accessAssignmentsContainer as any).mockResolvedValue(queryContainer([]));
    (workspaceRolesContainer as any).mockResolvedValue(queryContainer([]));
    (accessRequestWorkflowContainer as any).mockResolvedValue(makePartitionedContainer({
      partitionKeyPath: '/tenantId',
      seed: [intent('i-p1', {}), intent('i-p2', { principalId: 'p2', scopeRef: 'silver' })],
    }));
    expect((await (await GET(req('?principalId=p2'))).json()).grantRecords.map((r: any) => r.id)).toEqual(['i-p2']);
    expect((await (await GET(req('?resourceRef=gold'))).json()).grantRecords.map((r: any) => r.id)).toEqual(['i-p1']);
  });

  it('answers the report when the grant records cannot be read, and says so', async () => {
    (accessAssignmentsContainer as any).mockResolvedValue(queryContainer([
      { id: 'a1', principalId: 'p1', principalType: 'User', tenantId: 't', resourceType: 'workspace', resourceRef: 'ws-1', role: 'Viewer', source: 'workspace-acl', grantedAt: '2026-07-02T00:00:00Z', state: 'active' },
    ]));
    (workspaceRolesContainer as any).mockResolvedValue(queryContainer([]));
    (accessRequestWorkflowContainer as any).mockRejectedValue(new Error('cosmos down'));
    const res = await GET(req());
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.count).toBe(1);
    expect(j.grantRecords).toEqual([]);
    expect(j.grantRecordsError).toBe('The access-request grant records could not be read, so grants not yet settled are not listed.');
  });
});
