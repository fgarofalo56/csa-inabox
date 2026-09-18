/**
 * Input-validation contract for `DELETE /api/onelake/[itemId]` — the ADLS
 * folder set a soft-delete is allowed to touch.
 *
 * WHAT THIS PINS. The route accepts an optional `adlsHints: [{container,path}]`
 * array in the request body. It used to forward that array to
 * `softDeleteOwnedItem` verbatim, so the folders soft-deleted were whatever the
 * body named. They are now resolved against `deriveAdlsHints(itemId)` — the set
 * built from the item's OneLake security roles — and a body entry that is not a
 * member of that derived set is dropped.
 *
 * WHAT IS DELIBERATELY *NOT* MOCKED. `softDeleteOwnedItem` runs FOR REAL, so
 * these assertions read the mechanism (`softDeleteDirectory` call arguments) and
 * not merely the JSON the route returns. A route that resolved the set correctly
 * in its response while still forwarding the body array would pass a
 * response-only assertion and fail these.
 *
 * WHAT THIS SPEC DOES *NOT* COVER, stated so it is not miscounted as coverage:
 * the workspace ACL ladder. `resolveWorkspaceAccessByOid` is mocked, so
 * `LOOM_MULTIUSER_ACL` is never consulted on any path here and this spec is
 * config-independent by construction — it is deliberately NOT run under a
 * non-default flag value. The ladder itself is covered by
 * `lib/auth/__tests__/workspace-access*.test.ts`. What IS covered here is that
 * the route ACTS on the resolver's verdict, in both directions.
 *
 * Every assertion below names the value that makes it fail in a comment at the
 * site; the two directions are paired — a legitimate delete must still reach
 * ADLS, or "nothing was deleted" would be satisfied by deleting the feature.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  itemsQuery: vi.fn(),
  itemReplace: vi.fn(),
  listRoles: vi.fn(),
  softDeleteDirectory: vi.fn(),
  getSession: vi.fn(),
  resolveWorkspaceAccessByOid: vi.fn(),
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
  workspacesContainer: vi.fn(async () => ({ item: () => ({ read: vi.fn() }) })),
  tenantSettingsContainer: vi.fn(async () => ({ item: () => ({ read: vi.fn() }) })),
  // item-crud emits an item.deleted lifecycle event; the fan-out reads this.
  webhookSubscriptionsContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
}));

// The workspace ladder, mocked at its single entry point — see the header. Both
// `authorizeItemWorkspace` (the route's gate) and `loadOwnedItem` (inside
// softDeleteOwnedItem) resolve through this one function.
vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: h.resolveWorkspaceAccessByOid,
  ambientAccessOptsFor: vi.fn(async () => ({})),
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
// The REAL validator, not a transcription of it — the fixture assertion below
// lifts the rule rather than restating it, so a drift in either direction shows
// up as a red test instead of a fixture that quietly leaves the population.
import { isValidRolePath } from '@/lib/azure/onelake-security-rules';

const TENANT = 'tenant-1';
const ITEM_ID = 'item-1';

const activeItem = {
  id: ITEM_ID, workspaceId: 'ws-1', itemType: 'lakehouse',
  displayName: 'Sales LH', state: {},
  createdBy: 'u', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

/**
 * The item's OneLake security roles. `container` is one of the tenant-wide
 * KNOWN_CONTAINERS and each path is a real, validator-accepted role path — see
 * the fixture-shape test below, which is what keeps this drawn from the real
 * population rather than from what this spec finds convenient.
 */
const ownRoles = [
  { container: 'bronze', paths: ['/Tables/orders'] },
  { container: 'silver', paths: ['/Files/curated/orders'] },
];
/** What deriveAdlsHints() turns `ownRoles` into. */
const DERIVED: Array<[string, string]> = [
  ['bronze', 'Tables/orders'],
  ['silver', 'Files/curated/orders'],
];

const ownerAccess = {
  workspace: { id: 'ws-1', tenantId: TENANT }, role: 'Owner', via: 'owner', canWrite: true,
};

function delReq(body: unknown) {
  return { json: async () => body } as any;
}

async function callDelete(body: unknown) {
  const res = await DELETE(delReq(body), { params: Promise.resolve({ itemId: ITEM_ID }) } as any);
  return { res, json: await res.json() };
}

/**
 * The route consults the workspace resolver TWICE per inference-branch request,
 * and the two calls are distinguishable — measured, not assumed:
 *
 *   argc 4  `authorizeItemWorkspace` → `authorizeWorkspace`, which passes the
 *           `diag` out-channel as a 4th argument and `{callerTid, tenantAdmin}`
 *           as the 3rd.
 *   argc 3  `loadOwnedItem` inside `softDeleteOwnedItem`, whose `accessOptsFor`
 *           falls through to the ambient branch and passes no `diag`.
 *
 * Answering them differently is what makes a gate assertion able to fail at all.
 * Drive both from one answer and the arms below are BLIND: the item check denies
 * too, so the route 404s whether or not the gate's verdict was consumed — which
 * is exactly how the first draft of these arms let a `void denied;` mutant live.
 *
 * This pins verdict CONSUMPTION. It does not claim a live deployment routinely
 * produces divergent answers — only that the two calls carry different inputs,
 * so divergence is structurally possible and the route must honour the gate's.
 */
function resolverDenyingOnlyTheGate(gateAnswer: unknown) {
  h.resolveWorkspaceAccessByOid.mockImplementation(
    async (...args: unknown[]) => (args.length >= 4 ? gateAnswer : ownerAccess),
  );
}

/** argc per resolver call, in call order. */
const resolverShapes = () => h.resolveWorkspaceAccessByOid.mock.calls.map((c) => c.length);

beforeEach(() => {
  Object.values(h).forEach((fn) => fn.mockReset());
  // Asserted, not assumed: the resolver is mocked, so this flag reaches no code
  // path in this spec. Cleared anyway so a value leaked from another spec file
  // cannot make these results depend on it.
  delete process.env.LOOM_MULTIUSER_ACL;
  h.getSession.mockReturnValue({ claims: { oid: TENANT, tid: 'tid-1', upn: 'alice@contoso.com' } });
  h.itemsQuery.mockResolvedValue({ resources: [activeItem] });
  h.itemReplace.mockImplementation((_id: string, _pk: string, doc: any) => ({ resource: doc }));
  h.resolveWorkspaceAccessByOid.mockResolvedValue(ownerAccess);
  h.listRoles.mockResolvedValue(ownRoles);
  h.softDeleteDirectory.mockResolvedValue({ deletionId: 'del-1' });
});

describe('fixture shape', () => {
  // FAILS IF a role path in `ownRoles` is one `isValidRolePath` would reject —
  // e.g. the '/lakehouses/sales-lh' this fixture originally used, which matches
  // neither the '*' arm nor the /Tables|/Files prefix arms and so could never
  // appear on a real role. A fixture outside the population proves nothing.
  it('every fixture role path is one the real validator accepts', () => {
    for (const role of ownRoles) {
      for (const p of role.paths) {
        expect(isValidRolePath(p), `${role.container} ${p}`).toBe(true);
      }
    }
  });

  // FAILS IF the validator stops rejecting a non-/Tables, non-/Files path —
  // which would mean the arm above had lost its discriminating power.
  it('the validator still rejects a path outside its prefixes', () => {
    expect(isValidRolePath('/lakehouses/sales-lh')).toBe(false);
  });
});

describe('DELETE /api/onelake/[itemId] — ADLS folder resolution', () => {
  // POSITIVE (paired with the drop cases below): with no hints in the body —
  // the shape the OneLake page actually sends — the item's whole derived set is
  // soft-deleted. FAILS IF resolution returns [] for a missing/empty
  // `adlsHints`, i.e. if the derived path were dropped along with the body one.
  it('soft-deletes the derived folder set when the body carries no hints', async () => {
    const { json } = await callDelete({ itemType: 'lakehouse' });
    expect(json.ok).toBe(true);
    expect(h.softDeleteDirectory.mock.calls).toEqual(DERIVED);
    expect(json.recycled.adlsSoftDeleted).toBe(2);
  });

  // NEGATIVE — the behaviour this change adds. 'bronze'/'Tables/someone_elses'
  // shares a CONTAINER with a derived entry and is still not a member, so
  // container agreement alone is not enough. FAILS IF the route forwards
  // `body.adlsHints` (the previous
  // `body.adlsHints.filter((h) => h?.container && h?.path)`): the call list
  // becomes [['bronze','Tables/someone_elses']] and adlsSoftDeleted becomes 1.
  it('drops a hint that is outside the derived set', async () => {
    const { json } = await callDelete({
      itemType: 'lakehouse',
      adlsHints: [{ container: 'bronze', path: 'Tables/someone_elses' }],
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
  // gives a 2-row call list containing 'Tables/someone_elses'; discarding the
  // whole array on any foreign entry gives [].
  it('keeps the member and drops the non-member when both are supplied', async () => {
    const { json } = await callDelete({
      itemType: 'lakehouse',
      adlsHints: [
        { container: 'bronze', path: 'Tables/someone_elses' },
        { container: 'bronze', path: 'Tables/orders' },
      ],
    });
    expect(json.ok).toBe(true);
    expect(h.softDeleteDirectory.mock.calls).toEqual([['bronze', 'Tables/orders']]);
    expect(json.recycled.adlsSoftDeleted).toBe(1);
  });

  // POSITIVE — narrowing works, and the DERIVED spelling is what goes forward.
  // The body spells the silver folder '/Files/curated/orders/'; the derived pair
  // is 'Files/curated/orders'. FAILS IF normPath is not applied on the supplied
  // side (the silver row is dropped and the list is []), or if the caller's raw
  // string is emitted instead of the derived one (the recorded argument is
  // '/Files/curated/orders/'), or if narrowing is ignored (bronze appears too).
  it('narrows to the supplied member and forwards the derived path spelling', async () => {
    const { json } = await callDelete({
      itemType: 'lakehouse',
      adlsHints: [{ container: 'silver', path: '/Files/curated/orders/' }],
    });
    expect(json.ok).toBe(true);
    expect(h.softDeleteDirectory.mock.calls).toEqual([['silver', 'Files/curated/orders']]);
    expect(json.recycled.adlsSoftDeleted).toBe(1);
  });

  // NEGATIVE — two spellings of ONE member collapse to ONE call. This pins the
  // `seen` de-duplication, which is NOT an equivalent mutant: without it the
  // same folder is soft-deleted twice, which inflates `adlsSoftDeleted` AND
  // writes a duplicate `state._recycled.adlsRefs` entry that the restore path
  // then acts on. FAILS IF `seen` is removed: the call list becomes
  // [['bronze','Tables/orders'],['bronze','Tables/orders']] and the count 2.
  it('collapses two spellings of the same member to a single call', async () => {
    const { json } = await callDelete({
      itemType: 'lakehouse',
      adlsHints: [
        { container: 'bronze', path: 'Tables/orders' },
        { container: 'bronze', path: '/Tables/orders/' },
      ],
    });
    expect(json.ok).toBe(true);
    expect(h.softDeleteDirectory.mock.calls).toEqual([['bronze', 'Tables/orders']]);
    expect(json.recycled.adlsSoftDeleted).toBe(1);
  });

  // NEGATIVE — a container-root hint. deriveAdlsHints never emits an empty path
  // (it skips '*' and ''), so no root hint can be a member of the derived set.
  // FAILS IF the supplied array is forwarded: softDeleteDirectory is called with
  // ('bronze','/') and a whole tenant-wide container is the target.
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

describe('DELETE /api/onelake/[itemId] — itemType-inference branch', () => {
  // POSITIVE — omitting `itemType` takes the inference branch, which resolves
  // the type from the item doc and runs the workspace ladder before acting.
  // FAILS IF the branch stops reaching the soft-delete at all (call list []),
  // or infers the wrong type (loadOwnedItem's `c.itemType = @t` misses and the
  // route answers 404 with ok:false).
  it('infers the item type and still soft-deletes the derived set', async () => {
    const { json } = await callDelete({});
    expect(json.ok).toBe(true);
    expect(json.item.itemType).toBe('lakehouse');
    expect(h.softDeleteDirectory.mock.calls).toEqual(DERIVED);
  });

  // The DISCRIMINATOR the two arms below depend on, asserted rather than
  // assumed. FAILS IF the gate and the item check ever collapse into one
  // resolver call, or stop differing in arity — either of which would silently
  // make `resolverDenyingOnlyTheGate` answer both the same way and turn those
  // arms blind. This is the guard against the exact defect that let `void
  // denied;` survive the first draft.
  it('the gate and the item check are two distinct resolver calls', async () => {
    await callDelete({});
    expect(resolverShapes()).toEqual([4, 3]);
  });

  // NEGATIVE, paired with the positive above — the route ACTS on the gate's
  // verdict, and stops there. The item check is rigged to ALLOW, so nothing but
  // the gate can produce this refusal. FAILS IF the verdict is discarded
  // (`void denied;`): execution reaches loadOwnedItem, the resolver is called a
  // second time at argc 3, and the call list becomes the 2-row DERIVED set.
  it('refuses on the gate verdict alone, when the item check would allow', async () => {
    resolverDenyingOnlyTheGate(null);
    const { res, json } = await callDelete({});
    expect(res.status).toBe(404);
    expect(json.ok).toBe(false);
    expect(h.softDeleteDirectory.mock.calls).toEqual([]);
    // Stopped AT the gate — loadOwnedItem was never reached.
    expect(resolverShapes()).toEqual([4]);
  });

  // NEGATIVE — a read-only role must not pass a mutating handler. Again the item
  // check is rigged to allow, so the gate is the only thing that can refuse.
  // FAILS IF the gate is given `allowReadRoles: true`, which admits Viewer and
  // lets execution through: shapes become [4, 3] and the call list DERIVED.
  it('refuses a read-only workspace role at the gate', async () => {
    resolverDenyingOnlyTheGate({
      workspace: { id: 'ws-1', tenantId: TENANT }, role: 'Viewer', via: 'acl', canWrite: false,
    });
    const { res } = await callDelete({});
    expect(res.status).toBe(404);
    expect(h.softDeleteDirectory.mock.calls).toEqual([]);
    expect(resolverShapes()).toEqual([4]);
  });

  // DISCLOSED, not counted as gate coverage (assertion-design.md §5): when BOTH
  // layers answer from the same resolver — the live shape — removing the gate
  // entirely is NOT observable at this route. `loadOwnedItem` is write-scoped
  // and unconditional (item-crud.ts:597, `softDeleteOwnedItem` never passes
  // `allowReadRoles`), so it refuses the same callers a beat later and the
  // route still 404s. The gate is defence-in-depth over a check that already
  // binds — which is precisely why migrating onto it admits nobody. This arm
  // pins that shared-resolver behaviour so the claim is checkable, and it is
  // the arms above, with their per-call-site answers, that carry the kill power.
  it('still refuses when BOTH layers deny — the shared-resolver shape', async () => {
    h.resolveWorkspaceAccessByOid.mockResolvedValue(null);
    const { res, json } = await callDelete({});
    expect(res.status).toBe(404);
    expect(json.ok).toBe(false);
    expect(h.softDeleteDirectory.mock.calls).toEqual([]);
  });
});
