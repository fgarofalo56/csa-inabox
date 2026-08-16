/**
 * GET /api/lakehouse/shortcuts/browse — the caller names the Key Vault secret,
 * so the platform decides which secrets that name may resolve to.
 *
 * THE DEFECT THESE TESTS PIN
 *   `?kvSecret=` is a caller-supplied secret NAME and the Console resolved it with
 *   its managed identity through `getShortcutSecretValue()` — the one Key Vault
 *   reader that never received the purpose policy. `shortcutVaultUrl()` falls back
 *   to the main Loom vault whenever LOOM_SHORTCUT_KEYVAULT is unset (the default
 *   deployment), so the name-space on offer was the platform's own credentials.
 *   Two sinks then carried the value outward:
 *     • sourceType=dataverse — the value was interpolated into parseAbfss's error
 *       ("Not a valid abfss:// URI: <value>") and returned in the response body.
 *     • sourceType=s3 — `region` was unvalidated and interpolated into the request
 *       authority, so `s3.<region>.amazonaws.com` could be relocated to a host of
 *       the caller's choosing while still ending in '.amazonaws.com'.
 *
 * These tests run the REAL kv-secrets-client and the REAL purpose policy; only
 * the session, the Azure credential, the HTTP transport and adls-client's
 * listPaths are mocked. A refusal is therefore proved to happen before a vault
 * token is minted and before any request is issued — not merely reported.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: 'user-1', tid: 't1', groups: [] }, exp: Date.now() / 1000 + 3600 }),
}));

/** Stands in for whatever the vault would return. No real credential material. */
const VAULT_VALUE = 'SENTINEL-VAULT-VALUE-NOT-A-REAL-SECRET';

const { fetchWithTimeoutMock } = vi.hoisted(() => ({
  fetchWithTimeoutMock: vi.fn(async (url: any) => {
    if (String(url).includes('/secrets/')) {
      return new Response(JSON.stringify({ value: 'SENTINEL-VAULT-VALUE-NOT-A-REAL-SECRET' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }),
}));
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...a: any[]) => fetchWithTimeoutMock(...(a as [])),
}));

const { getTokenMock } = vi.hoisted(() => ({ getTokenMock: vi.fn(async () => ({ token: 'KV-MI-TOKEN' })) }));
vi.mock('@azure/identity', () => {
  class Cred { async getToken(...a: any[]) { return getTokenMock(...(a as [])); } }
  return { ChainedTokenCredential: Cred, DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => {
  class Cred { async getToken(...a: any[]) { return getTokenMock(...(a as [])); } }
  return { AcaManagedIdentityCredential: Cred };
});

const listPathsMock = vi.fn(async () => [{ name: 'account', isDirectory: true }] as any);
vi.mock('@/lib/azure/adls-client', () => ({
  listPaths: (...a: any[]) => listPathsMock(...(a as [])),
  getMetadata: vi.fn(async () => ({})),
  getAccountName: () => 'loomlake',
}));

import { GET } from '../route';

const req = (qs: string) =>
  ({ nextUrl: new URL(`https://console.local/api/lakehouse/shortcuts/browse?${qs}`) }) as any;

/**
 * Every platform credential the browse surface must never resolve.
 *
 * Deliberately NOT limited to names already in RESERVED_EXACT. The first five
 * were, which made the assertion prove only that the policy is WIRED, not that
 * the reserved list is COMPLETE — and completeness was the actual gap:
 * `session-secret` (the Console session-signing key) and the four below it are
 * real vault secrets created by platform bicep that no check refused until this
 * change. The `loom-sc-`/`loom-shortcut-` name-space policy now refuses them
 * structurally, whether or not anyone remembers to list them.
 */
const PLATFORM_SECRETS = [
  'loom-msal-client-secret',
  'loom-internal-token',
  'loom-ci-token',
  'loom-dataverse-client-secret',
  'loom-github-mcp-pat',
  // Not covered by any reserved name or pattern before this change:
  'session-secret',
  'synthetic-login-secret',
  'loom-risingwave-root-password',
  'loom-azure-maps-primary-key',
  'loom-ducklake-catalog-url',
];

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks resets CALLS but not implementations, so restore the default
  // vault response here — otherwise a per-test mockImplementation leaks forward
  // and a later test silently asserts against the wrong secret value.
  fetchWithTimeoutMock.mockImplementation(async (url: any) => {
    if (String(url).includes('/secrets/')) {
      return new Response(JSON.stringify({ value: VAULT_VALUE }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  listPathsMock.mockImplementation(async () => [{ name: 'account', isDirectory: true }] as any);
  process.env.LOOM_KEY_VAULT_URI = 'https://loomkv.vault.azure.net';
  // THE REAL SHIPPED DEFAULT: admin-plane/main.bicep sets LOOM_SHORTCUT_KEYVAULT
  // to the admin-plane vault whenever loomShortcutKeyVaultUri is empty, and no
  // params file in any boundary supplies that override — so the shortcut vault
  // IS the main Loom vault, explicitly, in every deployment. An earlier revision
  // deleted the variable to model a "fallback", which is a state that does not
  // occur on a deployed Console.
  process.env.LOOM_SHORTCUT_KEYVAULT = 'https://loomkv.vault.azure.net';
});
afterEach(() => {
  delete process.env.LOOM_KEY_VAULT_URI;
});

describe('ATTACK: a caller-named platform secret', () => {
  it('is refused BEFORE the secret is read — no token minted, no request issued', async () => {
    const res = await GET(req('sourceType=dataverse&kvSecret=loom-msal-client-secret'));

    expect(res.status).toBe(403);
    expect(getTokenMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('kv_secret_not_permitted');
    // The refusal names what was ASKED FOR and why — never anything from a vault.
    expect(body.error).toMatch(/platform credential/i);
    expect(JSON.stringify(body)).not.toContain(VAULT_VALUE);
  });

  it('is refused for every platform credential and every source type', async () => {
    for (const name of PLATFORM_SECRETS) {
      for (const sourceType of ['dataverse', 's3', 'gcs']) {
        const res = await GET(req(`sourceType=${sourceType}&kvSecret=${name}&bucket=b`));
        expect(res.status).toBe(403);
      }
    }
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it('cannot borrow another feature\'s minted credential (a connection password or git PAT)', async () => {
    for (const name of ['loom-conn-someone-elses-uuid', 'loom-git-ws1-pat', 'loom-app-git-abc123']) {
      const res = await GET(req(`sourceType=dataverse&kvSecret=${name}`));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/name-space/i);
    }
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it('is refused when an operator DOES split shortcuts onto their own vault', async () => {
    // The shipped default points both names at one vault; an operator override
    // is the other configuration, and the policy is not conditional on either.
    process.env.LOOM_SHORTCUT_KEYVAULT = 'https://shortcutkv.vault.azure.net';
    const res = await GET(req('sourceType=dataverse&kvSecret=loom-msal-client-secret'));
    expect(res.status).toBe(403);
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it('refuses an operator-typed name outside the minted name-space', async () => {
    // shortcut-credential OWNS loom-sc-/loom-shortcut-. A free-typed name is not
    // in it, and no UI path sends one to this route.
    const res = await GET(req('sourceType=dataverse&kvSecret=contoso-dataverse-export-path'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/name-space/i);
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });
});

describe('ATTACK: the resolved value must not come back in the response', () => {
  it('never echoes a malformed dataverse credential', async () => {
    // The vault returns something that is not an abfss:// URI — exactly the case
    // that used to interpolate the value into the error message.
    const res = await GET(req('sourceType=dataverse&kvSecret=loom-shortcut-abc'));

    expect(res.status).toBe(400);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain(VAULT_VALUE);
    expect(raw).toMatch(/not an abfss:\/\/ export path/i);
  });
});

describe('ATTACK: the S3 destination must not be caller-steerable', () => {
  it('refuses a region that would relocate the request authority — before the secret is read', async () => {
    for (const region of ['evil.example/', 'x.evil.example/y', 'us-east-1@evil.example', 'us-east-1?x=']) {
      const res = await GET(
        req(`sourceType=s3&kvSecret=loom-shortcut-abc&bucket=b&region=${encodeURIComponent(region)}`),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('s3_bad_region');
    }
    // No S3 request went out — and no vault read happened either, because the
    // destination is validated before the credential is resolved.
    const urls = fetchWithTimeoutMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('evil.example'))).toBe(false);
    expect(urls.some((u) => u.includes('/secrets/'))).toBe(false);
    expect(getTokenMock).not.toHaveBeenCalled();
  });
});

describe('the legitimate browse flow still works', () => {
  it('resolves a shortcut credential and lists the Dataverse export path', async () => {
    fetchWithTimeoutMock.mockImplementation(async (url: any) => {
      if (String(url).includes('/secrets/')) {
        return new Response(
          JSON.stringify({ value: 'abfss://dataverse@contoso.dfs.core.windows.net/exports/tables' }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const res = await GET(req('sourceType=dataverse&kvSecret=loom-shortcut-abc'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.entries).toEqual([{ name: 'account', path: 'account', isDirectory: true }]);
    // The credential WAS read — from the vault, under its own name.
    expect(String(fetchWithTimeoutMock.mock.calls[0][0]))
      .toBe('https://loomkv.vault.azure.net/secrets/loom-shortcut-abc?api-version=7.4');
    // ...and the browse ran against the account named by the stored path.
    expect(listPathsMock).toHaveBeenCalledWith('dataverse', 'exports/tables', 200, 'contoso');
  });

  it('accepts the OTHER minted shortcut prefix (loom-sc-) as well', async () => {
    // Two mint sites exist: `loom-shortcut-<itemId>` (the item route) and
    // `loom-sc-<uuid>` (the credentials route). Both must resolve, or the
    // name-space policy would break one of the two real creation paths.
    const res = await GET(req('sourceType=dataverse&kvSecret=loom-sc-4f2a9c1e'));
    expect(res.status).not.toBe(403);
    expect(String(fetchWithTimeoutMock.mock.calls[0][0]))
      .toBe('https://loomkv.vault.azure.net/secrets/loom-sc-4f2a9c1e?api-version=7.4');
  });

  it('a valid AWS region is accepted and signs against the AWS host', async () => {
    fetchWithTimeoutMock.mockImplementation(async (url: any) => {
      if (String(url).includes('/secrets/')) {
        return new Response(JSON.stringify({ value: 'AKIAEXAMPLE:not-a-real-key' }), { status: 200 });
      }
      return new Response('<ListBucketResult></ListBucketResult>', { status: 200 });
    });

    const res = await GET(req('sourceType=s3&kvSecret=loom-shortcut-abc&bucket=my-bucket&region=eu-west-2'));

    expect(res.status).toBe(200);
    const s3Call = fetchWithTimeoutMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('amazonaws.com'));
    expect(s3Call).toBe('https://s3.eu-west-2.amazonaws.com/my-bucket?delimiter=%2F&list-type=2&max-keys=100');
  });

  it('ADLS browse needs no credential at all', async () => {
    const res = await GET(req('sourceType=adls&account=contoso&container=raw'));
    expect(res.status).toBe(200);
    // No vault read happened on the uncredentialed path.
    const secretReads = fetchWithTimeoutMock.mock.calls.filter((c) => String(c[0]).includes('/secrets/'));
    expect(secretReads).toHaveLength(0);
  });
});
