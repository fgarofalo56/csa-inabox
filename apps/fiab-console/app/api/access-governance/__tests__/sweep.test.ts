/**
 * Contract test for POST /api/access-governance/sweep (access-governance W3):
 * admin gate, dry-run (select only), the real expire+revoke path, and the
 * access-request grant ledger resolved on the same schedule.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  getSession: vi.fn(),
}));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({ accessAssignmentsContainer: vi.fn(), auditLogContainer: vi.fn() }));
vi.mock('@/lib/azure/access-policy-client', () => ({ revokeAccessGrant: vi.fn(), revokeStructuredGrant: vi.fn() }));
vi.mock('@/lib/access/assignment-ledger', () => ({ expireAssignment: vi.fn() }));
vi.mock('@/lib/access/grant-intents', () => ({ reconcileStaleGrantIntents: vi.fn() }));
vi.mock('@/lib/access/sweep-auth', () => ({ isSweepSystemCaller: vi.fn() }));

import { POST } from '../sweep/route';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { accessAssignmentsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { revokeAccessGrant, revokeStructuredGrant } from '@/lib/azure/access-policy-client';
import { expireAssignment } from '@/lib/access/assignment-ledger';
import { reconcileStaleGrantIntents } from '@/lib/access/grant-intents';
import { isSweepSystemCaller } from '@/lib/access/sweep-auth';

const PAST = '2026-01-01T00:00:00.000Z';
const TALLY = { checked: 6, absent: 2, found: 1, landedLate: 1, stillAbsent: 1, unknown: 1 };
function req(qs = '') {
  return { nextUrl: new URL(`http://x/api/access-governance/sweep${qs}`), headers: { get: () => null } } as any;
}
function queryContainer(resources: any[]) {
  return { items: { query: () => ({ fetchAll: async () => ({ resources }) }), create: async () => ({}) } };
}

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'admin', upn: 'a@x', tid: 'tenant-7' } });
  (requireTenantAdmin as any).mockReturnValue(null);
  (isSweepSystemCaller as any).mockReturnValue(false);
  (auditLogContainer as any).mockResolvedValue(queryContainer([]));
  (expireAssignment as any).mockResolvedValue(true);
  (reconcileStaleGrantIntents as any).mockResolvedValue(TALLY);
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

describe('POST /api/access-governance/sweep — the access-request grant ledger', () => {
  it('the scheduled caller resolves stale grant records in every tenant and reports the counts', async () => {
    // The 15-minute loom-access-sweep job is the system caller. Breaks if the
    // sweep did not call the reconciler (no `grantRecords`, 0 calls), or
    // scoped the scheduled pass to one tenant (a tenantId argument).
    (isSweepSystemCaller as any).mockReturnValue(true);
    (accessAssignmentsContainer as any).mockResolvedValue(queryContainer([]));
    const j = await (await POST(req())).json();
    expect(j.ok).toBe(true);
    expect(reconcileStaleGrantIntents).toHaveBeenCalledTimes(1);
    expect((reconcileStaleGrantIntents as any).mock.calls[0][0]).not.toHaveProperty('tenantId');
    expect(j.grantRecords).toEqual(TALLY);
  });

  it("an admin's sweep resolves the admin's own tenant only", async () => {
    (accessAssignmentsContainer as any).mockResolvedValue(queryContainer([]));
    await POST(req());
    expect((reconcileStaleGrantIntents as any).mock.calls[0][0]).toMatchObject({ tenantId: 'tenant-7' });
  });

  it('a dry run resolves nothing', async () => {
    (accessAssignmentsContainer as any).mockResolvedValue(queryContainer([]));
    const j = await (await POST(req('?dryRun=1'))).json();
    expect(j.dryRun).toBe(true);
    expect(reconcileStaleGrantIntents).not.toHaveBeenCalled();
  });

  it('a grant-ledger failure is reported and does not fail the expiry pass', async () => {
    // Breaks if the reconciler's error escaped (500, nothing expired) or were
    // swallowed silently (no grantRecordsError).
    (accessAssignmentsContainer as any).mockResolvedValue(queryContainer([
      { id: 'a', principalId: 'p1', principalUpn: 'p1@x', resourceType: 'workspace', resourceRef: 'ws-1', state: 'active', expiresAt: PAST },
    ]));
    (reconcileStaleGrantIntents as any).mockRejectedValue(Object.assign(new Error('Cosmos internal-host-2'), { code: 503 }));
    const res = await POST(req());
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.expired).toBe(1);
    expect(j.grantRecords).toBeUndefined();
    expect(j.grantRecordsError).toBe('The access-request grant records could not be resolved (the store answered 503).');
  });
});
