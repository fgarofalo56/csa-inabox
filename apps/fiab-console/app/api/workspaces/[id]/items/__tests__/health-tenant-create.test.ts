/**
 * POST /api/workspaces/[id]/items must thread the session into autoBindOnCreate so a
 * health-tenant binds AT CREATE for a granted caller (#5177 item 1, #5161).
 * Real auto-bind runs; only the Cosmos container, workspace ACL, the D12 gate and the
 * provisioner are faked, so the assertion reaches the session check inside the arm.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ensure = vi.fn();
const created: any[] = [];
vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({ items: { create: async (i: any) => { created.push(i); return { resource: i }; } } }),
}));
vi.mock('@/lib/azure/loom-search', () => ({ upsertLoomDoc: vi.fn(), docForItem: vi.fn() }));
vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: async () => ({ canWrite: true, workspace: { id: 'ws-1' } }),
}));
vi.mock('@/lib/auth/feature-gate', () => ({ isTenantAdmin: () => false }));
vi.mock('@/app/api/health/tenants/_lib/tenant-admin-gate', () => ({ enforceHealthTenantAdmin: vi.fn() }));
vi.mock('@/lib/install/provisioners/health-tenant', () => ({
  ensureHealthTenant: (...a: unknown[]) => ensure(...a),
  realDeps: () => ({}),
}));

import { getSession } from '@/lib/auth/session';
import { enforceHealthTenantAdmin } from '@/app/api/health/tenants/_lib/tenant-admin-gate';
import { POST } from '../route';

const SESSION: any = { claims: { oid: 'user-1', upn: 'u@x' } };
const call = (itemType: string) =>
  POST(
    new Request('http://x/api/workspaces/ws-1/items', {
      method: 'POST',
      body: JSON.stringify({ itemType, displayName: 'Mercy General' }),
    }) as any,
    { params: Promise.resolve({ id: 'ws-1' }) },
  );

beforeEach(() => {
  ensure.mockReset();
  ensure.mockResolvedValue({ phase: 'provisioning' });
  created.length = 0;
  vi.mocked(getSession).mockReturnValue(SESSION);
  vi.mocked(enforceHealthTenantAdmin).mockReset();
  vi.mocked(enforceHealthTenantAdmin).mockResolvedValue(null); // null = allowed
});

describe('workspace items POST: health-tenant create-time bind', () => {
  it('binds at create for a granted caller: ONE ensureHealthTenant, name verbatim', async () => {
    const res = await call('health-tenant');
    expect(res.status).toBeLessThan(300);
    // Breaks (0 calls) if the session is not threaded: the arm returns early on a missing session.
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure.mock.calls[0][0]).toMatchObject({ displayName: 'Mercy General', itemId: created[0].id });
    expect(enforceHealthTenantAdmin).toHaveBeenCalledWith(SESSION, 'Contributor');
  });

  it('a caller without the capability creates the item but binds nothing (pairs with the case above)', async () => {
    vi.mocked(enforceHealthTenantAdmin).mockResolvedValue({ status: 403 } as any);
    const res = await call('health-tenant');
    expect(res.status).toBeLessThan(300);
    expect(created).toHaveLength(1); // item still created
    expect(ensure).not.toHaveBeenCalled();
  });
});
