/**
 * Backend contract tests for /api/onelake/security — the OneLake catalog Secure
 * tab access matrix. Azure-native (NO Fabric dependency): the matrix is rolled
 * up from real Azure RBAC, ADLS POSIX ACL, Cosmos workspace-roles and (Comm/GCC)
 * Databricks Unity Catalog grants.
 *
 *   GET   401 / 403 non-admin (no ARM read) / bare-list / matrix assembly /
 *         honest ACL gate / RBAC env gate / 400 on a container that is not a
 *         storage container name
 *   POST  401 / 403 non-admin (grant never called) / 400 validation, including
 *         every rejected container shape / grantContainerRole happy path (admin)
 *   DELETE 401 / 403 non-admin (revoke never called) / 400 on every id that is
 *         not exactly a container-scope role-assignment id of this account /
 *         404 on a well-formed id that is not currently listed / revoke of the
 *         LISTED id (admin)
 *
 * Every verb is tenant-admin (#4619): they read, grant and revoke data-plane
 * roles on the shared deployment containers, which no single item owns.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  getAccountName: vi.fn(() => 'acctlake'),
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
  getAccountName,
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
  (getAccountName as any).mockReturnValue('acctlake');
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

  it('403 admin_only for a signed-in non-admin, with no ARM, ACL or workspace-role read', async () => {
    // Breaks if GET is session-scoped again: the non-admin would get the
    // assembled matrix (200) and listContainerRoleAssignments would be called.
    (getSession as any).mockReturnValue(sess);
    (listContainerRoleAssignments as any).mockResolvedValue([]);
    (getAcl as any).mockResolvedValue([]);
    const res = await GET(getReq('container=bronze&workspaceId=ws-1'));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.code).toBe('admin_only');
    // The route-specific reason, not the label/DLP/Purview default. Breaks if
    // the refusal text is dropped from the wrapper.
    expect(j.reason).toMatch(/Secure tab/);
    expect(j.reason).not.toMatch(/sensitivity labels/);
    expect(listContainerRoleAssignments).not.toHaveBeenCalled();
    expect(getAcl).not.toHaveBeenCalled();
    expect(listWorkspaceRoles).not.toHaveBeenCalled();
  });

  it('bare GET returns the container picker list', async () => {
    (getSession as any).mockReturnValue(adminSess);
    const res = await GET(getReq(''));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.needsContainer).toBe(true);
    expect(j.knownContainers).toContain('bronze');
  });

  it('assembles the matrix from RBAC + ACL + workspace roles (no mock principals)', async () => {
    (getSession as any).mockReturnValue(adminSess);
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
    (getSession as any).mockReturnValue(adminSess);
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
    (getSession as any).mockReturnValue(adminSess);
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
    (getSession as any).mockReturnValue(adminSess);
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
    (getSession as any).mockReturnValue(adminSess);
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
  // A well-formed id at a container scope of THIS deployment's account
  // ("acctlake", the mocked getAccountName). Every refused fixture below is
  // this string with ONE thing changed, so each refusal is attributable.
  const SUB = '11111111-2222-3333-4444-555555555555';
  const RA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const scopeOf = (account: string, container: string) =>
    `/subscriptions/${SUB}/resourceGroups/rg-dlz/providers/Microsoft.Storage/storageAccounts/${account}`
    + `/blobServices/default/containers/${container}`;
  const VALID = `${scopeOf('acctlake', 'bronze')}/providers/Microsoft.Authorization/roleAssignments/${RA}`;
  const del = (id: string) => DELETE(delReq('id=' + encodeURIComponent(id)));

  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await del(VALID)).status).toBe(401);
  });
  it('403 admin_only for a signed-in non-admin, and never revokes', async () => {
    // Breaks if DELETE is not tenant-admin gated: VALID is listed, so the
    // handler would reach revokeContainerRoleAssignment and answer 200.
    (getSession as any).mockReturnValue(sess);
    (listContainerRoleAssignments as any).mockResolvedValue([{ id: VALID, principalId: 'p' }]);
    (revokeContainerRoleAssignment as any).mockResolvedValue(undefined);
    const res = await del(VALID);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('admin_only');
    expect(revokeContainerRoleAssignment).not.toHaveBeenCalled();
  });
  it('400 without id', async () => {
    (getSession as any).mockReturnValue(adminSess);
    expect((await DELETE(delReq(''))).status).toBe(400);
  });

  it.each([
    ['a trailing path suffix', `${VALID}/x`],
    ['a trailing "?"', `${VALID}?api-version=2022-04-01`],
    ['a trailing "#"', `${VALID}#x`],
    ['a leading prefix', `/x${VALID}`],
    ['a "?" inside the id', VALID.replace('/providers/Microsoft.Authorization', '?/providers/Microsoft.Authorization')],
    ['a subscription-scope id', `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleAssignments/${RA}`],
    ['an account-scope id (no container)', `/subscriptions/${SUB}/resourceGroups/rg-dlz/providers/Microsoft.Storage/storageAccounts/acctlake/providers/Microsoft.Authorization/roleAssignments/${RA}`],
    ['another storage account', `${scopeOf('otheracct', 'bronze')}/providers/Microsoft.Authorization/roleAssignments/${RA}`],
    ['an upper-case container', `${scopeOf('acctlake', 'Bronze')}/providers/Microsoft.Authorization/roleAssignments/${RA}`],
    ['a role-assignment name that is not a GUID', `${scopeOf('acctlake', 'bronze')}/providers/Microsoft.Authorization/roleAssignments/not-a-guid`],
    ['a ".." resource group', VALID.replace('/resourceGroups/rg-dlz/', '/resourceGroups/../')],
    ['a "." resource group', VALID.replace('/resourceGroups/rg-dlz/', '/resourceGroups/./')],
    ['a resource group ending in "."', VALID.replace('/resourceGroups/rg-dlz/', '/resourceGroups/rg-dlz./')],
    ['a 91-character resource group', VALID.replace('/resourceGroups/rg-dlz/', `/resourceGroups/${'r'.repeat(91)}/`)],
  ])('400 on an id with %s, before any ARM call', async (_label, id) => {
    // Breaks if the parse is not anchored at BOTH ends, or is loosened to a
    // prefix / substring test: the first four would then parse (to container
    // "bronze") and the handler would list assignments. The list is mocked to
    // contain the refused string itself, so a missing parse is not rescued by
    // the membership check — the answer would be 200 and a revoke.
    (getSession as any).mockReturnValue(adminSess);
    (listContainerRoleAssignments as any).mockResolvedValue([{ id, principalId: 'p' }]);
    (revokeContainerRoleAssignment as any).mockResolvedValue(undefined);
    const res = await del(id);
    expect(res.status).toBe(400);
    expect(listContainerRoleAssignments).not.toHaveBeenCalled();
    expect(revokeContainerRoleAssignment).not.toHaveBeenCalled();
  });

  it('404 on a well-formed id that is not a current assignment on that container', async () => {
    // Breaks if the membership check is removed: the id parses, so the handler
    // would revoke it (200) although the container lists no such assignment.
    (getSession as any).mockReturnValue(adminSess);
    (listContainerRoleAssignments as any).mockResolvedValue([
      { id: VALID.replace(RA, 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'), principalId: 'p' },
    ]);
    const res = await del(VALID);
    expect(res.status).toBe(404);
    expect(listContainerRoleAssignments).toHaveBeenCalledWith('bronze');
    expect(revokeContainerRoleAssignment).not.toHaveBeenCalled();
  });

  it('revokes the LISTED id for a tenant admin (positive pair)', async () => {
    // The caller spells the fixed segments in a different case; the listed id
    // is what reaches ARM. Breaks if the caller's string were revoked instead,
    // or if a case-only difference were refused.
    (getSession as any).mockReturnValue(adminSess);
    (listContainerRoleAssignments as any).mockResolvedValue([{ id: VALID, principalId: 'p' }]);
    (revokeContainerRoleAssignment as any).mockResolvedValue(undefined);
    const spelled = VALID.replace('/resourceGroups/', '/resourcegroups/');
    expect(spelled).not.toBe(VALID);
    const res = await del(spelled);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(listContainerRoleAssignments).toHaveBeenCalledWith('bronze');
    expect(revokeContainerRoleAssignment).toHaveBeenCalledWith(VALID);
  });

  it.each([
    ['dots and parentheses inside', 'rg.dlz_(1)'],
    ['a single character', 'r'],
    ['90 characters', 'r'.repeat(90)],
    ['accented letters', 'rg-données'],
    ['CJK letters', '资源组'],
    ['non-ASCII decimal digits', 'rg-١٢٣'],
  ])('accepts a resource group with %s (positive pair for the name rule)', async (_l, rg) => {
    // Breaks if the segment refused a legal ARM name: the answer would be 400
    // instead of the revoke. The last three break on the ASCII-only `\w`
    // class the segment used before, which Azure's Unicode rule does not share.
    const id = VALID.replace('/resourceGroups/rg-dlz/', `/resourceGroups/${rg}/`);
    expect(id).not.toBe(VALID);
    (getSession as any).mockReturnValue(adminSess);
    (listContainerRoleAssignments as any).mockResolvedValue([{ id, principalId: 'p' }]);
    (revokeContainerRoleAssignment as any).mockResolvedValue(undefined);
    const res = await del(id);
    expect(res.status).toBe(200);
    expect(revokeContainerRoleAssignment).toHaveBeenCalledWith(id);
  });

  it.each([
    ['a space in the resource group', VALID.replace('/resourceGroups/rg-dlz/', '/resourceGroups/rg dlz/')],
    ['a percent-encoded slash in the resource group', VALID.replace('/resourceGroups/rg-dlz/', '/resourceGroups/rg%2Fdlz/')],
    // U+212A KELVIN SIGN folds to "k" under the `iu` flags together. The id
    // pattern is `i` only, so it is not an ASCII letter to the account class.
    ['a KELVIN SIGN in the account name', `${scopeOf('acctla\u212Ae', 'bronze')}/providers/Microsoft.Authorization/roleAssignments/${RA}`],
  ])('400 on an id with %s', async (_l, id) => {
    // Breaks if the Unicode rule were applied by adding `u` to the whole id
    // pattern (the KELVIN SIGN would then parse as "acctlake" and be listed),
    // or if the resource-group segment admitted a space or a "%".
    // The account fixture is written as an escape on purpose: an ASCII "K"
    // matches `[a-z]` under `i` and lower-cases to the real account.
    (getSession as any).mockReturnValue(adminSess);
    (listContainerRoleAssignments as any).mockResolvedValue([{ id, principalId: 'p' }]);
    (revokeContainerRoleAssignment as any).mockResolvedValue(undefined);
    const res = await del(id);
    expect(res.status).toBe(400);
    expect(listContainerRoleAssignments).not.toHaveBeenCalled();
    expect(revokeContainerRoleAssignment).not.toHaveBeenCalled();
  });

  it('the resource-group name rule, lifted from the route source', () => {
    // The pattern is read out of route.ts at runtime rather than transcribed,
    // so this probe cannot disagree with the implementation. Breaks if the
    // literal is renamed or split (the lift finds nothing), or if the rule
    // changes on any row below.
    const src = readFileSync(fileURLToPath(new URL('../security/route.ts', import.meta.url)), 'utf8');
    const lifted = /const RESOURCE_GROUP_NAME_RE = \/(.+)\/([a-z]*);/.exec(src);
    expect(lifted).not.toBeNull();
    const re = new RegExp(lifted![1], lifted![2]);
    expect(re.flags).toContain('u');
    const table: Array<[string, boolean]> = [
      ['rg-dlz', true], ['r', true], ['r'.repeat(90), true], ['rg.dlz_(1)', true],
      ['rg-données', true], ['资源组', true], ['rg-١٢٣', true], ['RG-Upper', true],
      ['', false], ['.', false], ['..', false], ['rg-dlz.', false], ['r'.repeat(91), false],
      ['a/b', false], ['a b', false], ['rg%2F', false], ['rg?x', false], ['rg#x', false],
    ];
    for (const [name, ok] of table) expect([name, re.test(name)]).toEqual([name, ok]);
  });
});
