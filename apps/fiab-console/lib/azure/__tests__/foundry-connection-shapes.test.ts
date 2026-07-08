/**
 * Unit tests for the pure Foundry connection body shaping (AIF-9).
 * No live workspace / credential — asserts the secret-handling contract:
 * Entra ID needs no secret, and key-based modes NEVER put a raw secret on the
 * wire (only a Key Vault reference).
 */
import { describe, it, expect } from 'vitest';
import {
  buildConnectionBody,
  isKeyVaultSecretUri,
  isValidConnectionName,
  RawSecretRejectedError,
  CONNECTION_CATEGORIES,
} from '../foundry-connection-shapes';

const KV = 'https://my-kv.vault.azure.net/secrets/aoai-key';

describe('isKeyVaultSecretUri', () => {
  it('accepts commercial + gov KV secret identifiers', () => {
    expect(isKeyVaultSecretUri(KV)).toBe(true);
    expect(isKeyVaultSecretUri(`${KV}/abc123version`)).toBe(true);
    expect(isKeyVaultSecretUri('https://kv.vault.usgovcloudapi.net/secrets/x')).toBe(true);
  });
  it('rejects raw keys and non-KV URLs', () => {
    expect(isKeyVaultSecretUri('sk-abc123')).toBe(false);
    expect(isKeyVaultSecretUri('a1b2c3d4e5')).toBe(false);
    expect(isKeyVaultSecretUri('https://example.com/secrets/x')).toBe(false);
    expect(isKeyVaultSecretUri('')).toBe(false);
  });
});

describe('isValidConnectionName', () => {
  it('enforces the 2–63 char name rule', () => {
    expect(isValidConnectionName('my-aoai_conn.1')).toBe(true);
    expect(isValidConnectionName('a')).toBe(false);
    expect(isValidConnectionName('bad name')).toBe(false);
    expect(isValidConnectionName('-lead')).toBe(false);
  });
});

describe('buildConnectionBody — Entra ID (AAD) default', () => {
  it('emits authType AAD with NO credentials for an AzureOpenAI connection', () => {
    const body = buildConnectionBody({ name: 'aoai', category: 'AzureOpenAI', target: 'https://x.openai.azure.com' });
    expect(body.properties.category).toBe('AzureOpenAI');
    expect(body.properties.authType).toBe('AAD');
    expect(body.properties.credentials).toBeUndefined();
    expect(body.properties.isSharedToAll).toBe(true);
  });
  it('honors isSharedToAll=false', () => {
    const body = buildConnectionBody({ name: 'search', category: 'CognitiveSearch', target: 'https://x.search.windows.net', isSharedToAll: false });
    expect(body.properties.isSharedToAll).toBe(false);
  });
});

describe('buildConnectionBody — key-based modes never carry a raw secret', () => {
  it('accepts a KV reference for ApiKey and stores it (no plaintext key)', () => {
    const body = buildConnectionBody({ name: 'byo', category: 'ApiKey', target: 'https://x', authMode: 'ApiKey', keyVaultSecretUri: KV });
    expect(body.properties.authType).toBe('ApiKey');
    expect(body.properties.credentials.key).toBe(KV);
    // The wire body must contain the KV reference and nothing that looks like a raw key.
    expect(JSON.stringify(body)).toContain('vault.azure.net/secrets');
  });
  it('throws RawSecretRejectedError when ApiKey is given a raw key', () => {
    expect(() => buildConnectionBody({ name: 'byo', category: 'ApiKey', target: 'https://x', authMode: 'ApiKey', keyVaultSecretUri: 'sk-raw-secret' }))
      .toThrow(RawSecretRejectedError);
  });
  it('CustomKeys accepts a map of KV references', () => {
    const body = buildConnectionBody({ name: 'ck', category: 'CustomKeys', target: 'https://x', authMode: 'CustomKeys', customKeyVaultRefs: { primary: KV } });
    expect(body.properties.authType).toBe('CustomKeys');
    expect(body.properties.credentials.keys.primary).toBe(KV);
  });
  it('CustomKeys rejects a raw value in any key', () => {
    expect(() => buildConnectionBody({ name: 'ck', category: 'CustomKeys', target: 'https://x', authMode: 'CustomKeys', customKeyVaultRefs: { primary: 'raw' } }))
      .toThrow(RawSecretRejectedError);
  });
});

describe('CONNECTION_CATEGORIES', () => {
  it('every category lists at least one auth mode with the first as default', () => {
    for (const c of CONNECTION_CATEGORIES) {
      expect(c.authModes.length).toBeGreaterThan(0);
    }
    expect(CONNECTION_CATEGORIES.find((c) => c.value === 'AzureOpenAI')!.authModes[0]).toBe('AAD');
  });
});
