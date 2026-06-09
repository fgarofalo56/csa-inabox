/**
 * Unit tests for cmk-client (Customer-Managed Keys, F14).
 *
 * Mocks @azure/identity (token always succeeds, with a per-scope tag so we can
 * assert the KV data-plane scope is sovereign-correct) and global fetch (per-URL
 * routing so we can assert the exact KV/ARM request shapes). No live Azure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Tag the token by the requested scope so tests can prove kvToken() asks for the
// Key Vault audience (NOT a hard-coded vault.azure.net) and armToken() asks ARM.
// Fully self-contained (no importActual) so the real @azure/identity — whose
// transitive deps are not all present in the test store — never loads.
vi.mock('@azure/identity', () => {
  class StubCred {
    async getToken(scope: string) {
      return { token: `tok::${scope}`, expiresOnTimestamp: Date.now() + 60_000 };
    }
  }
  return {
    DefaultAzureCredential: StubCred,
    ManagedIdentityCredential: StubCred,
    ChainedTokenCredential: StubCred,
  };
});

import {
  cmkConfigGate,
  cmkVaultUrl,
  parseStorageAccountId,
  resolveStorageAccount,
  listVaultKeys,
  listKeyVersions,
  getStorageCmkStatus,
  bindStorageCmk,
  unbindStorageCmk,
  checkRoleAtScope,
  KV_CRYPTO_SVC_ENC_USER_ROLE_ID,
  STORAGE_ACCOUNT_CONTRIBUTOR_ROLE_ID,
} from '../cmk-client';

const ENV0 = { ...process.env };

interface Captured { url: string; init: any }
let calls: Captured[] = [];

/** Route fetch by URL substring → JSON body. */
function routeFetch(routes: Array<{ match: string; status?: number; json: any }>) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
    calls.push({ url, init });
    const r = routes.find((x) => url.includes(x.match));
    const status = r?.status ?? 200;
    const payload = r?.json ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    } as any;
  }));
}

beforeEach(() => {
  process.env = { ...ENV0 };
  process.env.AZURE_CLOUD = 'AzureCloud';
  process.env.LOOM_KEY_VAULT_URI = 'https://kv-loom.vault.azure.net';
  process.env.LOOM_UAMI_RESOURCE_ID =
    '/subscriptions/sub1/resourceGroups/rg-admin/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uami-console';
  process.env.LOOM_SUBSCRIPTION_ID = 'sub1';
  process.env.LOOM_DLZ_RG = 'rg-dlz';
  process.env.LOOM_BRONZE_URL = 'https://saloomtest.dfs.core.windows.net/bronze';
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ENV0 };
});

describe('cmkConfigGate', () => {
  it('returns null when all env present', () => {
    expect(cmkConfigGate()).toBeNull();
  });
  it('flags LOOM_KEY_VAULT_URI first', () => {
    delete process.env.LOOM_KEY_VAULT_URI;
    delete process.env.LOOM_KEY_VAULT_NAME;
    expect(cmkConfigGate()?.missing).toBe('LOOM_KEY_VAULT_URI');
  });
  it('flags LOOM_UAMI_RESOURCE_ID when missing', () => {
    delete process.env.LOOM_UAMI_RESOURCE_ID;
    expect(cmkConfigGate()?.missing).toBe('LOOM_UAMI_RESOURCE_ID');
  });
  it('flags sub/rg when missing', () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    expect(cmkConfigGate()?.missing).toContain('LOOM_SUBSCRIPTION_ID');
  });
});

describe('cmkVaultUrl', () => {
  it('strips trailing slash from explicit URI', () => {
    process.env.LOOM_KEY_VAULT_URI = 'https://kv-loom.vault.azure.net/';
    expect(cmkVaultUrl()).toBe('https://kv-loom.vault.azure.net');
  });
  it('builds sovereign host from LOOM_KEY_VAULT_NAME in Gov', () => {
    delete process.env.LOOM_KEY_VAULT_URI;
    process.env.LOOM_KEY_VAULT_NAME = 'kv-gov';
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    expect(cmkVaultUrl()).toBe('https://kv-gov.vault.usgovcloudapi.net');
  });
});

describe('parseStorageAccountId / resolveStorageAccount', () => {
  it('parses a full ARM id', () => {
    const ref = parseStorageAccountId(
      '/subscriptions/s/resourceGroups/g/providers/Microsoft.Storage/storageAccounts/acct',
    );
    expect(ref).toEqual({ subscriptionId: 's', resourceGroup: 'g', accountName: 'acct' });
  });
  it('returns null for malformed id', () => {
    expect(parseStorageAccountId('not-an-arm-id')).toBeNull();
  });
  it('falls back to env (account parsed from LOOM_BRONZE_URL)', () => {
    const ref = resolveStorageAccount(undefined);
    expect(ref).toEqual({ subscriptionId: 'sub1', resourceGroup: 'rg-dlz', accountName: 'saloomtest' });
  });
  it('prefers the workspace ARM id over env', () => {
    const ref = resolveStorageAccount(
      '/subscriptions/sX/resourceGroups/gX/providers/Microsoft.Storage/storageAccounts/acctX',
    );
    expect(ref.accountName).toBe('acctX');
  });
});

describe('listVaultKeys', () => {
  it('uses KV api 7.4 + sovereign KV token, extracts names newest-first', async () => {
    routeFetch([{
      match: '/keys?api-version=7.4',
      json: {
        value: [
          { kid: 'https://kv-loom.vault.azure.net/keys/old', attributes: { enabled: true, created: 100 } },
          { kid: 'https://kv-loom.vault.azure.net/keys/new', attributes: { enabled: true, created: 200 } },
        ],
      },
    }]);
    const keys = await listVaultKeys('https://kv-loom.vault.azure.net');
    expect(keys.map((k) => k.name)).toEqual(['new', 'old']); // sorted by created desc
    // Token scope must be the KV audience, not ARM.
    expect(calls[0].init.headers.authorization).toBe('Bearer tok::https://vault.azure.net/.default');
    expect(calls[0].url).toContain('api-version=7.4');
  });
});

describe('listKeyVersions', () => {
  it('extracts version segment from kid', async () => {
    routeFetch([{
      match: '/keys/mykey/versions',
      json: {
        value: [
          { kid: 'https://kv-loom.vault.azure.net/keys/mykey/aaa', attributes: { enabled: true, created: 1 } },
          { kid: 'https://kv-loom.vault.azure.net/keys/mykey/bbb', attributes: { enabled: true, created: 2 } },
        ],
      },
    }]);
    const versions = await listKeyVersions('https://kv-loom.vault.azure.net', 'mykey');
    expect(versions.map((v) => v.version)).toEqual(['bbb', 'aaa']);
  });
});

describe('getStorageCmkStatus', () => {
  it('reads encryption.keyvaultproperties from ARM', async () => {
    routeFetch([{
      match: '/storageAccounts/acct?api-version=2023-05-01',
      json: {
        properties: {
          encryption: {
            keySource: 'Microsoft.Keyvault',
            identity: { userAssignedIdentity: '/uami/x' },
            keyvaultproperties: {
              keyvaulturi: 'https://kv-loom.vault.azure.net',
              keyname: 'mykey',
              keyversion: '',
              currentVersionedKeyIdentifier: 'https://kv-loom.vault.azure.net/keys/mykey/abc',
            },
          },
        },
      },
    }]);
    const st = await getStorageCmkStatus({ subscriptionId: 's', resourceGroup: 'g', accountName: 'acct' });
    expect(st.cmk).toBe(true);
    expect(st.keySource).toBe('Microsoft.Keyvault');
    expect(st.keyName).toBe('mykey');
    expect(st.keyVersion).toBe('');
    expect(st.currentVersionedKeyIdentifier).toContain('/keys/mykey/abc');
    // ARM token, not KV token.
    expect(calls[0].init.headers.authorization).toBe('Bearer tok::https://management.azure.com/.default');
  });

  it('reports Microsoft-managed when keySource is Microsoft.Storage', async () => {
    routeFetch([{
      match: '/storageAccounts/acct',
      json: { properties: { encryption: { keySource: 'Microsoft.Storage' } } },
    }]);
    const st = await getStorageCmkStatus({ subscriptionId: 's', resourceGroup: 'g', accountName: 'acct' });
    expect(st.cmk).toBe(false);
    expect(st.keySource).toBe('Microsoft.Storage');
  });
});

describe('bindStorageCmk', () => {
  it('PATCHes Microsoft.Keyvault with auto-rotate when keyVersion empty', async () => {
    let patchBody: any = null;
    routeFetch([{ match: '/storageAccounts/acct', json: {
      properties: { encryption: { keySource: 'Microsoft.Keyvault', keyvaultproperties: { keyvaulturi: 'https://kv-loom.vault.azure.net', keyname: 'mykey', keyversion: '' } } },
    } }]);
    await bindStorageCmk({
      ref: { subscriptionId: 's', resourceGroup: 'g', accountName: 'acct' },
      uamiResourceId: '/uami/x',
      vaultUri: 'https://kv-loom.vault.azure.net',
      keyName: 'mykey',
    });
    // First call is the PATCH; capture it.
    const patch = calls.find((c) => c.init.method === 'PATCH')!;
    patchBody = JSON.parse(patch.init.body);
    expect(patch.init.method).toBe('PATCH');
    expect(patchBody.properties.encryption.keySource).toBe('Microsoft.Keyvault');
    expect(patchBody.properties.encryption.keyvaultproperties.keyversion).toBe('');
    expect(patchBody.properties.encryption.identity.userAssignedIdentity).toBe('/uami/x');
    expect(patchBody.identity.type).toBe('UserAssigned');
    expect(Object.keys(patchBody.identity.userAssignedIdentities)).toContain('/uami/x');
  });

  it('pins the version when provided', async () => {
    routeFetch([{ match: '/storageAccounts/acct', json: { properties: { encryption: { keySource: 'Microsoft.Keyvault', keyvaultproperties: {} } } } }]);
    await bindStorageCmk({
      ref: { subscriptionId: 's', resourceGroup: 'g', accountName: 'acct' },
      uamiResourceId: '/uami/x',
      vaultUri: 'https://kv-loom.vault.azure.net',
      keyName: 'mykey',
      keyVersion: 'deadbeef',
    });
    const patch = calls.find((c) => c.init.method === 'PATCH')!;
    expect(JSON.parse(patch.init.body).properties.encryption.keyvaultproperties.keyversion).toBe('deadbeef');
  });
});

describe('unbindStorageCmk', () => {
  it('reverts to Microsoft.Storage', async () => {
    routeFetch([{ match: '/storageAccounts/acct', json: { properties: { encryption: { keySource: 'Microsoft.Storage' } } } }]);
    await unbindStorageCmk({ subscriptionId: 's', resourceGroup: 'g', accountName: 'acct' });
    const patch = calls.find((c) => c.init.method === 'PATCH')!;
    expect(JSON.parse(patch.init.body).properties.encryption.keySource).toBe('Microsoft.Storage');
  });
});

describe('checkRoleAtScope', () => {
  it('returns present when the principal holds the role', async () => {
    routeFetch([{ match: '/roleAssignments', json: {
      value: [{ properties: { roleDefinitionId: `/x/${STORAGE_ACCOUNT_CONTRIBUTOR_ROLE_ID}` } }],
    } }]);
    const r = await checkRoleAtScope('/scope', STORAGE_ACCOUNT_CONTRIBUTOR_ROLE_ID, 'p1');
    expect(r).toBe('present');
  });
  it('returns missing when the role is absent', async () => {
    routeFetch([{ match: '/roleAssignments', json: { value: [{ properties: { roleDefinitionId: '/x/other' } }] } }]);
    const r = await checkRoleAtScope('/scope', KV_CRYPTO_SVC_ENC_USER_ROLE_ID, 'p1');
    expect(r).toBe('missing');
  });
  it('returns unknown on ARM error (so the UI does not hard-block)', async () => {
    routeFetch([{ match: '/roleAssignments', status: 403, json: { error: { message: 'forbidden' } } }]);
    const r = await checkRoleAtScope('/scope', KV_CRYPTO_SVC_ENC_USER_ROLE_ID, 'p1');
    expect(r).toBe('unknown');
  });
});
