/**
 * Directory-user lifecycle route (#2758) — the security-critical properties.
 *
 * The one that MUST hold: delete tears down every entitlement BEFORE deleting
 * the Entra object, so a grant can never outlive the user it belonged to. Also
 * pins the admin gate and the honest 403 when the Graph write permission is not
 * consented (no-vaporware — never a silent success).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  accessAssignmentsContainer: vi.fn(),
  auditLogContainer: vi.fn(async () => ({ items: { create: vi.fn(async () => ({})) } })),
}));
vi.mock('@/lib/access/revoke-assignment', () => ({ revokeAssignment: vi.fn(async () => ({ warnings: [] })) }));
vi.mock('@/lib/access/assignment-ledger', () => ({
  pauseAssignment: vi.fn(async () => true),
  resumeAssignment: vi.fn(async () => true),
}));
vi.mock('@/lib/azure/graph-identity-client', () => {
  class GraphIdentityError extends Error {
    status: number;
    constructor(status: number, _b: unknown, m?: string) { super(m); this.status = status; }
  }
  return {
    GraphIdentityError,
    LIFECYCLE_APP_ROLES: [{ name: 'User.ReadWrite.All', appRoleId: 'x', scope: '', reason: '' }],
    setUserAccountEnabled: vi.fn(async () => {}),
    deleteTenantUser: vi.fn(async () => {}),
  };
});

import { NextResponse } from 'next/server';
import { POST } from '../[id]/lifecycle/route';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { accessAssignmentsContainer } from '@/lib/azure/cosmos-client';
import { revokeAssignment } from '@/lib/access/revoke-assignment';
import { deleteTenantUser, setUserAccountEnabled, GraphIdentityError } from '@/lib/azure/graph-identity-client';

function ctx(id: string) { return { params: Promise.resolve({ id }) }; }
function post(body: unknown) { return { json: async () => body, headers: new Headers() } as any; }

function mockLedger(rows: any[]) {
  (accessAssignmentsContainer as any).mockResolvedValue({
    items: { query: () => ({ fetchAll: async () => ({ resources: rows }) }) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'admin-1', upn: 'admin@x' } });
  (requireTenantAdmin as any).mockReturnValue(null); // admin
  mockLedger([]);
});

describe('directory-users lifecycle', () => {
  it('401/403s a non-admin (requireTenantAdmin gate)', async () => {
    (requireTenantAdmin as any).mockReturnValue(NextResponse.json({ ok: false }, { status: 403 }));
    const res = await POST(post({ action: 'pause' }), ctx('u1'));
    expect(res.status).toBe(403);
    expect(setUserAccountEnabled).not.toHaveBeenCalled();
  });

  it('rejects an unknown action', async () => {
    const res = await POST(post({ action: 'nope' }), ctx('u1'));
    expect(res.status).toBe(400);
  });

  it('DELETE revokes every entitlement BEFORE deleting the object', async () => {
    const order: string[] = [];
    (revokeAssignment as any).mockImplementation(async () => { order.push('revoke'); return { warnings: [] }; });
    (deleteTenantUser as any).mockImplementation(async () => { order.push('delete'); });
    mockLedger([
      { id: 'a1', principalId: 'u1', state: 'active', resourceType: 'adls', resourceRef: 'c1' },
      { id: 'a2', principalId: 'u1', state: 'eligible', resourceType: 'warehouse', resourceRef: 'w1' },
      { id: 'a3', principalId: 'u1', state: 'revoked', resourceType: 'x', resourceRef: 'y' }, // not revocable
    ]);
    const res = await POST(post({ action: 'delete' }), ctx('u1'));
    expect(res.status).toBe(200);
    // Two revocable rows revoked, THEN delete — never delete before revoke.
    expect(order).toEqual(['revoke', 'revoke', 'delete']);
    expect(order.indexOf('delete')).toBe(order.length - 1);
  });

  it('honest 403 when the delete lacks User.ReadWrite.All consent', async () => {
    mockLedger([{ id: 'a1', principalId: 'u1', state: 'active', resourceType: 'adls', resourceRef: 'c1' }]);
    (deleteTenantUser as any).mockRejectedValue(new (GraphIdentityError as any)(403, null, 'forbidden'));
    const res = await POST(post({ action: 'delete' }), ctx('u1'));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/User\.ReadWrite\.All/);
    // The entitlement WAS revoked before the delete failed — no dangling grant.
    expect(revokeAssignment).toHaveBeenCalledTimes(1);
  });

  it('pause disables the account and updates the ledger', async () => {
    mockLedger([{ id: 'a1', principalId: 'u1', state: 'active' }]);
    const res = await POST(post({ action: 'pause' }), ctx('u1'));
    expect(res.status).toBe(200);
    expect(setUserAccountEnabled).toHaveBeenCalledWith('u1', false);
    const body = await res.json();
    expect(body.accountEnabled).toBe(false);
  });

  it('resume re-enables the account', async () => {
    const res = await POST(post({ action: 'resume' }), ctx('u1'));
    expect(res.status).toBe(200);
    expect(setUserAccountEnabled).toHaveBeenCalledWith('u1', true);
  });
});
