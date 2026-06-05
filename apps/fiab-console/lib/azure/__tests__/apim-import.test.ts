/**
 * Unit tests for importApiFromOpenApi — the "Create from definition → OpenAPI"
 * APIM import.
 *
 * Pins the real ARM contract the editor + /api/apim/import route depend on:
 *   PUT .../service/{apim}/apis/{apiId}?api-version=2024-06-01-preview
 *       { properties: { format, value, path, displayName? } }
 *
 * Mocks @azure/identity (token) + global fetch (ARM) the same way the other
 * apim-client specs do, and asserts the URL, method, api-version, and body for
 * both the inline (openapi+json) and link (openapi-link) formats — plus the
 * honest config-gate throw when the APIM service is unconfigured.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return {
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred,
  };
});

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_APIM_RG = 'rg-admin';
  process.env.LOOM_APIM_NAME = 'apim-test';
  vi.restoreAllMocks();
});

const BASE = '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.ApiManagement/service/apim-test';

function armReply(name: string, path: string, displayName: string) {
  return {
    status: 201, ok: true,
    text: async () => JSON.stringify({
      id: `${BASE}/apis/${name}`, name,
      properties: { displayName, path, protocols: ['https'] },
    }),
  } as any;
}

describe('importApiFromOpenApi', () => {
  it('PUTs the inline OpenAPI document to /apis/{apiId} with format+value+path+displayName', async () => {
    const calls: { url: string; init: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return armReply('petstore', 'petstore', 'Pet Store');
    }));

    const spec = '{"openapi":"3.0.1","info":{"title":"Pet Store","version":"1.0"},"paths":{}}';
    const { importApiFromOpenApi } = await import('../apim-client');
    const out = await importApiFromOpenApi({
      apiId: 'petstore',
      displayName: 'Pet Store',
      path: 'petstore',
      format: 'openapi+json',
      value: spec,
    });

    expect(out.name).toBe('petstore');
    expect(out.path).toBe('petstore');
    expect(out.displayName).toBe('Pet Store');

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(init.method).toBe('PUT');
    expect(url).toContain(`${BASE}/apis/petstore`);
    expect(url).toContain('api-version=2024-06-01-preview');
    expect(init.headers.authorization).toBe('Bearer tk');

    const body = JSON.parse(init.body);
    expect(body.properties.format).toBe('openapi+json');
    expect(body.properties.value).toBe(spec);
    expect(body.properties.path).toBe('petstore');
    expect(body.properties.displayName).toBe('Pet Store');
  });

  it('sends a URL as value for the openapi-link format and omits displayName when not given', async () => {
    let sent: any = null;
    let sentUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      sentUrl = url;
      sent = JSON.parse(init.body);
      return armReply('remote', 'remote', 'Remote API');
    }));

    const { importApiFromOpenApi } = await import('../apim-client');
    await importApiFromOpenApi({
      apiId: 'remote',
      path: 'remote',
      format: 'openapi-link',
      value: 'https://petstore3.swagger.io/api/v3/openapi.json',
    });

    expect(sentUrl).toContain(`${BASE}/apis/remote`);
    expect(sent.properties.format).toBe('openapi-link');
    expect(sent.properties.value).toBe('https://petstore3.swagger.io/api/v3/openapi.json');
    expect(sent.properties.path).toBe('remote');
    // displayName not supplied → must not be in the body
    expect('displayName' in sent.properties).toBe(false);
  });

  it('url-encodes the apiId in the request path', async () => {
    let sentUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      sentUrl = url;
      return armReply('a b', 'p', 'X');
    }));
    const { importApiFromOpenApi } = await import('../apim-client');
    await importApiFromOpenApi({ apiId: 'a b', path: 'p', format: 'openapi+json', value: '{}' });
    expect(sentUrl).toContain(`${BASE}/apis/a%20b`);
  });

  it('throws an honest config-gate error (no fetch) when the APIM service is unconfigured', async () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { importApiFromOpenApi } = await import('../apim-client');
    await expect(
      importApiFromOpenApi({ apiId: 'x', path: 'x', format: 'openapi+json', value: '{}' }),
    ).rejects.toThrow(/LOOM_SUBSCRIPTION_ID/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces APIM validation as an ApimError carrying the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 400, ok: false,
      text: async () => JSON.stringify({ error: { message: 'Specification file is not valid.' } }),
    } as any)));
    const { importApiFromOpenApi, ApimError } = await import('../apim-client');
    await expect(
      importApiFromOpenApi({ apiId: 'bad', path: 'bad', format: 'openapi+json', value: '{ not json' }),
    ).rejects.toMatchObject({ status: 400 });
    try {
      await importApiFromOpenApi({ apiId: 'bad', path: 'bad', format: 'openapi+json', value: '{ not json' });
    } catch (e) {
      expect(e).toBeInstanceOf(ApimError);
      expect((e as InstanceType<typeof ApimError>).message).toContain('not valid');
    }
  });
});
