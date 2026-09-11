/**
 * Unit tests for the pure Foundry connection body shaping (AIF-9).
 * No live workspace / credential — asserts the secret-handling contract:
 * Entra ID needs no secret, and key-based modes NEVER put a raw secret on the
 * wire (only a Key Vault reference).
 */
import { describe, it, expect } from 'vitest';
import {
  buildConnectionBody,
  buildConnectionUpdateBody,
  authTypeToMode,
  isKeyVaultSecretUri,
  isValidConnectionName,
  RawSecretRejectedError,
  CONNECTION_CATEGORIES,
  composeBlobTarget,
  splitBlobTarget,
  blobAccountFromEndpoint,
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

describe('authTypeToMode — prefill the edit dialog from a persisted authType', () => {
  it('maps key-based authTypes to their edit mode', () => {
    expect(authTypeToMode('ApiKey')).toBe('ApiKey');
    expect(authTypeToMode('CustomKeys')).toBe('CustomKeys');
  });
  it('falls back to AAD for AAD, unknown, or missing authTypes', () => {
    expect(authTypeToMode('AAD')).toBe('AAD');
    expect(authTypeToMode('SAS')).toBe('AAD');
    expect(authTypeToMode(undefined)).toBe('AAD');
    expect(authTypeToMode(null)).toBe('AAD');
    expect(authTypeToMode('')).toBe('AAD');
  });
});

describe('buildConnectionUpdateBody — edit reuses the create-or-update PUT shaping', () => {
  it('preserves the (immutable) category while changing the target on edit', () => {
    const body = buildConnectionUpdateBody({
      name: 'aoai', category: 'AzureOpenAI', target: 'https://new-endpoint.openai.azure.com',
    });
    expect(body.properties.category).toBe('AzureOpenAI');
    expect(body.properties.target).toBe('https://new-endpoint.openai.azure.com');
    expect(body.properties.authType).toBe('AAD');
  });
  it('still rejects a raw secret on edit (KV reference only)', () => {
    expect(() => buildConnectionUpdateBody({
      name: 'byo', category: 'ApiKey', target: 'https://x', authMode: 'ApiKey', keyVaultSecretUri: 'sk-raw',
    })).toThrow(RawSecretRejectedError);
  });
  it('carries a rotated KV reference on edit without any plaintext', () => {
    const body = buildConnectionUpdateBody({
      name: 'byo', category: 'ApiKey', target: 'https://x', authMode: 'ApiKey', keyVaultSecretUri: KV,
    });
    expect(body.properties.credentials.key).toBe(KV);
    expect(JSON.stringify(body)).toContain('vault.azure.net/secrets');
  });
});

describe('CONNECTION_CATEGORIES', () => {
  it('every category lists at least one auth mode with the first as default', () => {
    for (const c of CONNECTION_CATEGORIES) {
      expect(c.authModes.length).toBeGreaterThan(0);
    }
    expect(CONNECTION_CATEGORIES.find((c) => c.value === 'AzureOpenAI')!.authModes[0]).toBe('AAD');
  });

  /**
   * THE ROW MUST BE ABLE TO EMIT THE SHAPE IT DECLARES (blocking review,
   * 2026-09-07). `AzureBlob`'s `targetPlaceholder` is
   * `https://<account>.blob.core.windows.net/<container>`, and its `kind`
   * projects `properties.primaryEndpoints.blob` — the ACCOUNT endpoint, no
   * container — so the default path (pick from the list, create) produced a
   * target missing a segment this same file says is part of it. That was a
   * contradiction INSIDE the repo, which is why this is asserted here and not
   * against a live workspace.
   *
   * MUTATION: drop `containerScoped: true` from the AzureBlob row → RC=1,
   * `expected undefined to be true`.
   */
  it('a row whose placeholder has a path segment is declared containerScoped', () => {
    for (const c of CONNECTION_CATEGORIES) {
      // `https://<x>` has no path; `https://<x>/<y>` does.
      const hasPathSegment = /^https:\/\/[^/]+\/.+/.test(c.targetPlaceholder);
      expect(!!c.containerScoped, `${c.value}: ${c.targetPlaceholder}`).toBe(hasPathSegment);
    }
    expect(CONNECTION_CATEGORIES.find((c) => c.value === 'AzureBlob')!.containerScoped).toBe(true);
  });

  it('the composed AzureBlob target matches the shape the row declares', () => {
    const row = CONNECTION_CATEGORIES.find((c) => c.value === 'AzureBlob')!;
    // What `storage-blob-endpoint` actually returns from ARM, both boundaries.
    for (const endpoint of ['https://acct.blob.core.windows.net/', 'https://acct.blob.core.usgovcloudapi.net/']) {
      const composed = composeBlobTarget(endpoint, 'raw');
      const shape = new RegExp(
        `^${row.targetPlaceholder
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace('<account>', '[a-z0-9]+')
          .replace('blob\\.core\\.windows\\.net', 'blob\\.core\\.[a-z.]+')
          .replace('<container>', '[a-z0-9-]+')}$`,
      );
      expect(composed, `${endpoint} -> ${composed}`).toMatch(shape);
      // …and the account endpoint ALONE — what the kind emits unaided — does not.
      expect(endpoint.replace(/\/$/, '')).not.toMatch(shape);
    }
  });
});

describe('composeBlobTarget / splitBlobTarget — the container half', () => {
  it('joins with exactly one slash, whatever the two halves carry', () => {
    expect(composeBlobTarget('https://a.blob.core.windows.net/', 'raw')).toBe('https://a.blob.core.windows.net/raw');
    expect(composeBlobTarget('https://a.blob.core.windows.net', 'raw')).toBe('https://a.blob.core.windows.net/raw');
    expect(composeBlobTarget('https://a.blob.core.windows.net//', '/raw/')).toBe('https://a.blob.core.windows.net/raw');
  });

  it('does not emit a dangling slash for a half-filled form', () => {
    expect(composeBlobTarget('https://a.blob.core.windows.net/', '')).toBe('https://a.blob.core.windows.net');
    expect(composeBlobTarget('', 'raw')).toBe('');
  });

  it('round-trips a stored target back into the two controls that made it', () => {
    const t = composeBlobTarget('https://acct.blob.core.usgovcloudapi.net/', 'bronze');
    expect(splitBlobTarget(t)).toEqual({ accountEndpoint: 'https://acct.blob.core.usgovcloudapi.net', container: 'bronze', path: '' });
    const s = splitBlobTarget(t);
    expect(composeBlobTarget(s.accountEndpoint, s.container, s.path)).toBe(t);
  });

  it('splits an account-only target to an EMPTY container rather than guessing one', () => {
    expect(splitBlobTarget('https://acct.blob.core.windows.net')).toEqual({ accountEndpoint: 'https://acct.blob.core.windows.net', container: '', path: '' });
    expect(splitBlobTarget('https://acct.blob.core.windows.net/')).toEqual({ accountEndpoint: 'https://acct.blob.core.windows.net', container: '', path: '' });
  });

  /**
   * Re-review 2026-09-07, nit 4. Everything after the host used to be folded
   * into `container`, so a stored `…/bronze/raw/2026` prefilled the container
   * picker with `bronze/raw/2026` — a "container name" containing slashes,
   * which matches none of the containers the picker lists and which compose
   * would then re-emit as though the user had chosen it.
   */
  describe('a deeper stored path is kept, not folded into the container', () => {
    it('takes the FIRST segment as the container and returns the rest as path', () => {
      expect(splitBlobTarget('https://acct.blob.core.windows.net/bronze/raw/2026')).toEqual({
        accountEndpoint: 'https://acct.blob.core.windows.net', container: 'bronze', path: 'raw/2026',
      });
      // Never a slash in the container half — that is what broke the picker.
      expect(splitBlobTarget('https://acct.blob.core.windows.net/bronze/raw/2026').container).not.toContain('/');
    });

    it('round-trips a nested path losslessly — an edit must not repoint the connection', () => {
      const t = 'https://acct.blob.core.usgovcloudapi.net/bronze/raw/2026';
      const s = splitBlobTarget(t);
      expect(composeBlobTarget(s.accountEndpoint, s.container, s.path)).toBe(t);
    });

    it('normalises stray slashes on the way back out', () => {
      expect(splitBlobTarget('https://acct.blob.core.windows.net/bronze/raw/')).toEqual({
        accountEndpoint: 'https://acct.blob.core.windows.net', container: 'bronze', path: 'raw',
      });
      expect(composeBlobTarget('https://acct.blob.core.windows.net/', '/bronze/', '/raw/2026/'))
        .toBe('https://acct.blob.core.windows.net/bronze/raw/2026');
    });

    it('drops a path with no container — a shape nothing can produce', () => {
      expect(composeBlobTarget('https://acct.blob.core.windows.net', '', 'raw/2026'))
        .toBe('https://acct.blob.core.windows.net');
    });

    it('omitting the path argument is the old two-arg behaviour, unchanged', () => {
      expect(composeBlobTarget('https://acct.blob.core.windows.net', 'bronze'))
        .toBe('https://acct.blob.core.windows.net/bronze');
    });
  });

  it('reads the account name out of either boundary host, and nothing else', () => {
    expect(blobAccountFromEndpoint('https://acct1.blob.core.windows.net/')).toBe('acct1');
    expect(blobAccountFromEndpoint('https://ACCT1.blob.core.usgovcloudapi.net')).toBe('acct1');
    // A DFS endpoint is a different service and must not be read as a blob one.
    expect(blobAccountFromEndpoint('https://acct1.dfs.core.windows.net/')).toBe('');
    expect(blobAccountFromEndpoint('')).toBe('');
  });
});
