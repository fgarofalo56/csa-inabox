/**
 * Contract tests for the Power Platform environment lifecycle client surface
 * (createEnvironment / updateEnvironment / deleteEnvironment /
 * getEnvironmentLifecycleOperation). Each test stubs `fetch` and asserts the
 * exact BAP URL / method / body / async-op handling so a wire-format
 * regression is caught.
 *
 * Grounded in Microsoft Learn:
 *   - Host/path/api-version: power-platform/admin/list-environments
 *       https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments
 *   - Create params → properties: New-AdminPowerAppEnvironment
 *       (-DisplayName / -Location / -EnvironmentSku / -ProvisionDatabase /
 *        -CurrencyName / -LanguageName) → { properties: { displayName,
 *        environmentSku, linkedEnvironmentMetadata: { baseLanguage, currency } } }
 *   - Delete is async (202 + Location header): Remove-AdminPowerAppEnvironment
 *   - Poll terminal on Succeeded/Failed/Canceled; 404 on a delete op = removed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return {
    DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred, ClientSecretCredential: Cred,
  };
});

beforeEach(() => {
  process.env.LOOM_UAMI_CLIENT_ID = 'uami-1';
  delete process.env.LOOM_BAP_BASE;
  delete process.env.LOOM_BAP_LIFECYCLE_API_VERSION;
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function captureFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string>; contentType?: string }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = impl(String(url), init);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': r.contentType ?? 'application/json', ...(r.headers || {}) },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('createEnvironment', () => {
  it('POSTs the BAP admin environments endpoint with api-version + location and a { properties } body', async () => {
    const calls = captureFetch(() => ({ status: 202, body: { status: 'Running' }, headers: { 'operation-location': 'https://api.bap.microsoft.com/op/123' } }));
    const { createEnvironment } = await import('../powerplatform-client');
    const op = await createEnvironment({ displayName: 'HQ Apps', environmentSku: 'Sandbox', location: 'unitedstates' });

    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].url).toContain('/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments');
    expect(calls[0].url).toContain('api-version=2021-04-01');
    expect(calls[0].url).toContain('location=unitedstates');

    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent.properties.displayName).toBe('HQ Apps');
    expect(sent.properties.environmentSku).toBe('Sandbox');
    // No Dataverse → no linkedEnvironmentMetadata in the body.
    expect(sent.properties.linkedEnvironmentMetadata).toBeUndefined();

    // Async op handle captured from the Operation-Location header.
    expect(op.operationUrl).toBe('https://api.bap.microsoft.com/op/123');
    expect(op.done).toBe(false);
    expect(op.status).toBe('Running');
  });

  it('includes linkedEnvironmentMetadata (baseLanguage + currency) when a Dataverse db is requested', async () => {
    const calls = captureFetch(() => ({ status: 202, body: {} }));
    const { createEnvironment } = await import('../powerplatform-client');
    await createEnvironment({
      displayName: 'Dev', environmentSku: 'Trial', location: 'europe',
      dataverse: { baseLanguage: 1033, currency: 'USD', templates: ['D365_Sales'], securityGroupId: 'sg-1' },
    });
    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent.properties.linkedEnvironmentMetadata).toEqual({
      baseLanguage: 1033,
      currency: { code: 'USD' },
      templates: ['D365_Sales'],
      securityGroupId: 'sg-1',
    });
  });

  it('reports a terminal Failed op when the body status is Failed', async () => {
    captureFetch(() => ({ body: { status: 'Failed', error: { code: 'x', message: 'no capacity' } } }));
    const { createEnvironment } = await import('../powerplatform-client');
    const op = await createEnvironment({ displayName: 'X', environmentSku: 'Sandbox', location: 'asia' });
    expect(op.done).toBe(true);
    expect(op.status).toBe('Failed');
    expect(op.error?.message).toBe('no capacity');
  });
});

describe('updateEnvironment', () => {
  it('PATCHes the named environment with a { properties } body (rename)', async () => {
    const calls = captureFetch(() => ({ body: { status: 'Succeeded' } }));
    const { updateEnvironment } = await import('../powerplatform-client');
    await updateEnvironment('Env-X', { displayName: 'Renamed', description: 'updated' });
    expect(calls[0].init?.method).toBe('PATCH');
    expect(calls[0].url).toMatch(/\/scopes\/admin\/environments\/Env-X\?api-version=2021-04-01/);
    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent.properties.displayName).toBe('Renamed');
    expect(sent.properties.description).toBe('updated');
  });
});

describe('deleteEnvironment', () => {
  it('DELETEs the named environment and returns the async op handle from the Location header', async () => {
    const calls = captureFetch(() => ({ status: 202, body: {}, headers: { location: 'https://api.bap.microsoft.com/op/del-9' } }));
    const { deleteEnvironment } = await import('../powerplatform-client');
    const op = await deleteEnvironment('Env-Y');
    expect(calls[0].init?.method).toBe('DELETE');
    expect(calls[0].url).toMatch(/\/scopes\/admin\/environments\/Env-Y\?api-version=2021-04-01/);
    expect(op.operationUrl).toBe('https://api.bap.microsoft.com/op/del-9');
    expect(op.status).toBe('Running'); // 202 with no body status → Running
    expect(op.done).toBe(false);
  });
});

describe('getEnvironmentLifecycleOperation', () => {
  it('GETs the operation url and is terminal on Succeeded', async () => {
    const calls = captureFetch(() => ({ body: { status: 'Succeeded' } }));
    const { getEnvironmentLifecycleOperation } = await import('../powerplatform-client');
    const op = await getEnvironmentLifecycleOperation('https://api.bap.microsoft.com/op/123');
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].url).toBe('https://api.bap.microsoft.com/op/123');
    expect(op.done).toBe(true);
    expect(op.status).toBe('Succeeded');
  });

  it('treats a 404 on a delete-op url as a terminal Succeeded (environment fully removed)', async () => {
    captureFetch(() => ({ status: 404, body: { error: { message: 'not found' } } }));
    const { getEnvironmentLifecycleOperation } = await import('../powerplatform-client');
    const op = await getEnvironmentLifecycleOperation('https://api.bap.microsoft.com/op/del-9');
    expect(op.done).toBe(true);
    expect(op.status).toBe('Succeeded');
  });
});

describe('error handling', () => {
  it('surfaces a 403 from the BAP create with an actionable hint', async () => {
    captureFetch(() => ({ status: 403, body: { error: { message: 'forbidden' } } }));
    const { createEnvironment } = await import('../powerplatform-client');
    await expect(createEnvironment({ displayName: 'X', environmentSku: 'Sandbox', location: 'asia' }))
      .rejects.toMatchObject({ status: 403, hint: expect.stringContaining('Power Platform') });
  });
});
