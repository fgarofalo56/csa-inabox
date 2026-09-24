/**
 * #3706 — the recycle-bin tenancy constraint, pinned so a later WIDENING is a
 * deliberate act rather than a quiet one.
 *
 * `loadRecycledItem` gates restore/purge on a POINT READ in the CALLER's own
 * workspace partition — "did you CREATE this workspace", not "may you write in
 * it". That is narrower than the canonical `authorizeWorkspace` ladder, and it
 * looks exactly like the #2947 defect (an `assertOwner` inlined under another
 * name, which 404'd legitimate members). It is not the same, because
 * `purgeRecycledItem` HARD-DELETES the Cosmos document. Over-restrictive is the
 * safe direction here.
 *
 * The issue is latent — nothing is broken today. These tests exist so that the
 * eventual "fix" for the apparent asymmetry fails the suite instead of silently
 * handing every shared-workspace collaborator an irreversible purge.
 *
 * They therefore assert the MECHANISM (a caller-partitioned point read, a
 * POSITIVE tenant match) rather than only the verdict — a verdict-only test
 * would still pass if the read were widened to a cross-partition query that
 * happened to return the same row in a single-tenant fixture.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const RECYCLED = {
  id: 'item-1',
  workspaceId: 'ws-owned-by-A',
  itemType: 'notebook',
  displayName: 'n',
  state: { _recycled: { deletedAt: 'x', deletedBy: 'a@x', purgeAfter: 'y' } },
};

/** Every `ws.item(id, partitionKey)` the code under test performs. */
const wsPointReads: Array<{ id: string; pk: string }> = [];
/** Every cross-partition query against the WORKSPACES container. */
const wsQueries: any[] = [];
/** What the workspace point read should resolve to, per test. */
let wsDoc: any = null;

/**
 * The ACL ladder's answer, if the code under test ever asks it.
 *
 * Today `loadRecycledItem` never calls `resolveWorkspaceAccessByOid`, so this
 * mock is INERT on the current tree — it is not coverage, it is the harness the
 * "shared-workspace member" test below needs in order to be a REAL kill rather
 * than an incidental one. Without it, migrating `loadRecycledItem` to the
 * canonical ladder makes tests fail on an unmocked `workspaceRolesContainer` —
 * a broken-harness red that a future author would "fix" by completing the mock,
 * at which point the widening ships green. Completing it up front means the
 * widening is refused on its merits.
 */
let aclAccess: any = null;

vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: vi.fn(async () => aclAccess),
  ambientAccessOptsFor: vi.fn(async () => ({})),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [RECYCLED] }) }) },
    item: () => ({ read: async () => ({ resource: RECYCLED }), delete: async () => ({}) }),
  })),
  workspacesContainer: vi.fn(async () => ({
    item: (id: string, pk: string) => {
      wsPointReads.push({ id, pk });
      return { read: async () => ({ resource: wsDoc }) };
    },
    items: {
      query: (spec: any) => { wsQueries.push(spec); return { fetchAll: async () => ({ resources: [] }) }; },
    },
  })),
  // Present so the canonical ladder's direct-role lookup does not throw if a
  // future widening reaches it — see `aclAccess` above.
  workspaceRolesContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
  auditLogContainer: vi.fn(async () => ({ items: { create: vi.fn(async () => ({})) } })),
}));

import { loadRecycledItem } from '../item-crud';

const CALLER = 'tenant-A';

beforeEach(() => {
  wsPointReads.length = 0;
  wsQueries.length = 0;
  wsDoc = null;
  aclAccess = null;
  vi.clearAllMocks();
});

describe('#3706 — loadRecycledItem is owner-scoped, and must stay that way', () => {
  it('reads the workspace in the CALLER\'s partition, not cross-partition', async () => {
    wsDoc = { id: RECYCLED.workspaceId, tenantId: CALLER };

    const got = await loadRecycledItem(RECYCLED.id, CALLER);

    expect(got).not.toBeNull();
    // THE MECHANISM: exactly one point read, partitioned by the CALLER.
    // Swapping this for a cross-partition query — the natural way to "fix" the
    // fact that a tenant admin is refused — makes this fail.
    expect(wsPointReads).toEqual([{ id: RECYCLED.workspaceId, pk: CALLER }]);
    expect(wsQueries).toHaveLength(0);
  });

  it('refuses when the workspace tenant does not POSITIVELY match the caller', async () => {
    // FAILS IF the `resource.tenantId !== tenantId` comparison is dropped: the
    // point read resolves a workspace owned by tenant-B and the item comes back.
    wsDoc = { id: RECYCLED.workspaceId, tenantId: 'tenant-B' };

    expect(await loadRecycledItem(RECYCLED.id, CALLER)).toBeNull();
  });

  it('refuses when the workspace carries NO tenantId at all', async () => {
    // THIS is the arm the short-circuit shape breaks: the wrong form
    // `caller && doc.tenantId && caller !== doc.tenantId` lets a claim-less
    // workspace doc through because the middle operand is falsy (cf. bfd67ed1).
    // It asserts the match is REQUIRED, not merely un-contradicted — the
    // previous test cannot distinguish the two shapes, this one can.
    wsDoc = { id: RECYCLED.workspaceId };

    expect(await loadRecycledItem(RECYCLED.id, CALLER)).toBeNull();
  });

  it('refuses when the workspace is not in the caller\'s partition', async () => {
    wsDoc = null; // Cosmos point read outside your partition resolves to nothing.

    expect(await loadRecycledItem(RECYCLED.id, CALLER)).toBeNull();
  });

  it('refuses an empty caller tenant WITHOUT querying Cosmos for the workspace', async () => {
    // A caller-supplied scope must never become an existence oracle: refuse
    // before the read, so nothing about the id is learnable.
    wsDoc = { id: RECYCLED.workspaceId, tenantId: CALLER };

    expect(await loadRecycledItem(RECYCLED.id, '')).toBeNull();
    expect(wsPointReads).toHaveLength(0);
  });

  /**
   * THE WIDENING THIS FILE EXISTS TO STOP, asserted on its merits.
   *
   * The caller is NOT the workspace creator (their partition read misses), but
   * the canonical ladder WOULD grant them write access — i.e. a member the
   * workspace was deliberately shared with. `loadRecycledItem` must still
   * refuse, because the verbs behind it include an unrecoverable purge.
   *
   * FAILS IF someone copies the sibling at `item-crud.ts:595`
   * (`resolveWorkspaceAccessByOid(...)` + `if (!access) return null`) into
   * `loadRecycledItem`: that mutation needs no signature change, and the four
   * tests above cannot see it — the owner fast path keeps the point-read
   * mechanism intact, so test 1 still passes. This one goes red because the
   * ladder is mocked to SAY YES and the correct answer is still null.
   */
  it('refuses a shared-workspace member the canonical ladder would admit', async () => {
    wsDoc = null; // not the creator — the caller-partitioned point read misses
    aclAccess = { role: 'Member', canWrite: true }; // ...but the ladder says yes

    expect(await loadRecycledItem(RECYCLED.id, CALLER)).toBeNull();
  });
});
