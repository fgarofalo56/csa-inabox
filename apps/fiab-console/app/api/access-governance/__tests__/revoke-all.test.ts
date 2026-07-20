/**
 * Contract test for the leaver revoke-all route (W4, AG-14). Cosmos + the real
 * revoke path stubbed; the pure selectRevocable filter runs real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({ accessAssignmentsContainer: vi.fn(), auditLogContainer: vi.fn() }));
vi.mock('@/lib/access/revoke-assignment', () => ({ revokeAssignment: vi.fn() }));

import { POST } from '../revoke-all/route';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { accessAssignmentsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { revokeAssignment } from '@/lib/access/revoke-assignment';

function queryContainer(resources: any[]) {
  return { items: { query: () => ({ fetchAll: async () => ({ resources }) }) } };
}
function req(qs = '', body?: any) { return { nextUrl: new URL(`http://x/api/access-governance/revoke-all${qs}`), json: async () => body } as any; }

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'admin', upn: 'admin@x' } });
  (requireTenantAdmin as any).mockReturnValue(null);
  (auditLogContainer as any).mockResolvedValue({ items: { create: async () => ({}) } });
  (revokeAssignment as any).mockResolvedValue({ id: 'x', revoked: true, warnings: [] });
});

it('403 for a non-admin', async () => {
  (requireTenantAdmin as any).mockReturnValue(NextResponse.json({ ok: false }, { status: 403 }));
  const res = await POST(req('', { principalId: 'p1' }));
  expect(res.status).toBe(403);
});

it('400 without principalId', async () => {
  const res = await POST(req('', {}));
  expect(res.status).toBe(400);
});

it('dry-run reports revocable candidates only (active + eligible)', async () => {
  (accessAssignmentsContainer as any).mockResolvedValue(queryContainer([
    { id: 'a1', principalId: 'p1', state: 'active', resourceType: 'workspace', resourceRef: 'ws-1', role: 'Viewer', source: 'direct' },
    { id: 'a2', principalId: 'p1', state: 'eligible', resourceType: 'item', resourceRef: 'it-1', role: 'Reader', source: 'direct' },
    { id: 'a3', principalId: 'p1', state: 'revoked', resourceType: 'item', resourceRef: 'it-2', role: 'Reader', source: 'direct' },
  ]));
  const res = await POST(req('?dryRun=1', { principalId: 'p1' }));
  const j = await res.json();
  expect(j.dryRun).toBe(true);
  expect(j.candidates).toBe(2);
});

it('revokes every active/eligible grant for the principal', async () => {
  (accessAssignmentsContainer as any).mockResolvedValue(queryContainer([
    { id: 'a1', principalId: 'p1', state: 'active', resourceType: 'workspace', resourceRef: 'ws-1', role: 'Viewer', source: 'direct' },
    { id: 'a2', principalId: 'p1', state: 'eligible', resourceType: 'item', resourceRef: 'it-1', role: 'Reader', source: 'direct' },
  ]));
  const res = await POST(req('', { principalId: 'p1' }));
  const j = await res.json();
  expect(j.ok).toBe(true);
  expect(j.revoked).toBe(2);
  expect(revokeAssignment).toHaveBeenCalledTimes(2);
});
