/**
 * listContainerRoleAssignments and grantContainerRole act on the storage
 * account they are given.
 *
 * The lakehouse permissions routes pass the item's bound account (pinned in
 * permissions-get.test.ts and permissions-delete.test.ts, which mock these
 * functions). This file pins the other half: the ARM scope is built on that
 * account, and its subscription and resource group are discovered for that
 * account, not the configured one.
 *
 * It also pins what a 403 from ARM on a role-assignment read, create or delete
 * becomes (a named error with the role to grant), and that an empty account
 * means the configured account for the listing as it does for the grant.
 *
 * Resource Graph discovery and the ARM fetch are replaced by recorders.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logSafe } from '@/lib/util/log-safe';

const rec = vi.hoisted(() => ({
  urls: [] as string[], bodies: [] as string[], discovered: [] as string[],
  /** Account names Resource Graph does not place (discovery answers null). */
  missing: new Set<string>(),
  /** When set, ARM answers every request with this status and an error body. */
  armStatus: 0,
}));

vi.mock('@/lib/azure/workspace-credential-factory', () => ({
  workspaceScopedCredential: () => ({ getToken: async () => ({ token: 't', expiresOnTimestamp: Date.now() + 60_000 }) }),
}));
vi.mock('@/lib/azure/resource-graph-coords', () => ({
  discoverResourceCoordsByName: async ({ name }: { name: string }) => {
    rec.discovered.push(name);
    if (rec.missing.has(name)) return null;
    return { subscriptionId: `sub-${name}`, resourceGroup: `rg-${name}` };
  },
}));
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: async (url: string, init?: { body?: unknown }) => {
    rec.urls.push(url);
    rec.bodies.push(typeof init?.body === 'string' ? init.body : '');
    if (rec.armStatus) {
      const status = rec.armStatus;
      return { ok: false, status, text: async () => JSON.stringify({ error: { message: ARM_MESSAGE } }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ value: [] }) };
  },
}));

// Shaped like ARM's real 403 text: it names an identity's object id and a
// subscription / resource-group scope, which must not reach a response.
// Low-entropy placeholders. The newline is there so the log test can tell a
// one-line entry from one that carries ARM's text unflattened.
const ARM_OBJECT_ID = '00000000-0000-0000-0000-00000000abcd';
const ARM_SCOPE = '/subscriptions/sub-fixture/resourceGroups/rg-fixture';
const ARM_MESSAGE = `The client 'console-uami' with object id '${ARM_OBJECT_ID}' does not have authorization to perform\n`
  + `action 'Microsoft.Authorization/roleAssignments/write' over scope '${ARM_SCOPE}/providers/Microsoft.Storage/storageAccounts/boundacct'.`;
// ARM's text as the log line carries it: flattened by the REAL logSafe (not a
// transcription of it), so this value moves with the implementation.
const ARM_MESSAGE_LOGGED = logSafe(ARM_MESSAGE, 1000);
const PRIMARY = 'primaryacct';
const BOUND = 'boundacct';
const saved = process.env.LOOM_BRONZE_URL;
const savedSub = process.env.LOOM_SUBSCRIPTION_ID;
const savedRg = process.env.LOOM_DLZ_RG;

beforeEach(() => {
  vi.resetModules();
  rec.urls.length = 0;
  rec.bodies.length = 0;
  rec.discovered.length = 0;
  rec.missing.clear();
  rec.armStatus = 0;
  process.env.LOOM_BRONZE_URL = `https://${PRIMARY}.dfs.core.windows.net/bronze`;
  // The env coordinates describe the configured account. Set on every test so
  // a fallback that used them for another account would have values to use.
  process.env.LOOM_SUBSCRIPTION_ID = 'env-sub';
  process.env.LOOM_DLZ_RG = 'env-rg';
});
afterEach(() => {
  if (saved === undefined) delete process.env.LOOM_BRONZE_URL; else process.env.LOOM_BRONZE_URL = saved;
  if (savedSub === undefined) delete process.env.LOOM_SUBSCRIPTION_ID; else process.env.LOOM_SUBSCRIPTION_ID = savedSub;
  if (savedRg === undefined) delete process.env.LOOM_DLZ_RG; else process.env.LOOM_DLZ_RG = savedRg;
});

describe('listContainerRoleAssignments account', () => {
  it('builds the scope on the account it is given, with that account\'s coordinates', async () => {
    const { listContainerRoleAssignments } = await import('../adls-client');
    await listContainerRoleAssignments('landing', BOUND);
    expect(rec.urls).toHaveLength(1);
    // Breaks if resolveStorageScope names getAccountName() instead of `account`
    // (the scope would read storageAccounts/primaryacct).
    expect(rec.urls[0]).toContain(`/storageAccounts/${BOUND}/blobServices/default/containers/landing/`);
    // Breaks if the coordinates are discovered for the configured account: the
    // subscription and resource group would be sub-primaryacct / rg-primaryacct.
    expect(rec.urls[0]).toContain(`/subscriptions/sub-${BOUND}/resourceGroups/rg-${BOUND}/`);
    expect(rec.discovered).toEqual([BOUND]);
  });

  it('uses the configured account when none is given', async () => {
    // Control for the case above: without it, a recorder that always answered
    // BOUND could not tell "forwarded" from "hard-coded".
    const { listContainerRoleAssignments } = await import('../adls-client');
    await listContainerRoleAssignments('landing');
    expect(rec.urls[0]).toContain(`/subscriptions/sub-${PRIMARY}/resourceGroups/rg-${PRIMARY}/providers/Microsoft.Storage/storageAccounts/${PRIMARY}/`);
    expect(rec.discovered).toEqual([PRIMARY]);
  });

  it('an empty account means the configured account, as for the grant', async () => {
    // Breaks if the listing forwards '' as the account (resolveStorageScope's
    // default applies only to undefined): discovery would be asked for '' and
    // the scope would read storageAccounts//blobServices.
    const { listContainerRoleAssignments } = await import('../adls-client');
    await listContainerRoleAssignments('landing', '');
    expect(rec.discovered).toEqual([PRIMARY]);
    expect(rec.urls[0]).toContain(`/storageAccounts/${PRIMARY}/blobServices/default/containers/landing/`);
  });
});

describe('grantContainerRole account', () => {
  it('grants on the account it is given, with that account\'s coordinates', async () => {
    const { grantContainerRole } = await import('../adls-client');
    await grantContainerRole('landing', 'p1', 'Storage Blob Data Reader', 'User', BOUND);
    expect(rec.urls).toHaveLength(1);
    // Breaks if the grant scope names the configured account: the PUT would go
    // to storageAccounts/primaryacct.
    expect(rec.urls[0]).toContain(
      `/subscriptions/sub-${BOUND}/resourceGroups/rg-${BOUND}/providers/Microsoft.Storage/storageAccounts/${BOUND}/blobServices/default/containers/landing/providers/Microsoft.Authorization/roleAssignments/`,
    );
    // Breaks if the role definition is scoped to the configured account's
    // subscription (resolveStorageCoords() with no account): sub-primaryacct.
    expect(JSON.parse(rec.bodies[0]).properties.roleDefinitionId).toMatch(
      new RegExp(`^/subscriptions/sub-${BOUND}/providers/Microsoft\\.Authorization/roleDefinitions/`),
    );
    // The account's coordinates are resolved ONCE and used for both the role
    // definition and the scope. The discovery mock has no cache, so this
    // breaks if the grant resolves them twice: [BOUND, BOUND].
    expect(rec.discovered).toEqual([BOUND]);
  });

  it('grants on the configured account when none is given', async () => {
    // Control for the case above, as for the listing.
    const { grantContainerRole } = await import('../adls-client');
    await grantContainerRole('landing', 'p1', 'Storage Blob Data Reader', 'User');
    expect(rec.urls[0]).toContain(`/storageAccounts/${PRIMARY}/blobServices/default/containers/landing/`);
    expect(JSON.parse(rec.bodies[0]).properties.roleDefinitionId).toMatch(new RegExp(`^/subscriptions/sub-${PRIMARY}/`));
  });
});

describe('an account Resource Graph does not place', () => {
  // LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG are set (beforeEach), so a fallback that
  // built the scope from them for BOUND would have values, would call ARM, and
  // would resolve. Each case below breaks on that: the call resolves instead of
  // rejecting, and rec.urls gains the env-built URL.
  const notLocated = {
    name: 'StorageAccountNotLocatedError',
    code: 'storage_account_not_located',
    account: BOUND,
    remediation: expect.stringContaining(
      `Role Based Access Control Administrator on storage account "${BOUND}", constrained (ABAC condition) `
      + 'to assigning only Storage Blob Data Reader, Storage Blob Data Contributor or Storage Blob Data Owner.',
    ),
  };

  it('the remediation names the bicep module that grants the role', async () => {
    rec.missing.add(BOUND);
    const { listContainerRoleAssignments, STORAGE_RBAC_ADMIN_BICEP } = await import('../adls-client');
    // Breaks if the constant names a path that is not the module.
    expect(STORAGE_RBAC_ADMIN_BICEP).toBe('platform/fiab/bicep/modules/landing-zone/storage-rbac-admin.bicep');
    const err: any = await listContainerRoleAssignments('landing', BOUND).catch((e) => e);
    // Breaks if the remediation stops citing the module or its parameter, or
    // names Reader on the subscription instead (the Round 7 text).
    expect(err.remediation).toContain(`with ${STORAGE_RBAC_ADMIN_BICEP}`);
    expect(err.remediation).toContain(`storageAccountName="${BOUND}"`);
    expect(err.remediation).not.toContain('Reader on the subscription');
    // Breaks if the parameter is described as just "the Console identity" (a
    // client id there fails the module), or the propagation delay is dropped.
    expect(err.remediation).toContain("consolePrincipalId set to the Console identity's principal (object) id, not its client id.");
    expect(err.remediation).toContain('A new role assignment can take a few minutes to take effect');
  });

  it('the listing refuses with a named error and calls no ARM', async () => {
    rec.missing.add(BOUND);
    const { listContainerRoleAssignments } = await import('../adls-client');
    await expect(listContainerRoleAssignments('landing', BOUND)).rejects.toMatchObject(notLocated);
    expect(rec.discovered).toEqual([BOUND]);
    expect(rec.urls).toEqual([]);
  });

  it('the grant refuses with a named error and calls no ARM', async () => {
    rec.missing.add(BOUND);
    const { grantContainerRole } = await import('../adls-client');
    await expect(grantContainerRole('landing', 'p1', 'Storage Blob Data Reader', 'User', BOUND)).rejects.toMatchObject(notLocated);
    expect(rec.urls).toEqual([]);
    expect(rec.bodies).toEqual([]);
  });

  it('the configured account still uses the env coordinates (control)', async () => {
    // The env values describe the configured account, so the fallback stays
    // for it. Breaks if the named error is thrown for every missing account
    // (this call would reject), or if the fallback is removed.
    rec.missing.add(PRIMARY);
    const { listContainerRoleAssignments } = await import('../adls-client');
    await listContainerRoleAssignments('landing');
    expect(rec.urls).toHaveLength(1);
    expect(rec.urls[0]).toContain(`/subscriptions/env-sub/resourceGroups/env-rg/providers/Microsoft.Storage/storageAccounts/${PRIMARY}/`);
  });

  it('the configured account in another case still uses the env coordinates (control)', async () => {
    // Storage account names are case-insensitive. Breaks if the compare with
    // the configured account is case-sensitive: 'PrimaryAcct' !== 'primaryacct',
    // so the call would reject with StorageAccountNotLocatedError.
    const MIXED = 'PrimaryAcct';
    rec.missing.add(MIXED);
    const { listContainerRoleAssignments } = await import('../adls-client');
    await listContainerRoleAssignments('landing', MIXED);
    expect(rec.discovered).toEqual([MIXED]);
    expect(rec.urls).toHaveLength(1);
    expect(rec.urls[0]).toContain(`/subscriptions/env-sub/resourceGroups/env-rg/providers/Microsoft.Storage/storageAccounts/${MIXED}/`);
  });
});

describe('a 403 from ARM on a role-assignment request', () => {
  const remediation = expect.stringContaining(
    `Role Based Access Control Administrator on storage account "${BOUND}"`,
  );
  const REVOKE_ID = `/subscriptions/s1/resourceGroups/rg1/providers/Microsoft.Storage/storageAccounts/${BOUND}`
    + '/blobServices/default/containers/landing/providers/Microsoft.Authorization/roleAssignments/'
    + '00000000-0000-0000-0000-000000000001';

  it('the listing rejects with storage_role_read_denied and the remediation', async () => {
    rec.armStatus = 403;
    const { listContainerRoleAssignments } = await import('../adls-client');
    // Breaks if the listing uses armCall directly: the rejection is a plain
    // Error with no code or remediation.
    await expect(listContainerRoleAssignments('landing', BOUND)).rejects.toMatchObject({
      name: 'StorageRoleDeniedError', code: 'storage_role_read_denied', operation: 'list',
      account: BOUND, status: 403, remediation,
      // A revoke lists first, so this sentence must also read right after Revoke.
      message: expect.stringContaining('Nothing was listed or changed.'),
    });
    expect(rec.urls).toHaveLength(1);
  });

  it('the grant rejects with storage_role_write_denied and a correlation id; ARM\'s text is logged, not returned', async () => {
    rec.armStatus = 403;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { grantContainerRole } = await import('../adls-client');
      const err: any = await grantContainerRole('landing', 'p1', 'Storage Blob Data Reader', 'User', BOUND).catch((e) => e);
      // Breaks if the grant PUT uses armCall directly (plain Error, no code).
      expect(err).toMatchObject({
        name: 'StorageRoleDeniedError', code: 'storage_role_write_denied', operation: 'grant',
        account: BOUND, status: 403, remediation,
      });
      expect(err.message).toContain('Nothing was granted.');
      // Breaks if ARM's message is appended again (the pre-change ` Azure said: ...`):
      // the object id and the subscription scope would then be in the message.
      expect([err.message.includes(ARM_OBJECT_ID), err.message.includes(ARM_SCOPE), err.message.includes(ARM_MESSAGE)])
        .toEqual([false, false, false]);
      // Breaks if the error carries no id, or the message does not name it.
      expect(err.correlationId).toMatch(/^[0-9a-f-]{8,}$/i);
      expect(err.message).toContain(`correlation id ${err.correlationId}.`);
      // Breaks if ARM's text is not logged, or is logged under another id.
      expect(logged).toHaveBeenCalledTimes(1);
      // ONE string argument on ONE line. Breaks if the entry goes back to a
      // header plus an object (2 arguments, which Node prints over several
      // lines), or if ARM's text is logged without logSafe and keeps its newline.
      const entry = logged.mock.calls[0];
      expect([entry.length, typeof entry[0], String(entry[0]).includes('\n')]).toEqual([1, 'string', false]);
      // Breaks if any field is dropped from the line, or the id differs from
      // the one the error names. `error` keeps the stock error-line query matching.
      expect(entry[0]).toBe(
        `[adls-client] error: role-assignment request refused (HTTP 403) correlationId=${err.correlationId} `
        + `account=${BOUND} operation=grant arm=${ARM_MESSAGE_LOGGED}`,
      );
    } finally {
      logged.mockRestore();
    }
  });

  it('the revoke rejects with storage_role_write_denied for the account in the id', async () => {
    rec.armStatus = 403;
    const { revokeContainerRoleAssignment } = await import('../adls-client');
    // Breaks if the revoke DELETE uses armCall directly, or if the account is
    // not read from the id (it would be '' and the remediation would name
    // storage account "").
    await expect(revokeContainerRoleAssignment(REVOKE_ID)).rejects.toMatchObject({
      name: 'StorageRoleDeniedError', code: 'storage_role_write_denied', operation: 'revoke',
      account: BOUND, remediation,
    });
  });

  it('another ARM status is rethrown unchanged (control)', async () => {
    rec.armStatus = 500;
    const { grantContainerRole, StorageRoleDeniedError } = await import('../adls-client');
    const err: any = await grantContainerRole('landing', 'p1', 'Storage Blob Data Reader', 'User', BOUND).catch((e) => e);
    // Breaks if every ARM failure is mapped to the named error (a 500 is not
    // a refusal of the Console identity's role).
    expect(err).not.toBeInstanceOf(StorageRoleDeniedError);
    expect(err.status).toBe(500);
    expect(err.message).toBe(ARM_MESSAGE);
  });
});
