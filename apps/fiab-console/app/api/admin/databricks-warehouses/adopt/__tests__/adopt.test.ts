/**
 * #3669 — `POST/GET /api/admin/databricks-warehouses/adopt` links an existing
 * Databricks SQL warehouse to a `databricks-sql-warehouse` item by stamping the
 * `loom_item_id` tag. Tenant admins only; write scope on the target item's
 * workspace; dry run by default; success reported only on a read-back.
 *
 * Every `it` names the value that would turn it red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  getSession: vi.fn(),
}));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: vi.fn() }));
const ITEMS = [
  { id: 'wh-item-1', itemType: 'databricks-sql-warehouse', workspaceId: 'ws-1' },
  { id: 'wh-item-2', itemType: 'databricks-sql-warehouse', workspaceId: 'ws-2' },
  { id: 'wh-item-nows', itemType: 'databricks-sql-warehouse', workspaceId: '' },
  // A NOTEBOOK in ws-1, where the admin can write: only the query's
  // `c.itemType = @t` keeps it from resolving as a warehouse item.
  { id: 'nb-1', itemType: 'notebook', workspaceId: 'ws-1' },
  // ONE id, TWO warehouse items; the first is in writable ws-1.
  { id: 'wh-item-dup', itemType: 'databricks-sql-warehouse', workspaceId: 'ws-1' },
  { id: 'wh-item-dup', itemType: 'databricks-sql-warehouse', workspaceId: 'ws-2' },
];
// Evaluates the query TEXT (`cosmos-query-model.ts`), so a predicate dropped from
// the production query is dropped here too.
let cosmos: ItemsModel;
vi.mock('@/lib/azure/cosmos-client', () => ({ itemsContainer: async () => cosmos.container }));
vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: vi.fn(() => null),
  editWarehouse: vi.fn(),
  getWarehouse: vi.fn(),
  listWarehouses: vi.fn(),
}));

import { GET, POST } from '../route';
import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { databricksConfigGate, editWarehouse, getWarehouse, listWarehouses } from '@/lib/azure/databricks-client';
import { makeItemsModel, type ItemsModel } from '@/app/api/items/_lib/__tests__/cosmos-query-model';

const ADMIN = { claims: { upn: 'a@contoso.com', oid: 'oid-admin', tid: 'tid-1' }, exp: 9_999_999_999 };
const USER = { claims: { upn: 'u@contoso.com', oid: 'oid-user', tid: 'tid-1' }, exp: 9_999_999_999 };

let store: Record<string, any>;
const fresh = () => ({
  'wh-plain': { id: 'wh-plain', name: 'plain', state: 'RUNNING', min_num_clusters: 1, max_num_clusters: 2, auto_stop_mins: 30, enable_serverless_compute: true, tags: { custom_tags: [{ key: 'env', value: 'dev' }] } },
  'wh-mine': { id: 'wh-mine', name: 'mine', state: 'STOPPED', tags: { custom_tags: [{ key: 'loom_item_id', value: 'wh-item-1' }] } },
  'wh-other': { id: 'wh-other', name: 'other', state: 'STOPPED', tags: { custom_tags: [{ key: 'loom_item_id', value: 'wh-item-2' }] } },
  'wh-conflict': { id: 'wh-conflict', name: 'c', state: 'STOPPED', tags: { custom_tags: [{ key: 'loom_item_id', value: 'a' }, { key: 'LOOM_ITEM_ID', value: 'b' }] } },
  // Untagged, but named like the bootstrap's shared warehouse.
  'wh-shared': { id: 'wh-shared', name: 'loom-default', state: 'RUNNING', tags: { custom_tags: [] } },
});

const req = (body?: any) => {
  const url = new URL('http://x/');
  return { url: url.toString(), nextUrl: url, json: async () => body ?? {} } as any;
};
const ctx = { params: Promise.resolve({}) } as any;
const post = (body: any) => POST(req(body), ctx);

beforeEach(() => {
  vi.resetAllMocks();
  cosmos = makeItemsModel(ITEMS);
  vi.stubEnv('LOOM_TENANT_ADMIN_OID', 'oid-admin');
  store = fresh();
  (getSession as any).mockReturnValue(ADMIN);
  (databricksConfigGate as any).mockReturnValue(null);
  // Write scope on ws-1 only.
  (authorizeItemWorkspace as any).mockImplementation(async (_s: any, o: any) =>
    o.workspaceId === 'ws-1' && !o.allowReadRoles ? null : NextResponse.json({ ok: false, error: o.notFound }, { status: 404 }),
  );
  (getWarehouse as any).mockImplementation(async (id: string) => {
    if (!store[id]) throw Object.assign(new Error('nf'), { status: 404 });
    return structuredClone(store[id]);
  });
  (listWarehouses as any).mockImplementation(async () => Object.values(store));
  // A working edit: the tags it is sent become the warehouse's tags.
  (editWarehouse as any).mockImplementation(async (id: string, _spec: any, tags: any[]) => {
    store[id].tags = { custom_tags: tags };
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('who may call it', () => {
  // RED if `withTenantAdmin` is replaced by `withSession`.
  it('403s a non-admin on both verbs and touches nothing', async () => {
    (getSession as any).mockReturnValue(USER);
    expect((await GET(req(), ctx)).status).toBe(403);
    expect((await post({ warehouseId: 'wh-plain', itemId: 'wh-item-1', dryRun: false })).status).toBe(403);
    expect(listWarehouses).not.toHaveBeenCalled();
    expect(editWarehouse).not.toHaveBeenCalled();
  });

  // RED if the admin skips the write-scoped ladder, or the ladder gets read scope.
  it('refuses an item in a workspace the admin cannot write, write-scoped by explicit id', async () => {
    const res = await post({ warehouseId: 'wh-plain', itemId: 'wh-item-2', dryRun: false });
    expect(res.status).toBe(404);
    expect(editWarehouse).not.toHaveBeenCalled();
    expect((authorizeItemWorkspace as any).mock.calls[0][1]).toMatchObject({ workspaceId: 'ws-2', itemId: 'wh-item-2' });
    expect((authorizeItemWorkspace as any).mock.calls[0][1].allowReadRoles).toBeUndefined();
  });

  // RED if the empty-workspace fail-closed check goes (the real ladder allows then),
  // or if the item lookup's QUERY loses `AND c.itemType = @t`: the ladder here
  // allows everything, so `nb-1` (a notebook in ws-1) would then resolve and be
  // stamped — editWarehouse called, status 200.
  it('refuses an item with no workspace, and an item of another type', async () => {
    (authorizeItemWorkspace as any).mockResolvedValue(null);
    for (const itemId of ['wh-item-nows', 'nb-1', 'nope']) {
      expect((await post({ warehouseId: 'wh-plain', itemId, dryRun: false })).status, itemId).toBe(404);
    }
    expect(editWarehouse).not.toHaveBeenCalled();
    const q = cosmos.queries.find((s) => s.parameters?.some((p) => p.name === '@id' && p.value === 'nb-1'));
    expect(q!.query).toMatch(/\bc\.itemType\s*=\s*@t\b/);
    expect(q!.parameters?.find((p) => p.name === '@t')?.value).toBe('databricks-sql-warehouse');
    // Positive pair: the same permissive ladder + a real warehouse item stamps.
    expect((await post({ warehouseId: 'wh-plain', itemId: 'wh-item-1', dryRun: false })).status).toBe(200);
  });

  // RED if `loadWarehouseItemRaw` returns the first of two rows: the first is in
  // ws-1, which the admin can write, so the route would then stamp (200).
  it('502s item_unverifiable, and stamps nothing, when the item id matches two warehouse items', async () => {
    const res = await post({ warehouseId: 'wh-plain', itemId: 'wh-item-dup', dryRun: false });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('item_unverifiable');
    expect(authorizeItemWorkspace).not.toHaveBeenCalled();
    expect(editWarehouse).not.toHaveBeenCalled();
  });
});

describe('the dry-run listing (GET)', () => {
  // RED if the owner is read from the wrong field, or a conflict is resolved to one value.
  it('lists every warehouse with its current link and changes nothing', async () => {
    const res = await GET(req(), ctx);
    const j = await res.json();
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(j.warehouses.map((w: any) => [w.id, w]));
    expect(byId['wh-plain']).toMatchObject({ linkedItemId: null, conflict: false });
    expect(byId['wh-mine']).toMatchObject({ linkedItemId: 'wh-item-1', conflict: false });
    expect(byId['wh-conflict']).toMatchObject({ linkedItemId: null, conflict: true });
    // RED if `deploymentShared` is dropped or computed from the wrong field: the
    // editor would then offer "Link to this item" on `loom-default`.
    expect(byId['wh-shared']).toMatchObject({ linkedItemId: null, deploymentShared: true });
    expect(byId['wh-plain'].deploymentShared).toBe(false);
    expect(editWarehouse).not.toHaveBeenCalled();
  });

  // RED if the config gate is dropped (Gov / unconfigured would then 502 or throw).
  it('503s when Databricks is not configured', async () => {
    (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
    expect((await GET(req(), ctx)).status).toBe(503);
  });
});

describe('stamping (POST)', () => {
  // RED if the default flips to writing.
  it('is a dry run unless dryRun is exactly false', async () => {
    for (const dryRun of [undefined, true, 'false', 0]) {
      const j = await (await post({ warehouseId: 'wh-plain', itemId: 'wh-item-1', dryRun })).json();
      expect(j, String(dryRun)).toMatchObject({ ok: true, dryRun: true, action: 'stamp' });
    }
    expect(editWarehouse).not.toHaveBeenCalled();
  });

  // RED if the user's tags are dropped, the scale settings are not re-sent, or
  // success is reported without the stamp.
  it('stamps, keeping existing tags and scale settings, and reports the read-back', async () => {
    const res = await post({ warehouseId: 'wh-plain', itemId: 'wh-item-1', dryRun: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, dryRun: false, action: 'stamp' });
    const [id, spec, tags] = (editWarehouse as any).mock.calls[0];
    expect(id).toBe('wh-plain');
    expect(spec).toEqual({ min_num_clusters: 1, max_num_clusters: 2, auto_stop_mins: 30, enable_serverless_compute: true });
    expect(tags).toEqual([{ key: 'env', value: 'dev' }, { key: 'loom_item_id', value: 'wh-item-1' }]);
  });

  // RED if the read-back verification is removed: the edit "succeeds" but the
  // tag never lands, and the route would still report 200.
  it('502s when the tag cannot be read back after the edit', async () => {
    (editWarehouse as any).mockResolvedValue(undefined); // edit accepted, nothing changed
    const res = await post({ warehouseId: 'wh-plain', itemId: 'wh-item-1', dryRun: false });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('stamp_unconfirmed');
  });

  // RED if an existing link to another item is overwritten.
  it('409s a warehouse already linked to a different item', async () => {
    const res = await post({ warehouseId: 'wh-other', itemId: 'wh-item-1', dryRun: false });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('warehouse_already_linked');
    expect(editWarehouse).not.toHaveBeenCalled();
  });

  // RED if a two-valued tag is "fixed" by picking one.
  it('409s a warehouse whose owner tag has two values', async () => {
    const res = await post({ warehouseId: 'wh-conflict', itemId: 'wh-item-1', dryRun: false });
    expect(res.status).toBe(409);
    expect(editWarehouse).not.toHaveBeenCalled();
  });

  // RED if an already-correct link is edited again (a needless edit on a live warehouse).
  it('does nothing for a warehouse already linked to this item', async () => {
    const j = await (await post({ warehouseId: 'wh-mine', itemId: 'wh-item-1', dryRun: false })).json();
    expect(j).toMatchObject({ ok: true, action: 'none' });
    expect(editWarehouse).not.toHaveBeenCalled();
  });

  // RED if an unknown warehouse is reported as anything but 404.
  it('404s an unknown warehouse and 400s missing ids', async () => {
    expect((await post({ warehouseId: 'wh-x', itemId: 'wh-item-1', dryRun: false })).status).toBe(404);
    expect((await post({ itemId: 'wh-item-1' })).status).toBe(400);
  });

  // RED if the deployment-shared check is removed or moved after the dry-run
  // return: `loom-default` would then be linked to one item (200 / action stamp).
  it('409s the deployment-shared warehouse, on a dry run too, and never stamps it', async () => {
    for (const dryRun of [false, undefined]) {
      const res = await post({ warehouseId: 'wh-shared', itemId: 'wh-item-1', dryRun });
      expect(res.status, String(dryRun)).toBe(409);
      expect((await res.json()).code, String(dryRun)).toBe('warehouse_deployment_shared');
    }
    expect(editWarehouse).not.toHaveBeenCalled();
  });

  // RED if the wired warehouse id (`LOOM_DATABRICKS_SQL_WAREHOUSE_ID`) is not
  // treated as shared: `wh-plain` has an ordinary name, so only the env id makes
  // it shared, and without that check this is a 200.
  it('treats the warehouse the Console is wired to as shared, whatever its name', async () => {
    vi.stubEnv('LOOM_DATABRICKS_SQL_WAREHOUSE_ID', 'wh-plain');
    const res = await post({ warehouseId: 'wh-plain', itemId: 'wh-item-1', dryRun: false });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('warehouse_deployment_shared');
    expect(editWarehouse).not.toHaveBeenCalled();
  });
});

describe('two admins linking the same warehouse at once', () => {
  // The edit lands, but by the read-back ANOTHER item's id is on the warehouse
  // (a concurrent adopt won the race). RED if the read-back is removed or its
  // verdict ignored: the route would report 200 for a link it does not hold.
  it('409s warehouse_already_linked naming the winner, when the read-back shows another owner', async () => {
    (editWarehouse as any).mockImplementation(async (id: string) => {
      store[id].tags = { custom_tags: [{ key: 'loom_item_id', value: 'wh-item-2' }] };
    });
    const res = await post({ warehouseId: 'wh-plain', itemId: 'wh-item-1', dryRun: false });
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j).toMatchObject({ ok: false, code: 'warehouse_already_linked', linkedItemId: 'wh-item-2' });
    expect(editWarehouse).toHaveBeenCalledTimes(1);
    // Read once before the edit, once after.
    expect((getWarehouse as any).mock.calls.filter((c: any[]) => c[0] === 'wh-plain')).toHaveLength(2);
  });

  // RED if a read-back carrying BOTH values is resolved to ours.
  it('409s warehouse_tag_conflict when the read-back carries two owner values', async () => {
    (editWarehouse as any).mockImplementation(async (id: string, _s: any, tags: any[]) => {
      store[id].tags = { custom_tags: [...tags, { key: 'loom_item_id', value: 'wh-item-2' }] };
    });
    const res = await post({ warehouseId: 'wh-plain', itemId: 'wh-item-1', dryRun: false });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('warehouse_tag_conflict');
  });
});
