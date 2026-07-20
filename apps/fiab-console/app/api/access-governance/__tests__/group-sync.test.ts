/**
 * Contract test for the group-sync route (W4, AG-8/AG-9): the honest opt-in gate
 * and a dry-run reconcile plan. Graph + Cosmos stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  accessPackagesContainer: vi.fn(),
  accessAssignmentsContainer: vi.fn(),
  auditLogContainer: vi.fn(),
}));
vi.mock('@/lib/azure/graph-identity-client', () => ({ getGroupTransitiveMembers: vi.fn(), getGroupsByIds: vi.fn() }));
vi.mock('@/lib/azure/access-policy-client', () => ({ enforceAccessGrant: vi.fn() }));
vi.mock('@/lib/access/assignment-ledger', () => ({ recordAssignment: vi.fn() }));
vi.mock('@/lib/access/revoke-assignment', () => ({ revokeAssignment: vi.fn() }));

import { POST } from '../group-sync/route';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { accessPackagesContainer, accessAssignmentsContainer } from '@/lib/azure/cosmos-client';
import { getGroupTransitiveMembers, getGroupsByIds } from '@/lib/azure/graph-identity-client';

function queryContainer(resources: any[]) {
  return { items: { query: () => ({ fetchAll: async () => ({ resources }) }) } };
}
function req(qs = '') { return { nextUrl: new URL(`http://x/api/access-governance/group-sync${qs}`), headers: { get: () => null } } as any; }

const OLD = process.env.LOOM_GRAPH_GROUP_SYNC_ENABLED;
beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'admin', upn: 'admin@x' } });
  (requireTenantAdmin as any).mockReturnValue(null);
});
afterEach(() => { process.env.LOOM_GRAPH_GROUP_SYNC_ENABLED = OLD; });

it('returns an honest gate when group sync is off', async () => {
  delete process.env.LOOM_GRAPH_GROUP_SYNC_ENABLED;
  const res = await POST(req());
  const j = await res.json();
  expect(j.ok).toBe(false);
  expect(j.gated).toBe(true);
  expect(j.gate).toBe('graph-group-sync');
  expect(j.remediation).toMatch(/LOOM_GRAPH_GROUP_SYNC_ENABLED/);
});

it('dry-run reports a reconcile plan (joiners/leavers)', async () => {
  process.env.LOOM_GRAPH_GROUP_SYNC_ENABLED = 'true';
  (accessPackagesContainer as any).mockResolvedValue(queryContainer([
    { id: 'pk1', tenantId: 't1', enabled: true, groupTargets: ['g1'], grants: [{ resourceType: 'workspace', resourceRef: 'ws-1', role: 'Viewer' }] },
  ]));
  (accessAssignmentsContainer as any).mockResolvedValue(queryContainer([
    { id: 'a1', principalId: 'gone', state: 'active', source: 'group:g1', resourceRef: 'ws-1', resourceType: 'workspace' },
  ]));
  (getGroupTransitiveMembers as any).mockResolvedValue([{ id: 'p1', upn: 'p1@x', type: 'user' }]);
  (getGroupsByIds as any).mockResolvedValue([{ id: 'g1', displayName: 'Sales' }]);
  const res = await POST(req('?dryRun=1'));
  const j = await res.json();
  expect(j.ok).toBe(true);
  expect(j.dryRun).toBe(true);
  expect(j.plan[0]).toMatchObject({ packageId: 'pk1', groupId: 'g1', resourceRef: 'ws-1', toGrant: 1, toRevoke: 1 });
});
