/**
 * #2703 — the item helpers must ACTUALLY enforce the cross-tenant tid boundary.
 *
 * These run the REAL `resolveWorkspaceAccessByOid` (only Cosmos and the session
 * cookie are mocked), because the defect was not in the resolver — it was that
 * `loadOwnedItem` / `listOwnedItems` / `listAllOwnedItems` called it with no
 * options at all, which switched its step-4 tenant boundary off. Mocking the
 * resolver here would test the mock and reproduce exactly the blind spot the
 * issue is about.
 *
 * `listAllOwnedItems` is the sharpest case: it took NO session parameter, so it
 * could never enforce the boundary — and it backs the Copilot `item_list` tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const CALLER_OID = 'oid-caller';
const OWNER_OID = 'oid-owner';
const WS_ID = 'ws-theirs';
const WS_TENANT = 'tenant-A';
const FOREIGN_TENANT = 'tenant-B';

const WS_DOC = { id: WS_ID, tenantId: OWNER_OID, tid: WS_TENANT, name: 'Theirs' };
const ITEM = { id: 'i-1', itemType: 'lakehouse', workspaceId: WS_ID, displayName: 'Lake' };

const getSession = vi.fn();
const resolveEffectiveRole = vi.fn();
const itemsFetchAll = vi.fn();
const wsPointRead = vi.fn();
const wsQueryFetchAll = vi.fn();

vi.mock('@/lib/auth/session', () => ({ getSession: (...a: any[]) => getSession(...a) }));
vi.mock('@/lib/azure/workspace-roles-client', () => ({
  resolveEffectiveRole: (...a: any[]) => resolveEffectiveRole(...a),
}));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({ items: { query: () => ({ fetchAll: itemsFetchAll }) } }),
  workspacesContainer: async () => ({
    item: (...a: any[]) => ({ read: async () => wsPointRead(...a) }),
    items: { query: () => ({ fetchAll: async () => ({ resources: await wsQueryFetchAll() }) }) },
  }),
  workspaceRolesContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  }),
  tenantSettingsContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
}));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeWorkspace: vi.fn() }));
vi.mock('@/lib/auth/workspace-list-access', () => ({ authorizeWorkspaceList: vi.fn(async () => null) }));
vi.mock('@/lib/azure/loom-search', () => ({ upsertLoomDoc: vi.fn(), deleteLoomDoc: vi.fn(), docForItem: vi.fn() }));
vi.mock('@/lib/azure/loom-data-products-search', () => ({
  upsertDataProductDoc: vi.fn(), deleteDataProductDoc: vi.fn(), docForDataProduct: vi.fn(),
}));
vi.mock('@/lib/azure/governance-catalog-index', () => ({
  upsertGovernanceItem: vi.fn(), deleteGovernanceItem: vi.fn(),
  docForGovernanceItem: vi.fn(), isCatalogDataType: vi.fn(() => false),
}));
vi.mock('@/lib/azure/purview-autoonboard', () => ({
  autoOnboardToPurview: vi.fn(), offboardFromPurview: vi.fn(),
}));
vi.mock('@/lib/thread/thread-edges', () => ({
  reconcileThreadEdgesOnDelete: vi.fn(), restoreThreadEdgesForItem: vi.fn(),
}));
vi.mock('@/lib/versions/item-version-store', () => ({ recordItemVersion: vi.fn() }));
vi.mock('@/lib/events/webhook-emitter', () => ({ emitLoomEvent: vi.fn() }));

import { loadOwnedItem, listOwnedItems, listAllOwnedItems } from '../item-crud';

beforeEach(() => {
  vi.clearAllMocks();
  itemsFetchAll.mockResolvedValue({ resources: [ITEM] });
  wsPointRead.mockResolvedValue({ resource: undefined }); // caller is not the owner
  wsQueryFetchAll.mockResolvedValue([WS_DOC]);
  resolveEffectiveRole.mockResolvedValue('Member'); // an ACL grant exists
});

describe('item-crud helpers apply the cross-tenant tid boundary (#2703)', () => {
  describe('caller is signed in to a DIFFERENT Entra tenant than the workspace', () => {
    beforeEach(() => {
      getSession.mockReturnValue({ claims: { oid: CALLER_OID, tid: FOREIGN_TENANT } });
    });

    it('loadOwnedItem returns null', async () => {
      expect(await loadOwnedItem('i-1', 'lakehouse', CALLER_OID)).toBeNull();
    });

    it('listOwnedItems (no workspaceId — the per-row filter path) returns nothing', async () => {
      expect(await listOwnedItems('lakehouse', CALLER_OID)).toEqual([]);
    });

    it('listAllOwnedItems — the Copilot item_list path — returns nothing', async () => {
      expect(await listAllOwnedItems(CALLER_OID)).toEqual([]);
    });

    it('listAllOwnedItems scoped to that workspace also returns nothing', async () => {
      expect(await listAllOwnedItems(CALLER_OID, WS_ID)).toEqual([]);
    });
  });

  describe('caller is signed in to the SAME tenant (the shared-workspace case that must keep working)', () => {
    beforeEach(() => {
      getSession.mockReturnValue({ claims: { oid: CALLER_OID, tid: WS_TENANT } });
    });

    it('loadOwnedItem still resolves the shared item', async () => {
      expect(await loadOwnedItem('i-1', 'lakehouse', CALLER_OID)).toMatchObject({ id: 'i-1' });
    });

    it('listAllOwnedItems still lists it', async () => {
      expect((await listAllOwnedItems(CALLER_OID)).map((i) => i.id)).toEqual(['i-1']);
    });
  });

  it('listAllOwnedItems accepts a session and authorizes the scoped workspace through the list chokepoint', async () => {
    const { authorizeWorkspaceList } = await import('@/lib/auth/workspace-list-access');
    getSession.mockReturnValue({ claims: { oid: CALLER_OID, tid: WS_TENANT } });
    const session = { claims: { oid: CALLER_OID, tid: WS_TENANT }, exp: 0 } as any;
    const out = await listAllOwnedItems(CALLER_OID, WS_ID, { session });
    // The mocked chokepoint denies → no scan, no rows.
    expect(authorizeWorkspaceList).toHaveBeenCalledWith(session, WS_ID);
    expect(out).toEqual([]);
    expect(itemsFetchAll).not.toHaveBeenCalled();
  });

  /**
   * CodeQL js/user-controlled-bypass flags the `if (workspaceId)` fast path in
   * `listAllOwnedItems` — a caller-supplied value selecting which authorization
   * path runs — exactly as it flags the sibling in `listOwnedItems` (#625, the
   * alert #2703 opens by dismissing). It is a PERFORMANCE branch: both arms
   * authorize, and dropping either input is not an escape. That equivalence has
   * to be a pinned property, not a property of today's source.
   */
  describe('the workspaceId / session inputs select a path, they do not gate one', () => {
    beforeEach(() => {
      getSession.mockReturnValue({ claims: { oid: CALLER_OID, tid: FOREIGN_TENANT } });
    });

    it('a forbidden workspace stays forbidden with a session, without one, and unscoped', async () => {
      const session = { claims: { oid: CALLER_OID, tid: FOREIGN_TENANT }, exp: 0 } as any;
      expect(await listAllOwnedItems(CALLER_OID, WS_ID, { session })).toEqual([]);
      expect(await listAllOwnedItems(CALLER_OID, WS_ID)).toEqual([]);
      expect(await listAllOwnedItems(CALLER_OID)).toEqual([]);
    });

    it('the session-less scoped path authorizes BEFORE the query, like the session path', async () => {
      await listAllOwnedItems(CALLER_OID, WS_ID);
      expect(itemsFetchAll).not.toHaveBeenCalled();
    });
  });
});
