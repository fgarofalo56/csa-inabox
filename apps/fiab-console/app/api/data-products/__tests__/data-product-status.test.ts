/**
 * Backend contract tests for
 *   POST /api/data-products/[id]/status   (F6 lifecycle: Publish/Draft/Expire)
 *
 * Guards the no-vaporware invariant: Publish is REALLY gated server-side on the
 * three Purview preconditions (>=1 asset, an active Access policy, a set
 * governance domain) and returns 422 with the PRECISE precondition reason —
 * never a fake 200. Cosmos is the authoritative status store; there is NO
 * Microsoft Fabric / Power BI dependency.
 *
 * session, item-crud, cosmos-client, and purview-client are all mocked so this
 * is a pure backend contract spec (the repo's DOM render tests are pre-existing
 * red on a node vitest env issue).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/app/api/items/_lib/item-crud', async () => {
  const { NextResponse } = await import('next/server');
  return {
    loadOwnedItem: vi.fn(),
    updateOwnedItem: vi.fn(),
    jerr: (error: string, status = 500, code?: string) =>
      NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status }),
  };
});
vi.mock('@/lib/azure/cosmos-client', () => ({ tenantSettingsContainer: vi.fn() }));
vi.mock('@/lib/azure/purview-client', () => {
  // Fully stubbed (no importActual) so the real purview-client + its Azure SDK
  // chain never loads in CI — the route only needs these three symbols.
  class PurviewNotConfiguredError extends Error {}
  class PurviewError extends Error { status = 500; }
  return { updateDataProductStatus: vi.fn(), PurviewNotConfiguredError, PurviewError };
});

import { POST } from '../[id]/status/route';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '@/app/api/items/_lib/item-crud';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import { updateDataProductStatus } from '@/lib/azure/purview-client';

const DOMAIN = '4e74f902-62f5-49f4-8258-92ed2b8537ba';

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}
function req(body: any) {
  return { json: async () => body } as any;
}
function item(state: Record<string, unknown>) {
  return { id: 'dp-1', workspaceId: 'ws-1', itemType: 'data-product', displayName: 'Sales 360', state } as any;
}
/** Stub the tenant-settings policies doc read. */
function stubPolicies(items: any[], code?: number) {
  (tenantSettingsContainer as any).mockResolvedValue({
    item: () => ({
      read: async () => {
        if (code === 404) { const e: any = new Error('not found'); e.code = 404; throw e; }
        return { resource: { id: 'policies:u', tenantId: 'u', kind: 'policies', items } };
      },
    }),
  });
}

beforeEach(() => { vi.resetAllMocks(); });

describe('POST /api/data-products/[id]/status', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(req({ status: 'PUBLISHED' }), ctx('dp-1'));
    expect(res.status).toBe(401);
  });

  it('400 on an invalid status value', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const res = await POST(req({ status: 'ARCHIVED' }), ctx('dp-1'));
    expect(res.status).toBe(400);
  });

  it('404 when the item is not owned/found', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (loadOwnedItem as any).mockResolvedValue(null);
    const res = await POST(req({ status: 'DRAFT' }), ctx('dp-1'));
    expect(res.status).toBe(404);
  });

  it('422 no_assets when publishing with no datasets — the exact reason', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (loadOwnedItem as any).mockResolvedValue(item({ domain: DOMAIN }));
    const res = await POST(req({ status: 'PUBLISHED' }), ctx('dp-1'));
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.preconditionFailed.reason).toBe('no_assets');
    expect(j.preconditionFailed.field).toBe('state.datasets');
    expect(updateOwnedItem).not.toHaveBeenCalled();
  });

  it('422 no_active_policy when assets exist but no active Access policy', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (loadOwnedItem as any).mockResolvedValue(item({ domain: DOMAIN, datasets: [{ name: 'sales' }] }));
    stubPolicies([]); // none
    const res = await POST(req({ status: 'PUBLISHED' }), ctx('dp-1'));
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.preconditionFailed.reason).toBe('no_active_policy');
    expect(updateOwnedItem).not.toHaveBeenCalled();
  });

  it('422 no_active_policy when a policy exists but is scoped to a different product / disabled', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (loadOwnedItem as any).mockResolvedValue(item({ domain: DOMAIN, datasets: [{ name: 'sales' }] }));
    stubPolicies([
      { kind: 'Access', scope: 'data-product:OTHER', enabled: true },
      { kind: 'Access', scope: 'data-product:dp-1', enabled: false },
    ]);
    const res = await POST(req({ status: 'PUBLISHED' }), ctx('dp-1'));
    expect(res.status).toBe(422);
    expect((await res.json()).preconditionFailed.reason).toBe('no_active_policy');
  });

  it('422 domain_not_published when assets + policy exist but domain is empty', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (loadOwnedItem as any).mockResolvedValue(item({ datasets: [{ name: 'sales' }] }));
    stubPolicies([{ kind: 'Access', scope: 'data-product:dp-1', enabled: true }]);
    const res = await POST(req({ status: 'PUBLISHED' }), ctx('dp-1'));
    expect(res.status).toBe(422);
    expect((await res.json()).preconditionFailed.reason).toBe('domain_not_published');
  });

  it('200 PUBLISHED when all three preconditions pass; writes lifecycleStatus to Cosmos', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const loaded = item({ domain: DOMAIN, datasets: [{ name: 'sales' }] });
    (loadOwnedItem as any).mockResolvedValue(loaded);
    stubPolicies([{ kind: 'Access', scope: 'data-product:dp-1', enabled: true }]);
    (updateOwnedItem as any).mockImplementation(async (_i: string, _t: string, _o: string, patch: any) => ({ ...loaded, state: patch.state }));
    const res = await POST(req({ status: 'PUBLISHED' }), ctx('dp-1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.lifecycleStatus).toBe('PUBLISHED');
    expect(j.lifecycleStatusAt).toBeTruthy();
    const persisted = (updateOwnedItem as any).mock.calls[0][3];
    expect(persisted.state.lifecycleStatus).toBe('PUBLISHED');
  });

  it('200 EXPIRED with no precondition checks (unpublish path)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const loaded = item({ datasets: [], lifecycleStatus: 'PUBLISHED' });
    (loadOwnedItem as any).mockResolvedValue(loaded);
    (updateOwnedItem as any).mockImplementation(async (_i: string, _t: string, _o: string, patch: any) => ({ ...loaded, state: patch.state }));
    const res = await POST(req({ status: 'EXPIRED' }), ctx('dp-1'));
    expect(res.status).toBe(200);
    expect((await res.json()).lifecycleStatus).toBe('EXPIRED');
    // No policy lookup needed for a non-publish transition.
    expect(tenantSettingsContainer).not.toHaveBeenCalled();
    const persisted = (updateOwnedItem as any).mock.calls[0][3];
    expect(persisted.state.lifecycleStatus).toBe('EXPIRED');
  });

  it('200 DRAFT (set-to-draft) returns lifecycleStatus DRAFT', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const loaded = item({ lifecycleStatus: 'PUBLISHED' });
    (loadOwnedItem as any).mockResolvedValue(loaded);
    (updateOwnedItem as any).mockImplementation(async (_i: string, _t: string, _o: string, patch: any) => ({ ...loaded, state: patch.state }));
    const res = await POST(req({ status: 'DRAFT' }), ctx('dp-1'));
    expect(res.status).toBe(200);
    expect((await res.json()).lifecycleStatus).toBe('DRAFT');
  });

  it('publish with a purviewDataProductId is best-effort: gate does not block the Cosmos write', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const loaded = item({ domain: DOMAIN, datasets: [{ name: 'sales' }], purviewDataProductId: 'pv-9' });
    (loadOwnedItem as any).mockResolvedValue(loaded);
    stubPolicies([{ kind: 'Access', scope: 'data-product:dp-1', enabled: true }]);
    (updateDataProductStatus as any).mockRejectedValue(Object.assign(new Error('gate'), {}));
    (updateOwnedItem as any).mockImplementation(async (_i: string, _t: string, _o: string, patch: any) => ({ ...loaded, state: patch.state }));
    const res = await POST(req({ status: 'PUBLISHED' }), ctx('dp-1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.purviewSync).toBe(false);
    expect(j.purviewSyncNote).toBeTruthy();
    expect(updateDataProductStatus).toHaveBeenCalledWith('pv-9', 'PUBLISHED');
  });

  it('500 (not a fake 200) when the Cosmos write fails', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (loadOwnedItem as any).mockResolvedValue(item({ lifecycleStatus: 'PUBLISHED' }));
    (updateOwnedItem as any).mockResolvedValue(null);
    const res = await POST(req({ status: 'DRAFT' }), ctx('dp-1'));
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });
});
