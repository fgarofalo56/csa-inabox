/**
 * Contract tests for the write verbs of /api/lakehouse/permissions.
 *
 * DELETE uses the same tenant-admin rule as POST, with the same 403 body. For
 * tab=object the role-assignment id must (1) have the shape of an assignment at
 * the named container's scope and (2) be one of the assignments listed on that
 * container; the id handed to `revokeContainerRoleAssignment` is the listed one.
 *
 * Every refusal reads the CALL ROW SET of `listContainerRoleAssignments` /
 * `revokeContainerRoleAssignment` / `dropRlsPolicy`, and is paired with a
 * positive arm on the same fixture, so "nothing was revoked" cannot be satisfied
 * by a route that never revokes anything.
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

import { DELETE, POST } from '../permissions/route';
import { isContainerRoleAssignmentId } from '../_lib/container-role-assignment';
import { getSession } from '@/lib/auth/session';
import {
  listContainerRoleAssignments, revokeContainerRoleAssignment, grantContainerRole,
} from '@/lib/azure/adls-client';
import { dedicatedTarget, dropRlsPolicy } from '@/lib/azure/synapse-permissions-client';

const ADMIN_OID = 'oid-tenant-admin';
const admin = { claims: { oid: ADMIN_OID, upn: 'admin@x' } };
const member = { claims: { oid: 'oid-member', upn: 'member@x' } };

const SUB = '11111111-2222-3333-4444-555555555555';
const GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CONTAINER = 'landing';
const scopeOf = (c: string) =>
  `/subscriptions/${SUB}/resourceGroups/rg-loom/providers/Microsoft.Storage/storageAccounts/loomlake01/blobServices/default/containers/${c}`;
const assignmentOn = (c: string, g = GUID) => `${scopeOf(c)}/providers/Microsoft.Authorization/roleAssignments/${g}`;
const LISTED = assignmentOn(CONTAINER);

function delReq(qs: string) {
  return { nextUrl: new URL(`http://x/api/lakehouse/permissions?${qs}`), json: async () => ({}) } as any;
}
function postReq(body: any) {
  return { nextUrl: new URL('http://x/api/lakehouse/permissions'), json: async () => body } as any;
}
const objectQs = (id: string, container = CONTAINER) =>
  new URLSearchParams({ tab: 'object', container, id }).toString();

let savedAdminOid: string | undefined;
let savedAdminGroup: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  savedAdminOid = process.env.LOOM_TENANT_ADMIN_OID;
  savedAdminGroup = process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN_OID;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  (getSession as any).mockReturnValue(admin);
  (listContainerRoleAssignments as any).mockResolvedValue([
    { id: LISTED, principalId: 'p1', principalType: 'User', roleName: 'Storage Blob Data Reader' },
  ]);
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

describe('DELETE /api/lakehouse/permissions — tenant admin, like POST', () => {
  it('a tenant admin revokes a listed assignment on the container (positive arm)', async () => {
    const res = await DELETE(delReq(objectQs(LISTED)));
    expect(res.status).toBe(200);
    // Breaks if the route stops calling revoke, or revokes some other id.
    expect((revokeContainerRoleAssignment as any).mock.calls).toEqual([[LISTED]]);
    expect((listContainerRoleAssignments as any).mock.calls).toEqual([[CONTAINER]]);
  });

  it('requires tenant-admin; 403 with the same body shape POST returns, nothing listed or revoked', async () => {
    (getSession as any).mockReturnValue(member);
    const del = await DELETE(delReq(objectQs(LISTED)));
    const post = await POST(postReq({ tab: 'object', container: CONTAINER, principalId: 'p1', role: 'Storage Blob Data Reader' }));
    expect(del.status).toBe(403);
    expect(post.status).toBe(403);
    const dj = await del.json();
    const pj = await post.json();
    // Breaks if DELETE drops the admin check (200 + a revoke row) or answers
    // with a different body than POST.
    expect(Object.keys(dj).sort()).toEqual(Object.keys(pj).sort());
    // Callers render `error`: it must be the sentence, not a bare code. Breaks
    // if `error` goes back to 'forbidden' with the sentence only in `hint`.
    expect(dj.error).toMatch(/requires tenant-admin/);
    expect(pj.error).toMatch(/requires tenant-admin/);
    expect(dj.code).toBe('admin_only');
    expect(pj.code).toBe('admin_only');
    expect(dj.remediation).toMatch(/tenant admin|Azure portal/);
    expect((revokeContainerRoleAssignment as any).mock.calls).toEqual([]);
    expect((listContainerRoleAssignments as any).mock.calls).toEqual([]);
    expect((grantContainerRole as any).mock.calls).toEqual([]);
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

describe('DELETE /api/lakehouse/permissions?tab=object — role-assignment id validation', () => {
  it('400 when container is missing; nothing listed or revoked', async () => {
    const res = await DELETE(delReq(new URLSearchParams({ tab: 'object', id: LISTED }).toString()));
    expect(res.status).toBe(400);
    expect((listContainerRoleAssignments as any).mock.calls).toEqual([]);
    expect((revokeContainerRoleAssignment as any).mock.calls).toEqual([]);
  });

  it.each([
    ['an assignment on a different container', assignmentOn('bronze')],
    ['a subscription-scope assignment', `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleAssignments/${GUID}`],
    ['a storage-account-scope assignment', `/subscriptions/${SUB}/resourceGroups/rg-loom/providers/Microsoft.Storage/storageAccounts/loomlake01/providers/Microsoft.Authorization/roleAssignments/${GUID}`],
    ['a container scope with a dot-dot segment', `${scopeOf(CONTAINER)}/../bronze/providers/Microsoft.Authorization/roleAssignments/${GUID}`],
    ['a non-GUID assignment name', `${scopeOf(CONTAINER)}/providers/Microsoft.Authorization/roleAssignments/not-a-guid`],
    ['a trailing query string', `${LISTED}?api-version=2022-04-01`],
    ['a role definition, not an assignment', `${scopeOf(CONTAINER)}/providers/Microsoft.Authorization/roleDefinitions/${GUID}`],
  ])('400 for %s; nothing listed or revoked', async (_label, id) => {
    const res = await DELETE(delReq(objectQs(id)));
    expect(res.status).toBe(400);
    expect((listContainerRoleAssignments as any).mock.calls).toEqual([]);
    expect((revokeContainerRoleAssignment as any).mock.calls).toEqual([]);
  });

  it('404 for a well-formed id that is not listed on the container; nothing revoked', async () => {
    const unlisted = assignmentOn(CONTAINER, 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee');
    // Precondition: the shape check alone would accept it, so only the
    // membership check can produce the 404.
    expect(isContainerRoleAssignmentId(unlisted, CONTAINER)).toBe(true);
    const res = await DELETE(delReq(objectQs(unlisted)));
    expect(res.status).toBe(404);
    expect((listContainerRoleAssignments as any).mock.calls).toEqual([[CONTAINER]]);
    expect((revokeContainerRoleAssignment as any).mock.calls).toEqual([]);
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
