/**
 * POST /api/governance/dlp/restrict — tenant-admin gate + scope validation (#4619).
 *
 *   401 / 403 non-admin (no revoke, no ACL edit) / admin reaches the sink /
 *   an adls scopeRef that is not a container name is a 400 /
 *   an adls-path subPath with a ".." segment, NUL or control char is a 400.
 *
 * Each load-bearing assertion names the input that breaks it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  tenantSettingsContainer: vi.fn(async () => ({
    item: () => ({ read: async () => ({ resource: undefined }), replace: async () => ({}) }),
  })),
}));
vi.mock('@/lib/azure/adls-client', () => ({
  listContainerRoleAssignments: vi.fn(),
  revokeContainerRoleAssignment: vi.fn(),
  removePrincipalFromPathAcl: vi.fn(),
}));
vi.mock('@/lib/azure/access-policy-client', () => ({
  revokeStructuredGrant: vi.fn(),
  denySchemaAccess: vi.fn(),
}));
vi.mock('../../_lib/meta', () => ({
  loadDlpMeta: vi.fn(async () => ({ restrictions: [] })),
  saveDlpMeta: vi.fn(async () => undefined),
}));

import { POST } from '../route';
import { getSession } from '@/lib/auth/session';
import {
  listContainerRoleAssignments,
  revokeContainerRoleAssignment,
  removePrincipalFromPathAcl,
} from '@/lib/azure/adls-client';

const user = { claims: { upn: 'u@x', tid: 't1', oid: 'user-oid' } };
const admin = { claims: { upn: 'a@x', tid: 't1', oid: 'admin-oid' } };

function req(body: unknown) {
  return { json: async () => body, nextUrl: new URL('http://x/api/governance/dlp/restrict') } as any;
}
const containerBody = { scopeType: 'adls-container', scopeRef: 'bronze', principalId: 'victim-oid' };
const pathBody = { scopeType: 'adls-path', scopeRef: 'bronze', subPath: 'Files/sales', principalId: 'victim-oid' };

function sinkCalls() {
  return (listContainerRoleAssignments as any).mock.calls.length
    + (revokeContainerRoleAssignment as any).mock.calls.length
    + (removePrincipalFromPathAcl as any).mock.calls.length;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid';
  let reads = 0;
  (listContainerRoleAssignments as any).mockImplementation(async () => {
    reads += 1;
    // First read: the principal holds a role; read-back: it no longer does.
    return reads === 1
      ? [{ id: '/ra/1', principalId: 'victim-oid', roleName: 'Storage Blob Data Reader' }]
      : [];
  });
  (revokeContainerRoleAssignment as any).mockResolvedValue(undefined);
  (removePrincipalFromPathAcl as any).mockResolvedValue({ removed: true, aclConfirmed: true, scopesRemoved: ['access'] });
});

describe('POST /api/governance/dlp/restrict — authorization', () => {
  it('401 without a session, and the sink is never called', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await POST(req(containerBody), {} as any)).status).toBe(401);
    expect(sinkCalls()).toBe(0);
  });

  it.each([
    ['adls-container', containerBody],
    ['adls-path', pathBody],
  ])('403 admin_only for a signed-in non-admin on %s, and the sink is never called', async (_label, body) => {
    // Breaks if POST is not tenant-admin gated: the body is valid, so the
    // handler would list+revoke (or edit the ACL) and answer 200.
    (getSession as any).mockReturnValue(user);
    const res = await POST(req(body), {} as any);
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('admin_only');
    expect(sinkCalls()).toBe(0);
  });

  it('a tenant admin reaches the container revoke (positive pair)', async () => {
    // Breaks if the gate refuses admins, or the handler stops revoking.
    (getSession as any).mockReturnValue(admin);
    const res = await POST(req(containerBody), {} as any);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.restricted).toBe(true);
    expect(revokeContainerRoleAssignment).toHaveBeenCalledWith('/ra/1');
  });

  it('a tenant admin reaches the path ACL edit (positive pair)', async () => {
    (getSession as any).mockReturnValue(admin);
    const res = await POST(req(pathBody), {} as any);
    expect(res.status).toBe(200);
    expect(removePrincipalFromPathAcl).toHaveBeenCalledWith('bronze', 'Files/sales', 'victim-oid');
  });
});

describe('POST /api/governance/dlp/restrict — scope validation (tenant admin)', () => {
  it.each([
    ['a path separator', 'bronze/x'],
    ['a ".." traversal', '../other'],
    ['an ARM-scope fragment', 'bronze/providers/Microsoft.Authorization'],
    ['uppercase', 'Bronze'],
    ['a double hyphen', 'a--b'],
  ])('400 on an adls-container scopeRef with %s, and the sink is never called', async (_label, scopeRef) => {
    // Breaks if the scopeRef container-name check is removed: the mocked
    // list/revoke would run and the response would be 200.
    (getSession as any).mockReturnValue(admin);
    const res = await POST(req({ ...containerBody, scopeRef }), {} as any);
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
    expect(sinkCalls()).toBe(0);
  });

  it('400 on an adls-path scopeRef that is not a container name, and the sink is never called', async () => {
    // Breaks if the container-name check only covers adls-container.
    (getSession as any).mockReturnValue(admin);
    const res = await POST(req({ ...pathBody, scopeRef: 'bronze/x' }), {} as any);
    expect(res.status).toBe(400);
    expect(sinkCalls()).toBe(0);
  });

  it.each([
    ['a ".." segment', 'Files/../../other'],
    ['a backslash ".." segment', 'Files\\..\\other'],
    ['a leading backslash', '\\Files\\x'],
    ['a NUL', 'Files/a\u0000b'],
    ['a control character', 'Files/a\u0001b'],
  ])('400 on an adls-path subPath with %s, and the ACL is never edited', async (_label, subPath) => {
    // Breaks if the subPath blobRelPathError check is removed: the mocked
    // removePrincipalFromPathAcl would run and the response would be 200.
    (getSession as any).mockReturnValue(admin);
    const res = await POST(req({ ...pathBody, subPath }), {} as any);
    expect(res.status).toBe(400);
    expect(removePrincipalFromPathAcl).not.toHaveBeenCalled();
  });

  it('a leading "/" on subPath is normalised away, not refused', async () => {
    // Pins the preserved trimSlashes normalisation: "/Files/sales" names the
    // same path under the container as "Files/sales". Breaks if the check were
    // moved before trimSlashes (then this is a 400).
    (getSession as any).mockReturnValue(admin);
    const res = await POST(req({ ...pathBody, subPath: '/Files/sales' }), {} as any);
    expect(res.status).toBe(200);
    expect(removePrincipalFromPathAcl).toHaveBeenCalledWith('bronze', 'Files/sales', 'victim-oid');
  });
});
