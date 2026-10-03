/**
 * #3669 — `GET /api/items/databricks-sql-warehouse/[id]/warehouses` reports the
 * item's linked warehouse (`linkedWarehouseId`) and runs the self-heal (`link`)
 * on every real-id open.
 *
 * The heal is the REAL `healWarehouseLink` over the query-evaluating Cosmos
 * model; only the ladder, the Databricks client and the cloud switch are mocked.
 * Every `it` names the value that would turn it red.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  getSession: vi.fn(),
}));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: vi.fn() }));
let cosmos: ItemsModel;
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => cosmos.container,
  featurePermissionsContainer: vi.fn(),
}));
vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: vi.fn(() => null),
  editWarehouse: vi.fn(),
  getWarehouse: vi.fn(),
  listWarehouses: vi.fn(),
}));
vi.mock('@/lib/azure/synapse-dev-client', () => ({ listDedicatedSqlPools: vi.fn() }));
vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/azure/cloud-endpoints')>()),
  isGovCloud: vi.fn(() => false),
}));

import { GET } from '../[id]/warehouses/route';
import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { editWarehouse, getWarehouse, listWarehouses, databricksConfigGate } from '@/lib/azure/databricks-client';
import { listDedicatedSqlPools } from '@/lib/azure/synapse-dev-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import { LOOM_OWNER_KEY } from '@/app/api/items/_lib/databricks-resource-binding';
import { makeItemsModel, type ItemsModel } from '@/app/api/items/_lib/__tests__/cosmos-query-model';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1', tid: 'tid-1' }, exp: 9_999_999_999 };
const T = 'databricks-sql-warehouse';
const receipt = (warehouseId: string) => ({ provisioning: { secondaryIds: { warehouseId } } });
const ITEMS = [
  // No receipt: nothing to heal, only the tag lookup applies.
  { id: 'sw-1', itemType: T, workspaceId: 'ws-1', state: {} },
  // A receipt naming an UNTAGGED warehouse: the heal stamps it on open.
  { id: 'sw-2', itemType: T, workspaceId: 'ws-1', state: receipt('wh-r') },
];

let store: Record<string, any>;
const tagged = (id: string, owner?: string) => ({
  id,
  name: id,
  state: 'RUNNING',
  tags: { custom_tags: owner === undefined ? [] : [{ key: LOOM_OWNER_KEY, value: owner }] },
});

const req = () => {
  const url = new URL('http://x/');
  return { url: url.toString(), nextUrl: url, json: async () => ({}) } as any;
};
const get = async (id: string) => {
  const res = await GET(req(), { params: Promise.resolve({ id }) } as any);
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  vi.resetAllMocks();
  cosmos = makeItemsModel(ITEMS);
  (getSession as any).mockReturnValue(SESSION);
  (isGovCloud as any).mockReturnValue(false);
  (databricksConfigGate as any).mockReturnValue(null);
  // Read AND write scope on ws-1. The route guard passes no workspace (the real
  // ladder resolves it from the item), so resolve it the same way here.
  (authorizeItemWorkspace as any).mockImplementation(async (_s: any, o: any) =>
    (o.workspaceId ?? ITEMS.find((i) => i.id === o.itemId)?.workspaceId) === 'ws-1'
      ? null
      : NextResponse.json({ ok: false }, { status: 404 }),
  );
  // `wh-a` is FIRST and names another item; `wh-b` names sw-1.
  store = { 'wh-a': tagged('wh-a', 'sw-other'), 'wh-b': tagged('wh-b', 'sw-1'), 'wh-r': tagged('wh-r') };
  (listWarehouses as any).mockImplementation(async () => Object.values(store).map((w) => structuredClone(w)));
  (getWarehouse as any).mockImplementation(async (id: string) => {
    if (!store[id]) throw Object.assign(new Error('nf'), { status: 404 });
    return structuredClone(store[id]);
  });
  (editWarehouse as any).mockImplementation(async (id: string, _spec: any, tags: any[]) => {
    store[id].tags = { custom_tags: tags };
  });
});

describe('linkedWarehouseId', () => {
  // RED if the route goes back to `list[0]` (`wh-a`, another item's warehouse)
  // or drops the field (undefined).
  it('is the warehouse whose tag names this item, not the first listed', async () => {
    const { status, body } = await get('sw-1');
    expect(status).toBe(200);
    expect(body.warehouses.map((w: any) => w.id)).toEqual(['wh-a', 'wh-b', 'wh-r']);
    expect(body.linkedWarehouseId).toBe('wh-b');
    expect(body.link).toBe('no_receipt');
    expect(editWarehouse).not.toHaveBeenCalled();
  });
});

describe('the self-heal on open', () => {
  // RED if the route stops calling the heal: `wh-r` stays untagged, `link` is
  // absent and `linkedWarehouseId` is ''. Also RED if the heal runs AFTER the
  // list (the list would then be read before the stamp, so linkedWarehouseId '').
  it('stamps the recorded, untagged warehouse and reports it linked in the same response', async () => {
    const { status, body } = await get('sw-2');
    expect(status).toBe(200);
    expect(body.link).toBe('stamped');
    expect(body.linkedWarehouseId).toBe('wh-r');
    expect((editWarehouse as any).mock.calls.map((c: any[]) => c[0])).toEqual(['wh-r']);
    // A second open is a no-op: RED if the heal re-edits a correct link.
    expect((await get('sw-2')).body.link).toBe('already_linked');
    expect(editWarehouse).toHaveBeenCalledTimes(1);
  });

  // RED if a heal that throws fails the list (status 502/500 instead of 200),
  // or is reported as anything but 'error'. The guard's READ-scoped call passes;
  // only the heal's WRITE-scoped call throws.
  it('reports link "error" and still returns the list when the heal throws', async () => {
    (authorizeItemWorkspace as any).mockImplementation(async (_s: any, o: any) => {
      if (!o.allowReadRoles) throw new Error('ladder down');
      return null;
    });
    const { status, body } = await get('sw-2');
    expect(status).toBe(200);
    expect(body.link).toBe('error');
    expect(body.warehouses).toHaveLength(3);
    expect(editWarehouse).not.toHaveBeenCalled();
  });

  // RED if the unsaved-item path starts healing or guarding: it has no item.
  it('does not heal, guard, or report a link on the unsaved-item path', async () => {
    const { status, body } = await get('new');
    expect(status).toBe(200);
    expect(body.linkedWarehouseId).toBe('');
    expect('link' in body).toBe(false);
    expect(authorizeItemWorkspace).not.toHaveBeenCalled();
    expect(editWarehouse).not.toHaveBeenCalled();
    // Positive pair: the list itself is still served.
    expect(body.warehouses).toHaveLength(3);
  });

  // RED if Gov preselects a pool (the old `list[0]`) or the heal edits there.
  it('returns no linked id on Gov, where pools carry no tags', async () => {
    (isGovCloud as any).mockReturnValue(true);
    (listDedicatedSqlPools as any).mockResolvedValue([{ name: 'pool1', status: 'Online' }]);
    const { status, body } = await get('sw-2');
    expect(status).toBe(200);
    expect(body).toMatchObject({ gov: true, linkedWarehouseId: '' });
    expect(body.warehouses.map((w: any) => w.id)).toEqual(['pool1']);
    expect(editWarehouse).not.toHaveBeenCalled();
  });
});
