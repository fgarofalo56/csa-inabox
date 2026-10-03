/**
 * #3342 — the Console identity as a Databricks ACCOUNT ADMIN.
 *
 * `probeConsoleAccountAdmin` is what clears the brownfield
 * `databricks.metastoreAssignment` blocker and the svc-databricks-account-admin
 * gate the moment an account admin performs the grant, so its three outcomes
 * must be distinguishable: admin, refused, and "established nothing". The
 * transport is mocked at `fetchWithTimeout`, so the REAL `acctFetch` (URL
 * construction, error mapping, the audit `finally`) runs in every case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  getToken: vi.fn(async () => ({ token: 'tok', expiresOnTimestamp: Date.now() + 60_000 })),
}));

vi.mock('@/lib/azure/fetch-with-timeout', () => ({ fetchWithTimeout: h.fetch }));
vi.mock('@/lib/azure/unity-audit', () => ({ recordUnityAccountAccess: vi.fn() }));
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class {} }));
vi.mock('@azure/identity', () => {
  class Cred { getToken = h.getToken; }
  return { ChainedTokenCredential: Cred, DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred };
});

import {
  UnityCatalogAccountError,
  accountConsoleUrl,
  classifyAccountAdminFailure,
  consoleAccountAdminValues,
  probeConsoleAccountAdmin,
} from '../unity-catalog-account-client';

const KEYS = [
  'LOOM_DATABRICKS_ACCOUNT_ID', 'LOOM_DATABRICKS_ACCOUNT_HOST', 'LOOM_UAMI_CLIENT_ID', 'AZURE_CLIENT_ID',
  'LOOM_UAMI_PRINCIPAL_ID', 'LOOM_CONSOLE_PRINCIPAL_ID',
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  h.fetch.mockReset();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

describe('classifyAccountAdminFailure', () => {
  it('a 403 the ACCOUNT API returned is "not-admin"', () => {
    const e = new UnityCatalogAccountError('User is not an account admin', 403, null, 'https://accounts/x');
    expect(classifyAccountAdminFailure(e).state).toBe('not-admin');
  });

  // Breaks if the endpoint requirement is dropped: this 401 is the shape
  // dbxToken() throws when NO request was made, and it says nothing about roles.
  it('a 401 with no endpoint (token acquisition) is inconclusive, not "not-admin"', () => {
    const e = new UnityCatalogAccountError('Failed to acquire Databricks AAD token', 401);
    expect(classifyAccountAdminFailure(e).state).toBe('inconclusive');
  });

  // Breaks if the IP-block exclusion is removed.
  it('a 403 from an account IP access list is inconclusive', () => {
    const e = new UnityCatalogAccountError('Source IP address 1.2.3.4 is blocked by access list', 403, null, 'https://accounts/x');
    expect(classifyAccountAdminFailure(e).state).toBe('inconclusive');
  });

  it('a 5xx and a non-account error are inconclusive', () => {
    expect(classifyAccountAdminFailure(new UnityCatalogAccountError('boom', 503, null, 'https://a/x')).state).toBe('inconclusive');
    expect(classifyAccountAdminFailure(new Error('socket hang up')).state).toBe('inconclusive');
  });
});

describe('probeConsoleAccountAdmin — live read through the real acctFetch', () => {
  it('asks nothing when the account id is unset', async () => {
    expect(await probeConsoleAccountAdmin()).toEqual({ state: 'not-configured' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('reports admin with the metastore count the account returned', async () => {
    process.env.LOOM_DATABRICKS_ACCOUNT_ID = 'acct-1';
    h.fetch.mockResolvedValueOnce(res(200, { metastores: [{ metastore_id: 'm1', name: 'a' }, { metastore_id: 'm2', name: 'b' }] }));
    // Breaks if the probe stops counting what the API returned (2, not 0 or 1).
    expect(await probeConsoleAccountAdmin()).toEqual({ state: 'admin', metastoreCount: 2 });
    expect(String(h.fetch.mock.calls[0][0])).toBe('https://accounts.azuredatabricks.net/api/2.0/accounts/acct-1/metastores');
  });

  it('reports not-admin when the account API refuses the identity', async () => {
    process.env.LOOM_DATABRICKS_ACCOUNT_ID = 'acct-1';
    h.fetch.mockResolvedValueOnce(res(403, { message: 'User is not an account admin' }));
    const r = await probeConsoleAccountAdmin();
    expect(r.state).toBe('not-admin');
  });
});

describe('consoleAccountAdminValues', () => {
  it('reads every value from the deployment, null when the deployment does not hold it', () => {
    expect(consoleAccountAdminValues()).toEqual({
      consoleClientId: null, consolePrincipalId: null, accountId: null,
      accountConsoleUrl: 'https://accounts.azuredatabricks.net', suggestedDisplayName: 'loom-console-uami',
    });
    process.env.LOOM_UAMI_CLIENT_ID = 'client-1';
    process.env.LOOM_UAMI_PRINCIPAL_ID = 'oid-1';
    process.env.LOOM_CONSOLE_PRINCIPAL_ID = 'oid-other';
    process.env.LOOM_DATABRICKS_ACCOUNT_ID = ' acct-1 ';
    const v = consoleAccountAdminValues();
    expect(v.consoleClientId).toBe('client-1');
    // LOOM_UAMI_PRINCIPAL_ID is the one bicep sets on the Console app; it wins.
    expect(v.consolePrincipalId).toBe('oid-1');
    expect(v.accountId).toBe('acct-1');
  });

  it('the account console follows the sovereign host override', () => {
    process.env.LOOM_DATABRICKS_ACCOUNT_HOST = 'https://accounts.azuredatabricks.us/';
    expect(accountConsoleUrl()).toBe('https://accounts.azuredatabricks.us');
  });
});
