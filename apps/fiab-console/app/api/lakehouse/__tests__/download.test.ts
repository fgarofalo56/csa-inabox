/**
 * Backend contract tests for GET /api/lakehouse/download — ADLS Gen2 byte
 * passthrough backing the lakehouse explorer's right-click "Download".
 *
 * Two request forms:
 *
 *   ITEM FORM (`lakehouseId=`) — what the lakehouse editor sends. The item is
 *   authorized through `resolveItemAccessByOid`, its container + root come from
 *   `resolveLakehouseAbfss`, and the file must sit strictly below that root,
 *   compared segment by segment.
 *
 *   STORAGE FORM (no `lakehouseId`) — names a container + path directly. Only a
 *   tenant admin may use it; everyone else is refused before any storage call.
 *
 * Every refusal reads the `downloadFile` CALL ROW SET, not only the status, and
 * is paired with a positive arm: "nothing reached storage" alone is satisfied by
 * deleting the route.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/adls-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/adls-client');
  return { ...actual, downloadFile: vi.fn() };
});
// `resolveLakehouseStorage` is a plain function (not a vi.fn, so a
// resetAllMocks cannot clear it) that DELEGATES to the `resolveLakehouseAbfss`
// mock: a bound value is `{ ok: true, bound }`, null is `no-storage`, and
// `{ withheld: <reason> }` is that withheld reason. The message function is
// the REAL one, so asserted text is the resolver module's own wording.
vi.mock('@/lib/azure/lakehouse-abfss', async () => {
  const actual: any = await vi.importActual('@/lib/azure/lakehouse-abfss');
  const resolveLakehouseAbfss = vi.fn();
  return {
    lakehouseStorageWithheldMessage: actual.lakehouseStorageWithheldMessage,
    resolveLakehouseAbfss,
    resolveLakehouseStorage: async (...a: any[]) => {
      const b: any = await resolveLakehouseAbfss(...a);
      if (b && typeof b === 'object' && 'withheld' in b) return { ok: false, reason: b.withheld };
      return b ? { ok: true, bound: b } : { ok: false, reason: 'no-storage' };
    },
  };
});
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));

import { GET } from '../download/route';
import { getSession } from '@/lib/auth/session';
import { downloadFile } from '@/lib/azure/adls-client';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';

function getReq(qs: string) { return { nextUrl: new URL(`http://x/api/lakehouse/download?${qs}`) } as any; }

const ADMIN_OID = 'oid-tenant-admin';
const MEMBER_OID = 'oid-member';
const admin = { claims: { oid: ADMIN_OID, upn: 'admin@x' } };
const member = { claims: { oid: MEMBER_OID, upn: 'member@x' } };

const LH = 'lh-dl';
const CONTAINER = 'landing';
const ROOT = 'lakehouses/Sales--lh-dl';
const INSIDE = `${ROOT}/Files/a.csv`;

let savedAdminOid: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  savedAdminOid = process.env.LOOM_TENANT_ADMIN_OID;
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN_OID;
  (resolveItemAccessByOid as any).mockResolvedValue({
    item: { id: LH, workspaceId: 'ws-1', itemType: 'lakehouse' },
    role: 'Viewer',
    via: 'workspace',
    canWrite: false,
  });
  (resolveLakehouseAbfss as any).mockResolvedValue({
    abfss: `abfss://${CONTAINER}@acct.dfs.core.windows.net/${ROOT}`,
    container: CONTAINER,
    root: ROOT,
  });
  (downloadFile as any).mockResolvedValue({ body: Buffer.from('hello'), contentType: 'text/csv', size: 5 });
});

afterEach(() => {
  if (savedAdminOid === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
  else process.env.LOOM_TENANT_ADMIN_OID = savedAdminOid;
});

describe('GET /api/lakehouse/download — storage form (tenant admin)', () => {
  it('401 when no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(getReq('container=bronze&path=a.csv'));
    expect(res.status).toBe(401);
  });

  it('400 when params missing', async () => {
    (getSession as any).mockReturnValue(admin);
    const res = await GET(getReq('container=bronze'));
    expect(res.status).toBe(400);
  });

  it('404 when container is unknown', async () => {
    (getSession as any).mockReturnValue(admin);
    const res = await GET(getReq('container=nope&path=a.csv'));
    expect(res.status).toBe(404);
  });

  it('streams bytes with attachment disposition on happy path', async () => {
    (getSession as any).mockReturnValue(admin);
    const res = await GET(getReq('container=bronze&path=data/a.csv'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment; filename="a.csv"');
    expect(res.headers.get('content-type')).toBe('text/csv');
    expect((downloadFile as any).mock.calls).toEqual([['bronze', 'data/a.csv']]);
  });

  it('404 when ADLS reports file not found', async () => {
    (getSession as any).mockReturnValue(admin);
    (downloadFile as any).mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const res = await GET(getReq('container=bronze&path=missing.csv'));
    expect(res.status).toBe(404);
  });

  // FAILS IF the storage form stops requiring a tenant admin: the status becomes
  // 200 and the row set [['bronze','data/a.csv']]. Paired with the happy path
  // above, which is the same request from the admin.
  it('refuses the storage form for a caller who is not a tenant admin', async () => {
    (getSession as any).mockReturnValue(member);
    const res = await GET(getReq('container=bronze&path=data/a.csv'));
    expect(res.status).toBe(403);
    expect((downloadFile as any).mock.calls).toEqual([]);
  });
});

describe('GET /api/lakehouse/download — item form', () => {
  // POSITIVE: a read-only member downloads a file inside the item's own root.
  // FAILS IF download asks for write access (403) or the containment test
  // refuses a genuine member (row set []).
  it('downloads a file inside the lakehouse root for a caller who can see the item', async () => {
    (getSession as any).mockReturnValue(member);
    const res = await GET(getReq(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(INSIDE)}`));
    expect(res.status).toBe(200);
    expect((downloadFile as any).mock.calls).toEqual([[CONTAINER, INSIDE]]);
    expect((resolveItemAccessByOid as any).mock.calls).toEqual([[member, LH, 'lakehouse']]);
  });

  // FAILS IF the item authorization is dropped or answered 403: the status
  // becomes 200 (row set 1) or 403.
  it('answers 404 for a lakehouse the caller cannot reach, with no storage call', async () => {
    (getSession as any).mockReturnValue(member);
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await GET(getReq(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(INSIDE)}`));
    expect(res.status).toBe(404);
    expect((downloadFile as any).mock.calls).toEqual([]);
    expect((resolveLakehouseAbfss as any).mock.calls).toEqual([]);
  });

  // FAILS IF containment is a string-prefix test: `lakehouses/Sales--lh-dl-archive`
  // starts with the root string, so the row set would become 1.
  it('refuses a sibling folder that shares a string prefix with the root', async () => {
    (getSession as any).mockReturnValue(member);
    const trap = `${ROOT}-archive/a.csv`;
    expect(trap.startsWith(ROOT)).toBe(true);
    const res = await GET(getReq(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(trap)}`));
    expect(res.status).toBe(403);
    expect((downloadFile as any).mock.calls).toEqual([]);
  });

  // FAILS IF `..` is folded rather than refused: `<root>/Files/../a.csv` folds
  // back inside the root and the row set would become [[landing, <root>/a.csv]].
  it('refuses a ".." segment', async () => {
    (getSession as any).mockReturnValue(member);
    const res = await GET(getReq(
      `lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(`${ROOT}/Files/../a.csv`)}`,
    ));
    expect(res.status).toBe(400);
    expect((downloadFile as any).mock.calls).toEqual([]);
  });

  // FAILS IF the container is taken from the caller rather than the binding:
  // the row set becomes [['gold', INSIDE]].
  it('refuses a container other than the one the lakehouse is bound to', async () => {
    (getSession as any).mockReturnValue(member);
    const res = await GET(getReq(`lakehouseId=${LH}&container=gold&path=${encodeURIComponent(INSIDE)}`));
    expect(res.status).toBe(403);
    expect((downloadFile as any).mock.calls).toEqual([]);
  });
});
