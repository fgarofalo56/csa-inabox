/**
 * LU-2 — Loom Unity authorization contract test.
 *
 * The finding this closes: the deployed, Unity-Catalog-compatible OSS catalog ran
 * `server.authorization=disable`, so anything that could reach the Container Apps
 * environment could read AND mutate catalog metadata anonymously. LU-2 makes the
 * Console BFF the single credentialed choke point.
 *
 * Proves (per .claude/rules/no-vaporware.md — real fetch capture, no client stubs):
 *   - a pre-shared server-minted token is presented as a bearer,
 *   - a DECLARED Entra audience makes the Console mint a UAMI token for exactly
 *     that scope and present it on the real UC REST call,
 *   - the sovereign/Commercial-agnostic scope derivation
 *     (LOOM_UNITY_AUDIENCE > api://LOOM_UNITY_CLIENT_ID > api://LOOM_MSAL_CLIENT_ID),
 *   - an un-mintable token FAILS CLOSED rather than silently retrying anonymously,
 *   - the un-declared posture stays anonymous (no behaviour change for pre-LU-2
 *     estates) but is REPORTED as un-hardened with the exact remediation — never
 *     a silent open door.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getToken = vi.fn();

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() {
      return { token: 'fake-aad-token', expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  }
  return { DefaultAzureCredential: FakeCred, ManagedIdentityCredential: FakeCred, ChainedTokenCredential: FakeCred };
});

vi.mock('@/lib/azure/arm-credential', () => ({
  uamiArmCredential: () => ({ getToken }),
}));

import {
  resolveUnityAuthMode, unityAudience, unityAuthorizationPosture,
  ossUcAuthHeader, OssUcAuthNotConfiguredError,
} from '../uc-backend';
import { listCatalogs } from '../unity-catalog-client';

const AUTH_ENV = [
  'LOOM_UC_BACKEND', 'LOOM_UNITY_URL', 'LOOM_UNITY_TOKEN',
  'LOOM_UNITY_CLIENT_ID', 'LOOM_UNITY_AUDIENCE', 'LOOM_UNITY_AUTH_MODE',
  'LOOM_MSAL_CLIENT_ID', 'LOOM_DATABRICKS_HOSTNAME', 'LOOM_DATABRICKS_HOSTNAMES',
  'LOOM_CLOUD', 'AZURE_CLOUD',
];
function clearAuthEnv() {
  for (const k of AUTH_ENV) delete process.env[k];
  getToken.mockReset();
}

function okResponse(body: unknown = {}): Response {
  return {
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('resolveUnityAuthMode / unityAudience', () => {
  beforeEach(clearAuthEnv);
  afterEach(clearAuthEnv);

  it('is anonymous when nothing is declared (pre-LU-2 estates keep working)', () => {
    expect(resolveUnityAuthMode()).toBe('anonymous');
  });

  it('does NOT infer hardening from LOOM_MSAL_CLIENT_ID alone', () => {
    // Every deployment sets the Console app registration; inferring "authorization
    // is on" from it would make the Console fail closed against catalogs that
    // never enabled authorization.
    process.env.LOOM_MSAL_CLIENT_ID = 'console-app-id';
    expect(resolveUnityAuthMode()).toBe('anonymous');
  });

  it('a declared client id selects entra and derives api://<id>/.default', () => {
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    expect(resolveUnityAuthMode()).toBe('entra');
    expect(unityAudience()).toBe('api://unity-app-id/.default');
  });

  it('an explicit audience wins over the derived one', () => {
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    process.env.LOOM_UNITY_AUDIENCE = 'api://custom/.default';
    expect(unityAudience()).toBe('api://custom/.default');
  });

  it('falls back to the Console app registration once entra is explicitly declared', () => {
    process.env.LOOM_MSAL_CLIENT_ID = 'console-app-id';
    process.env.LOOM_UNITY_AUTH_MODE = 'entra';
    expect(resolveUnityAuthMode()).toBe('entra');
    expect(unityAudience()).toBe('api://console-app-id/.default');
  });

  it('a pre-shared token selects token mode', () => {
    process.env.LOOM_UNITY_TOKEN = 'uc-service-token';
    expect(resolveUnityAuthMode()).toBe('token');
  });

  it('LOOM_UNITY_AUTH_MODE=anonymous is an explicit, reported opt-out', () => {
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    process.env.LOOM_UNITY_AUTH_MODE = 'anonymous';
    expect(resolveUnityAuthMode()).toBe('anonymous');
    expect(unityAuthorizationPosture().hardened).toBe(false);
  });
});

describe('unityAuthorizationPosture', () => {
  beforeEach(clearAuthEnv);
  afterEach(clearAuthEnv);

  it('reports the un-declared posture as UN-hardened with the exact remediation', () => {
    const p = unityAuthorizationPosture();
    expect(p.mode).toBe('anonymous');
    expect(p.hardened).toBe(false);
    expect(p.detail).toMatch(/UNAUTHENTICATED/);
    expect(p.remediation).toMatch(/authMode=entra/);
    expect(p.remediation).toMatch(/LOOM_UNITY_CLIENT_ID/);
  });

  it('reports entra hardening with the audience in play', () => {
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    const p = unityAuthorizationPosture();
    expect(p.hardened).toBe(true);
    expect(p.audience).toBe('api://unity-app-id/.default');
    expect(p.remediation).toBeUndefined();
  });
});

describe('ossUcAuthHeader', () => {
  beforeEach(clearAuthEnv);
  afterEach(clearAuthEnv);

  it('presents the pre-shared server-minted token as a bearer', async () => {
    process.env.LOOM_UNITY_TOKEN = 'uc-service-token';
    await expect(ossUcAuthHeader()).resolves.toEqual({ authorization: 'Bearer uc-service-token' });
    expect(getToken).not.toHaveBeenCalled();
  });

  it('mints an Entra token for exactly the declared scope', async () => {
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    getToken.mockResolvedValue({ token: 'entra-token', expiresOnTimestamp: Date.now() + 3_600_000 });
    await expect(ossUcAuthHeader()).resolves.toEqual({ authorization: 'Bearer entra-token' });
    expect(getToken).toHaveBeenCalledWith('api://unity-app-id/.default');
  });

  it('FAILS CLOSED when the managed identity cannot mint the token', async () => {
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    getToken.mockRejectedValue(new Error('AADSTS500011: resource principal not found'));
    await expect(ossUcAuthHeader()).rejects.toBeInstanceOf(OssUcAuthNotConfiguredError);
  });

  it('FAILS CLOSED when the credential returns no token', async () => {
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    getToken.mockResolvedValue(null);
    await expect(ossUcAuthHeader()).rejects.toBeInstanceOf(OssUcAuthNotConfiguredError);
  });

  it('FAILS CLOSED when entra is declared but no audience can be resolved', async () => {
    process.env.LOOM_UNITY_AUTH_MODE = 'entra';
    await expect(ossUcAuthHeader()).rejects.toBeInstanceOf(OssUcAuthNotConfiguredError);
    expect(getToken).not.toHaveBeenCalled();
  });

  it('stays anonymous (no header) when nothing is declared', async () => {
    await expect(ossUcAuthHeader()).resolves.toEqual({});
    expect(getToken).not.toHaveBeenCalled();
  });
});

describe('the credential reaches the real Loom Unity REST call', () => {
  beforeEach(clearAuthEnv);
  afterEach(() => { clearAuthEnv(); vi.unstubAllGlobals(); });

  it('sends the minted Entra bearer on the OSS catalogs call', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    getToken.mockResolvedValue({ token: 'entra-token', expiresOnTimestamp: Date.now() + 3_600_000 });
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ catalogs: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await listCatalogs('ignored-host');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://loom-unity.internal/api/2.1/unity-catalog/catalogs');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer entra-token');
  });

  it('does not fall back to an anonymous call when the token cannot be minted', async () => {
    process.env.LOOM_UC_BACKEND = 'oss';
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal';
    process.env.LOOM_UNITY_CLIENT_ID = 'unity-app-id';
    getToken.mockRejectedValue(new Error('no token'));
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ catalogs: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listCatalogs('ignored-host')).rejects.toBeInstanceOf(OssUcAuthNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
