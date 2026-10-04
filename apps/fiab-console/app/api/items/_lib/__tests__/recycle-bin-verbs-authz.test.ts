/**
 * #4692 — the recycle-bin authorization matrix, asserted THROUGH THE VERBS.
 * Operator decision 2026-09-24 (Refs #3706): restore AND purge are now WIDENED
 * to the canonical ladder (Owner/Admin/Member + tenant admin).
 *
 * ── RETRACTED, not silently replaced ────────────────────────────────────────
 *
 * This file used to pin the OPPOSITE verdict for the exact same arms below —
 * "admitted by the ladder, refused by the bin" — because #3706 had decided
 * restore/purge stay owner-only. #4692 reversed that decision (see item-crud
 * .ts's retraction note at `loadRecycledItem`). The arms are NOT renamed
 * (same roles, same verbs) so a reviewer can diff this file against its
 * previous revision and see exactly which verdicts flipped and which did not.
 *
 * ── What this file still adds that the other two do not ────────────────────
 *
 * `recycle-bin-tenancy.test.ts` pins `loadRecycledItem`'s OWN delegation
 * (right args, gates on `canWrite`) with the ladder mocked directly, but it
 * imports the helper DIRECTLY — so it cannot see a change that leaves the
 * shared helper alone and widens (or narrows) one verb's own path.
 *
 * `recycle-crud.test.ts` pins BOTH VERBS against an owned vs. cross-tenant
 * workspace with `LOOM_MULTIUSER_ACL=off`, so it never represents the
 * interesting principal (one the ladder, not bare ownership, admits).
 *
 * So the matrix this file owns is the CROSS PRODUCT: each role against BOTH
 * verbs, with the ladder mocked to answer per-arm, so a change that widens
 * (or narrows) ONE verb without the other reds only that verb's column.
 *
 * THE MUTATION THIS FILE EXISTS TO CATCH: split the loader — give
 * `restoreOwnedItem` a ladder-backed loader while leaving `purgeRecycledItem`
 * on a DIFFERENT (narrower or wider) one, or the reverse. That is the shape
 * any future "restore and purge should differ" change would take; today both
 * route through the one shared `loadRecycledItem`, so every arm below moves
 * together.
 *
 * The third-tenant-mismatch arm the pre-#4692 revision carried here is
 * RETIRED, not quietly dropped: `loadRecycledItem` no longer performs its own
 * partition read + tenant comparison (that mechanism is gone — see
 * item-crud.ts), so a fixture encoding it can no longer witness anything from
 * THIS mocked harness. The tid boundary itself is the ladder's own concern,
 * covered by `lib/auth/__tests__/workspace-access-tid-boundary.test.ts`; this
 * file's remaining job is "does loadRecycledItem obey whatever the ladder
 * says", which `recycle-bin-tenancy.test.ts` now covers directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** The workspace's creator. In this codebase the workspace partition key IS the creator oid. */
const CREATOR = 'oid-creator';
/** A caller who did NOT create the workspace — every negative arm below is this principal. */
const OTHER = 'oid-other';
const WS_ID = 'ws-1';

const WORKSPACE = { id: WS_ID, tenantId: CREATOR };

/**
 * `adlsRefs` is NOT decoration. `restoreOwnedItem` gates its `unDeleteDirectory`
 * call on `if (recycled?.adlsRefs?.length)` (`item-crud.ts:1163`), so WITHOUT
 * this entry every `expect(h.unDeleteDirectory).not.toHaveBeenCalled()` below
 * would be unreachable — true even in the arms where restore fully SUCCEEDS,
 * i.e. an assertion no input could break. With it, the creator arm asserts the
 * call POSITIVELY and the negative arms' absence assertions acquire real kill
 * power. (Caught in review; the shape follows `recycle-crud.test.ts:133`/`:145`.)
 */
const RECYCLED = {
  id: 'item-1',
  workspaceId: WS_ID,
  itemType: 'notebook',
  displayName: 'Deleted notebook',
  state: {
    _recycled: {
      deletedAt: '2026-01-01T00:00:00.000Z',
      deletedBy: 'creator@x',
      purgeAfter: '2026-02-01T00:00:00.000Z',
      adlsRefs: [{ container: 'bronze', path: 'notebooks/deleted-notebook', deletionId: 'del-77' }],
    },
  },
};

const h = vi.hoisted(() => ({
  itemReplace: vi.fn(),
  itemDelete: vi.fn(),
  unDeleteDirectory: vi.fn(),
  deleteLoomDoc: vi.fn(),
  upsertLoomDoc: vi.fn(),
  deleteGovernanceItem: vi.fn(),
  reconcileThreadEdgesOnDelete: vi.fn(),
  restoreThreadEdgesForItem: vi.fn(),
  offboardFromPurview: vi.fn(),
}));

/** Every `ws.item(id, pk)` performed — kept only so a future regression that
 *  re-adds an inline point read to `loadRecycledItem` is visible; nothing in
 *  this file's current assertions reads from it. */
const wsPointReads: Array<{ id: string; pk: string }> = [];

/**
 * The canonical ladder's answer. Set per-arm to the role under test.
 *
 * #4692 — THIS IS NOW THE DECIDING MOCK, not an inert harness. `loadRecycledItem`
 * delegates fully to `resolveWorkspaceAccessByOid` (mocked here) and gates on
 * `access.canWrite` — see `recycle-bin-tenancy.test.ts` for the delegation
 * mechanism itself. `workspaceRolesContainer` stays stubbed below so a future
 * widening that reaches the REAL resolver's direct-role lookup (e.g. if this
 * mock is ever removed) does not throw.
 */
let aclAccess: any = null;

vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: vi.fn(async () => aclAccess),
  ambientAccessOptsFor: vi.fn(async () => ({})),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [RECYCLED] }) }) },
    item: (id: string, pk: string) => ({
      read: async () => ({ resource: RECYCLED }),
      replace: (doc: any) => h.itemReplace(id, pk, doc),
      delete: () => h.itemDelete(id, pk),
    }),
  })),
  workspacesContainer: vi.fn(async () => ({
    item: (id: string, pk: string) => {
      wsPointReads.push({ id, pk });
      return { read: async () => ({ resource: undefined }) };
    },
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
  // Present so a future widening that reaches the ladder's direct-role lookup
  // does not throw — see `aclAccess` above.
  workspaceRolesContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
  tenantSettingsContainer: vi.fn(async () => ({ item: () => ({ read: vi.fn(async () => ({ resource: undefined })) }) })),
  auditLogContainer: vi.fn(async () => ({ items: { create: vi.fn(async () => ({})) } })),
  // #4692 — purge now emits `item.purged` on every ADMITTED arm, so this is no
  // longer an unreached path: it silences the webhook fan-out's internal fetch
  // of subscribed hooks (returns none, so delivery never fires either).
  webhookSubscriptionsContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
}));

vi.mock('@/lib/azure/loom-search', () => ({
  upsertLoomDoc: h.upsertLoomDoc, deleteLoomDoc: h.deleteLoomDoc, docForItem: vi.fn(() => ({ id: 'it:x' })),
}));
vi.mock('@/lib/azure/loom-data-products-search', () => ({
  upsertDataProductDoc: vi.fn(), deleteDataProductDoc: vi.fn(), docForDataProduct: vi.fn(() => ({})),
}));
vi.mock('@/lib/azure/governance-catalog-index', () => ({
  upsertGovernanceItem: vi.fn(), deleteGovernanceItem: h.deleteGovernanceItem,
  docForGovernanceItem: vi.fn(() => ({})), isCatalogDataType: vi.fn(() => false),
}));
vi.mock('@/lib/azure/purview-autoonboard', () => ({
  autoOnboardToPurview: vi.fn(), offboardFromPurview: h.offboardFromPurview,
}));
vi.mock('@/lib/azure/adls-client', () => ({
  softDeleteDirectory: vi.fn(), unDeleteDirectory: h.unDeleteDirectory,
}));
vi.mock('@/lib/thread/thread-edges', () => ({
  reconcileThreadEdgesOnDelete: h.reconcileThreadEdgesOnDelete,
  restoreThreadEdgesForItem: h.restoreThreadEdgesForItem,
}));

import { restoreOwnedItem, purgeRecycledItem } from '../item-crud';

beforeEach(() => {
  Object.values(h).forEach((fn) => fn.mockReset());
  wsPointReads.length = 0;
  aclAccess = null;
  h.itemReplace.mockImplementation((_id: string, _pk: string, doc: any) => ({ resource: doc }));
});

/**
 * The ladder answers this file mocks, one per role relevant to the matrix,
 * paired with the oid the verb is called with (the mock ignores it, but it
 * keeps each row's label honest about who is acting).
 *
 * #4692 flips three of these four verdicts from the pre-decision revision:
 * Member and the tenant admin now ADMIT (previously refused); Viewer is
 * UNCHANGED (refused before and after — a write-scoped gate never admitted a
 * read-only role, so this is the one row whose kill direction did not move).
 */
const WRITE_CAPABLE: Array<[string, any, string]> = [
  ['the workspace CREATOR (ladder: Owner)', { workspace: WORKSPACE, role: 'Owner', via: 'owner', canWrite: true }, CREATOR],
  ['a shared-workspace Member with write', { workspace: WORKSPACE, role: 'Member', via: 'acl', canWrite: true }, OTHER],
  ['a tenant admin opening a workspace they do not own', { workspace: WORKSPACE, role: 'Admin', via: 'admin', canWrite: true }, OTHER],
];
const READ_ONLY: Array<[string, any, string]> = [
  ['a read-only Viewer', { workspace: WORKSPACE, role: 'Viewer', via: 'acl', canWrite: false }, OTHER],
];

describe('#4692 — recycle-bin role x verb matrix (restore and purge)', () => {
  describe.each(WRITE_CAPABLE)('%s — write-capable, CAN restore AND purge', (_label, access, oid) => {
    beforeEach(() => { aclAccess = access; });

    /**
     * FAILS IF the write-scoped gate stops admitting a write-capable ladder
     * verdict at all (e.g. `access.canWrite` inverted, or the ladder's result
     * ignored outright) — every row in this table would then also refuse.
     */
    it('CAN restore', async () => {
      const out = await restoreOwnedItem(RECYCLED.id, oid);

      expect(out).not.toBeNull();
      expect((out!.state as any)._recycled).toBeUndefined();
      expect(h.itemReplace).toHaveBeenCalledTimes(1);
      // THE POSITIVE PAIR for the READ_ONLY arm's absence assertions below.
      // FAILS IF the ADLS un-delete is dropped from restore, or if the fixture
      // loses `adlsRefs` (which would silently make those absence assertions
      // unreachable again).
      expect(h.unDeleteDirectory).toHaveBeenCalledWith('bronze', 'notebooks/deleted-notebook', 'del-77');
      expect(h.restoreThreadEdgesForItem).toHaveBeenCalledWith(oid, RECYCLED.id);
    });

    it('CAN purge', async () => {
      const ok = await purgeRecycledItem(RECYCLED.id, oid);

      expect(ok).toBe(true);
      expect(h.itemDelete).toHaveBeenCalledWith(RECYCLED.id, WS_ID);
      expect(h.deleteLoomDoc).toHaveBeenCalledWith(`it:${RECYCLED.id}`);
      expect(h.reconcileThreadEdgesOnDelete).toHaveBeenCalledWith(oid, RECYCLED.id, { mode: 'remove' });
    });
  });

  /**
   * THE ONE ROLE WHOSE VERDICT DID NOT FLIP. A read-only Viewer is admitted by
   * the ladder (`access` is non-null) but carries `canWrite:false`, and both
   * verbs are mutations. FAILS IF the gate is loosened from `!access.canWrite`
   * to bare `!access` (truthiness) — a Viewer grant is truthy, so that mutant
   * admits it here while every WRITE_CAPABLE arm above stays green, naming
   * exactly which check broke.
   */
  describe.each(READ_ONLY)('%s — read-only, refused by the write-scoped gate', (_label, access, oid) => {
    beforeEach(() => { aclAccess = access; });

    it('must NOT restore', async () => {
      const out = await restoreOwnedItem(RECYCLED.id, oid);

      expect(out).toBeNull();
      // The irreversible-adjacent effects must not fire either — a verdict-only
      // assertion would still pass if the write happened and the return value
      // were dropped. Each is REACHABLE: the WRITE_CAPABLE arms above prove all
      // three DO fire on a successful restore.
      expect(h.itemReplace).not.toHaveBeenCalled();
      expect(h.unDeleteDirectory).not.toHaveBeenCalled();
      expect(h.restoreThreadEdgesForItem).not.toHaveBeenCalled();
    });

    it('must NOT purge', async () => {
      const ok = await purgeRecycledItem(RECYCLED.id, oid);

      expect(ok).toBe(false);
      // THE ONE THAT MATTERS: purge hard-deletes the Cosmos document. If this
      // fires for a principal the ladder only grants READ to, the only copy of
      // someone else's item is gone with no write role behind it.
      expect(h.itemDelete).not.toHaveBeenCalled();
      expect(h.deleteLoomDoc).not.toHaveBeenCalled();
      expect(h.reconcileThreadEdgesOnDelete).not.toHaveBeenCalled();
      expect(h.offboardFromPurview).not.toHaveBeenCalled();
    });
  });

  it('refuses outright when the ladder itself refuses (null)', async () => {
    // FAILS IF a falsy/null ladder verdict is read as "no opinion, proceed"
    // instead of a refusal — the opposite of a least-privilege default.
    aclAccess = null;

    expect(await restoreOwnedItem(RECYCLED.id, OTHER)).toBeNull();
    expect(await purgeRecycledItem(RECYCLED.id, OTHER)).toBe(false);
  });
});

