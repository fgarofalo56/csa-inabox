/**
 * Backend contract tests for POST /api/data-products/[id]/certify (DP-5).
 *
 * Guards the no-vaporware certification gates: (1) a reviewer who IS the creator
 * is refused (403), (2) certifying with a failing automated check is refused
 * (422 with the precise blockers), (3) a distinct reviewer with all checks
 * green records the sign-off. session, item-crud, cosmos-client, and the search
 * index are mocked so this is a pure backend contract spec.
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
vi.mock('@/lib/azure/cosmos-client', () => ({
  tenantSettingsContainer: vi.fn(),
  auditLogContainer: vi.fn(async () => ({ items: { create: vi.fn(async () => ({})) } })),
  itemsContainer: vi.fn(),
}));
vi.mock('@/lib/azure/loom-data-products-search', () => ({
  upsertDataProductDoc: vi.fn(async () => {}),
  docForDataProduct: vi.fn(() => ({})),
}));

import { POST } from '../[id]/certify/route';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '@/app/api/items/_lib/item-crud';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';

function ctx(id: string) { return { params: Promise.resolve({ id }) }; }
function req(body: any) { return { json: async () => body } as any; }

/** A fully-certifiable item (all automated checks pass) created by 'creator'. */
function fullItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dp-1', workspaceId: 'ws-1', itemType: 'data-product', createdBy: 'creator',
    displayName: 'Sales 360', description: 'x'.repeat(60),
    state: {
      owners: [{ id: 'o1' }], useCase: 'y'.repeat(40), glossaryLinks: [{ name: 'g' }],
      datasets: [{ name: 'sales' }], contract: { schema: [{ name: 'c' }], slo: { freshness: '1d' } },
      accessPolicy: { tier: 'a' }, sampleData: { rows: 5 },
      ...overrides,
    },
  } as any;
}
/** Stub tenant DQ rules so the DQ check passes (all rules enabled → score 100). */
function stubDqPass() {
  (tenantSettingsContainer as any).mockResolvedValue({
    item: () => ({ read: async () => ({ resource: { items: [{ enabled: true }, { enabled: true }] } }) }),
  });
}

beforeEach(() => { vi.resetAllMocks(); });

describe('POST /api/data-products/[id]/certify', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(req({ action: 'certify' }), ctx('dp-1'));
    expect(res.status).toBe(401);
  });

  it('400 on an unknown action', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'r' } });
    const res = await POST(req({ action: 'bogus' }), ctx('dp-1'));
    expect(res.status).toBe(400);
  });

  it('403 when the reviewer IS the creator', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'creator' } });
    (loadOwnedItem as any).mockResolvedValue(fullItem());
    stubDqPass();
    const res = await POST(req({ action: 'certify' }), ctx('dp-1'));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('reviewer_is_creator');
    expect(updateOwnedItem).not.toHaveBeenCalled();
  });

  it('422 with precise blockers when an automated check fails', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'reviewer' } });
    // No datasets → the assets check fails.
    (loadOwnedItem as any).mockResolvedValue(fullItem({ datasets: [] }));
    stubDqPass();
    const res = await POST(req({ action: 'certify' }), ctx('dp-1'));
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.code).toBe('checks_failed');
    expect(j.blockers.some((b: any) => b.id === 'assets')).toBe(true);
    expect(updateOwnedItem).not.toHaveBeenCalled();
  });

  it('200 records the sign-off when a distinct reviewer certifies an all-green product', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'reviewer', upn: 'rev@contoso.com' } });
    const item = fullItem();
    (loadOwnedItem as any).mockResolvedValue(item);
    stubDqPass();
    (updateOwnedItem as any).mockImplementation(async (_i: string, _t: string, _o: string, patch: any) => ({ ...item, state: patch.state }));
    const res = await POST(req({ action: 'certify' }), ctx('dp-1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.certification.state).toBe('certified');
    expect(j.certification.certifiedBy.oid).toBe('reviewer');
    const persisted = (updateOwnedItem as any).mock.calls[0][3].state;
    expect(persisted.certificationState).toBe('certified');
    expect(persisted.certification.certifiedAt).toBeTruthy();
  });

  it('promote sets the lightweight endorsed signal (any owner, no reviewer gate)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'creator' } });
    const item = fullItem();
    (loadOwnedItem as any).mockResolvedValue(item);
    (updateOwnedItem as any).mockImplementation(async (_i: string, _t: string, _o: string, patch: any) => ({ ...item, state: patch.state }));
    const res = await POST(req({ action: 'promote' }), ctx('dp-1'));
    expect(res.status).toBe(200);
    expect((await res.json()).endorsed).toBe(true);
    expect((updateOwnedItem as any).mock.calls[0][3].state.endorsed).toBe(true);
  });
});
