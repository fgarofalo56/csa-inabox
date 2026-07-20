/**
 * Contract test for POST /api/access-governance/assignments/[id]/activate (W3).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({ accessAssignmentsContainer: vi.fn() }));
vi.mock('@/lib/azure/access-policy-client', () => ({ enforceAccessGrant: vi.fn() }));
vi.mock('@/lib/access/assignment-ledger', () => ({ activateAssignment: vi.fn() }));

import { POST } from '../activate/route';
import { getSession } from '@/lib/auth/session';
import { accessAssignmentsContainer } from '@/lib/azure/cosmos-client';
import { enforceAccessGrant } from '@/lib/azure/access-policy-client';
import { activateAssignment } from '@/lib/access/assignment-ledger';

const ctx = { params: Promise.resolve({ id: 'asg-1' }) };
function itemContainer(resource: any) {
  return { item: () => ({ read: async () => ({ resource }) }) };
}

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'p1', upn: 'p1@x' } });
});

describe('POST activate', () => {
  it('404 when the assignment is missing', async () => {
    (accessAssignmentsContainer as any).mockResolvedValue(itemContainer(undefined));
    expect((await POST({} as any, ctx)).status).toBe(404);
  });

  it('409 when the assignment is not eligible', async () => {
    (accessAssignmentsContainer as any).mockResolvedValue(itemContainer({ id: 'asg-1', principalId: 'p1', state: 'active' }));
    expect((await POST({} as any, ctx)).status).toBe(409);
  });

  it('grants + activates an eligible assignment with a bounded expiry', async () => {
    (accessAssignmentsContainer as any).mockResolvedValue(itemContainer({
      id: 'asg-1', principalId: 'p1', principalUpn: 'p1@x', principalType: 'User',
      resourceType: 'kql-database', resourceRef: 'db-1', permission: 'read', role: 'viewer',
      state: 'eligible', activationWindowHours: 4,
    }));
    (enforceAccessGrant as any).mockResolvedValue({ status: 'active', roleName: 'ADX Viewer', roleAssignmentId: 'ra9' });
    (activateAssignment as any).mockImplementation(async (_id: string, _oid: string, patch: any) => ({ id: 'asg-1', state: 'active', expiresAt: patch.expiresAt }));
    const res = await POST({} as any, ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.activated).toBe(true);
    expect(j.windowHours).toBe(4);
    expect(enforceAccessGrant).toHaveBeenCalledOnce();
    expect(activateAssignment).toHaveBeenCalledWith('asg-1', 'p1', expect.objectContaining({ roleAssignmentId: 'ra9' }));
  });

  it('leaves the assignment eligible on a grant gate', async () => {
    (accessAssignmentsContainer as any).mockResolvedValue(itemContainer({ id: 'asg-1', principalId: 'p1', resourceType: 'kql-database', resourceRef: 'db-1', state: 'eligible' }));
    (enforceAccessGrant as any).mockResolvedValue({ status: 'pending', detail: 'set LOOM_ADX_CLUSTER' });
    const res = await POST({} as any, ctx);
    const j = await res.json();
    expect(j.activated).toBe(false);
    expect(activateAssignment).not.toHaveBeenCalled();
  });
});
