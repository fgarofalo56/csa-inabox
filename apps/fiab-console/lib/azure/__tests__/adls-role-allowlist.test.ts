/**
 * grantContainerRole must only ever assign the three blob data-plane roles.
 *
 * Why this exists: the role resolution used to be
 *
 *     const roleGuid = BLOB_DATA_ROLES[roleNameOrId] || roleNameOrId;
 *
 * so an unrecognised name fell through and was used as a RAW role-definition
 * GUID in the ARM roleAssignments PUT. `POST /api/lakehouse/permissions`
 * (tab='object') passed `role` straight off the request body and never
 * validated it — only `principalType` was checked — and the route was
 * session-only. The Console UAMI holds Role Based Access Control Administrator
 * at the lake scope, so the assignment executed. Net effect: any authenticated
 * user could grant any principal ANY Azure role at that scope, including Owner
 * and User Access Administrator. That is a durable privilege escalation to
 * Azure resource ownership, not a data read.
 *
 * These are ATTACK tests: each asserts the escalation is REFUSED. Reverting the
 * allow-list in adls-client.ts makes the first three fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const armFetch = vi.fn();

vi.mock('@/lib/azure/arm-credential', () => ({
  uamiArmCredential: () => ({ getToken: async () => ({ token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }) }),
}));
// The legitimate-role cases need storage coords; the ATTACK cases must refuse
// before any of this is touched, which is the point of the guard's placement.
vi.mock('@/lib/azure/adls-coords', () => ({}), { virtual: true } as never);
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...args: unknown[]) => armFetch(...args),
  DEFAULT_SERVER_FETCH_TIMEOUT_MS: 30_000,
}));

/** Roles an attacker would actually reach for. */
const ESCALATION_ROLES = [
  'Owner',
  'Contributor',
  'User Access Administrator',
  '8e3af657-a8ff-443c-a75c-2fe8c4bcb635', // Owner, by raw GUID
  '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9', // User Access Administrator, by raw GUID
];

describe('grantContainerRole — role allow-list', () => {
  beforeEach(() => {
    process.env.LOOM_ADLS_ACCOUNT = 'saloomtest';
    process.env.LOOM_SUBSCRIPTION_ID = '00000000-0000-0000-0000-0000000000ff';
    process.env.LOOM_DLZ_RG = 'rg-test';
    armFetch.mockReset();
    armFetch.mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: '/x' }), text: async () => '' });
  });

  it.each(ESCALATION_ROLES)('ATTACK: refuses to assign %s and issues NO ARM call', async (role) => {
    const { grantContainerRole } = await import('../adls-client');
    // Must reject. Crucially it must reject BEFORE any ARM request — a refusal
    // that still issued the PUT would have already granted the role.
    await expect(
      grantContainerRole('bronze', '00000000-0000-0000-0000-000000000001', role, 'User'),
    ).rejects.toThrow(/Refusing to assign role/);
    expect(armFetch).not.toHaveBeenCalled();
  });

  it('the allow-list is exactly the three blob data-plane roles', async () => {
    const { listKnownBlobDataRoles } = await import('../adls-client');
    expect(listKnownBlobDataRoles()).toEqual([
      { name: 'Storage Blob Data Reader', id: '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1' },
      { name: 'Storage Blob Data Contributor', id: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe' },
      { name: 'Storage Blob Data Owner', id: 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b' },
    ]);
  });

  it('a legitimate role name is NOT refused by the guard', async () => {
    const { grantContainerRole } = await import('../adls-client');
    // The guard runs before any I/O, so a permitted role must get PAST it. The
    // ARM call itself needs live storage coords, so assert only that the failure
    // (if any) is not the guard's refusal. The happy path end-to-end is covered
    // by access-policy-client.test.ts, which mocks grantContainerRole outright.
    await expect(
      grantContainerRole('bronze', '00000000-0000-0000-0000-000000000001', 'Storage Blob Data Reader', 'User'),
    ).rejects.not.toThrow(/Refusing to assign role/);
  });
});
