/**
 * The dataset editor's three routes (`dataset/[id]`, `/preview`, `/lineage`)
 * require read access to the dataset item, as the lakehouse routes do.
 *
 * Each test names the change that turns it red:
 *   - a reader gets the answer / the check asks for the `dataset` item: the
 *     access check removed, or run against another item type.
 *   - a caller without access gets the 404 with `dataset_item_not_found`,
 *     before Foundry or Synapse: the check removed, moved after the asset
 *     read, or answering without the code the editor keys on.
 *   - a tenant admin opens an asset by name: the admin form dropped.
 *   - no session is a 401 before the access check: the session check dropped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sess = vi.hoisted(() => ({
  current: { claims: { oid: 'oid-reader', tid: 'tid-1', upn: 'r@loom.test', groups: [] } } as any,
}));
vi.mock('@/lib/auth/session', () => ({ getSession: () => sess.current }));

const access = vi.hoisted(() => ({ resolveItemAccessByOid: vi.fn() }));
vi.mock('@/lib/auth/item-access', () => access);

const admin = vi.hoisted(() => ({ isTenantAdmin: vi.fn(() => false) }));
vi.mock('@/lib/auth/feature-gate', async () => ({
  ...(await vi.importActual<any>('@/lib/auth/feature-gate')),
  isTenantAdmin: admin.isTenantAdmin,
}));

const foundry = vi.hoisted(() => ({
  getDataAsset: vi.fn(async () => ({
    container: { name: 'orders', dataUri: 'abfss://gold@acct1.dfs.core.windows.net/data/orders.parquet', latestVersion: '1' },
    versions: [{ version: '1' }],
  })),
  getDataAssetLineage: vi.fn(async () => ({ producers: [], consumers: [], jobsScanned: 3 })),
  FoundryError: class extends Error { status = 502; },
  NotDeployedError: class extends Error { hint = ''; },
}));
vi.mock('@/lib/azure/foundry-client', () => foundry);

const synapse = vi.hoisted(() => ({
  executeQuery: vi.fn(async () => ({ columns: ['a'], rows: [[1]], rowCount: 1, executionMs: 3, truncated: false })),
  serverlessTarget: vi.fn(() => ({ server: 's', database: 'master', cacheKey: 'k' })),
}));
vi.mock('@/lib/azure/synapse-sql-client', () => synapse);
vi.mock('@/lib/azure/adls-client', () => ({
  KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing'],
  pathToHttpsUrl: (c: string, p: string) => `https://acct1.dfs.core.windows.net/${c}/${p}`,
  pathToHttpsUrlFor: (a: string, c: string, p: string) => `https://${a}.dfs.core.windows.net/${c}/${p}`,
}));

import { GET as GET_ASSET } from '../[id]/route';
import { GET as GET_PREVIEW } from '../[id]/preview/route';
import { GET as GET_LINEAGE } from '../[id]/lineage/route';
import { DATASET_ITEM_NOT_FOUND } from '../_lib/dataset-item-scope';

const ctx = { params: Promise.resolve({ id: 'ds-1' }) } as any;
function req() {
  const url = new URL('http://x/?top=5');
  return { url: url.toString(), nextUrl: url } as any;
}

const ROUTES: Array<[string, (r: any, c: any) => Promise<Response>, () => unknown[]]> = [
  ['dataset/[id]', GET_ASSET as any, () => foundry.getDataAsset.mock.calls],
  ['dataset/[id]/preview', GET_PREVIEW as any, () => foundry.getDataAsset.mock.calls],
  ['dataset/[id]/lineage', GET_LINEAGE as any, () => foundry.getDataAssetLineage.mock.calls],
];

beforeEach(() => {
  vi.clearAllMocks();
  sess.current = { claims: { oid: 'oid-reader', tid: 'tid-1', upn: 'r@loom.test', groups: [] } };
  access.resolveItemAccessByOid.mockResolvedValue({ item: { id: 'ds-1' }, role: 'Viewer', via: 'workspace-acl', canWrite: false });
  admin.isTenantAdmin.mockReturnValue(false);
});

describe('dataset routes — require access to the dataset item', () => {
  for (const [name, GET, backendCalls] of ROUTES) {
    it(`${name}: a reader of the dataset item gets the answer`, async () => {
      const res = await GET(req(), ctx);
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
      expect(access.resolveItemAccessByOid).toHaveBeenCalledWith(sess.current, 'ds-1', 'dataset');
      expect(backendCalls()).toHaveLength(1);
    });

    it(`${name}: requires access to the dataset item — 404 with its code, before Foundry or Synapse`, async () => {
      access.resolveItemAccessByOid.mockResolvedValue(null);
      const res = await GET(req(), ctx);
      expect(res.status).toBe(404);
      const j = await res.json();
      expect(j).toMatchObject({ ok: false, code: DATASET_ITEM_NOT_FOUND });
      expect(j.remediation).toContain('issues/4826');
      expect(foundry.getDataAsset).not.toHaveBeenCalled();
      expect(foundry.getDataAssetLineage).not.toHaveBeenCalled();
      expect(synapse.executeQuery).not.toHaveBeenCalled();
    });

    it(`${name}: a tenant admin opens a data asset by name without a Loom item`, async () => {
      access.resolveItemAccessByOid.mockResolvedValue(null);
      admin.isTenantAdmin.mockReturnValue(true);
      const res = await GET(req(), ctx);
      expect(res.status).toBe(200);
      expect(backendCalls()).toHaveLength(1);
      expect((backendCalls()[0] as unknown[])[0]).toBe('ds-1');
    });

    it(`${name}: 401 with no session, before the access check`, async () => {
      sess.current = null;
      const res = await GET(req(), ctx);
      expect(res.status).toBe(401);
      expect(access.resolveItemAccessByOid).not.toHaveBeenCalled();
    });
  }

  it('the preview still samples rows for a reader', async () => {
    const res = await GET_PREVIEW(req(), ctx);
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, previewable: true, columns: ['a'] });
    expect(synapse.executeQuery).toHaveBeenCalledTimes(1);
  });
});
