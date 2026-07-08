/**
 * BFF route tests for POST/GET /api/admin/lineage/reconcile (LIN-GC-2).
 *
 * The route diffs Loom-provisioned Purview entities against live Cosmos items
 * and reports (dry-run, the default) or purges (dryRun:false) the orphans. It
 * is tenant-admin gated. lineage-gc is mocked so the tests focus on the route's
 * auth + dry-run/purge contract, not the Purview/Cosmos plumbing (covered in
 * lib/azure/__tests__/lineage-gc.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSessionMock = vi.fn();
const isTenantAdminMock = vi.fn(() => true);
const findLineageOrphansMock = vi.fn();
const purgeLineageOrphansMock = vi.fn();

vi.mock('@/lib/auth/session', () => ({ getSession: (...a: any[]) => getSessionMock(...a) }));
vi.mock('@/lib/auth/feature-gate', async () => {
  const { NextResponse } = await import('next/server');
  return {
    isTenantAdmin: (...a: any[]) => isTenantAdminMock(...a),
    requireTenantAdmin: (session: any) =>
      !session
        ? NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 })
        : isTenantAdminMock(session)
          ? null
          : NextResponse.json({ ok: false, error: 'forbidden', code: 'admin_only' }, { status: 403 }),
  };
});
vi.mock('@/lib/azure/purview-client', () => ({ isPurviewConfigured: () => true }));
vi.mock('@/lib/azure/lineage-gc', () => ({
  findLineageOrphans: (...a: any[]) => findLineageOrphansMock(...a),
  purgeLineageOrphans: (...a: any[]) => purgeLineageOrphansMock(...a),
}));

import { GET, POST } from '../route';

function post(body?: any) {
  return { json: async () => (body ?? {}) } as any;
}

const ORPHANS = [
  { qualifiedName: 'loom://t/w/dataset/i2', typeName: 'DataSet', tenantId: 't', workspaceId: 'w', itemType: 'dataset', itemId: 'i2' },
];

beforeEach(() => {
  getSessionMock.mockReset();
  isTenantAdminMock.mockReset().mockReturnValue(true);
  findLineageOrphansMock.mockReset().mockResolvedValue({ purviewConfigured: true, scanned: 5, orphans: ORPHANS });
  purgeLineageOrphansMock.mockReset().mockResolvedValue([{ qualifiedName: 'loom://t/w/dataset/i2', itemId: 'i2', result: 'deleted' }]);
  getSessionMock.mockReturnValue({ claims: { oid: 'admin-1' } });
});

describe('POST /api/admin/lineage/reconcile', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null);
    const res = await POST(post({ dryRun: true }));
    expect(res.status).toBe(401);
    expect(findLineageOrphansMock).not.toHaveBeenCalled();
  });

  it('403 when the caller is not a tenant admin', async () => {
    isTenantAdminMock.mockReturnValue(false);
    const res = await POST(post({ dryRun: true }));
    expect(res.status).toBe(403);
    expect(findLineageOrphansMock).not.toHaveBeenCalled();
  });

  it('dry-run (default) reports orphans without purging', async () => {
    const res = await POST(post({})); // no dryRun → defaults to true
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.dryRun).toBe(true);
    expect(j.scanned).toBe(5);
    expect(j.orphans).toHaveLength(1);
    expect(purgeLineageOrphansMock).not.toHaveBeenCalled();
  });

  it('dryRun:false purges the orphans', async () => {
    const res = await POST(post({ dryRun: false }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.dryRun).toBe(false);
    expect(purgeLineageOrphansMock).toHaveBeenCalledWith(ORPHANS);
    expect(j.purged).toEqual([{ qualifiedName: 'loom://t/w/dataset/i2', itemId: 'i2', result: 'deleted' }]);
  });
});

describe('GET /api/admin/lineage/reconcile', () => {
  it('returns the admin + purview probe for a signed-in caller', async () => {
    const res = await GET();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.isAdmin).toBe(true);
    expect(j.purviewConfigured).toBe(true);
  });

  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });
});
