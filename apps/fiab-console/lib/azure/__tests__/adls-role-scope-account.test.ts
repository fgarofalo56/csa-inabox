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
 * Resource Graph discovery and the ARM fetch are replaced by recorders.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const rec = vi.hoisted(() => ({
  urls: [] as string[], bodies: [] as string[], discovered: [] as string[],
  /** Account names Resource Graph does not place (discovery answers null). */
  missing: new Set<string>(),
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
    return { ok: true, status: 200, text: async () => JSON.stringify({ value: [] }) };
  },
}));

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
    remediation: expect.stringContaining(`Reader on the subscription that holds storage account "${BOUND}"`),
  };

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
});
