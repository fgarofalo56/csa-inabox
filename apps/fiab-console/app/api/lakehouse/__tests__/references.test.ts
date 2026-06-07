/**
 * Backend contract tests for Reference-Lakehouse federation (F8) —
 * /api/lakehouse/references (GET/POST) and /api/lakehouse/references/paths (GET).
 *
 * Azure-native, NO Fabric dependency: references live on the primary lakehouse's
 * Cosmos `items` doc (state.referencedLakehouseIds); reads go through ADLS
 * listPaths with pass-through RBAC.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

// Cosmos: items container (query + item().replace) + workspaces container (item().read).
const itemsQueryFetchAll = vi.fn();
const itemReplace = vi.fn();
const itemFn = vi.fn(() => ({ replace: itemReplace }));
const wsReadFn = vi.fn();
const wsItemFn = vi.fn(() => ({ read: wsReadFn }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    items: { query: vi.fn(() => ({ fetchAll: itemsQueryFetchAll })) },
    item: itemFn,
  })),
  workspacesContainer: vi.fn(async () => ({ item: wsItemFn })),
}));

const listPaths = vi.fn();
const containerExistsOn = vi.fn();
vi.mock('@/lib/azure/adls-client', () => ({
  KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing'],
  getAccountName: vi.fn(() => 'loomacct'),
  containerExistsOn: (...a: any[]) => containerExistsOn(...a),
  listPaths: (...a: any[]) => listPaths(...a),
}));

import { GET, POST } from '../references/route';
import { GET as PATHS_GET } from '../references/paths/route';
import { getSession } from '@/lib/auth/session';

function getReq(qs: string) { return { nextUrl: new URL(`http://x/api/lakehouse/references?${qs}`) } as any; }
function postReq(body: any) { return { json: async () => body } as any; }
function pathsReq(qs: string) { return { nextUrl: new URL(`http://x/api/lakehouse/references/paths?${qs}`) } as any; }

const sess = { claims: { oid: 'tenant-1', upn: 'u@x' } };
const primary = { id: 'lh-primary', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Primary', state: { referencedLakehouseIds: ['lh-ref'] } };
const ref = { id: 'lh-ref', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Agency B', state: {} };

beforeEach(() => {
  vi.clearAllMocks();
  wsReadFn.mockResolvedValue({ resource: { id: 'ws-1', tenantId: 'tenant-1' } });
  containerExistsOn.mockResolvedValue(true);
});

describe('GET /api/lakehouse/references', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await GET(getReq('lakehouseId=lh-primary'))).status).toBe(401);
  });

  it('400 without lakehouseId', async () => {
    (getSession as any).mockReturnValue(sess);
    expect((await GET(getReq(''))).status).toBe(400);
  });

  it('returns primary + references + workspace picker list', async () => {
    (getSession as any).mockReturnValue(sess);
    // 1st query: load primary by id. 2nd query: list workspace lakehouses.
    itemsQueryFetchAll
      .mockResolvedValueOnce({ resources: [primary] })
      .mockResolvedValueOnce({ resources: [primary, ref] });
    const res = await GET(getReq('lakehouseId=lh-primary'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.primary.id).toBe('lh-primary');
    expect(j.primary.containers).toContain('bronze');
    expect(j.references).toHaveLength(1);
    expect(j.references[0].id).toBe('lh-ref');
    expect(j.references[0].account).toBe('loomacct'); // falls through to primary account
    expect(j.references[0].reachable).toBe(true);
    // workspaceLakehouses excludes the primary itself
    expect(j.workspaceLakehouses.map((l: any) => l.id)).toEqual(['lh-ref']);
  });

  it('marks a reference unreachable when the UAMI cannot see its containers', async () => {
    (getSession as any).mockReturnValue(sess);
    containerExistsOn.mockResolvedValue(false);
    itemsQueryFetchAll
      .mockResolvedValueOnce({ resources: [primary] })
      .mockResolvedValueOnce({ resources: [primary, ref] });
    const j = await (await GET(getReq('lakehouseId=lh-primary'))).json();
    expect(j.references[0].reachable).toBe(false);
  });
});

describe('POST /api/lakehouse/references', () => {
  it('400 when adding a lakehouse that is not in the workspace', async () => {
    (getSession as any).mockReturnValue(sess);
    itemsQueryFetchAll
      .mockResolvedValueOnce({ resources: [primary] })      // load primary
      .mockResolvedValueOnce({ resources: [primary] });     // siblings (no lh-other)
    const res = await POST(postReq({ lakehouseId: 'lh-primary', addId: 'lh-other' }));
    expect(res.status).toBe(400);
  });

  it('rejects a self-reference', async () => {
    (getSession as any).mockReturnValue(sess);
    const res = await POST(postReq({ lakehouseId: 'lh-primary', addId: 'lh-primary' }));
    expect(res.status).toBe(400);
  });

  it('adds a valid in-workspace reference and persists it', async () => {
    (getSession as any).mockReturnValue(sess);
    const fresh = { ...primary, state: {} };
    itemsQueryFetchAll
      .mockResolvedValueOnce({ resources: [fresh] })          // load primary
      .mockResolvedValueOnce({ resources: [fresh, ref] });    // siblings include lh-ref
    itemReplace.mockResolvedValue({ resource: {} });
    const res = await POST(postReq({ lakehouseId: 'lh-primary', addId: 'lh-ref' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.referencedLakehouseIds).toEqual(['lh-ref']);
    expect(itemReplace).toHaveBeenCalledTimes(1);
    const persisted = itemReplace.mock.calls[0][0];
    expect(persisted.state.referencedLakehouseIds).toEqual(['lh-ref']);
  });

  it('removes a reference', async () => {
    (getSession as any).mockReturnValue(sess);
    itemsQueryFetchAll.mockResolvedValueOnce({ resources: [primary] });
    itemReplace.mockResolvedValue({ resource: {} });
    const j = await (await POST(postReq({ lakehouseId: 'lh-primary', removeId: 'lh-ref' }))).json();
    expect(j.ok).toBe(true);
    expect(j.referencedLakehouseIds).toEqual([]);
  });
});

describe('GET /api/lakehouse/references/paths', () => {
  it('400 without refId/container', async () => {
    (getSession as any).mockReturnValue(sess);
    expect((await PATHS_GET(pathsReq('container=bronze'))).status).toBe(400);
    expect((await PATHS_GET(pathsReq('refId=lh-ref'))).status).toBe(400);
  });

  it('404 for a container the reference does not own', async () => {
    (getSession as any).mockReturnValue(sess);
    itemsQueryFetchAll.mockResolvedValueOnce({ resources: [ref] });
    const res = await PATHS_GET(pathsReq('refId=lh-ref&container=secret'));
    expect(res.status).toBe(404);
  });

  it('lists paths in a referenced lakehouse via listPaths', async () => {
    (getSession as any).mockReturnValue(sess);
    itemsQueryFetchAll.mockResolvedValueOnce({ resources: [ref] });
    listPaths.mockResolvedValue([{ name: 'Tables/orders', isDirectory: true, size: 0 }]);
    const res = await PATHS_GET(pathsReq('refId=lh-ref&container=silver&prefix=Tables'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.paths).toHaveLength(1);
    // account undefined (no state.storageAccount) → primary account path
    expect(listPaths).toHaveBeenCalledWith('silver', 'Tables', 200, undefined);
  });

  it('routes a cross-account reference to its own storage account', async () => {
    (getSession as any).mockReturnValue(sess);
    const xref = { ...ref, state: { storageAccount: 'extacct', ownedContainers: ['bronze'] } };
    itemsQueryFetchAll.mockResolvedValueOnce({ resources: [xref] });
    listPaths.mockResolvedValue([]);
    await PATHS_GET(pathsReq('refId=lh-ref&container=bronze&prefix='));
    expect(listPaths).toHaveBeenCalledWith('bronze', '', 200, 'extacct');
  });
});
