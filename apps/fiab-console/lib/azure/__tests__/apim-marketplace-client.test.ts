/**
 * Unit tests for the APIM marketplace client helpers added for the consumer
 * catalog: subscriptionScope, slugSid, and createSubscription's PUT contract.
 *
 * These pin the ARM scope-string shape (the absolute resource id the portal
 * sends) and the createSubscription request body/URL so the marketplace
 * "Subscribe" flow stays in lock-step with the Azure REST contract:
 *   PUT .../subscriptions/{sid}?notify=true  { properties: { displayName, scope } }
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

describe('subscriptionScope', () => {
  it('builds an absolute product scope', async () => {
    const { subscriptionScope } = await import('../apim-client');
    expect(subscriptionScope({ product: 'unlimited' })).toBe(`${BASE}/products/unlimited`);
  });
  it('builds an absolute api scope', async () => {
    const { subscriptionScope } = await import('../apim-client');
    expect(subscriptionScope({ api: 'orders' })).toBe(`${BASE}/apis/orders`);
  });
  it('falls back to all-apis scope', async () => {
    const { subscriptionScope } = await import('../apim-client');
    expect(subscriptionScope({ allApis: true })).toBe(`${BASE}/apis`);
  });
  it('url-encodes ids with special chars', async () => {
    const { subscriptionScope } = await import('../apim-client');
    expect(subscriptionScope({ product: 'a/b c' })).toBe(`${BASE}/products/a%2Fb%20c`);
  });
});

describe('slugSid', () => {
  it('prefixes and slugifies', async () => {
    const { slugSid } = await import('../apim-client');
    expect(slugSid('My Product 360')).toBe('sub-my-product-360');
  });
  it('falls back to a timestamped id for empty input', async () => {
    const { slugSid } = await import('../apim-client');
    expect(slugSid('!!!')).toMatch(/^sub-\d+$/);
  });
});

describe('createSubscription', () => {
  it('PUTs to /subscriptions/{sid}?notify=true with displayName + absolute scope', async () => {
    const calls: { url: string; init: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return {
        status: 201, ok: true,
        text: async () => JSON.stringify({
          id: `${BASE}/subscriptions/sub-unlimited`, name: 'sub-unlimited',
          properties: { displayName: 'Unlimited', scope: `${BASE}/products/unlimited`, state: 'submitted' },
        }),
      } as any;
    }));

    const { createSubscription } = await import('../apim-client');
    const out = await createSubscription({ displayName: 'Unlimited', product: 'unlimited' });

    expect(out.name).toBe('sub-unlimited');
    expect(out.state).toBe('submitted');
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(init.method).toBe('PUT');
    expect(url).toContain(`${BASE}/subscriptions/sub-unlimited`);
    expect(url).toContain('notify=true');
    const body = JSON.parse(init.body);
    expect(body.properties.displayName).toBe('Unlimited');
    expect(body.properties.scope).toBe(`${BASE}/products/unlimited`);
  });

  it('passes an explicit active state through to the request body', async () => {
    let sentBody: any = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return { status: 201, ok: true, text: async () => JSON.stringify({ name: 'x', properties: { state: 'active' } }) } as any;
    }));
    const { createSubscription } = await import('../apim-client');
    await createSubscription({ displayName: 'x', api: 'orders', state: 'active' });
    expect(sentBody.properties.state).toBe('active');
    expect(sentBody.properties.scope).toBe(`${BASE}/apis/orders`);
  });
});
