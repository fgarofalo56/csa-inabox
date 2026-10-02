/**
 * Contract tests for GET /api/lakehouse/permissions — every read is scoped to
 * one lakehouse item.
 *
 * - With `lakehouseId`: the item is authorized for READ through
 *   `resolveItemAccessByOid`. A caller who cannot reach it gets 404 (the same
 *   answer every other lakehouse route gives) and no backend listing runs.
 *   tab=object lists role assignments only on the item's own container.
 * - Without `lakehouseId`: tab=object is refused for every caller (400
 *   `item_required`, the grant and the revoke answer the same); the SQL tabs
 *   answer only a tenant admin.
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
import {
  listContainerRoleAssignments, StorageAccountNotLocatedError, StorageRoleDeniedError,
} from '@/lib/azure/adls-client';
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
const ACCOUNT = 'acct';
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
    abfss: `abfss://${CONTAINER}@${ACCOUNT}.dfs.core.windows.net/${ROOT}`,
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
    expect(listingCalls()).toEqual({ ...NONE, rbac: [[CONTAINER, ACCOUNT]] });
    expect((resolveItemAccessByOid as any).mock.calls).toEqual([[member, LH, 'lakehouse']]);
  });

  // FAILS IF the container is taken only from the request: with no `container`
  // the row set would be [] (400) instead of the bound container.
  it('defaults to the bound container when none is named', async () => {
    (getSession as any).mockReturnValue(member);
    const res = await GET(getReq({ lakehouseId: LH, tab: 'object' }));
    expect(res.status).toBe(200);
    expect(listingCalls()).toEqual({ ...NONE, rbac: [[CONTAINER, ACCOUNT]] });
  });

  // FAILS IF the listing ignores the item's bound account (the code before this
  // change): the row set would be [['landing']] or [['landing', undefined]],
  // which lists the configured account's container of the same name.
  it('lists on the item\'s bound account when it is not the configured one', async () => {
    (getSession as any).mockReturnValue(member);
    (resolveLakehouseAbfss as any).mockResolvedValue({
      abfss: `abfss://${CONTAINER}@otheracct.dfs.core.windows.net/${ROOT}`,
      container: CONTAINER,
      root: ROOT,
    });
    const res = await GET(getReq({ lakehouseId: LH, tab: 'object' }));
    expect(res.status).toBe(200);
    expect(listingCalls()).toEqual({ ...NONE, rbac: [[CONTAINER, 'otheracct']] });
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
    expect((await res.json()).code).toBe('no_storage_binding');
    expect(listingCalls()).toEqual(NONE);
  });

  // FAILS IF an unreadable account falls back to the configured one: 200 and
  // the row set [['landing', undefined]]. `loom-lake` has a hyphen, which no
  // storage account name has, so `boundAccountOf` cannot read it.
  it('answers 409 when the bound account cannot be read, with no listing', async () => {
    (getSession as any).mockReturnValue(member);
    (resolveLakehouseAbfss as any).mockResolvedValue({
      abfss: `abfss://${CONTAINER}@loom-lake.dfs.core.windows.net/${ROOT}`,
      container: CONTAINER,
      root: ROOT,
    });
    const res = await GET(getReq({ lakehouseId: LH, tab: 'object' }));
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.code).toBe('storage_account_unreadable');
    expect(typeof j.remediation).toBe('string');
    expect(listingCalls()).toEqual(NONE);
  });

  // Each refusal carries the lakehouse routes' `code` and `remediation`. FAILS
  // IF a refusal goes back to `{ ok:false, error }` only (the code is then
  // undefined), or carries another refusal's code.
  it.each([
    ['a container other than the bound one', () => GET(getReq({ lakehouseId: LH, tab: 'object', container: 'gold' })), 403, 'outside_item_root'],
    ['a lakehouse the caller cannot reach', () => {
      (resolveItemAccessByOid as any).mockResolvedValue(null);
      return GET(getReq({ lakehouseId: LH, tab: 'object' }));
    }, 404, 'item_not_found'],
    ['a SQL tab on a lakehouse the caller cannot reach', () => {
      (resolveItemAccessByOid as any).mockResolvedValue(null);
      return GET(getReq({ lakehouseId: LH, tab: 'table' }));
    }, 404, 'item_not_found'],
    ['tab=object without lakehouseId', () => GET(getReq({ tab: 'object', container: CONTAINER })), 400, 'item_required'],
    ['a SQL tab without lakehouseId from a non-admin', () => GET(getReq({ tab: 'table' })), 403, 'admin_only'],
  ])('refusal envelope: %s', async (_l, call, status, code) => {
    (getSession as any).mockReturnValue(member);
    const res = await (call as () => Promise<Response>)();
    expect(res.status).toBe(status);
    const j = await res.json();
    expect([j.ok, j.code, typeof j.remediation, typeof j.error]).toEqual([false, code, 'string', 'string']);
    expect(listingCalls()).toEqual(NONE);
  });
});

describe('GET /api/lakehouse/permissions?tab=object — no lakehouseId', () => {
  // The object tab needs the item for every caller, as the grant and the
  // revoke do, so no row is listed that a revoke could not act on. FAILS IF
  // the tenant-admin form lists on the configured account again: the admin
  // row then answers 200 with the row set [['landing', '']].
  it.each([
    ['a member', member],
    ['a tenant admin', admin],
  ])('%s is refused with 400 item_required, with no listing', async (_l, who) => {
    (getSession as any).mockReturnValue(who);
    const res = await GET(getReq({ tab: 'object', container: CONTAINER }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect([body.code, typeof body.remediation]).toEqual(['item_required', 'string']);
    expect(body.error).toContain('lakehouseId');
    expect(listingCalls()).toEqual(NONE);
    expect((resolveItemAccessByOid as any).mock.calls).toEqual([]);
  });

  // The listing refusal reads as one sentence and points at the Permissions
  // dialog only: Share does not list. Breaks on the Round 7 text ("Listing
  // container role assignments need the lakehouse they belong to") or if the
  // Listing remediation names Share. The grant's remediation still names
  // Share (permissions-delete.test.ts), so the difference is per verb.
  it('the listing refusal text: "needs", and the remediation names the dialog, not Share', async () => {
    (getSession as any).mockReturnValue(member);
    const body = await (await GET(getReq({ tab: 'object', container: CONTAINER }))).json();
    expect(body.error).toMatch(
      /^Listing container role assignments needs the lakehouse they belong to \(lakehouseId\), so Loom reads /,
    );
    expect(body.remediation).toBe('Open the lakehouse and use its Permissions dialog, so the request names the item.');
    expect(body.remediation).not.toMatch(/Share/);
  });

  // POSITIVE, the same admin naming the item. FAILS IF the refusal above is
  // applied to every object-tab GET (400 here too).
  it('a tenant admin who names the lakehouse lists on its bound account', async () => {
    (getSession as any).mockReturnValue(admin);
    const res = await GET(getReq({ lakehouseId: LH, tab: 'object', container: CONTAINER }));
    expect(res.status).toBe(200);
    expect(listingCalls()).toEqual({ ...NONE, rbac: [[CONTAINER, ACCOUNT]] });
  });
});

describe('GET /api/lakehouse/permissions?tab=object — a bound account Resource Graph cannot place', () => {
  // FAILS IF the route does not map StorageAccountNotLocatedError: the answer
  // is then the generic 502 with no `code` and no `remediation`.
  it('answers 409 storage_account_not_located with the role-administrator remediation', async () => {
    (getSession as any).mockReturnValue(member);
    (listContainerRoleAssignments as any).mockRejectedValue(new StorageAccountNotLocatedError(ACCOUNT));
    const res = await GET(getReq({ lakehouseId: LH, tab: 'object' }));
    expect(res.status).toBe(409);
    const j = await res.json();
    expect([j.ok, j.code]).toEqual([false, 'storage_account_not_located']);
    // Breaks if the remediation names Reader on the subscription (Round 7):
    // that identity could locate the account but still not write a role there.
    expect(j.remediation).toContain(`Role Based Access Control Administrator on storage account "${ACCOUNT}"`);
    expect(j.remediation).toContain('platform/fiab/bicep/modules/landing-zone/storage-rbac-admin.bicep');
    expect(j.error).toContain(ACCOUNT);
  });

  // FAILS IF the route does not map StorageRoleDeniedError: the answer is then
  // a bare 403 with ARM's message and no `code` or `remediation`.
  it('a role read Azure refuses answers 403 storage_role_read_denied with the remediation', async () => {
    (getSession as any).mockReturnValue(member);
    (listContainerRoleAssignments as any).mockRejectedValue(new StorageRoleDeniedError(ACCOUNT, 'list', 'corr-read-1'));
    const res = await GET(getReq({ lakehouseId: LH, tab: 'object' }));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect([j.ok, j.code]).toEqual([false, 'storage_role_read_denied']);
    expect(j.remediation).toContain(`Role Based Access Control Administrator on storage account "${ACCOUNT}"`);
    // Breaks if the route drops the correlation id, or adds a field (such as
    // ARM's own message) beyond the five below.
    expect([j.correlationId, Object.keys(j).sort()])
      .toEqual(['corr-read-1', ['code', 'correlationId', 'error', 'ok', 'remediation']]);
  });

  // CONTROL: any other listing failure keeps the generic answer. FAILS IF
  // every error is mapped to the 409 (the status would be 409, with a code).
  it('another listing failure is still the generic 502', async () => {
    (getSession as any).mockReturnValue(member);
    (listContainerRoleAssignments as any).mockRejectedValue(new Error('ARM 500'));
    const res = await GET(getReq({ lakehouseId: LH, tab: 'object' }));
    expect(res.status).toBe(502);
    const j = await res.json();
    expect([j.ok, j.error, j.code]).toEqual([false, 'ARM 500', undefined]);
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
