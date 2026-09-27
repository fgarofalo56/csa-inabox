/**
 * #3706 — the recycle-bin authorization matrix, asserted THROUGH THE VERBS.
 *
 * ── What this file adds that the two existing ones do not ──────────────────
 *
 * `recycle-bin-tenancy.test.ts` pins the MECHANISM, but it imports
 * `loadRecycledItem` DIRECTLY — so it cannot see a change that leaves the
 * shared helper alone and widens one verb's own path.
 *
 * `recycle-crud.test.ts` pins BOTH VERBS, but only against a cross-tenant
 * workspace, and it is STRUCTURALLY incapable of witnessing a ladder-based
 * widening: it sets `process.env.LOOM_MULTIUSER_ACL = 'off'` (`:72`), and
 * `workspace-access.ts:101` reads exactly that env var to degrade the real
 * resolver to owner-only. So the interesting principal — one the canonical
 * ladder WOULD admit — cannot be represented there at all, mocked or not.
 *
 * (An earlier revision of this header predicted that file would instead red as
 * an unmocked-`workspaceRolesContainer` CRASH. That was MEASURED WRONG: run
 * against a restore-widened mutant it passes 9/9, because the resolver
 * short-circuits on the kill switch before ever reaching that container.)
 *
 * So the gap closed here is the CROSS PRODUCT the issue's acceptance asked for:
 * each role against BOTH verbs, with the ladder mocked to SAY YES.
 *
 * THE MUTATION THIS FILE EXISTS TO CATCH, and which neither file above catches:
 * split the loader — give `restoreOwnedItem` a ladder-backed loader and leave
 * `purgeRecycledItem` on the narrow one (or the reverse). That is the shape any
 * future "restore should be wider than purge" change would take. Measured
 * against a restore-widened mutant, counting the WHOLE FILE (10 runtime tests
 * = 5 restore arms + 5 purge arms): all 4 restore NEGATIVES go red — the 3
 * `describe.each` roles plus the third-tenant row — and all 5 purge arms stay
 * green, as does the creator's restore arm. The purge-widened mirror is
 * symmetric: 4 purge negatives red, 5 restore arms green. So it names WHICH
 * VERB moved instead of merely failing.
 *
 * ── What this file does NOT do ────────────────────────────────────────────
 *
 * It does not argue the current narrowness is right. That decision is recorded
 * at `item-crud.ts` (the `#3706 — THIS NARROWNESS IS THE CONTROL` block) and is
 * unchanged by this file. These tests make a future widening an explicit,
 * reviewed act rather than a quiet one — in EITHER direction.
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

/**
 * Which workspace doc each PARTITION resolves. Modelled faithfully: a Cosmos
 * point read outside your own partition finds NOTHING — it does not find
 * someone else's row. Default: only the creator's partition has the workspace.
 */
let wsByPartition: Record<string, any> = {};
/** Every `ws.item(id, pk)` performed, so a cross-partition rewrite is visible. */
const wsPointReads: Array<{ id: string; pk: string }> = [];
/** Every cross-partition query against the WORKSPACES container. */
const wsQueries: any[] = [];

/**
 * The canonical ladder's answer. Set per-arm to the role under test.
 *
 * On the current tree `loadRecycledItem` never calls this, so the mock is INERT
 * — it is not coverage, it is the harness that makes each negative arm a REAL
 * kill. It is paired with the `workspaceRolesContainer` stub below so that a
 * widening which DOES reach the ladder cannot die on a harness error: a
 * broken-harness red invites a later author to "repair" the mock, and the
 * widening then ships green. MEASURED, both directions: under the
 * restore-widened and purge-widened mutants the negative arms fail on the
 * VERDICT (`expected {…} to be null` / `expected true to be false`), never on a
 * module error — i.e. the widening is refused ON ITS MERITS.
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
      return { read: async () => ({ resource: wsByPartition[pk] }) };
    },
    items: {
      query: (spec: any) => { wsQueries.push(spec); return { fetchAll: async () => ({ resources: [] }) }; },
    },
  })),
  // Present so a future widening that reaches the ladder's direct-role lookup
  // does not throw — see `aclAccess` above.
  workspaceRolesContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
  tenantSettingsContainer: vi.fn(async () => ({ item: () => ({ read: vi.fn(async () => ({ resource: undefined })) }) })),
  auditLogContainer: vi.fn(async () => ({ items: { create: vi.fn(async () => ({})) } })),
  // Silences the webhook fan-out's "no export defined" stderr; the emitter is
  // best-effort and fires only on paths these arms must never reach anyway.
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
  wsQueries.length = 0;
  wsByPartition = { [CREATOR]: WORKSPACE };
  aclAccess = null;
  h.itemReplace.mockImplementation((_id: string, _pk: string, doc: any) => ({ resource: doc }));
});

/**
 * The ladder answers this file mocks, one per role the canonical
 * `authorizeWorkspace` ladder can return for a NON-creator.
 *
 * `Viewer` is DISCLOSED as dominated, not counted as extra coverage: under a
 * write-scoped widening it stays GREEN (a write-scoped ladder refuses a viewer
 * too), and under a read-scoped widening it reds — but so does `Member`. Its
 * kill set is therefore a SUBSET of `Member`'s under every widening shape
 * considered. It is here because the issue asked in those words ("a read-only
 * role must not purge") and because it states the intent for a reader, NOT
 * because it kills a mutant `Member` misses.
 */
const LADDER_SAYS_YES: Array<[string, any]> = [
  ['a shared-workspace Member with write', { workspace: WORKSPACE, role: 'Member', via: 'acl', canWrite: true }],
  ['a read-only Viewer', { workspace: WORKSPACE, role: 'Viewer', via: 'acl', canWrite: false }],
  ['a tenant admin opening a workspace they do not own', { workspace: WORKSPACE, role: 'Admin', via: 'admin', canWrite: true }],
];

describe('#3706 — recycle-bin role x verb matrix (restore and purge)', () => {
  describe('the workspace CREATOR — the positive pair every absence assertion below is paired with', () => {
    /**
     * FAILS IF the owner path stops working at all — e.g. the positive tenant
     * comparison is inverted, or the point read is given the wrong partition.
     * Without this arm, every `not.toHaveBeenCalled()` below would also be
     * satisfied by deleting the feature outright.
     */
    it('CAN restore', async () => {
      const out = await restoreOwnedItem(RECYCLED.id, CREATOR);

      expect(out).not.toBeNull();
      expect((out!.state as any)._recycled).toBeUndefined();
      expect(h.itemReplace).toHaveBeenCalledTimes(1);
      // THE POSITIVE PAIR for the negative arms' `unDeleteDirectory` absence
      // assertions. FAILS IF the ADLS un-delete is dropped from restore, or if
      // the fixture loses `adlsRefs` (which would silently make those absence
      // assertions unreachable again).
      expect(h.unDeleteDirectory).toHaveBeenCalledWith('bronze', 'notebooks/deleted-notebook', 'del-77');
      // THE MECHANISM: resolved by a point read in the CALLER's own partition,
      // never a cross-partition query. Swapping the read for a query — the
      // natural way to "fix" the fact that an admin is refused — fails here.
      expect(wsPointReads).toEqual([{ id: WS_ID, pk: CREATOR }]);
      // DISCLOSED as near-dominated (assertion-design §5): the query-swap mutant
      // is already caught by the `wsPointReads` equality one line up, which
      // throws first, and a FALLBACK query never fires on the owner-hit path.
      // Kept as a regression guard; the arm with real kill power for a
      // cross-partition fallback is the negative one below.
      expect(wsQueries).toHaveLength(0);
    });

    it('CAN purge', async () => {
      const ok = await purgeRecycledItem(RECYCLED.id, CREATOR);

      expect(ok).toBe(true);
      expect(h.itemDelete).toHaveBeenCalledWith(RECYCLED.id, WS_ID);
      expect(wsPointReads).toEqual([{ id: WS_ID, pk: CREATOR }]);
      expect(wsQueries).toHaveLength(0);
    });
  });

  /**
   * THE MATRIX. For each principal the canonical ladder would ADMIT but who did
   * NOT create the workspace, BOTH verbs must still refuse.
   *
   * Every arm FAILS IF `loadRecycledItem` — or a verb-specific loader
   * introduced beside it — is migrated to `resolveWorkspaceAccessByOid` /
   * `authorizeWorkspace`: the ladder is mocked to say YES, the caller's own
   * partition read misses, and the correct answer is still a refusal.
   *
   * Running it through the VERBS rather than the helper is the point: a change
   * that widens ONE verb reds only that verb's column, which no other spec in
   * this directory can see.
   */
  describe.each(LADDER_SAYS_YES)('%s — admitted by the ladder, refused by the bin', (_label, access) => {
    beforeEach(() => {
      // Not the creator: their partition holds no workspace row...
      wsByPartition = { [CREATOR]: WORKSPACE };
      // ...but the canonical ladder would admit them.
      aclAccess = access;
    });

    it('must NOT restore', async () => {
      const out = await restoreOwnedItem(RECYCLED.id, OTHER);

      expect(out).toBeNull();
      // The irreversible-adjacent effects must not fire either — a verdict-only
      // assertion would still pass if the write happened and the return value
      // were dropped. Each is REACHABLE: the creator arm above proves all three
      // DO fire on a successful restore, so a widening reds every one of them.
      expect(h.itemReplace).not.toHaveBeenCalled();
      expect(h.unDeleteDirectory).not.toHaveBeenCalled();
      expect(h.restoreThreadEdgesForItem).not.toHaveBeenCalled();
      // THE REALISTIC WIDENING SHAPE, and why this line is not decoration:
      // KEEP the point read and add a cross-partition QUERY as a FALLBACK —
      // which "fixes" the tenant-admin 404 without appearing to remove
      // anything. MEASURED against exactly that mutant: it reds the six
      // `describe.each` negative arms and nothing else, every one of them ON
      // THIS LINE (`expected [ { …(2) } ] to have a length of +0 but got 1`),
      // while `recycle-bin-tenancy.test.ts` stays 6/6 green. The verdict
      // assertions above CANNOT see it — the query mock yields no rows, so the
      // item is still refused and `toBeNull` still passes. This assertion is
      // dominated by nothing.
      expect(wsQueries).toHaveLength(0);
    });

    it('must NOT purge', async () => {
      const ok = await purgeRecycledItem(RECYCLED.id, OTHER);

      expect(ok).toBe(false);
      // THE ONE THAT MATTERS: purge hard-deletes the Cosmos document. If this
      // fires for a principal who did not create the workspace, the only copy
      // of someone else's item is gone.
      expect(h.itemDelete).not.toHaveBeenCalled();
      expect(h.deleteLoomDoc).not.toHaveBeenCalled();
      expect(h.reconcileThreadEdgesOnDelete).not.toHaveBeenCalled();
      expect(h.offboardFromPurview).not.toHaveBeenCalled();
      // Same cross-partition-query kill as the restore arm above.
      expect(wsQueries).toHaveLength(0);
    });
  });

  /**
   * A workspace row that DOES resolve in the caller's partition but carries
   * another tenant's id. FAILS IF the `resource.tenantId !== tenantId`
   * comparison is dropped, or rewritten into the short-circuiting
   * `caller && doc.tenantId && caller !== doc.tenantId` shape that lets a
   * claim-less doc through (cf. bfd67ed1).
   *
   * `recycle-crud.test.ts` covers this pair too; it is repeated here so the
   * matrix is complete in one place AND so it is measured with the ladder
   * mocked — there, the `LOOM_MULTIUSER_ACL='off'` kill switch (`:72`) means a
   * ladder-based widening cannot be witnessed at all: that file stays 9/9 green
   * under BOTH the restore-widened and purge-widened mutants (measured).
   */
  describe('a workspace row whose tenant does not POSITIVELY match the caller', () => {
    beforeEach(() => {
      wsByPartition = { [OTHER]: { id: WS_ID, tenantId: 'some-third-tenant' } };
      aclAccess = { workspace: WORKSPACE, role: 'Member', via: 'acl', canWrite: true };
    });

    it('must NOT restore', async () => {
      expect(await restoreOwnedItem(RECYCLED.id, OTHER)).toBeNull();
      expect(h.itemReplace).not.toHaveBeenCalled();
    });

    it('must NOT purge', async () => {
      expect(await purgeRecycledItem(RECYCLED.id, OTHER)).toBe(false);
      expect(h.itemDelete).not.toHaveBeenCalled();
    });
  });
});
