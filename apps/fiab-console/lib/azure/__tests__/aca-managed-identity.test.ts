/**
 * AcaManagedIdentityCredential — unit tests.
 *
 * Proves the credential parses the REAL ACA managed-identity response shape
 * (`expires_on` Unix-seconds string, NO `expires_in`) that @azure/identity's
 * MSAL MI path chokes on, maps scope → resource correctly, and stays out of the
 * way (CredentialUnavailableError) when not running under a managed identity.
 *
 * fetchWithTimeout is mocked — no real network. Per no-vaporware.md this test
 * exercises the actual parsing/credential logic, not a stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialUnavailableError } from '@azure/identity';

const fetchWithTimeout = vi.fn();
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
}));

import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

const ENV_KEYS = [
  'IDENTITY_ENDPOINT',
  'IDENTITY_HEADER',
  'MSI_ENDPOINT',
  'MSI_SECRET',
  'LOOM_UAMI_CLIENT_ID',
  'AZURE_CLIENT_ID',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  fetchWithTimeout.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('AcaManagedIdentityCredential', () => {
  it('parses the ACA response shape (expires_on Unix-seconds → ms)', async () => {
    process.env.IDENTITY_ENDPOINT = 'http://localhost:42356/msi/token';
    process.env.IDENTITY_HEADER = 'secret-header';

    fetchWithTimeout.mockResolvedValueOnce(
      okResponse({ access_token: 'tok', expires_on: '1781647579', token_type: 'Bearer' }),
    );

    const cred = new AcaManagedIdentityCredential();
    const token = await cred.getToken('https://management.azure.com/.default');

    expect(token).toEqual({ token: 'tok', expiresOnTimestamp: 1781647579000 });
  });

  it('maps scope → resource by stripping a trailing /.default', async () => {
    process.env.IDENTITY_ENDPOINT = 'http://localhost:42356/msi/token';
    process.env.IDENTITY_HEADER = 'secret-header';

    fetchWithTimeout.mockResolvedValueOnce(
      okResponse({ access_token: 'tok', expires_on: '1781647579', token_type: 'Bearer' }),
    );

    const cred = new AcaManagedIdentityCredential();
    await cred.getToken('https://api.loganalytics.azure.com/.default');

    const calledUrl = String(fetchWithTimeout.mock.calls[0][0]);
    // resource is URL-encoded in the query string
    expect(calledUrl).toContain(
      `resource=${encodeURIComponent('https://api.loganalytics.azure.com')}`,
    );
    expect(calledUrl).not.toContain('.default');
    expect(calledUrl).toContain('api-version=2019-08-01');

    // X-IDENTITY-HEADER is sent
    const init = fetchWithTimeout.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-IDENTITY-HEADER']).toBe('secret-header');
  });

  it('passes the configured clientId as client_id', async () => {
    process.env.IDENTITY_ENDPOINT = 'http://localhost:42356/msi/token';
    process.env.IDENTITY_HEADER = 'secret-header';

    fetchWithTimeout.mockResolvedValueOnce(
      okResponse({ access_token: 'tok', expires_on: '1781647579', token_type: 'Bearer' }),
    );

    const cred = new AcaManagedIdentityCredential({ clientId: 'uami-123' });
    await cred.getToken('https://management.azure.com/.default');

    expect(String(fetchWithTimeout.mock.calls[0][0])).toContain('client_id=uami-123');
  });

  it('throws CredentialUnavailableError when IDENTITY_ENDPOINT is unset', async () => {
    const cred = new AcaManagedIdentityCredential();
    await expect(cred.getToken('https://management.azure.com/.default')).rejects.toBeInstanceOf(
      CredentialUnavailableError,
    );
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('throws a clear error on a non-200 response', async () => {
    process.env.IDENTITY_ENDPOINT = 'http://localhost:42356/msi/token';
    process.env.IDENTITY_HEADER = 'secret-header';

    fetchWithTimeout.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    } as unknown as Response);

    const cred = new AcaManagedIdentityCredential();
    await expect(cred.getToken('https://management.azure.com/.default')).rejects.toThrow(/400/);
  });
});
