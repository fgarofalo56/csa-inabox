/**
 * Backend contract tests for /api/onelake/security — the OneLake catalog Secure
 * tab access matrix. Azure-native (NO Fabric dependency): the matrix is rolled
 * up from real Azure RBAC, ADLS POSIX ACL, Cosmos workspace-roles and (Comm/GCC)
 * Databricks Unity Catalog grants.
 *
 *   GET   401 / bare-list / matrix assembly / honest ACL gate / RBAC env gate /
 *         400 on a container that is not a storage container name
 *   POST  401 / 403 non-admin (grant never called) / 400 validation, including
 *         every rejected container shape / grantContainerRole happy path (admin)
 *   DELETE 401 / 403 non-admin (revoke never called) / 400 / revoke happy path (admin)
 *
 * POST and DELETE are tenant-admin (#4619): they grant and revoke data-plane
 * roles on the shared deployment containers, which no single item owns.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() { return null; }
  }
  return { ChainedTokenCredential: Cred, DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred };
});
vi.mock('@/lib/azure/adls-client', () => ({
  KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing', 'csv-imports'],
  listContainerRoleAssignments: vi.fn(),
  grantContainerRole: vi.fn(),
  revokeContainerRoleAssignment: vi.fn(),
  getAcl: vi.fn(),
  listKnownBlobDataRoles: vi.fn(() => [
    { name: 'Storage Blob Data Reader', id: 'r-guid' },
    { name: 'Storage Blob Data Contributor', id: 'c-guid' },
    { name: 'Storage Blob Data Owner', id: 'o-guid' },
  ]),
}));
vi.mock('@/lib/azure/workspace-roles-client', () => ({ listWorkspaceRoles: vi.fn() }));
vi.mock('@/lib/azure/unity-catalog-client', () => ({
  listWorkspaceHostnames: vi.fn(),
  listPermissions: vi.fn(),
  UnityCatalogNotConfiguredError: class extends Error {},
}));
vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal() as any),
  isGovCloud: vi.fn(() => false),
  graphBase: vi.fn(() => 'https://graph.microsoft.com/v1.0'),
  graphScope: vi.fn(() => 'https://graph.microsoft.com/.default'),
}));

import { GET, POST, DELETE } from '../security/route';
import { getSession } from '@/lib/auth/session';
import {
  listContainerRoleAssignments,
  grantContainerRole,
  revokeContainerRoleAssignment,
  getAcl,
} from '@/lib/azure/adls-client';
import { listWorkspaceRoles } from '@/lib/azure/workspace-roles-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';

function getReq(qs: string) {
  return { nextUrl: new URL(`http://x/api/onelake/security?${qs}`) } as any;
}
function postReq(body: any) {
  return { json: async () => body, nextUrl: new URL('http://x/api/onelake/security') } as any;
}
function delReq(qs: string) {
  return { nextUrl: new URL(`http://x/api/onelake/security?${qs}`) } as any;
}

const sess = { claims: { upn: 'u@x', tid: 't1', oid: 'user-oid' } };
// #4619: grant/revoke are tenant-admin. `isTenantAdmin` admits the bootstrap
// oid (LOOM_TENANT_ADMIN_OID), so this session is admin and `sess` is not.
const adminSess = { claims: { upn: 'admin@x', tid: 't1', oid: 'admin-oid' } };

beforeEach(() => {
  vi.resetAllMocks();
  (isGovCloud as any).mockReturnValue(false);
  delete process.env.LOOM_DATABRICKS_HOSTNAME;
  delete process.env.LOOM_DATABRICKS_HOSTNAMES;
  delete process.env.LOOM_GRAPH_USERS_ENABLED;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid';
});

describe('GET /api/onelake/security', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await GET(getReq('container=bronze'))).status).toBe(401);
  });

  it('bare GET returns the container picker list', async () => {
    (getSession as any).mockReturnValue(sess);
    const res = await GET(getReq(''));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.needsContainer).toBe(true);
    expect(j.knownContainers).toContain('bronze');
  });

  it('assembles the matrix from RBAC + ACL + workspace roles (no mock principals)', async () => {
    (getSession as any).mockReturnValue(sess);
    (listContainerRoleAssignments as any).mockResolvedValue([
      { id: '/ra/1', principalId: 'oid-1', principalType: 'User', roleDefinitionId: 'x', roleName: 'Storage Blob Data Reader' },
    ]);
    (getAcl as any).mockResolvedValue([
      { scope: 'access', type: 'user', entityId: 'oid-1', permissions: { read: true, write: false, execute: true } },
      { scope: 'access', type: 'group', entityId: 'oid-2', permissions: { read: true, write: true, execute: true } },
    ]);
    (listWorkspaceRoles as any).mockResolvedValue([
      { principalId: 'oid-2', role: 'Member', displayName: 'Data Eng', principalType: 'Group' },
    ]);

    const res = await GET(getReq('container=bronze&workspaceId=ws-1'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.container).toBe('bronze');
    // oid-1 (RBAC + ACL) and oid-2 (ACL + workspace role) => 2 principals
    expect(j.matrix).toHaveLength(2);
    const p1 = j.matrix.find((m: any) => m.principalId === 'oid-1');
    expect(p1.storageRbacRole).toBe('Storage Blob Data Reader');
    expect(p1.aclPermissions).toEqual({ read: true, write: false, execute: true });
    const p2 = j.matrix.find((m: any) => m.principalId === 'oid-2');
    expect(p2.workspaceRole).toBe('Member');
    expect(p2.displayName).toBe('Data Eng');
    // UC not configured (Commercial, no hostname) => honest gate, no fabricated grants
    expect(j.ucGrants).toBeUndefined();
    expect(j.gates.uc).toMatch(/LOOM_DATABRICKS_HOSTNAME/);
  });

  it('surfaces an honest ACL gate on 403 without failing the whole roll-up', async () => {
    (getSession as any).mockReturnValue(sess);
    (listContainerRoleAssignments as any).mockResolvedValue([]);
    (getAcl as any).mockRejectedValue(Object.assign(new Error('forbidden'), { statusCode: 403 }));

    const res = await GET(getReq('container=gold'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.gates.acl).toMatch(/Storage Blob Data Owner/);
    expect(j.aclEntries).toEqual([]);
  });

  it('returns a 503 env gate when ARM scope env vars are missing', async () => {
    (getSession as any).mockReturnValue(sess);
    (listContainerRoleAssignments as any).mockRejectedValue(
      new Error('LOOM_SUBSCRIPTION_ID and LOOM_DLZ_RG required to resolve container scope'),
    );
    const res = await GET(getReq('container=bronze'));
    const j = await res.json();
    expect(res.status).toBe(503);
    expect(j.gate).toBe(true);
    expect(j.missing).toMatch(/LOOM_SUBSCRIPTION_ID/);
  });

  it('skips Unity Catalog entirely in Gov clouds with an honest gate', async () => {
    (getSession as any).mockReturnValue(sess);
    (isGovCloud as any).mockReturnValue(true);
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb.azuredatabricks.net';
    (listContainerRoleAssignments as any).mockResolvedValue([]);
    (getAcl as any).mockResolvedValue([]);

    const res = await GET(getReq('container=bronze'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.gates.uc).toMatch(/GCC-High/);
    expect(j.ucGrants).toBeUndefined();
  });

  it('400 on a container that is not a storage container name, before any ARM read', async () => {
    // Breaks if the GET container-name check is removed: `listContainerRoleAssignments`
    // would be called with "a/b" and the status would be 200/502, not 400.
    (getSession as any).mockReturnValue(sess);
    (listContainerRoleAssignments as any).mockResolvedValue([]);
    (getAcl as any).mockResolvedValue([]);
    const res = await GET(getReq('container=' + encodeURIComponent('a/b')));
    expect(res.status).toBe(400);
    expect(listContainerRoleAssignments).not.toHaveBeenCalled();
    // Positive pair: a valid name reaches the ARM read.
    expect((await GET(getReq('container=bronze'))).status).toBe(200);
    expect(listContainerRoleAssignments).toHaveBeenCalledWith('bronze');
  });
});

describe('POST /api/onelake/security', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await POST(postReq({}))).status).toBe(401);
  });
  it('403 admin_only for a signed-in non-admin, and never grants', async () => {
    // Breaks if POST is not tenant-admin gated: the handler would reach
    // grantContainerRole and answer 200.
    (getSession as any).mockReturnValue(sess);
    (grantContainerRole as any).mockResolvedValue({ id: '/ra/new', principalId: 'oid-9' });
    const res = await POST(postReq({ container: 'bronze', principalId: 'oid-9', role: 'Storage Blob Data Reader' }));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('admin_only');
    expect(grantContainerRole).not.toHaveBeenCalled();
  });
  it('400 without container/principalId/role', async () => {
    (getSession as any).mockReturnValue(adminSess);
    expect((await POST(postReq({ container: 'bronze' }))).status).toBe(400);
  });
  it.each([
    ['a path separator', 'bronze/../x'],
    ['uppercase', 'Bronze'],
    ['a double hyphen', 'a--b'],
    ['too short', 'ab'],
    ['a NUL', 'bro\u0000nze'],
  ])('400 on a container name with %s, and never grants', async (_label, container) => {
    // Breaks if the POST container-name check is removed: each of these would
    // reach grantContainerRole (mocked to resolve) and answer 200.
    (getSession as any).mockReturnValue(adminSess);
    (grantContainerRole as any).mockResolvedValue({ id: '/ra/new', principalId: 'oid-9' });
    const res = await POST(postReq({ container, principalId: 'oid-9', role: 'Storage Blob Data Reader' }));
    expect(res.status).toBe(400);
    expect(grantContainerRole).not.toHaveBeenCalled();
  });
  it('grants a Storage Blob Data role (tenant admin)', async () => {
    (getSession as any).mockReturnValue(adminSess);
    (grantContainerRole as any).mockResolvedValue({ id: '/ra/new', principalId: 'oid-9', roleName: 'Storage Blob Data Reader' });
    const res = await POST(postReq({ container: 'bronze', principalId: 'oid-9', role: 'Storage Blob Data Reader', principalType: 'User' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.assignment.principalId).toBe('oid-9');
    expect(grantContainerRole).toHaveBeenCalledWith('bronze', 'oid-9', 'Storage Blob Data Reader', 'User');
  });
});

describe('DELETE /api/onelake/security', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await DELETE(delReq('id=/ra/1'))).status).toBe(401);
  });
  it('403 admin_only for a signed-in non-admin, and never revokes', async () => {
    // Breaks if DELETE is not tenant-admin gated: the handler would reach
    // revokeContainerRoleAssignment and answer 200.
    (getSession as any).mockReturnValue(sess);
    (revokeContainerRoleAssignment as any).mockResolvedValue(undefined);
    const res = await DELETE(delReq('id=' + encodeURIComponent('/ra/1')));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('admin_only');
    expect(revokeContainerRoleAssignment).not.toHaveBeenCalled();
  });
  it('400 without id', async () => {
    (getSession as any).mockReturnValue(adminSess);
    expect((await DELETE(delReq(''))).status).toBe(400);
  });
  it('revokes a role assignment (tenant admin)', async () => {
    (getSession as any).mockReturnValue(adminSess);
    (revokeContainerRoleAssignment as any).mockResolvedValue(undefined);
    const res = await DELETE(delReq('id=' + encodeURIComponent('/ra/1')));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(revokeContainerRoleAssignment).toHaveBeenCalledWith('/ra/1');
  });
});
