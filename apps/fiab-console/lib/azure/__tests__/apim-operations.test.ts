/**
 * Unit tests for the APIM operations-authoring + policy client functions.
 *
 * Pins the real ARM contracts the editor + BFF routes depend on:
 *   PUT    .../service/{apim}/apis/{apiId}/operations/{opId}?api-version=2024-06-01-preview
 *          { properties: { displayName, method, urlTemplate, templateParameters[], request?, responses[] } }
 *   DELETE .../apis/{apiId}/operations/{opId}            (If-Match: *)
 *   GET    .../apis/{apiId}/operations/{opId}/policies/policy?format=xml
 *   PUT    .../apis/{apiId}/operations/{opId}/policies/policy
 *          { properties: { format: 'xml', value: '<policies>…' } }
 *
 * Grounded in Microsoft Learn — OperationUpdateContractProperties
 * (displayName/method/urlTemplate/templateParameters/request/responses) and
 * PolicyContract (value + format 'xml').
 *
 * Mocks @azure/identity + global fetch the same way apim-import.test.ts does.
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

describe('upsertOperation', () => {
  it('PUTs the operation contract to /apis/{id}/operations/{opId} with method/urlTemplate/templateParameters/responses', async () => {
    const calls: { url: string; init: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return {
        status: 200, ok: true,
        text: async () => JSON.stringify({
          id: `${BASE}/apis/orders/operations/get-order`, name: 'get-order',
          properties: { displayName: 'Get order', method: 'GET', urlTemplate: '/orders/{id}', templateParameters: [{ name: 'id', type: 'string', required: true }], responses: [{ statusCode: 200, description: 'OK' }] },
        }),
      } as any;
    }));

    const { upsertOperation } = await import('../apim-client');
    const out = await upsertOperation('orders', 'get-order', {
      displayName: 'Get order',
      method: 'get',
      urlTemplate: '/orders/{id}',
      templateParameters: [{ name: 'id', type: 'string', required: true }],
      request: { queryParameters: [{ name: 'expand', type: 'boolean' }], representations: [{ contentType: 'application/json' }] },
      responses: [{ statusCode: 200, description: 'OK' }, { statusCode: 404 }],
    });

    expect(out.name).toBe('get-order');
    expect(out.method).toBe('GET');
    expect(out.urlTemplate).toBe('/orders/{id}');

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(init.method).toBe('PUT');
    expect(url).toContain(`${BASE}/apis/orders/operations/get-order`);
    expect(url).toContain('api-version=2024-06-01-preview');
    expect(init.headers.authorization).toBe('Bearer tk');

    const body = JSON.parse(init.body);
    expect(body.properties.displayName).toBe('Get order');
    // method is upper-cased before transmit
    expect(body.properties.method).toBe('GET');
    expect(body.properties.urlTemplate).toBe('/orders/{id}');
    expect(body.properties.templateParameters).toEqual([{ name: 'id', type: 'string', required: true }]);
    // request: query param + representation carried through
    expect(body.properties.request.queryParameters).toEqual([{ name: 'expand', type: 'boolean', required: false }]);
    expect(body.properties.request.representations).toEqual([{ contentType: 'application/json' }]);
    // responses: both declared statuses present, description optional
    expect(body.properties.responses).toEqual([{ statusCode: 200, description: 'OK' }, { statusCode: 404 }]);
  });

  it('url-encodes apiId + operationId in the request path', async () => {
    let sentUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      sentUrl = url;
      return { status: 200, ok: true, text: async () => JSON.stringify({ name: 'a b', properties: { displayName: 'X', method: 'GET', urlTemplate: '/' } }) } as any;
    }));
    const { upsertOperation } = await import('../apim-client');
    await upsertOperation('my api', 'a b', { displayName: 'X', method: 'GET', urlTemplate: '/' });
    expect(sentUrl).toContain(`${BASE}/apis/my%20api/operations/a%20b`);
  });

  it('always sends a templateParameters array (empty when none) and omits request when empty', async () => {
    let sent: any = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return { status: 200, ok: true, text: async () => JSON.stringify({ name: 'op', properties: { displayName: 'Op', method: 'POST', urlTemplate: '/' } }) } as any;
    }));
    const { upsertOperation } = await import('../apim-client');
    await upsertOperation('api', 'op', { displayName: 'Op', method: 'POST', urlTemplate: '/' });
    expect(sent.properties.templateParameters).toEqual([]);
    expect('request' in sent.properties).toBe(false);
    expect('responses' in sent.properties).toBe(false);
  });
});

describe('deleteOperation', () => {
  it('DELETEs the operation with If-Match: * and swallows 404/204', async () => {
    const calls: { url: string; init: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return { status: 204, ok: false, text: async () => '' } as any;
    }));
    const { deleteOperation } = await import('../apim-client');
    await deleteOperation('orders', 'get-order');
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].init.headers['If-Match']).toBe('*');
    expect(calls[0].url).toContain(`${BASE}/apis/orders/operations/get-order`);
  });
});

describe('policy (operation / api scope)', () => {
  it('GETs the operation-scope policy at /apis/{id}/operations/{opId}/policies/policy?format=xml', async () => {
    let sentUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      sentUrl = url;
      return { status: 200, ok: true, text: async () => JSON.stringify({ properties: { format: 'xml', value: '<policies><inbound><base /></inbound></policies>' } }) } as any;
    }));
    const { getPolicy } = await import('../apim-client');
    const out = await getPolicy('apis/orders/operations/get-order');
    expect(out?.value).toContain('<policies>');
    expect(out?.format).toBe('xml');
    expect(sentUrl).toContain(`${BASE}/apis/orders/operations/get-order/policies/policy`);
    expect(sentUrl).toContain('format=xml');
  });

  it('PUTs the policy with { properties: { format: "xml", value } } at operation scope', async () => {
    let sent: any = null;
    let sentUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      sentUrl = url;
      sent = JSON.parse(init.body);
      return { status: 200, ok: true, text: async () => JSON.stringify({ properties: { format: 'xml', value: sent.properties.value } }) } as any;
    }));
    const xml = '<policies><inbound><base /><rate-limit calls="10" renewal-period="60" /></inbound></policies>';
    const { upsertPolicy } = await import('../apim-client');
    const out = await upsertPolicy('apis/orders/operations/get-order', xml);
    expect(sentUrl).toContain(`${BASE}/apis/orders/operations/get-order/policies/policy`);
    expect(sent.properties.format).toBe('xml');
    expect(sent.properties.value).toBe(xml);
    expect(out.value).toBe(xml);
  });

  it('PUTs the api-scope policy at /apis/{id}/policies/policy', async () => {
    let sentUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      sentUrl = url;
      return { status: 200, ok: true, text: async () => JSON.stringify({ properties: { format: 'xml', value: '<policies />' } }) } as any;
    }));
    const { upsertPolicy } = await import('../apim-client');
    await upsertPolicy('apis/orders', '<policies />');
    expect(sentUrl).toContain(`${BASE}/apis/orders/policies/policy`);
  });
});
