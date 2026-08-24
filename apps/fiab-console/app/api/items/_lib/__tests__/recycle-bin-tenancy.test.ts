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
  auditLogContainer: vi.fn(async () => ({ items: { create: vi.fn(async () => ({})) } })),
}));

import { loadRecycledItem } from '../item-crud';

const CALLER = 'tenant-A';

beforeEach(() => {
  wsPointReads.length = 0;
  wsQueries.length = 0;
  wsDoc = null;
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
    // The wrong shape is `caller && doc.tid && caller !== doc.tid`, which lets a
    // claim-less session through by short-circuit (cf. bfd67ed1). This asserts
    // the match is required, not merely un-contradicted.
    wsDoc = { id: RECYCLED.workspaceId, tenantId: 'tenant-B' };

    expect(await loadRecycledItem(RECYCLED.id, CALLER)).toBeNull();
  });

  it('refuses when the workspace carries NO tenantId at all', async () => {
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
});
