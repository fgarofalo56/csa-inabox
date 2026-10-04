/**
 * #4692 — `loadRecycledItem` DELEGATES to the canonical authorization ladder
 * (operator decision 2026-09-24, Refs #3706).
 *
 * ── RETRACTED, not silently replaced ────────────────────────────────────────
 *
 * This file used to be titled "loadRecycledItem is owner-scoped, and must stay
 * that way" and pinned an INLINE partition point read + `resource.tenantId !==
 * tenantId` comparison that lived directly in `loadRecycledItem`. That
 * mechanism is GONE: the function now calls `resolveWorkspaceAccessByOid` (the
 * same delegation `loadOwnedItem` uses, item-crud.ts:595) and gates on
 * `access.canWrite`. The decision that mechanism enforced — restore/purge stay
 * owner-only because purge is irreversible — was REVERSED by #4692: see
 * item-crud.ts's retraction note at `loadRecycledItem`'s docblock.
 *
 * WHAT THIS FILE NOW PINS, and does NOT re-prove: the tid boundary / owner /
 * ACL / admin-open resolution LOGIC lives in `resolveWorkspaceAccessByOid`
 * itself and is independently covered by
 * `lib/auth/__tests__/workspace-access-tid-boundary.test.ts` and
 * `workspace-access-admin-tid.test.ts`. Re-deriving that here (as the old file
 * did, with its own partition-fixture mock) would duplicate coverage AND would
 * now be dead weight — the ladder is mocked below, so a fixture encoding the
 * resolver's internal tenant comparison can no longer witness anything (that
 * logic simply isn't reached from this file). What IS this file's own surface:
 * does `loadRecycledItem` call the ladder with the RIGHT ARGUMENTS, and does
 * it gate on `canWrite` (not merely truthiness)? That is new code this PR
 * wrote, and it has no other test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const RECYCLED = {
  id: 'item-1',
  workspaceId: 'ws-owned-by-A',
  itemType: 'notebook',
  displayName: 'n',
  state: { _recycled: { deletedAt: 'x', deletedBy: 'a@x', purgeAfter: 'y' } },
};

/** The ladder's answer, set per-test. */
let aclAccess: any = null;
const resolveWorkspaceAccessByOid = vi.fn(async () => aclAccess);
/** The row `itemsContainer().items.query(...).fetchAll()` returns, set per-test. */
let recycledFixture: any = RECYCLED;

vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: (...args: any[]) => resolveWorkspaceAccessByOid(...args),
  ambientAccessOptsFor: vi.fn(async () => ({})),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [recycledFixture] }) }) },
  })),
  // loadRecycledItem no longer reads `workspaces` directly — the delegation IS
  // the thing under test — but `accessOptsFor`'s ambient fallback dynamically
  // imports `@/lib/auth/session`, so nothing here touches this container.
  workspacesContainer: vi.fn(async () => ({
    item: () => ({ read: async () => ({ resource: undefined }) }),
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
}));

import { loadRecycledItem } from '../item-crud';

const CALLER = 'tenant-A';

beforeEach(() => {
  aclAccess = null;
  recycledFixture = RECYCLED;
  resolveWorkspaceAccessByOid.mockClear();
});

describe('#4692 — loadRecycledItem delegates to the canonical ladder', () => {
  it('passes the CALLER oid and the ITEM\'s own workspaceId to the ladder', async () => {
    aclAccess = { role: 'Owner', via: 'owner', canWrite: true };

    await loadRecycledItem(RECYCLED.id, CALLER);

    // FAILS IF either argument is transposed or hard-codes the wrong id — the
    // ladder would then decide the WRONG workspace's or WRONG caller's access.
    expect(resolveWorkspaceAccessByOid).toHaveBeenCalledWith(
      CALLER,
      RECYCLED.workspaceId,
      expect.anything(),
    );
  });

  it('admits when the ladder returns a write-capable role', async () => {
    aclAccess = { role: 'Member', via: 'acl', canWrite: true };

    expect(await loadRecycledItem(RECYCLED.id, CALLER)).toEqual(RECYCLED);
  });

  it('refuses when the ladder returns a role with canWrite:false', async () => {
    // FAILS IF the gate is loosened from `!access.canWrite` to a bare
    // `!access` (i.e. truthiness) — a read-only Viewer grant is TRUTHY, so a
    // bare-truthiness gate would wrongly admit it here.
    aclAccess = { role: 'Viewer', via: 'acl', canWrite: false };

    expect(await loadRecycledItem(RECYCLED.id, CALLER)).toBeNull();
  });

  it('refuses when the ladder refuses outright (null)', async () => {
    aclAccess = null;

    expect(await loadRecycledItem(RECYCLED.id, CALLER)).toBeNull();
  });

  it('refuses an empty caller tenant WITHOUT consulting the ladder', async () => {
    // A caller-supplied scope must never become an existence oracle: refuse
    // before any resolution, so nothing about the id is learnable.
    aclAccess = { role: 'Owner', via: 'owner', canWrite: true }; // would admit if reached

    expect(await loadRecycledItem(RECYCLED.id, '')).toBeNull();
    expect(resolveWorkspaceAccessByOid).not.toHaveBeenCalled();
  });

  it('refuses an item with no workspaceId WITHOUT consulting the ladder', async () => {
    aclAccess = { role: 'Owner', via: 'owner', canWrite: true }; // would admit if reached
    recycledFixture = { ...RECYCLED, workspaceId: undefined };

    expect(await loadRecycledItem(RECYCLED.id, CALLER)).toBeNull();
    expect(resolveWorkspaceAccessByOid).not.toHaveBeenCalled();
  });
});
