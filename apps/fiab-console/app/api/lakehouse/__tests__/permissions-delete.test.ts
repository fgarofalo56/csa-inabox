/**
 * Contract tests for the write verbs of /api/lakehouse/permissions.
 *
 * DELETE uses the same tenant-admin rule as POST, with the same 403 body. The
 * object-tab writes name the lakehouse (`lakehouseId`) and act on the
 * container AND the storage account that item is bound to — the same account
 * the GET lists on. For a revoke, the role-assignment id must (1) have the
 * shape of an assignment at the item container's scope and (2) be one of the
 * assignments listed on that container ON THAT ACCOUNT; the id handed to
 * `revokeContainerRoleAssignment` is the listed one.
 *
 * The fixture binds the lakehouse on `otheracct`, which is NOT the configured
 * account (`loomlake01`). The listing mock answers per account: `otheracct`
 * holds LISTED, the configured account holds CONFIGURED_LISTED on a container
 * of the same name. So a write that ignores the item's account is caught by
 * the account it reaches, not only by an argument count.
 *
 * Every refusal reads the CALL ROW SET of `listContainerRoleAssignments` /
 * `revokeContainerRoleAssignment` / `grantContainerRole` / `dropRlsPolicy`, and
 * is paired with a positive arm on the same fixture, so "nothing was revoked"
 * cannot be satisfied by a route that never revokes anything.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/adls-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/adls-client');
  return {
    ...actual,
    listContainerRoleAssignments: vi.fn(),
    revokeContainerRoleAssignment: vi.fn(),
    grantContainerRole: vi.fn(),
  };
});
vi.mock('@/lib/azure/synapse-permissions-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/synapse-permissions-client');
  return { ...actual, dedicatedTarget: vi.fn(), dropRlsPolicy: vi.fn() };
});
// Same resolver shape as permissions-get.test.ts: a bound value is
// `{ ok: true, bound }`, null is `no-storage`.
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

import { DELETE, POST } from '../permissions/route';
import { isContainerRoleAssignmentId } from '../_lib/container-role-assignment';
import { getSession } from '@/lib/auth/session';
import {
  listContainerRoleAssignments, revokeContainerRoleAssignment, grantContainerRole, StorageAccountNotLocatedError,
  StorageRoleDeniedError,
} from '@/lib/azure/adls-client';
import { dedicatedTarget, dropRlsPolicy } from '@/lib/azure/synapse-permissions-client';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';

const ADMIN_OID = 'oid-tenant-admin';
const admin = { claims: { oid: ADMIN_OID, upn: 'admin@x' } };
const member = { claims: { oid: 'oid-member', upn: 'member@x' } };

const LH = 'lh-perm';
const SUB = '11111111-2222-3333-4444-555555555555';
const GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const GUID_CONFIGURED = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';
const CONTAINER = 'landing';
const ROOT = 'lakehouses/Sales--lh-perm';
/** The account the lakehouse is bound to. */
const BOUND = 'otheracct';
/** The deployment's configured account, which the lakehouse is NOT on. */
const CONFIGURED = 'loomlake01';
const scopeOf = (c: string, acct = BOUND) =>
  `/subscriptions/${SUB}/resourceGroups/rg-loom/providers/Microsoft.Storage/storageAccounts/${acct}/blobServices/default/containers/${c}`;
const assignmentOn = (c: string, g = GUID, acct = BOUND) =>
  `${scopeOf(c, acct)}/providers/Microsoft.Authorization/roleAssignments/${g}`;
/** Listed on the item's container on the BOUND account. */
const LISTED = assignmentOn(CONTAINER);
/** Listed on the same-named container on the CONFIGURED account. */
const CONFIGURED_LISTED = assignmentOn(CONTAINER, GUID_CONFIGURED, CONFIGURED);
const READER = 'Storage Blob Data Reader';

function delReq(qs: string) {
  return { nextUrl: new URL(`http://x/api/lakehouse/permissions?${qs}`), json: async () => ({}) } as any;
}
function postReq(body: any) {
  return { nextUrl: new URL('http://x/api/lakehouse/permissions'), json: async () => body } as any;
}
const objectQs = (id: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({ tab: 'object', lakehouseId: LH, container: CONTAINER, id, ...extra }).toString();
const grantBody = (extra: Record<string, unknown> = {}) =>
  ({ tab: 'object', lakehouseId: LH, container: CONTAINER, principalId: 'p1', role: READER, ...extra });

/** Every backend call a write can make, one row set per mock. */
function writeCalls() {
  return {
    list: (listContainerRoleAssignments as any).mock.calls,
    revoke: (revokeContainerRoleAssignment as any).mock.calls,
    grant: (grantContainerRole as any).mock.calls,
  };
}
const NO_WRITES = { list: [], revoke: [], grant: [] };

let savedAdminOid: string | undefined;
let savedAdminGroup: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  savedAdminOid = process.env.LOOM_TENANT_ADMIN_OID;
  savedAdminGroup = process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN_OID;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  (getSession as any).mockReturnValue(admin);
  (resolveItemAccessByOid as any).mockResolvedValue({
    item: { id: LH, workspaceId: 'ws-1', itemType: 'lakehouse' },
    role: 'Admin',
    via: 'workspace',
    canWrite: true,
  });
  (resolveLakehouseAbfss as any).mockResolvedValue({
    abfss: `abfss://${CONTAINER}@${BOUND}.dfs.core.windows.net/${ROOT}`,
    container: CONTAINER,
    root: ROOT,
  });
  // Per account: the bound account's container holds LISTED; the configured
  // account's container of the same name (the default, no account) holds
  // CONFIGURED_LISTED.
  (listContainerRoleAssignments as any).mockImplementation(async (_c: string, acct?: string) => (
    acct === BOUND
      ? [{ id: LISTED, principalId: 'p1', principalType: 'User', roleName: READER }]
      : [{ id: CONFIGURED_LISTED, principalId: 'p9', principalType: 'User', roleName: READER }]
  ));
  (revokeContainerRoleAssignment as any).mockResolvedValue(undefined);
  (grantContainerRole as any).mockResolvedValue({ id: LISTED });
  (dedicatedTarget as any).mockReturnValue({ server: 's', database: 'd' });
  (dropRlsPolicy as any).mockResolvedValue({ dropped: true });
});

afterEach(() => {
  if (savedAdminOid === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
  else process.env.LOOM_TENANT_ADMIN_OID = savedAdminOid;
  if (savedAdminGroup === undefined) delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  else process.env.LOOM_TENANT_ADMIN_GROUP_ID = savedAdminGroup;
});

describe('fixture', () => {
  // The two listed ids differ only by account and GUID, and each is a
  // well-formed assignment on the container, so only the ACCOUNT the listing
  // runs on decides which one a revoke finds. Breaks if the fixture's ids
  // collapse to one account (the account tests below would then prove nothing).
  it('lists a different assignment on the bound and the configured account', () => {
    expect([BOUND === CONFIGURED, LISTED === CONFIGURED_LISTED]).toEqual([false, false]);
    expect([isContainerRoleAssignmentId(LISTED, CONTAINER), isContainerRoleAssignmentId(CONFIGURED_LISTED, CONTAINER)])
      .toEqual([true, true]);
  });
});

describe('DELETE /api/lakehouse/permissions — tenant admin, like POST', () => {
  it('a tenant admin revokes an assignment listed on the item\'s bound account (positive arm)', async () => {
    const res = await DELETE(delReq(objectQs(LISTED)));
    expect(res.status).toBe(200);
    // Breaks if the membership listing ignores the item's account: the listing
    // row becomes [landing] / [landing, undefined], LISTED is not found there,
    // and the answer is 404 with no revoke row.
    expect(writeCalls()).toEqual({ ...NO_WRITES, list: [[CONTAINER, BOUND]], revoke: [[LISTED]] });
  });

  it('requires tenant-admin; 403 with the same body shape POST returns, nothing listed or revoked', async () => {
    (getSession as any).mockReturnValue(member);
    const del = await DELETE(delReq(objectQs(LISTED)));
    const post = await POST(postReq(grantBody()));
    expect(del.status).toBe(403);
    expect(post.status).toBe(403);
    const dj = await del.json();
    const pj = await post.json();
    // Breaks if DELETE drops the admin check (200 + a revoke row) or answers
    // with a different body than POST.
    expect(Object.keys(dj).sort()).toEqual(Object.keys(pj).sort());
    // Callers render `error`: it must be the sentence, not a bare code. Breaks
    // if `error` goes back to 'forbidden' with the sentence elsewhere.
    expect(dj.error).toMatch(/requires tenant-admin/);
    expect(pj.error).toMatch(/requires tenant-admin/);
    expect(dj.code).toBe('admin_only');
    expect(pj.code).toBe('admin_only');
    expect(dj.remediation).toMatch(/tenant admin|Azure portal/);
    // The next step travels in `remediation` only; a duplicate `hint` field
    // is gone. Breaks if `hint` is added back to the shared refusal body.
    expect(dj).not.toHaveProperty('hint');
    expect(pj).not.toHaveProperty('hint');
    expect(writeCalls()).toEqual(NO_WRITES);
    expect((resolveItemAccessByOid as any).mock.calls).toEqual([]);
  });

  it('requires tenant-admin on the SQL-plane tabs too (tab=row drops nothing)', async () => {
    (getSession as any).mockReturnValue(member);
    const refused = await DELETE(delReq('tab=row&policyObjectId=42'));
    expect(refused.status).toBe(403);
    expect((dropRlsPolicy as any).mock.calls).toEqual([]);
    // Positive arm on the same request: the admin reaches dropRlsPolicy.
    (getSession as any).mockReturnValue(admin);
    const ok = await DELETE(delReq('tab=row&policyObjectId=42'));
    expect(ok.status).toBe(200);
    expect((dropRlsPolicy as any).mock.calls.length).toBe(1);
    expect((dropRlsPolicy as any).mock.calls[0][1]).toBe(42);
  });
});

describe('object-tab writes act on the item\'s bound storage account', () => {
  // Breaks if the grant ignores the item's account: the row ends in
  // `undefined` (or has four arguments), which grants on the configured
  // account's container of the same name.
  it('a grant is made on the bound account\'s container', async () => {
    const res = await POST(postReq(grantBody()));
    expect(res.status).toBe(200);
    expect(writeCalls()).toEqual({ ...NO_WRITES, grant: [[CONTAINER, 'p1', READER, 'User', BOUND]] });
  });

  // Breaks if the grant still needs the caller's container: with none named
  // the row would be [] (400) instead of the bound container.
  it('a grant with no container named uses the item\'s container', async () => {
    const res = await POST(postReq(grantBody({ container: undefined })));
    expect(res.status).toBe(200);
    expect(writeCalls().grant).toEqual([[CONTAINER, 'p1', READER, 'User', BOUND]]);
  });

  // The configured account holds an assignment with this id on a container of
  // the same name. Breaks if the revoke lists the configured account: the id is
  // found there, the answer is 200 and the revoke row is [CONFIGURED_LISTED].
  it('a revoke of an id listed only on the configured account is refused (404), nothing revoked', async () => {
    const res = await DELETE(delReq(objectQs(CONFIGURED_LISTED)));
    expect(res.status).toBe(404);
    expect(writeCalls()).toEqual({ ...NO_WRITES, list: [[CONTAINER, BOUND]] });
  });

  // Breaks if a write without an item is accepted: a 200 and a grant or revoke
  // row on the configured account. Positive arm: the same request with
  // `lakehouseId` (the first test in this describe, and the DELETE positive
  // arm above).
  it.each([
    ['POST', () => POST(postReq(grantBody({ lakehouseId: undefined })))],
    ['DELETE', () => DELETE(delReq(new URLSearchParams({ tab: 'object', container: CONTAINER, id: LISTED }).toString()))],
  ])('%s without lakehouseId is refused (400 item_required), nothing listed, granted or revoked', async (_v, call) => {
    const res = await call();
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.code).toBe('item_required');
    expect(j.error).toMatch(/lakehouseId/);
    expect(typeof j.remediation).toBe('string');
    expect(writeCalls()).toEqual(NO_WRITES);
    expect((resolveItemAccessByOid as any).mock.calls).toEqual([]);
  });

  // Breaks on the Round 7 grammar ("a container role needs the lakehouse they
  // belong to"). The write remediation names Share, since Share grants too;
  // the Listing one does not (permissions-get.test.ts).
  it.each([
    ['POST', 'Granting', () => POST(postReq(grantBody({ lakehouseId: undefined })))],
    ['DELETE', 'Revoking', () => DELETE(delReq(new URLSearchParams({ tab: 'object', container: CONTAINER, id: LISTED }).toString()))],
  ])('%s item_required text: "it belongs to", and the remediation names Share', async (_v, verb, call) => {
    const j = await (await (call as () => Promise<Response>)()).json();
    expect(j.error).toMatch(new RegExp(`^${verb} a container role needs the lakehouse it belongs to \\(lakehouseId\\), `));
    expect(j.remediation).toBe('Open the lakehouse and use its Permissions dialog or Share, so the request names the item.');
  });

  // A binding whose account cannot be read is a 409 on every write. Breaks if
  // the route falls back to the configured account: 200 and a grant or revoke
  // row. `loom-lake` has a hyphen, which no storage account name has.
  it.each([
    ['POST', () => POST(postReq(grantBody()))],
    ['DELETE', () => DELETE(delReq(objectQs(CONFIGURED_LISTED)))],
  ])('%s answers 409 when the bound account cannot be read, with no write', async (_v, call) => {
    (resolveLakehouseAbfss as any).mockResolvedValue({
      abfss: `abfss://${CONTAINER}@loom-lake.dfs.core.windows.net/${ROOT}`,
      container: CONTAINER,
      root: ROOT,
    });
    const res = await call();
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.code).toBe('storage_account_unreadable');
    expect(typeof j.remediation).toBe('string');
    expect(writeCalls()).toEqual(NO_WRITES);
  });

  // A bound account Resource Graph cannot place is a 409 with the role
  // administrator remediation on both writes. Breaks if POST's or DELETE's catch does not
  // map StorageAccountNotLocatedError: that verb answers the generic 502 with
  // no `code`. The grant mock throws it (grantContainerRole resolves the
  // account's coordinates first); for the revoke, the membership listing does.
  it.each([
    ['POST', () => {
      (grantContainerRole as any).mockRejectedValue(new StorageAccountNotLocatedError(BOUND));
      return POST(postReq(grantBody()));
    }, { list: 0, grant: 1 }],
    ['DELETE', () => {
      (listContainerRoleAssignments as any).mockRejectedValue(new StorageAccountNotLocatedError(BOUND));
      return DELETE(delReq(objectQs(LISTED)));
    }, { list: 1, grant: 0 }],
  ])('%s answers 409 storage_account_not_located when the bound account cannot be placed', async (_v, call, reached) => {
    const res = await (call as () => Promise<Response>)();
    expect(res.status).toBe(409);
    const j = await res.json();
    expect([j.ok, j.code]).toEqual([false, 'storage_account_not_located']);
    expect(j.remediation).toContain(`Role Based Access Control Administrator on storage account "${BOUND}"`);
    // Nothing was revoked; the failing call is the one the verb makes first.
    expect(writeCalls().revoke).toEqual([]);
    expect({ list: writeCalls().list.length, grant: writeCalls().grant.length }).toEqual(reached);
  });

  // A role create or delete that Azure refuses (a 403 from ARM, which
  // adls-client turns into StorageRoleDeniedError) is a coded 403 with the
  // remediation. Breaks if POST's or DELETE's catch does not map it: the answer
  // is then the error's bare 403 with no `code` and no `remediation`.
  it.each([
    ['POST', () => {
      (grantContainerRole as any).mockRejectedValue(new StorageRoleDeniedError(BOUND, 'grant', 'denied'));
      return POST(postReq(grantBody()));
    }, { grant: 1, revoke: 0 }],
    ['DELETE', () => {
      (revokeContainerRoleAssignment as any).mockRejectedValue(new StorageRoleDeniedError(BOUND, 'revoke', 'denied'));
      return DELETE(delReq(objectQs(LISTED)));
    }, { grant: 0, revoke: 1 }],
  ])('%s answers 403 storage_role_write_denied when Azure refuses the role write', async (_v, call, reached) => {
    const res = await (call as () => Promise<Response>)();
    expect(res.status).toBe(403);
    const j = await res.json();
    expect([j.ok, j.code]).toEqual([false, 'storage_role_write_denied']);
    expect(j.remediation).toContain(`Role Based Access Control Administrator on storage account "${BOUND}"`);
    expect(j.remediation).toContain('platform/fiab/bicep/modules/landing-zone/storage-rbac-admin.bicep');
    expect({ grant: writeCalls().grant.length, revoke: writeCalls().revoke.length }).toEqual(reached);
  });

  // CONTROL: another write failure is not given that code. Breaks if the
  // route maps every error with a status to storage_role_write_denied.
  it('a grant failure with another status keeps its own status and no code', async () => {
    const err: any = new Error('ARM 500');
    err.status = 500;
    (grantContainerRole as any).mockRejectedValue(err);
    const res = await POST(postReq(grantBody()));
    expect(res.status).toBe(500);
    const j = await res.json();
    expect([j.ok, j.error, j.code]).toEqual([false, 'ARM 500', undefined]);
  });

  // Breaks if the write skips the item check: 200 and a grant row.
  it('a grant on a lakehouse the admin cannot reach answers 404, with no grant', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await POST(postReq(grantBody()));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('item_not_found');
    expect(writeCalls()).toEqual(NO_WRITES);
  });

  // Breaks if the named container is not compared with the binding: 200 and a
  // grant or revoke on `gold`.
  it.each([
    ['POST', () => POST(postReq(grantBody({ container: 'gold' })))],
    ['DELETE', () => DELETE(delReq(objectQs(assignmentOn('gold'), { container: 'gold' })))],
  ])('%s naming another container is refused (403 outside_item_root)', async (_v, call) => {
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('outside_item_root');
    expect(writeCalls()).toEqual(NO_WRITES);
  });
});

describe('DELETE /api/lakehouse/permissions?tab=object — role-assignment id validation', () => {
  it('400 when id is missing; nothing listed or revoked', async () => {
    const res = await DELETE(delReq(new URLSearchParams({ tab: 'object', lakehouseId: LH, container: CONTAINER }).toString()));
    expect(res.status).toBe(400);
    expect(writeCalls()).toEqual(NO_WRITES);
  });

  it.each([
    ['an assignment on a different container', assignmentOn('bronze')],
    ['a subscription-scope assignment', `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleAssignments/${GUID}`],
    ['a storage-account-scope assignment', `/subscriptions/${SUB}/resourceGroups/rg-loom/providers/Microsoft.Storage/storageAccounts/${BOUND}/providers/Microsoft.Authorization/roleAssignments/${GUID}`],
    ['a container scope with a dot-dot segment', `${scopeOf(CONTAINER)}/../bronze/providers/Microsoft.Authorization/roleAssignments/${GUID}`],
    ['a non-GUID assignment name', `${scopeOf(CONTAINER)}/providers/Microsoft.Authorization/roleAssignments/not-a-guid`],
    ['a trailing query string', `${LISTED}?api-version=2022-04-01`],
    ['a role definition, not an assignment', `${scopeOf(CONTAINER)}/providers/Microsoft.Authorization/roleDefinitions/${GUID}`],
  ])('400 for %s; nothing listed or revoked', async (_label, id) => {
    const res = await DELETE(delReq(objectQs(id)));
    expect(res.status).toBe(400);
    expect(writeCalls()).toEqual(NO_WRITES);
  });

  it('404 for a well-formed id that is not listed on the container; nothing revoked', async () => {
    const unlisted = assignmentOn(CONTAINER, 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee');
    // Precondition: the shape check alone would accept it, so only the
    // membership check can produce the 404.
    expect(isContainerRoleAssignmentId(unlisted, CONTAINER)).toBe(true);
    const res = await DELETE(delReq(objectQs(unlisted)));
    expect(res.status).toBe(404);
    expect(writeCalls()).toEqual({ ...NO_WRITES, list: [[CONTAINER, BOUND]] });
  });

  it('revokes the id as listed, not the caller spelling of it', async () => {
    // ARM ids compare case-insensitively; the caller sends a lower-cased copy
    // and the revoke must receive the listing's own string. Breaks if the
    // route forwards the caller's string.
    const callerSpelling = LISTED.toLowerCase();
    expect(callerSpelling).not.toBe(LISTED);
    const res = await DELETE(delReq(objectQs(callerSpelling)));
    expect(res.status).toBe(200);
    expect((revokeContainerRoleAssignment as any).mock.calls).toEqual([[LISTED]]);
  });
});

describe('isContainerRoleAssignmentId', () => {
  it('accepts a role assignment at the container scope', () => {
    expect(isContainerRoleAssignmentId(LISTED, CONTAINER)).toBe(true);
  });
  it('refuses the same assignment when a different container is named', () => {
    expect(isContainerRoleAssignmentId(LISTED, 'bronze')).toBe(false);
  });
  it('refuses a container name that is not a valid blob container name', () => {
    // A regex metacharacter in the container would otherwise widen the match.
    expect(isContainerRoleAssignmentId(assignmentOn('land.ng'), 'land.ng')).toBe(false);
    expect(isContainerRoleAssignmentId(LISTED, 'land.ng')).toBe(false);
    expect(isContainerRoleAssignmentId(LISTED, '.*')).toBe(false);
  });
  it('refuses an id with a trailing path after the GUID', () => {
    expect(isContainerRoleAssignmentId(`${LISTED}/extra`, CONTAINER)).toBe(false);
  });
});
