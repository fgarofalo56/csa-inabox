/**
 * /api/onelake/tier — authorization + path containment (#4619).
 *
 * PUT is tenant-admin for now: the confinement relies on a lakehouse root read
 * from item state, which is not yet server-owned. It becomes item-scoped once
 * #4777's server-owned roots land. An admin's PUT still runs every check.
 *
 * GET is item-scoped: a non-admin names the lakehouse (`lakehouseId`) the file
 * belongs to; the route checks the caller's access to that item, then that the
 * path lies in the lakehouse's bound container, strictly below its bound root.
 * Without `lakehouseId` only a tenant admin may read. Each load-bearing
 * assertion names the input that breaks it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));
vi.mock('@/lib/azure/lakehouse-abfss', () => ({ resolveLakehouseAbfss: vi.fn() }));
vi.mock('@/lib/azure/adls-client', () => ({
  KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing', 'csv-imports'],
  getAccountName: vi.fn(),
  getBlobTier: vi.fn(),
  setBlobTier: vi.fn(),
  copyBlobToTier: vi.fn(),
}));

import { GET, PUT } from '../tier/route';
import { getSession } from '@/lib/auth/session';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { getAccountName, getBlobTier, setBlobTier, copyBlobToTier } from '@/lib/azure/adls-client';
import { TIER_CHANGE_ADMIN_ONLY } from '@/lib/util/admin-only-copy';

const user = { claims: { upn: 'u@x', tid: 't1', oid: 'user-oid' } };
const admin = { claims: { upn: 'a@x', tid: 't1', oid: 'admin-oid' } };

const LH = 'lh-1';
const ROOT = 'lakehouses/Sales';
/** A file inside the lakehouse root. */
const IN = `${ROOT}/Files/a.csv`;
const BOUND = { abfss: `abfss://bronze@acctlake.dfs.core.windows.net/${ROOT}`, container: 'bronze', root: ROOT };

function access(canWrite: boolean) {
  return { item: { id: LH, workspaceId: 'ws-1' }, role: canWrite ? 'Member' : 'Viewer', via: 'acl', canWrite };
}

function putReq(body: Record<string, unknown>) {
  return { json: async () => body, nextUrl: new URL('http://x/api/onelake/tier') } as any;
}
const put = (fields: Record<string, unknown>) => PUT(putReq({ tier: 'Cool', ...fields }), {} as any);
function getReq(q: Record<string, string>) {
  const u = new URL('http://x/api/onelake/tier');
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return { nextUrl: u } as any;
}

/** Every path shape the route must refuse as not a plain relative path. */
const BAD_PATHS: Array<[string, string]> = [
  ['a ".." segment', `${ROOT}/../../other/blob.csv`],
  ['a backslash ".." segment', 'lakehouses\\Sales\\..\\..\\blob.csv'],
  ['a trailing ".." segment', `${ROOT}/..`],
  ['a "." segment', `${ROOT}/./Files/a.csv`],
  ['a leading slash', `/${IN}`],
  ['a leading backslash', '\\lakehouses\\Sales\\a.csv'],
  ['a NUL', `${ROOT}/blob\u0000.csv`],
  ['a control character', `${ROOT}/blob\u001f.csv`],
  ['a DEL', `${ROOT}/blob\u007f.csv`],
  ['an over-long path', `${ROOT}/${'a'.repeat(1025)}`],
];

function sinkCalls() {
  return (getBlobTier as any).mock.calls.length
    + (setBlobTier as any).mock.calls.length
    + (copyBlobToTier as any).mock.calls.length;
}

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid';
  (getAccountName as any).mockReturnValue('acctlake');
  (resolveItemAccessByOid as any).mockResolvedValue(access(true));
  (resolveLakehouseAbfss as any).mockResolvedValue(BOUND);
  (getBlobTier as any).mockResolvedValue({ tier: 'Hot' });
  (setBlobTier as any).mockResolvedValue({ tier: 'Cool' });
  (copyBlobToTier as any).mockResolvedValue({ tier: 'Hot' });
});

describe('PUT /api/onelake/tier — tenant admin until roots are server-owned', () => {
  it('401 without a session, and the sink is never called', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await put({ lakehouseId: LH, container: 'bronze', path: IN })).status).toBe(401);
    expect(sinkCalls()).toBe(0);
  });

  it.each([
    ['with WRITE access to the lakehouse, inside its root', { lakehouseId: LH, container: 'bronze', path: IN }],
    ['who names no lakehouse', { container: 'bronze', path: IN }],
  ])('403 admin_only for a non-admin %s, before any lookup or sink', async (_l, fields) => {
    // Breaks if PUT goes back to item-scoped for non-admins (the round-2
    // shape: the first row answered 200), or if the gate moves after the
    // item lookup (resolveItemAccessByOid would be called).
    (getSession as any).mockReturnValue(user);
    const res = await put(fields);
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.code).toBe('admin_only');
    // The envelope names THIS verb, not the unscoped-request text.
    expect(j.reason).toBe(TIER_CHANGE_ADMIN_ONLY.reason);
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
    expect(sinkCalls()).toBe(0);
  });

  it('a tenant admin naming the lakehouse changes a tier inside its root (positive pair)', async () => {
    // Breaks if admins were refused too, or if the item lookup / binding
    // lookup stopped using this lakehouse.
    (getSession as any).mockReturnValue(admin);
    const res = await put({ lakehouseId: LH, container: 'bronze', path: IN });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect((resolveItemAccessByOid as any).mock.calls[0].slice(1)).toEqual([LH, 'lakehouse']);
    expect(resolveLakehouseAbfss).toHaveBeenCalledWith(LH, 'ws-1');
    expect(setBlobTier).toHaveBeenCalledWith('bronze', IN, 'Cool');
  });

  it('a tenant admin who names no lakehouse still reaches the sink', async () => {
    // Breaks if the unscoped branch refused admins too.
    (getSession as any).mockReturnValue(admin);
    const res = await put({ container: 'silver', path: 'anything/a.csv' });
    expect(res.status).toBe(200);
    expect(setBlobTier).toHaveBeenCalledWith('silver', 'anything/a.csv', 'Cool');
  });

  it('404 when the item lookup finds nothing, and no sink', async () => {
    // Breaks if a null access verdict were treated as an allow.
    (getSession as any).mockReturnValue(admin);
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    expect((await put({ lakehouseId: LH, container: 'bronze', path: IN })).status).toBe(404);
    expect(resolveLakehouseAbfss).not.toHaveBeenCalled();
    expect(sinkCalls()).toBe(0);
  });

  it('403 when the item lookup reports a read-only role, and no sink', async () => {
    // Breaks if PUT did not require canWrite: the path is inside, so 200.
    (getSession as any).mockReturnValue(admin);
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await put({ lakehouseId: LH, container: 'bronze', path: IN });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/read-only/);
    expect(sinkCalls()).toBe(0);
  });
});

describe('PUT /api/onelake/tier — containment to the lakehouse root (as a tenant admin)', () => {
  it.each([
    ['another container', { container: 'silver', path: IN }],
    ['a sibling whose name only STARTS with the root', { container: 'bronze', path: `${ROOT}-archive/Files/a.csv` }],
    ['another lakehouse', { container: 'bronze', path: 'lakehouses/Other/Files/a.csv' }],
    ['the root folder itself', { container: 'bronze', path: ROOT }],
    ['the root folder with a trailing slash', { container: 'bronze', path: `${ROOT}/` }],
    ['a parent of the root', { container: 'bronze', path: 'lakehouses' }],
    ['a file outside every lakehouse', { container: 'bronze', path: 'raw/a.csv' }],
  ])('403 for %s, and the sink is never called', async (_l, fields) => {
    // Breaks if the container check, the strictly-below check, or the
    // segment-wise prefix compare were removed / made a string startsWith:
    // each target would then reach setBlobTier with a 200.
    (getSession as any).mockReturnValue(admin);
    const res = await put({ lakehouseId: LH, ...fields });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/outside this lakehouse/);
    expect(sinkCalls()).toBe(0);
  });

  it('forwards the path REBUILT from its checked segments', async () => {
    // Breaks if the raw request path were forwarded: storage would receive the
    // backslash-and-double-slash spelling instead of the checked one.
    (getSession as any).mockReturnValue(admin);
    const res = await put({ lakehouseId: LH, container: 'bronze', path: 'lakehouses\\Sales//Files\\a.csv' });
    expect(res.status).toBe(200);
    expect(setBlobTier).toHaveBeenCalledWith('bronze', IN, 'Cool');
  });

  it('409 when the lakehouse has no storage binding', async () => {
    // Breaks if an unbound lakehouse fell through to the shared containers.
    (getSession as any).mockReturnValue(admin);
    (resolveLakehouseAbfss as any).mockResolvedValue(null);
    expect((await put({ lakehouseId: LH, container: 'bronze', path: IN })).status).toBe(409);
    expect(sinkCalls()).toBe(0);
  });

  it.each([
    ['an empty root', { ...BOUND, root: '' }],
    ['a root that is only slashes', { ...BOUND, root: '/' }],
    ['a root with a ".." segment', { ...BOUND, root: 'lakehouses/..' }],
  ])('409 when the binding has %s', async (_l, bound) => {
    // Breaks if an empty root were accepted: every path in the container would
    // then be "below" it and reach the sink.
    (getSession as any).mockReturnValue(admin);
    (resolveLakehouseAbfss as any).mockResolvedValue(bound);
    expect((await put({ lakehouseId: LH, container: 'bronze', path: IN })).status).toBe(409);
    expect(sinkCalls()).toBe(0);
  });

  it.each([
    ['on another storage account', () => (resolveLakehouseAbfss as any).mockResolvedValue({ ...BOUND, abfss: BOUND.abfss.replace('@acctlake.', '@otheracct.') })],
    ['when no lake account is configured', () => (getAccountName as any).mockImplementation(() => { throw new Error('none'); })],
  ])('409 when the binding is %s', async (_l, arrange) => {
    // Breaks if the account check were removed: the tier call acts on the
    // deployment lake account, which is not where this lakehouse keeps files.
    (getSession as any).mockReturnValue(admin);
    arrange();
    expect((await put({ lakehouseId: LH, container: 'bronze', path: IN })).status).toBe(409);
    expect(sinkCalls()).toBe(0);
  });
});

describe('PUT /api/onelake/tier — path validation (as a tenant admin)', () => {
  it.each(BAD_PATHS)('400 on a path with %s, before any lookup or sink', async (_label, path) => {
    // Breaks if blobRelPathError were removed: several of these normalise to
    // a path inside the root, and all would at least reach the item lookup.
    (getSession as any).mockReturnValue(admin);
    const res = await put({ lakehouseId: LH, container: 'bronze', path });
    expect(res.status).toBe(400);
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
    expect(sinkCalls()).toBe(0);
  });

  it('a dotted-but-legal name like "a..b.csv" is still accepted', async () => {
    // Breaks if ".." were matched as a substring rather than as a whole segment.
    (getSession as any).mockReturnValue(admin);
    const res = await put({ lakehouseId: LH, container: 'bronze', path: `${ROOT}/Files/a..b.csv` });
    expect(res.status).toBe(200);
    expect(setBlobTier).toHaveBeenCalledWith('bronze', `${ROOT}/Files/a..b.csv`, 'Cool');
  });
});

describe('GET /api/onelake/tier', () => {
  it('403 admin_only for a non-admin who names no lakehouse, before the tier read', async () => {
    // Breaks if an unscoped GET were served to any session: getBlobTier would
    // run and report the blob's existence and tier.
    (getSession as any).mockReturnValue(user);
    const res = await GET(getReq({ container: 'bronze', path: IN }), {} as any);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('admin_only');
    expect(getBlobTier).not.toHaveBeenCalled();
  });

  it('a READ-only role on the lakehouse can read a tier inside its root (positive pair)', async () => {
    // Breaks if GET required a write role, or stopped reading the tier.
    (getSession as any).mockReturnValue(user);
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await GET(getReq({ lakehouseId: LH, container: 'bronze', path: IN }), {} as any);
    expect(res.status).toBe(200);
    expect(getBlobTier).toHaveBeenCalledWith('bronze', IN);
  });

  it('403 for a path outside the lakehouse root, before the tier read', async () => {
    // Breaks if GET skipped containment: another lakehouse's file would be read.
    (getSession as any).mockReturnValue(user);
    const res = await GET(getReq({ lakehouseId: LH, container: 'bronze', path: 'lakehouses/Other/a.csv' }), {} as any);
    expect(res.status).toBe(403);
    expect(getBlobTier).not.toHaveBeenCalled();
  });

  it('404 when the caller cannot reach the lakehouse', async () => {
    // Breaks if GET skipped the item lookup.
    (getSession as any).mockReturnValue(user);
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    expect((await GET(getReq({ lakehouseId: LH, container: 'bronze', path: IN }), {} as any)).status).toBe(404);
    expect(getBlobTier).not.toHaveBeenCalled();
  });

  it.each(BAD_PATHS)('400 on a path with %s, before the tier read', async (_label, path) => {
    (getSession as any).mockReturnValue(user);
    const res = await GET(getReq({ lakehouseId: LH, container: 'bronze', path }), {} as any);
    expect(res.status).toBe(400);
    expect(getBlobTier).not.toHaveBeenCalled();
  });
});
