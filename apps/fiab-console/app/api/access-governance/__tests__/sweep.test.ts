/**
 * Contract test for POST /api/access-governance/sweep (access-governance W3):
 * admin gate, dry-run (select only), and the real expire+revoke path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({ accessAssignmentsContainer: vi.fn(), auditLogContainer: vi.fn() }));
vi.mock('@/lib/azure/access-policy-client', () => ({ revokeAccessGrant: vi.fn(), revokeStructuredGrant: vi.fn() }));
vi.mock('@/lib/access/assignment-ledger', () => ({ expireAssignment: vi.fn() }));

import { POST } from '../sweep/route';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { accessAssignmentsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { revokeAccessGrant, revokeStructuredGrant } from '@/lib/azure/access-policy-client';
import { expireAssignment } from '@/lib/access/assignment-ledger';

const PAST = '2026-01-01T00:00:00.000Z';
function req(qs = '') {
  return { nextUrl: new URL(`http://x/api/access-governance/sweep${qs}`), headers: { get: () => null } } as any;
}
function queryContainer(resources: any[]) {
  return { items: { query: () => ({ fetchAll: async () => ({ resources }) }), create: async () => ({}) } };
}

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'admin', upn: 'a@x' } });
  (requireTenantAdmin as any).mockReturnValue(null);
  (auditLogContainer as any).mockResolvedValue(queryContainer([]));
  (expireAssignment as any).mockResolvedValue(true);
});

describe('POST /api/access-governance/sweep', () => {
  it('403 for a non-admin without a system token', async () => {
    (requireTenantAdmin as any).mockReturnValue(NextResponse.json({ ok: false }, { status: 403 }));
    expect((await POST(req())).status).toBe(403);
  });

  it('dry-run reports candidates and revokes nothing', async () => {
    (accessAssignmentsContainer as any).mockResolvedValue(queryContainer([
      { id: 'a', principalId: 'p1', resourceType: 'workspace', resourceRef: 'ws-1', state: 'active', expiresAt: PAST, roleAssignmentId: 'ra1' },
    ]));
    const res = await POST(req('?dryRun=1'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.dryRun).toBe(true);
    expect(j.candidates).toBe(1);
    expect(revokeAccessGrant).not.toHaveBeenCalled();
    expect(expireAssignment).not.toHaveBeenCalled();
  });

  it('real run revokes + expires the due assignments', async () => {
    (accessAssignmentsContainer as any).mockResolvedValue(queryContainer([
      { id: 'a', principalId: 'p1', principalUpn: 'p1@x', principalType: 'User', resourceType: 'kql-database', resourceRef: 'db-1', permission: 'read', state: 'active', expiresAt: PAST, roleAssignmentId: 'ra1' },
    ]));
    const res = await POST(req());
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.expired).toBe(1);
    expect(revokeAccessGrant).toHaveBeenCalledWith('ra1');
    expect(revokeStructuredGrant).toHaveBeenCalledOnce();
    expect(expireAssignment).toHaveBeenCalledWith('a', 'p1');
  });
});
