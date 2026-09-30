/**
 * Contract tests for GET /api/lakehouse/permissions — every read is scoped to
 * one lakehouse item.
 *
 * - With `lakehouseId`: the item is authorized for READ through
 *   `resolveItemAccessByOid`. A caller who cannot reach it gets 404 (the same
 *   answer every other lakehouse route gives) and no backend listing runs.
 *   tab=object lists role assignments only on the item's own container.
 * - Without `lakehouseId`: only a tenant admin may list.
 *
 * Every refusal reads the CALL ROW SET of the backend listing it withholds, and
 * is paired with a positive arm on the same request shape, so "nothing was
 * listed" cannot be satisfied by a route that never lists anything.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/adls-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/adls-client');
  return { ...actual, listContainerRoleAssignments: vi.fn() };
});
vi.mock('@/lib/azure/synapse-permissions-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/synapse-permissions-client');
  return {
    ...actual,
    dedicatedTarget: vi.fn(),
    listSqlTables: vi.fn(),
    listSqlColumns: vi.fn(),
    listTableGrants: vi.fn(),
    listRlsPolicies: vi.fn(),
    listColumnDenyGrants: vi.fn(),
  };
});
// `resolveLakehouseStorage` delegates to the `resolveLakehouseAbfss` mock, as in
// the sibling lakehouse route specs: a bound value is `{ ok: true, bound }`,
// null is `no-storage`, `{ withheld: <reason> }` is that withheld reason.
vi.mock('@/lib/azure/lakehouse-abfss', async () => {
  const actual: any = await vi.importActual('@/lib/azure/lakehouse-abfss');
  const resolveLakehouseAbfss = vi.fn();
  return {
    lakehouseStorageWithheldMessage: actual.lakehouseStorageWithheldMessage,
    lakehouseStorageWithheldFields: actual.lakehouseStorageWithheldFields,
    resolveLakehouseAbfss,
    resolveLakehouseStorage: async (...a: any[]) => {
      const b: any = await resolveLakehouseAbfss(...a);
      if (b && typeof b === 'object' && 'withheld' in b) return { ok: false, reason: b.withheld };
      return b ? { ok: true, bound: b } : { ok: false, reason: 'no-storage' };
    },
  };
});
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));

import { GET } from '../permissions/route';
import { getSession } from '@/lib/auth/session';
import { listContainerRoleAssignments } from '@/lib/azure/adls-client';
import {
  dedicatedTarget, listSqlTables, listSqlColumns, listTableGrants, listRlsPolicies, listColumnDenyGrants,
} from '@/lib/azure/synapse-permissions-client';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';

const ADMIN_OID = 'oid-tenant-admin';
const admin = { claims: { oid: ADMIN_OID, upn: 'admin@x' } };
const member = { claims: { oid: 'oid-member', upn: 'member@x' } };

const LH = 'lh-perm';
const CONTAINER = 'landing';
const ROOT = 'lakehouses/Sales--lh-perm';
const TARGET = { server: 's', database: 'd' };

function getReq(q: Record<string, string>) {
  return { nextUrl: new URL(`http://x/api/lakehouse/permissions?${new URLSearchParams(q).toString()}`) } as any;
}

/** Every backend listing the GET can make, in one row set per mock. */
function listingCalls() {
  return {
    rbac: (listContainerRoleAssignments as any).mock.calls,
    tables: (listSqlTables as any).mock.calls,
    columns: (listSqlColumns as any).mock.calls,
    grants: (listTableGrants as any).mock.calls,
    rls: (listRlsPolicies as any).mock.calls,
    deny: (listColumnDenyGrants as any).mock.calls,
  };
}
const NONE = { rbac: [], tables: [], columns: [], grants: [], rls: [], deny: [] };

let savedAdminOid: string | undefined;
let savedAdminGroup: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  savedAdminOid = process.env.LOOM_TENANT_ADMIN_OID;
  savedAdminGroup = process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN_OID;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
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
  (listContainerRoleAssignments as any).mockResolvedValue([]);
  (dedicatedTarget as any).mockReturnValue(TARGET);
  (listSqlTables as any).mockResolvedValue([{ objectId: 7, schema: 'dbo', name: 'orders', type: 'U' }]);
  (listSqlColumns as any).mockResolvedValue([{ columnId: 1, name: 'region', dataType: 'varchar' }]);
  (listTableGrants as any).mockResolvedValue([]);
  (listRlsPolicies as any).mockResolvedValue([]);
  (listColumnDenyGrants as any).mockResolvedValue([]);
});

afterEach(() => {
  if (savedAdminOid === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
  else process.env.LOOM_TENANT_ADMIN_OID = savedAdminOid;
  if (savedAdminGroup === undefined) delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  else process.env.LOOM_TENANT_ADMIN_GROUP_ID = savedAdminGroup;
});

describe('GET /api/lakehouse/permissions?tab=object — the item container', () => {
  // POSITIVE: a read-only member lists the assignments on the item's container.
  // FAILS IF the GET asks for write access (403), or the item authorization is
  // not the one consulted (the resolveItemAccessByOid row set would differ).
  it('a member of the lakehouse lists role assignments on its container', async () => {
    (getSession as any).mockReturnValue(member);
    const res = await GET(getReq({ lakehouseId: LH, tab: 'object', container: CONTAINER }));
    expect(res.status).toBe(200);
    expect(listingCalls()).toEqual({ ...NONE, rbac: [[CONTAINER]] });
    expect((resolveItemAccessByOid as any).mock.calls).toEqual([[member, LH, 'lakehouse']]);
  });

  // FAILS IF the container is taken only from the request: with no `container`
  // the row set would be [] (400) instead of the bound container.
  it('defaults to the bound container when none is named', async () => {
    (getSession as any).mockReturnValue(member);
    const res = await GET(getReq({ lakehouseId: LH, tab: 'object' }));
    expect(res.status).toBe(200);
    expect(listingCalls()).toEqual({ ...NONE, rbac: [[CONTAINER]] });
  });

  // FAILS IF the named container is not compared with the binding: the status
  // becomes 200 and the row set [['gold']].
  it('refuses a container other than the one the lakehouse is bound to', async () => {
    (getSession as any).mockReturnValue(member);
    const res = await GET(getReq({ lakehouseId: LH, tab: 'object', container: 'gold' }));
    expect(res.status).toBe(403);
    expect(listingCalls()).toEqual(NONE);
  });

  // FAILS IF the item is not authorized (200, row set [['landing']]) or the
  // refusal is 403 rather than 404.
  it('answers 404 to a caller who cannot reach the lakehouse, with no listing', async () => {
    (getSession as any).mockReturnValue(member);
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await GET(getReq({ lakehouseId: LH, tab: 'object', container: CONTAINER }));
    expect(res.status).toBe(404);
    expect(listingCalls()).toEqual(NONE);
    expect((resolveLakehouseAbfss as any).mock.calls).toEqual([]);
  });

  // A binding the resolver withholds is answered by the resolver's own
  // response. FAILS IF the route falls back to the caller's container: the
  // status becomes 200 and the row set [['landing']].
  it('lists nothing when the item has no storage binding', async () => {
    (getSession as any).mockReturnValue(member);
    (resolveLakehouseAbfss as any).mockResolvedValue(null);
    const res = await GET(getReq({ lakehouseId: LH, tab: 'object', container: CONTAINER }));
    expect(res.status).toBe(409);
    expect(listingCalls()).toEqual(NONE);
  });
});

describe('GET /api/lakehouse/permissions — no lakehouseId', () => {
  // FAILS IF a listing without an item is open to every session: 200 and the
  // row set [['landing']].
  it('refuses a caller who is not a tenant admin, with no listing', async () => {
    (getSession as any).mockReturnValue(member);
    const res = await GET(getReq({ tab: 'object', container: CONTAINER }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('lakehouseId');
    expect(listingCalls()).toEqual(NONE);
  });

  // POSITIVE, same request from a tenant admin. FAILS IF the admin path is
  // closed too (403), or it consults an item it was never given.
  it('a tenant admin lists without an item', async () => {
    (getSession as any).mockReturnValue(admin);
    const res = await GET(getReq({ tab: 'object', container: CONTAINER }));
    expect(res.status).toBe(200);
    expect(listingCalls()).toEqual({ ...NONE, rbac: [[CONTAINER]] });
    expect((resolveItemAccessByOid as any).mock.calls).toEqual([]);
  });
});

/**
 * The SQL-plane reads, one row per query shape, each with the ONE listing it
 * makes. A non-member, a member, a tenant admin without an item, and a
 * non-admin without an item are all asked the same query.
 */
const SQL_READS: Array<{ name: string; q: Record<string, string>; expect: Partial<typeof NONE> }> = [
  { name: 'tab=table grants', q: { tab: 'table' }, expect: { grants: [[TARGET]] } },
  { name: 'tab=row policies', q: { tab: 'row' }, expect: { rls: [[TARGET]] } },
  { name: 'tab=cls deny grants', q: { tab: 'cls' }, expect: { deny: [[TARGET]], grants: [[TARGET]] } },
  { name: 'list=tables', q: { tab: 'table', list: 'tables' }, expect: { tables: [[TARGET]] } },
  { name: 'list=columns', q: { tab: 'column', list: 'columns', objectId: '7' }, expect: { columns: [[TARGET, 7]] } },
];

describe.each(SQL_READS)('GET /api/lakehouse/permissions — SQL plane, $name', ({ q, expect: listed }) => {
  // FAILS IF the SQL-plane reads skip the item check: 200 and the listing row.
  it('answers 404 to a caller who cannot reach the lakehouse, with no query', async () => {
    (getSession as any).mockReturnValue(member);
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await GET(getReq({ ...q, lakehouseId: LH }));
    expect(res.status).toBe(404);
    expect(listingCalls()).toEqual(NONE);
  });

  // POSITIVE. FAILS IF a read-only member is refused, or the storage binding
  // gates a SQL read (no storage is resolved for these tabs: row set []).
  it('a member of the lakehouse reads it', async () => {
    (getSession as any).mockReturnValue(member);
    const res = await GET(getReq({ ...q, lakehouseId: LH }));
    expect(res.status).toBe(200);
    expect(listingCalls()).toEqual({ ...NONE, ...listed });
    expect((resolveLakehouseAbfss as any).mock.calls).toEqual([]);
  });

  // FAILS IF the SQL-plane reads stay session-only: 200 and the listing row.
  it('refuses a non-admin without lakehouseId, with no query', async () => {
    (getSession as any).mockReturnValue(member);
    const res = await GET(getReq(q));
    expect(res.status).toBe(403);
    expect(listingCalls()).toEqual(NONE);
  });

  // POSITIVE for the admin path.
  it('a tenant admin reads without an item', async () => {
    (getSession as any).mockReturnValue(admin);
    const res = await GET(getReq(q));
    expect(res.status).toBe(200);
    expect(listingCalls()).toEqual({ ...NONE, ...listed });
  });
});
