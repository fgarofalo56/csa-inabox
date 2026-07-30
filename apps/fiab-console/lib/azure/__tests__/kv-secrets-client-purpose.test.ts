/**
 * getKeyVaultSecretValue enforces the purpose policy BEFORE it touches Azure.
 *
 * The point of this file (distinct from kv-secret-purpose.test.ts, which tests the
 * policy in isolation) is that the enforcement is wired into the ONE function all
 * ~13 call sites go through, and that a refusal happens before a token is minted
 * or a request is issued — so no error path, log line, or timing side channel can
 * carry the secret.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { fetchWithTimeoutMock } = vi.hoisted(() => ({
  fetchWithTimeoutMock: vi.fn(async () => new Response(JSON.stringify({ value: 'SHOULD-NEVER-BE-READ' }), { status: 200 })),
}));
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...a: any[]) => fetchWithTimeoutMock(...(a as [])),
}));

const { getTokenMock } = vi.hoisted(() => ({
  getTokenMock: vi.fn(async () => ({ token: 'KV-MI-TOKEN' })),
}));
vi.mock('@azure/identity', () => {
  class Cred { async getToken(...a: any[]) { return getTokenMock(...(a as [])); } }
  return {
    ChainedTokenCredential: Cred,
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
  };
});
vi.mock('@/lib/azure/aca-managed-identity', () => {
  class Cred { async getToken(...a: any[]) { return getTokenMock(...(a as [])); } }
  return { AcaManagedIdentityCredential: Cred };
});

import { getKeyVaultSecretValue, KeyVaultSecretPolicyError } from '../kv-secrets-client';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOOM_KEY_VAULT_URI = 'https://loomkv.vault.azure.net';
});
afterEach(() => {
  delete process.env.LOOM_KEY_VAULT_URI;
});

describe('the MSAL client secret is unreachable through the shared reader', () => {
  it('refuses before minting a Key Vault token or issuing a request', async () => {
    await expect(getKeyVaultSecretValue('loom-msal-client-secret', 'variable-library'))
      .rejects.toBeInstanceOf(KeyVaultSecretPolicyError);
    expect(getTokenMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it('refuses for every purpose in turn', async () => {
    for (const purpose of ['connection-secret', 'git-credential', 'udf-function-key', 'variable-library', 'directquery-source', 'app-env-binding'] as const) {
      await expect(getKeyVaultSecretValue('loom-msal-client-secret', purpose)).rejects.toThrow();
    }
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it('carries a 403 so BFF routes surface it as a refusal, not a 500', async () => {
    try {
      await getKeyVaultSecretValue('loom-internal-token', 'directquery-source');
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.status).toBe(403);
      expect(e.message).toMatch(/platform credential/i);
    }
  });
});

describe('a legitimate read still reaches Key Vault', () => {
  it('fetches the secret for an in-name-space read', async () => {
    const v = await getKeyVaultSecretValue('loom-conn-abc', 'connection-secret');
    expect(v).toBe('SHOULD-NEVER-BE-READ'); // the mocked KV body
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(String(fetchWithTimeoutMock.mock.calls[0][0]))
      .toBe('https://loomkv.vault.azure.net/secrets/loom-conn-abc?api-version=7.4');
  });
});
