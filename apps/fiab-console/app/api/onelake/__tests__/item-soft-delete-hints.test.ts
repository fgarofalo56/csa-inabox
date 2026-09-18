/**
 * Input-validation contract for `DELETE /api/onelake/[itemId]` — the ADLS
 * folder set a soft-delete is allowed to touch.
 *
 * WHAT THIS PINS. The route accepts an optional `adlsHints: [{container,path}]`
 * array in the request body. It used to forward that array to
 * `softDeleteOwnedItem` verbatim, so the folders soft-deleted were whatever the
 * body named. They are now resolved against `deriveAdlsHints(itemId)` — the
 * folders the item's own OneLake security roles cover — and a body entry that is
 * not a member of that derived set is dropped.
 *
 * WHAT IS DELIBERATELY *NOT* MOCKED. `softDeleteOwnedItem` runs FOR REAL, so
 * these assertions read the mechanism (`softDeleteDirectory` call arguments) and
 * not merely the JSON the route returns. A route that resolved the set correctly
 * in its response while still forwarding the body array would pass a
 * response-only assertion and fail these. Only Cosmos, the OneLake roles store,
 * the ADLS client and item-crud's best-effort side indexes are stubbed.
 *
 * Every assertion below names the value that makes it fail in a comment at the
 * site; the two directions are paired — a legitimate delete must still reach
 * ADLS, or "nothing was deleted" would be satisfied by deleting the feature.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  itemsQuery: vi.fn(),
  itemReplace: vi.fn(),
  wsRead: vi.fn(),
  listRoles: vi.fn(),
  softDeleteDirectory: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ getSession: h.getSession }));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    items: { query: (spec: any) => ({ fetchAll: () => h.itemsQuery(spec) }) },
    item: (id: string, pk: string) => ({
      replace: (doc: any) => h.itemReplace(id, pk, doc),
      delete: vi.fn(),
    }),
  })),
  workspacesContainer: vi.fn(async () => ({
    item: (id: string, pk: string) => ({ read: () => h.wsRead(id, pk) }),
  })),
  tenantSettingsContainer: vi.fn(async () => ({ item: () => ({ read: vi.fn() }) })),
  // item-crud emits an item.deleted lifecycle event; the fan-out reads this.
  webhookSubscriptionsContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
}));

// The derived set's source of truth — the item's own OneLake security roles.
vi.mock('@/lib/azure/onelake-security-client', () => ({ listRoles: h.listRoles }));

// The mechanism under test: item-crud dynamically imports this.
vi.mock('@/lib/azure/adls-client', () => ({
  softDeleteDirectory: h.softDeleteDirectory,
  unDeleteDirectory: vi.fn(),
}));

// item-crud's best-effort side indexes — stubbed so the spec doesn't pull @azure/*.
vi.mock('@/lib/azure/loom-search', () => ({
  upsertLoomDoc: vi.fn(), deleteLoomDoc: vi.fn(), docForItem: vi.fn(() => ({ id: 'it:x' })),
}));
vi.mock('@/lib/azure/loom-data-products-search', () => ({
  upsertDataProductDoc: vi.fn(), deleteDataProductDoc: vi.fn(), docForDataProduct: vi.fn(() => ({})),
}));
vi.mock('@/lib/azure/governance-catalog-index', () => ({
  upsertGovernanceItem: vi.fn(), deleteGovernanceItem: vi.fn(),
  docForGovernanceItem: vi.fn(() => ({})), isCatalogDataType: vi.fn(() => false),
}));
vi.mock('@/lib/azure/purview-autoonboard', () => ({
  autoOnboardToPurview: vi.fn(), offboardFromPurview: vi.fn(),
}));
vi.mock('@/lib/thread/thread-edges', () => ({
  reconcileThreadEdgesOnDelete: vi.fn(), restoreThreadEdgesForItem: vi.fn(),
}));

import { DELETE } from '../[itemId]/route';

const TENANT = 'tenant-1';
const ITEM_ID = 'item-1';

const activeItem = {
  id: ITEM_ID, workspaceId: 'ws-1', itemType: 'lakehouse',
  displayName: 'Sales LH', state: {},
  createdBy: 'u', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

/** The item's OWN folders, as its OneLake security roles describe them. */
const ownRoles = [
  { container: 'bronze', paths: ['/lakehouses/sales-lh'] },
  { container: 'silver', paths: ['Tables/orders_refined'] },
];

function delReq(body: unknown) {
  return { json: async () => body } as any;
}

async function callDelete(body: unknown) {
  const res = await DELETE(delReq(body), { params: Promise.resolve({ itemId: ITEM_ID }) } as any);
  return { res, json: await res.json() };
}

beforeEach(() => {
  Object.values(h).forEach((fn) => fn.mockReset());
  // Owner-path CRUD: the #1601 multi-user ACL read path does a cross-partition
  // lookup this suite doesn't mock (same reason recycle-crud.test.ts flips it).
  process.env.LOOM_MULTIUSER_ACL = 'off';
  h.getSession.mockReturnValue({ claims: { oid: TENANT, upn: 'alice@contoso.com' } });
  h.itemsQuery.mockResolvedValue({ resources: [activeItem] });
  h.wsRead.mockResolvedValue({ resource: { tenantId: TENANT } });
  h.itemReplace.mockImplementation((_id: string, _pk: string, doc: any) => ({ resource: doc }));
  h.listRoles.mockResolvedValue(ownRoles);
  h.softDeleteDirectory.mockResolvedValue({ deletionId: 'del-1' });
});

describe('DELETE /api/onelake/[itemId] — ADLS folder resolution', () => {
  // POSITIVE (paired with the drop cases below): with no hints in the body —
  // the shape the OneLake page actually sends — the item's whole derived set is
  // soft-deleted. FAILS IF: resolveAdlsHints returns [] for a missing/empty
  // `adlsHints`, i.e. if the derived path were dropped along with the body one.
  it('soft-deletes the item derived folder set when the body carries no hints', async () => {
    const { json } = await callDelete({ itemType: 'lakehouse' });
    expect(json.ok).toBe(true);
    expect(h.softDeleteDirectory.mock.calls).toEqual([
      ['bronze', 'lakehouses/sales-lh'],
      ['silver', 'Tables/orders_refined'],
    ]);
    expect(json.recycled.adlsSoftDeleted).toBe(2);
  });

  // NEGATIVE — the behaviour this change adds. `gold`/`lakehouses/other-lh` is
  // not in `ownRoles`, so it is dropped and ADLS is never asked to touch it.
  // FAILS IF the route forwards `body.adlsHints` (the previous
  // `body.adlsHints.filter((h) => h?.container && h?.path)`): the call list
  // becomes [['gold','lakehouses/other-lh']] and adlsSoftDeleted becomes 1.
  it('drops a hint that is outside the item derived set', async () => {
    const { json } = await callDelete({
      itemType: 'lakehouse',
      adlsHints: [{ container: 'gold', path: 'lakehouses/other-lh' }],
    });
    // The item still recycles — the Cosmos stamp is the source of truth.
    expect(json.ok).toBe(true);
    expect(json.item.id).toBe(ITEM_ID);
    // Row set, not a count: nothing at all reached the ADLS client.
    expect(h.softDeleteDirectory.mock.calls).toEqual([]);
    expect(json.recycled.adlsSoftDeleted).toBe(0);
  });

  // NEGATIVE + POSITIVE in one request: a member and a non-member together.
  // FAILS IF the drop is all-or-nothing in either direction — forwarding both
  // gives a 2-row call list containing 'gold'; discarding the whole array on any
  // foreign entry gives [].
  it('keeps the member and drops the non-member when both are supplied', async () => {
    const { json } = await callDelete({
      itemType: 'lakehouse',
      adlsHints: [
        { container: 'gold', path: 'lakehouses/other-lh' },
        { container: 'bronze', path: 'lakehouses/sales-lh' },
      ],
    });
    expect(json.ok).toBe(true);
    expect(h.softDeleteDirectory.mock.calls).toEqual([['bronze', 'lakehouses/sales-lh']]);
    expect(json.recycled.adlsSoftDeleted).toBe(1);
  });

  // POSITIVE — narrowing works, and the DERIVED spelling is what goes forward.
  // The body spells the silver folder '/Tables/orders_refined/'; the derived
  // pair is 'Tables/orders_refined'. FAILS IF normPath is not applied on the
  // supplied side (the silver row is dropped and the list is []), or if the
  // caller's raw string is emitted instead of the derived one (the recorded
  // argument is '/Tables/orders_refined/'), or if narrowing is ignored (bronze
  // appears too).
  it('narrows to the supplied member and forwards the derived path spelling', async () => {
    const { json } = await callDelete({
      itemType: 'lakehouse',
      adlsHints: [{ container: 'silver', path: '/Tables/orders_refined/' }],
    });
    expect(json.ok).toBe(true);
    expect(h.softDeleteDirectory.mock.calls).toEqual([['silver', 'Tables/orders_refined']]);
    expect(json.recycled.adlsSoftDeleted).toBe(1);
  });

  // NEGATIVE — a container-root hint. deriveAdlsHints never emits an empty path
  // (it skips '*' and ''), so no root hint can ever be a member of the derived
  // set. FAILS IF the supplied array is forwarded: softDeleteDirectory is called
  // with ('bronze','/') and a whole medallion container is the target.
  it('drops a container-root hint', async () => {
    const { json } = await callDelete({
      itemType: 'lakehouse',
      adlsHints: [{ container: 'bronze', path: '/' }],
    });
    expect(json.ok).toBe(true);
    expect(h.softDeleteDirectory.mock.calls).toEqual([]);
    expect(json.recycled.adlsSoftDeleted).toBe(0);
  });
});
