/**
 * #3669 — the self-heal (`healWarehouseLink`) and the receipt it reads
 * (`recordWarehouseReceipt`).
 *
 * The heal re-stamps `loom_item_id` on the warehouse the ITEM DOCUMENT's
 * server-written receipt records, for a WRITER of that item, when the tag is
 * absent — and never overwrites a different owner, never links a
 * deployment-shared warehouse, and never links one another warehouse item also
 * records.
 *
 * Cosmos is `cosmos-query-model.ts`, which EVALUATES the query text — so the
 * exclusivity query's `c.itemType = @t` and `c.id != @self` are applied only if
 * the production query carries them. Every `it` names the value that turns it red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

let cosmos: ItemsModel;
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => cosmos.container,
  featurePermissionsContainer: vi.fn(),
}));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: vi.fn() }));
vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: vi.fn(() => null),
  editWarehouse: vi.fn(),
  getWarehouse: vi.fn(),
}));
vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/azure/cloud-endpoints')>()),
  isGovCloud: vi.fn(() => false),
}));

import { healWarehouseLink, recordWarehouseReceipt, WAREHOUSE_ITEM_TYPE } from '../warehouse-item-binding';
import { LOOM_OWNER_KEY } from '../databricks-resource-binding';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { databricksConfigGate, editWarehouse, getWarehouse } from '@/lib/azure/databricks-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import { WAREHOUSE_ENV_VAR } from '@/lib/azure/databricks-sql-warehouse';
import { makeItemsModel, type ItemsModel, type ModelDoc } from './cosmos-query-model';

const SESSION = { claims: { upn: 'w@contoso.com', oid: 'oid-w', tid: 'tid-1' }, exp: 9_999_999_999 } as any;

const receipt = (warehouseId: string) => ({ provisioning: { secondaryIds: { warehouseId } } });
const item = (id: string, state: Record<string, unknown>, workspaceId = 'ws-1'): any => ({
  id,
  itemType: WAREHOUSE_ITEM_TYPE,
  workspaceId,
  state,
});

const ITEMS: ModelDoc[] = [
  item('wh-item-1', receipt('wh-1')),
  // ANOTHER warehouse item recording `wh-claimed` — a competing claim.
  item('wh-item-2', receipt('wh-claimed'), 'ws-2'),
  // A NOTEBOOK recording `wh-nbclaim` at the same path. Only the claim query's
  // `c.itemType = @t` keeps it from counting as a competing claim.
  { id: 'nb-1', itemType: 'notebook', workspaceId: 'ws-1', state: receipt('wh-nbclaim') },
];

let store: Record<string, any>;
const fresh = () => ({
  'wh-1': { id: 'wh-1', name: 'item-one', min_num_clusters: 1, max_num_clusters: 3, auto_stop_mins: 20, enable_serverless_compute: true, tags: { custom_tags: [{ key: 'env', value: 'dev' }] } },
  'wh-decoy': { id: 'wh-decoy', name: 'decoy', tags: { custom_tags: [] } },
  'wh-mine': { id: 'wh-mine', name: 'mine', tags: { custom_tags: [{ key: LOOM_OWNER_KEY, value: 'wh-item-1' }] } },
  'wh-other': { id: 'wh-other', name: 'other', tags: { custom_tags: [{ key: LOOM_OWNER_KEY, value: 'wh-item-9' }] } },
  'wh-conflict': { id: 'wh-conflict', name: 'c', tags: { custom_tags: [{ key: LOOM_OWNER_KEY, value: 'a' }, { key: 'LOOM_ITEM_ID', value: 'b' }] } },
  'wh-shared': { id: 'wh-shared', name: 'loom-default', tags: { custom_tags: [] } },
  'wh-claimed': { id: 'wh-claimed', name: 'claimed', tags: { custom_tags: [] } },
  'wh-nbclaim': { id: 'wh-nbclaim', name: 'nbclaim', tags: { custom_tags: [] } },
});

beforeEach(() => {
  vi.resetAllMocks();
  cosmos = makeItemsModel(ITEMS);
  store = fresh();
  (isGovCloud as any).mockReturnValue(false);
  (databricksConfigGate as any).mockReturnValue(null);
  // WRITE scope on ws-1 only; a read-scoped call is refused, so a heal that
  // asked for read scope would be caught by the "stamps" test.
  (authorizeItemWorkspace as any).mockImplementation(async (_s: any, o: any) =>
    o.workspaceId === 'ws-1' && !o.allowReadRoles ? null : NextResponse.json({ ok: false }, { status: 404 }),
  );
  (getWarehouse as any).mockImplementation(async (id: string) => {
    if (id === 'wh-err') throw Object.assign(new Error('boom'), { status: 500 });
    if (!store[id]) throw Object.assign(new Error('nf'), { status: 404 });
    return structuredClone(store[id]);
  });
  (editWarehouse as any).mockImplementation(async (id: string, _spec: any, tags: any[]) => {
    store[id].tags = { custom_tags: tags };
  });
});
afterEach(() => vi.unstubAllEnvs());

const ownerOf = (id: string) => store[id].tags.custom_tags.filter((t: any) => t.key.toLowerCase() === LOOM_OWNER_KEY);

describe('healWarehouseLink — stamps the recorded warehouse', () => {
  // RED if the heal stamps nothing, stamps another id, drops the user's tags,
  // or asks the ladder for READ scope (the mock refuses that).
  it('stamps an untagged warehouse the item records, for a writer, keeping its tags', async () => {
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-1')))).toBe('stamped');
    expect(editWarehouse).toHaveBeenCalledTimes(1);
    const [id, spec, tags] = (editWarehouse as any).mock.calls[0];
    expect(id).toBe('wh-1');
    expect(spec).toEqual({ min_num_clusters: 1, max_num_clusters: 3, auto_stop_mins: 20, enable_serverless_compute: true });
    expect(tags).toEqual([{ key: 'env', value: 'dev' }, { key: LOOM_OWNER_KEY, value: 'wh-item-1' }]);
    expect((authorizeItemWorkspace as any).mock.calls[0][1]).toMatchObject({ workspaceId: 'ws-1', itemId: 'wh-item-1' });
    expect((authorizeItemWorkspace as any).mock.calls[0][1].allowReadRoles).toBeUndefined();
  });

  // The id comes from the ITEM DOCUMENT's receipt only. `state.warehouseId` is
  // client-writable (PATCH replaces `state`), so it stands in for a
  // request-supplied id here. RED if the heal reads it: the first call would
  // then stamp `wh-decoy`, the second would stamp `wh-decoy` instead of `wh-1`.
  it('never stamps an id that is not in the server-written receipt', async () => {
    expect(await healWarehouseLink(SESSION, item('wh-item-1', { warehouseId: 'wh-decoy' }))).toBe('no_receipt');
    expect(editWarehouse).not.toHaveBeenCalled();
    expect(await healWarehouseLink(SESSION, item('wh-item-1', { warehouseId: 'wh-decoy', ...receipt('wh-1') }))).toBe('stamped');
    expect((editWarehouse as any).mock.calls.map((c: any[]) => c[0])).toEqual(['wh-1']);
    expect(ownerOf('wh-decoy')).toEqual([]);
    // The function takes no warehouse-id argument at all. Documentation, not
    // coverage: no input to THIS test distinguishes a 3-arg signature.
    expect(healWarehouseLink.length).toBe(2);
  });
});

describe('healWarehouseLink — never overwrites', () => {
  // RED if the heal stamps without checking the existing value: `wh-item-9`
  // would be replaced by `wh-item-1`.
  it('leaves a warehouse linked to a different item alone', async () => {
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-other')))).toBe('linked_elsewhere');
    expect(editWarehouse).not.toHaveBeenCalled();
    expect(ownerOf('wh-other')).toEqual([{ key: LOOM_OWNER_KEY, value: 'wh-item-9' }]);
  });

  // RED if a two-valued tag is "fixed" by picking one.
  it('leaves a conflicting tag alone', async () => {
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-conflict')))).toBe('tag_conflict');
    expect(editWarehouse).not.toHaveBeenCalled();
  });

  // RED if an already-correct link is re-edited.
  it('does nothing when the warehouse already names this item', async () => {
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-mine')))).toBe('already_linked');
    expect(editWarehouse).not.toHaveBeenCalled();
  });

  // RED if the shared check goes: `loom-default` would be handed to one item.
  it('never links a deployment-shared warehouse, by name or by the wired id', async () => {
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-shared')))).toBe('deployment_shared');
    vi.stubEnv(WAREHOUSE_ENV_VAR, 'wh-1');
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-1')))).toBe('deployment_shared');
    expect(editWarehouse).not.toHaveBeenCalled();
  });
});

describe('healWarehouseLink — who may cause it', () => {
  // RED if the empty-workspace check goes (the real ladder ALLOWS with no workspace).
  it('refuses an item with no workspace before reaching the ladder', async () => {
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-1'), ''))).toBe('not_writer');
    expect(authorizeItemWorkspace).not.toHaveBeenCalled();
    expect(editWarehouse).not.toHaveBeenCalled();
  });

  // RED if the ladder's refusal is ignored: ws-2 is not writable here.
  it('refuses a caller with no write role', async () => {
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-1'), 'ws-2'))).toBe('not_writer');
    expect(getWarehouse).not.toHaveBeenCalled();
    expect(editWarehouse).not.toHaveBeenCalled();
  });

  // RED if the Gov / unconfigured short-circuit goes (Gov uses Synapse pools).
  it('does nothing off the Databricks path', async () => {
    (isGovCloud as any).mockReturnValue(true);
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-1')))).toBe('not_databricks');
    (isGovCloud as any).mockReturnValue(false);
    (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-1')))).toBe('not_databricks');
    expect(getWarehouse).not.toHaveBeenCalled();
  });
});

describe('healWarehouseLink — exclusivity of the receipt', () => {
  // RED if the exclusivity check is skipped: `wh-item-2` also records `wh-claimed`.
  it('refuses a warehouse another warehouse item also records', async () => {
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-claimed')))).toBe('claimed_elsewhere');
    expect(editWarehouse).not.toHaveBeenCalled();
  });

  // RED if the claim query loses `c.itemType = @t` — the notebook's identical
  // receipt would then count as a competing claim (claimed_elsewhere).
  it('does not count a different item type recording the same id', async () => {
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-nbclaim')))).toBe('stamped');
    const q = cosmos.queries.find((s) => /COUNT\(1\)/.test(s.query))!;
    expect(q.query).toMatch(/\bc\.itemType\s*=\s*@t\b/);
    expect(q.parameters?.find((p) => p.name === '@t')?.value).toBe(WAREHOUSE_ITEM_TYPE);
  });

  // RED if the item's OWN receipt counts against it (`c.id != @self` dropped):
  // `wh-item-1` records `wh-1`, so a plain heal would then be claimed_elsewhere.
  // Witnessed by the first "stamps" test above; restated here for the site.
  it('does not count the item itself', async () => {
    cosmos = makeItemsModel([item('wh-item-1', receipt('wh-1'))]);
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-1')))).toBe('stamped');
  });

  // RED if a failed exclusivity query is read as "no competing claim".
  it('fails closed when the exclusivity check cannot run', async () => {
    cosmos = makeItemsModel(ITEMS, { failQuery: (s) => /COUNT\(1\)/.test(s.query) });
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-1')))).toBe('claim_unverifiable');
    expect(editWarehouse).not.toHaveBeenCalled();
  });
});

describe('healWarehouseLink — reads and read-backs', () => {
  // RED if a 404 and a 5xx are reported the same way.
  it('separates a missing warehouse from an unreadable one', async () => {
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-gone')))).toBe('warehouse_missing');
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-err')))).toBe('unreadable');
    expect(editWarehouse).not.toHaveBeenCalled();
  });

  // A concurrent linker's value is on the warehouse by the read-back. RED if
  // the read-back is dropped and `stamped` is returned on a sent edit.
  it('reports linked_elsewhere when the read-back shows another owner', async () => {
    (editWarehouse as any).mockImplementation(async (id: string) => {
      store[id].tags = { custom_tags: [{ key: LOOM_OWNER_KEY, value: 'wh-item-9' }] };
    });
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-1')))).toBe('linked_elsewhere');
  });

  // RED if an accepted-but-unapplied edit, or a refused one, is reported as stamped.
  it('reports unconfirmed and edit_failed honestly', async () => {
    (editWarehouse as any).mockResolvedValueOnce(undefined);
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-1')))).toBe('unconfirmed');
    (editWarehouse as any).mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
    expect(await healWarehouseLink(SESSION, item('wh-item-1', receipt('wh-1')))).toBe('edit_failed');
  });
});

describe('recordWarehouseReceipt', () => {
  const doc = () => cosmos.docs.find((d) => d.id === 'wh-item-1')!;

  // RED if the receipt is written anywhere but the provisioning path, or the
  // merge drops sibling keys.
  it('merges the id into state.provisioning.secondaryIds, keeping siblings', async () => {
    cosmos = makeItemsModel([
      item('wh-item-1', { description: 'd', provisioning: { status: 'ok', secondaryIds: { jobId: 'j-1' } } }),
    ]);
    expect(await recordWarehouseReceipt({ id: 'wh-item-1', workspaceId: 'ws-1' }, 'wh-new')).toBe(true);
    expect((doc() as any).state).toEqual({
      description: 'd',
      provisioning: { status: 'ok', secondaryIds: { jobId: 'j-1', warehouseId: 'wh-new' } },
    });
  });

  // A concurrent save lands between our read and our replace. RED if the
  // replace is unconditional: it would succeed on the stale body and erase the
  // concurrent `description`.
  it('replaces conditionally on the etag, and retries over a concurrent save', async () => {
    let raced = false;
    cosmos = makeItemsModel([item('wh-item-1', {})], {
      afterRead: (d) => {
        if (raced) return;
        raced = true;
        d.state = { description: 'saved concurrently' };
        d._etag = '"concurrent"';
      },
    });
    expect(await recordWarehouseReceipt({ id: 'wh-item-1', workspaceId: 'ws-1' }, 'wh-new')).toBe(true);
    expect((doc() as any).state).toEqual({
      description: 'saved concurrently',
      provisioning: { secondaryIds: { warehouseId: 'wh-new' } },
    });
    expect(cosmos.replaces).toHaveLength(1);
  });

  // RED if the retry is unbounded (this never settles) or exhaustion reports true.
  it('gives up after three contended attempts and says so', async () => {
    let n = 0;
    cosmos = makeItemsModel([item('wh-item-1', {})], { afterRead: (d) => { d._etag = `"bump-${++n}"`; } });
    expect(await recordWarehouseReceipt({ id: 'wh-item-1', workspaceId: 'ws-1' }, 'wh-new')).toBe(false);
    expect(n).toBe(3);
    expect(cosmos.replaces).toHaveLength(0);
  });

  // RED if a missing document or an empty workspace reports success.
  it('returns false with nothing to write to', async () => {
    expect(await recordWarehouseReceipt({ id: 'nope', workspaceId: 'ws-1' }, 'wh-new')).toBe(false);
    expect(await recordWarehouseReceipt({ id: 'wh-item-1', workspaceId: '' }, 'wh-new')).toBe(false);
    expect(cosmos.replaces).toHaveLength(0);
  });
});
