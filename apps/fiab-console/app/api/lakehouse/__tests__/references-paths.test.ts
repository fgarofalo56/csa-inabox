/**
 * Contract tests for GET /api/lakehouse/references/paths (Reference-Lakehouse
 * federation, read-only listing).
 *
 * Item scope: the REFERENCED lakehouse is authorized for read with the
 * caller's own access to it, and the prefix is confined to that item's root in
 * its own container; an empty prefix lists the root. Refusals read the
 * `listPaths` CALL ROW SET, paired with a positive arm on the same fixture.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/adls-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/adls-client');
  return { ...actual, listPaths: vi.fn() };
});
vi.mock('@/lib/azure/lakehouse-abfss', () => ({ resolveLakehouseAbfss: vi.fn() }));
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));

import { GET } from '../references/paths/route';
import { getSession } from '@/lib/auth/session';
import { listPaths } from '@/lib/azure/adls-client';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';

const REF = 'lh-ref';
const CONTAINER = 'silver';
const ROOT = 'lakehouses/AgencyB--lh-ref';
const req = (qs: string) => ({ nextUrl: new URL(`http://x/api/lakehouse/references/paths?${qs}`) } as any);
const listed = () => (listPaths as any).mock.calls.map((c: any[]) => [c[0], c[1], c[3]]);

function refAccess(state: Record<string, unknown> = {}) {
  return { item: { id: REF, workspaceId: 'ws-1', itemType: 'lakehouse', state }, role: 'Viewer', via: 'workspace', canWrite: false };
}

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'o1', upn: 'u@x' } });
  (resolveItemAccessByOid as any).mockResolvedValue(refAccess());
  (resolveLakehouseAbfss as any).mockResolvedValue({ abfss: `abfss://${CONTAINER}@acct.dfs.core.windows.net/${ROOT}`, container: CONTAINER, root: ROOT });
  (listPaths as any).mockResolvedValue([{ name: `${ROOT}/Tables/orders`, isDirectory: true, size: 0 }]);
});

describe('GET /api/lakehouse/references/paths', () => {
  it('lists the referenced item root for an empty prefix (read access is enough)', async () => {
    const res = await GET(req(`refId=${REF}&container=${CONTAINER}&prefix=`));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.paths).toHaveLength(1);
    // Breaks if an empty prefix lists the container top level ('').
    expect(listed()).toEqual([[CONTAINER, ROOT, undefined]]);
    expect((resolveItemAccessByOid as any).mock.calls[0].slice(1)).toEqual([REF, 'lakehouse']);
  });

  it('lists a folder inside the referenced item root', async () => {
    await GET(req(`refId=${REF}&container=${CONTAINER}&prefix=${encodeURIComponent(`${ROOT}/Tables`)}`));
    expect(listed()).toEqual([[CONTAINER, `${ROOT}/Tables`, undefined]]);
  });

  it('routes a reference with its own storage account to that account', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(refAccess({ storageAccount: 'extacct' }));
    await GET(req(`refId=${REF}&container=${CONTAINER}&prefix=`));
    expect(listed()).toEqual([[CONTAINER, ROOT, 'extacct']]);
  });

  it('requires access to the referenced lakehouse item (404; nothing listed)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await GET(req(`refId=${REF}&container=${CONTAINER}&prefix=`));
    expect(res.status).toBe(404);
    expect(listed()).toEqual([]);
  });

  it.each([
    ['the container top level', 'Tables', 403],
    ['a sibling root sharing the prefix', `${ROOT}-archive`, 403],
    ['another lakehouse root', 'lakehouses/Other--lh-x', 403],
    ['a dot-dot segment', `${ROOT}/..`, 400],
  ])('confines the prefix to the referenced item root: %s', async (_label, prefix, status) => {
    const res = await GET(req(`refId=${REF}&container=${CONTAINER}&prefix=${encodeURIComponent(prefix)}`));
    expect(res.status).toBe(status);
    expect(listed()).toEqual([]);
  });

  it('confines the listing to the referenced item container (403 for another container)', async () => {
    const res = await GET(req(`refId=${REF}&container=gold&prefix=`));
    expect(res.status).toBe(403);
    expect(listed()).toEqual([]);
  });

  it('400 without refId', async () => {
    const res = await GET(req(`container=${CONTAINER}`));
    expect(res.status).toBe(400);
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
  });
});
