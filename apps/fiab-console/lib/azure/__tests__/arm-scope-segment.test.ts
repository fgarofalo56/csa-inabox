/**
 * Role-assignment scope segments: each caller-supplied name becomes exactly
 * ONE ARM path segment, percent-encoded, and ids passed to revoke must be
 * container-scoped role assignments (on any account named by the id itself —
 * see `adls-role-scope-account.test.ts` for the multi-account revoke path).
 *
 * Each case names the value that breaks it (assertion-design.md).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const armFetch = vi.fn();
const discover = vi.fn();

vi.mock('@/lib/azure/workspace-credential-factory', () => ({
  workspaceScopedCredential: () => ({
    getToken: async () => ({ token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }),
  }),
}));
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...args: unknown[]) => armFetch(...args),
  DEFAULT_SERVER_FETCH_TIMEOUT_MS: 30_000,
}));
vi.mock('@/lib/azure/resource-graph-coords', () => ({
  discoverResourceCoordsByName: (...args: unknown[]) => discover(...args),
}));

import { armScopeSegment, assertContainerRoleAssignmentId, ArmScopeSegmentError, containerSegment } from '../arm-scope-segment';

const SUB = '00000000-0000-0000-0000-0000000000ff';
const RG = 'rg-test';
const ACCOUNT = 'saloomtest';
const RA_GUID = '11111111-2222-3333-4444-555555555555';
const PRINCIPAL = '00000000-0000-0000-0000-000000000001';
const containerRaId = (container: string, account = ACCOUNT) =>
  `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/${account}`
  + `/blobServices/default/containers/${container}/providers/Microsoft.Authorization/roleAssignments/${RA_GUID}`;

/** Values that are not a single path segment. Removing any one refusal in
 *  armScopeSegment lets the matching row through and fails this table. */
const REFUSED: Array<[string, string]> = [
  ['', 'empty'],
  ['.', 'current-directory segment'],
  ['..', 'parent-directory segment'],
  ['a/b', 'literal slash'],
  ['a\\b', 'literal backslash'],
  ['..%2f..', 'encoded slash (lowercase)'],
  ['%2F', 'encoded slash (uppercase)'],
  ['a%5cb', 'encoded backslash'],
  ['%2e%2e', 'encoded dots'],
  ['a?b=1', 'query delimiter'],
  ['a#b', 'fragment delimiter'],
  ['a b', 'whitespace'],
  ['a\u0000b', 'control character'],
];

describe('armScopeSegment', () => {
  it.each(REFUSED)('refuses %j (%s)', (value) => {
    // Breaks if the refusal for this row is removed: the call returns a string.
    expect(() => armScopeSegment(value, 'container')).toThrow(ArmScopeSegmentError);
  });

  it('refuses a non-string (breaks if `typeof` coercion is dropped: String(undefined) = "undefined")', () => {
    expect(() => armScopeSegment(undefined, 'container')).toThrow(/is empty/);
  });

  it('passes a normal container name through unchanged', () => {
    // Breaks if validation over-refuses hyphens/digits: 'bronze-01' throws.
    expect(armScopeSegment('bronze-01', 'container')).toBe('bronze-01');
  });

  it('percent-encodes a segment it accepts', () => {
    // Breaks if encoding is dropped: '$web' would be returned raw, not '%24web'.
    expect(armScopeSegment('$web', 'container')).toBe('%24web');
  });
});

describe('containerSegment — Azure container names only', () => {
  it.each([
    ['Bronze', 'uppercase'],
    ['ab', 'shorter than 3'],
    ['a'.repeat(64), 'longer than 63'],
    ['-bronze', 'leading hyphen'],
    ['bronze-', 'trailing hyphen'],
    ['bro--nze', 'consecutive hyphens'],
    ['bro_nze', 'underscore'],
    ['bro.nze', 'dot'],
    ['$other', 'unknown system name'],
    ['..', 'relative segment'],
  ])('refuses %j (%s)', (value) => {
    // Breaks if the container-name rule is dropped: each of these passes armScopeSegment.
    expect(() => containerSegment(value)).toThrow(ArmScopeSegmentError);
  });

  it.each([['bronze-01', 'bronze-01'], ['abc', 'abc'], ['a'.repeat(63), 'a'.repeat(63)], ['$web', '%24web'], ['$root', '%24root'], ['$logs', '%24logs']])(
    'accepts %j', (value, encoded) => {
      // Breaks if the rule over-refuses (a valid name or a system container throws).
      expect(containerSegment(value)).toBe(encoded);
    },
  );

  it('assertContainerRoleAssignmentId applies it to the container in the id', () => {
    // Breaks if the id check uses the generic segment rule: 'Bronze' passes that.
    expect(() => assertContainerRoleAssignmentId(containerRaId('Bronze'), ACCOUNT)).toThrow(/not a storage container name/);
  });
});

describe('assertContainerRoleAssignmentId', () => {
  it('accepts a container-scoped role assignment on the configured account', () => {
    // Breaks if the id pattern stops matching the shape ARM returns.
    expect(assertContainerRoleAssignmentId(containerRaId('bronze'), ACCOUNT)).toBe(containerRaId('bronze'));
    // Account comparison is case-insensitive, as ARM's is. Breaks on a strict ===.
    expect(() => assertContainerRoleAssignmentId(containerRaId('bronze', 'SALOOMTEST'), ACCOUNT)).not.toThrow();
  });

  it.each([
    ['subscription-scoped', `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleAssignments/${RA_GUID}`],
    ['resource-group-scoped', `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Authorization/roleAssignments/${RA_GUID}`],
    ['account-scoped', `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/${ACCOUNT}/providers/Microsoft.Authorization/roleAssignments/${RA_GUID}`],
    ['a different account', containerRaId('bronze', 'otheraccount')],
    ['a relative-path (`..`) container segment', containerRaId('..')],
    ['an encoded-separator container segment', containerRaId('a%2fb')],
    ['a non-GUID assignment name', containerRaId('bronze').replace(RA_GUID, 'not-a-guid')],
    ['a trailing query', `${containerRaId('bronze')}?api-version=1`],
    ['a relative id', '/ra/1'],
  ])('refuses %s', (_label, id) => {
    expect(() => assertContainerRoleAssignmentId(id, ACCOUNT)).toThrow(ArmScopeSegmentError);
  });
});

describe('adls-client role-assignment scope', () => {
  beforeEach(() => {
    process.env.LOOM_BRONZE_URL = `https://${ACCOUNT}.dfs.core.windows.net/bronze`;
    armFetch.mockReset();
    discover.mockReset();
    discover.mockResolvedValue({ subscriptionId: SUB, resourceGroup: RG });
    armFetch.mockResolvedValue({
      ok: true, status: 201,
      text: async () => JSON.stringify({ id: containerRaId('bronze') }),
    });
  });

  it.each(['..', '.', 'bronze/..', '..%2f..%2fproviders', 'a%5cb', ''])(
    'grantContainerRole refuses container %j with NO ARM call and no coordinate lookup',
    async (container) => {
      const { grantContainerRole } = await import('../adls-client');
      await expect(
        grantContainerRole(container, PRINCIPAL, 'Storage Blob Data Reader', 'User'),
      ).rejects.toThrow(ArmScopeSegmentError);
      // Breaks if validation moves after the PUT (armFetch called) or after the
      // coordinate lookup (discover called).
      expect(armFetch).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
    },
  );

  it('listContainerRoleAssignments refuses a `..` container with NO ARM call', async () => {
    const { listContainerRoleAssignments } = await import('../adls-client');
    await expect(listContainerRoleAssignments('..')).rejects.toThrow(ArmScopeSegmentError);
    expect(armFetch).not.toHaveBeenCalled();
  });

  it('grantContainerRole PUTs at exactly the container scope for a valid name', async () => {
    const { grantContainerRole } = await import('../adls-client');
    await grantContainerRole('bronze', PRINCIPAL, 'Storage Blob Data Reader', 'User');
    expect(armFetch).toHaveBeenCalledTimes(1);
    const url = String(armFetch.mock.calls[0][0]);
    // Breaks if the scope is assembled differently (a segment dropped or doubled).
    expect(url).toMatch(new RegExp(
      `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft\\.Storage/storageAccounts/${ACCOUNT}`
      + '/blobServices/default/containers/bronze/providers/Microsoft\\.Authorization/roleAssignments/'
      + '[0-9a-f-]{36}\\?api-version=2022-04-01$',
    ));
    expect(armFetch.mock.calls[0][1]).toMatchObject({ method: 'PUT' });
  });

  it('revokeContainerRoleAssignment refuses a non-container id with NO ARM call', async () => {
    const { revokeContainerRoleAssignment } = await import('../adls-client');
    const subScoped = `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleAssignments/${RA_GUID}`;
    // Breaks if revoke stops validating: the DELETE would be issued for this id.
    await expect(revokeContainerRoleAssignment(subScoped)).rejects.toThrow(ArmScopeSegmentError);
    expect(armFetch).not.toHaveBeenCalled();
  });

  it('revokeContainerRoleAssignment DELETEs a container-scoped id on an account OTHER than the configured one', async () => {
    // The account is read from the id, not fixed to the configured account —
    // see adls-role-scope-account.test.ts for the full multi-account + 403 path.
    // Breaks if revoke goes back to requiring the configured account: this id
    // names 'otheraccount', not ACCOUNT, and would be refused with no ARM call.
    const { revokeContainerRoleAssignment } = await import('../adls-client');
    await revokeContainerRoleAssignment(containerRaId('bronze', 'otheraccount'));
    expect(armFetch).toHaveBeenCalledTimes(1);
    expect(String(armFetch.mock.calls[0][0])).toContain(containerRaId('bronze', 'otheraccount'));
  });

  it('revokeContainerRoleAssignment DELETEs a valid container-scoped id', async () => {
    armFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    const { revokeContainerRoleAssignment } = await import('../adls-client');
    await revokeContainerRoleAssignment(containerRaId('bronze'));
    // Breaks if the validator over-refuses the shape ARM itself returns.
    expect(armFetch).toHaveBeenCalledTimes(1);
    expect(String(armFetch.mock.calls[0][0])).toContain(`${containerRaId('bronze')}?api-version=2022-04-01`);
    expect(armFetch.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
  });
});
