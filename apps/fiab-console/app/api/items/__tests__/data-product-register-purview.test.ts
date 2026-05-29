/**
 * Backend contract tests for
 *   POST /api/items/data-product/[id]/register-purview
 *
 * Root cause being guarded against: a "fake 200" — the route returning
 * `{ ok: true }` while having silently skipped the real Purview POST because a
 * prerequisite (businessDomainId / Purview account) was missing. Per
 * .claude/rules/no-vaporware.md the route MUST:
 *   - return a structured NON-200 gate when prerequisites are missing
 *   - return 200 with a real dataProductId ONLY when registerDataProduct
 *     actually succeeded AND the id was persisted to Cosmos.
 *
 * The repo's DOM render tests are pre-existing-red on a node vitest env issue,
 * so this is a pure backend contract spec (session + item-crud + purview-client
 * all mocked).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/purview-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/purview-client');
  return { ...actual, registerDataProduct: vi.fn() };
});
vi.mock('../_lib/item-crud', () => ({
  loadOwnedItem: vi.fn(),
  updateOwnedItem: vi.fn(),
}));

import { POST } from '../data-product/[id]/register-purview/route';
import { getSession } from '@/lib/auth/session';
import {
  registerDataProduct,
  PurviewNotConfiguredError,
  PurviewError,
} from '@/lib/azure/purview-client';
import { loadOwnedItem, updateOwnedItem } from '../_lib/item-crud';

const VALID_DOMAIN = '4e74f902-62f5-49f4-8258-92ed2b8537ba';

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function item(state: Record<string, unknown>) {
  return {
    id: 'dp-1',
    workspaceId: 'ws-1',
    itemType: 'data-product',
    displayName: 'Sales 360',
    state,
  } as any;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('POST /api/items/data-product/[id]/register-purview', () => {
  it('returns 401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST({} as any, ctx('dp-1'));
    expect(res.status).toBe(401);
  });

  it('returns 404 when the item is not owned/found', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (loadOwnedItem as any).mockResolvedValue(null);
    const res = await POST({} as any, ctx('dp-1'));
    expect(res.status).toBe(404);
  });

  it('returns a NON-200 gate (422) when state.domain is missing — never a fake 200', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    // Live-confirmed shape: a data-product can have empty state.
    (loadOwnedItem as any).mockResolvedValue(item({}));
    const res = await POST({} as any, ctx('dp-1'));
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.field).toBe('state.domain');
    // The real Purview call must NOT have been made.
    expect(registerDataProduct).not.toHaveBeenCalled();
  });

  it('returns 422 when state.domain is a free-text label, not a GUID', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (loadOwnedItem as any).mockResolvedValue(item({ displayName: 'Sales 360', domain: 'Finance' }));
    const res = await POST({} as any, ctx('dp-1'));
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.received).toBe('Finance');
    expect(registerDataProduct).not.toHaveBeenCalled();
  });

  it('returns 501 + hint when Purview is not provisioned', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (loadOwnedItem as any).mockResolvedValue(item({ displayName: 'Sales 360', domain: VALID_DOMAIN }));
    (registerDataProduct as any).mockRejectedValue(new PurviewNotConfiguredError({
      missingEnvVar: 'LOOM_PURVIEW_ACCOUNT',
      bicepModule: 'platform/fiab/bicep/modules/purview/',
      bicepStatus: 'not deployed',
      rolesRequired: [{ name: 'Data Product Owner', scope: 'domain', reason: 'create' }],
      followUp: 'set env + grant roles',
    }));
    const res = await POST({} as any, ctx('dp-1'));
    expect(res.status).toBe(501);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('purview_not_configured');
    expect(j.hint.missingEnvVar).toBe('LOOM_PURVIEW_ACCOUNT');
  });

  it('propagates an upstream Purview 403 (RBAC denial) as a non-200 — not a fake success', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (loadOwnedItem as any).mockResolvedValue(item({ displayName: 'Sales 360', domain: VALID_DOMAIN }));
    (registerDataProduct as any).mockRejectedValue(new PurviewError(403, { error: { message: 'Forbidden' } }, 'Forbidden'));
    const res = await POST({} as any, ctx('dp-1'));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('purview_error');
  });

  it('happy path: real POST succeeds → 200 with dataProductId + persists it to Cosmos', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const loaded = item({ displayName: 'Sales 360', domain: VALID_DOMAIN, owner: 'a@b.com' });
    (loadOwnedItem as any).mockResolvedValue(loaded);
    (registerDataProduct as any).mockResolvedValue({ id: 'pv-9999', name: 'Sales 360', status: 'DRAFT' });
    (updateOwnedItem as any).mockImplementation(async (_id: string, _t: string, _o: string, patch: any) => ({
      ...loaded,
      state: patch.state,
    }));

    const res = await POST({} as any, ctx('dp-1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.purviewDataProductId).toBe('pv-9999');
    expect(j.lastRegisteredAt).toBeTruthy();
    // The real Purview create was invoked with the GUID domain.
    expect(registerDataProduct).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Sales 360', domain: VALID_DOMAIN }),
    );
    // The returned id was persisted so the editor gate clears on refetch.
    const persisted = (updateOwnedItem as any).mock.calls[0][3];
    expect(persisted.state.purviewDataProductId).toBe('pv-9999');
  });

  it('re-register passes the existing id through so the same product is updated', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const loaded = item({ displayName: 'Sales 360', domain: VALID_DOMAIN, purviewDataProductId: 'pv-existing' });
    (loadOwnedItem as any).mockResolvedValue(loaded);
    (registerDataProduct as any).mockResolvedValue({ id: 'pv-existing', name: 'Sales 360' });
    (updateOwnedItem as any).mockResolvedValue({ ...loaded });

    const res = await POST({} as any, ctx('dp-1'));
    expect(res.status).toBe(200);
    expect(registerDataProduct).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pv-existing' }),
    );
  });

  it('returns 500 (not a fake 200) when Purview succeeds but the Cosmos write fails', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (loadOwnedItem as any).mockResolvedValue(item({ displayName: 'Sales 360', domain: VALID_DOMAIN }));
    (registerDataProduct as any).mockResolvedValue({ id: 'pv-9999' });
    (updateOwnedItem as any).mockResolvedValue(null);

    const res = await POST({} as any, ctx('dp-1'));
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('cosmos_write_failed');
    expect(j.purviewDataProductId).toBe('pv-9999');
  });
});
