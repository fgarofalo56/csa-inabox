/**
 * Unit tests for the APIM subscription state + key-rotation client functions
 * the ApimProductEditor Subscriptions tab and the marketplace BFF depend on.
 *
 * Pins the real ARM contracts (api-version 2024-06-01-preview):
 *   PATCH  .../service/{apim}/subscriptions/{sid}        (If-Match: *)
 *          { properties: { state: 'active'|'suspended'|'cancelled', displayName? } }
 *          -> 200 SubscriptionContract, or 204 No Content (then re-read via GET)
 *   POST   .../subscriptions/{sid}/regeneratePrimaryKey  (no body, 204)
 *   POST   .../subscriptions/{sid}/regenerateSecondaryKey
 *   POST   .../subscriptions/{sid}/listSecrets           ({ primaryKey, secondaryKey })
 *
 * Grounded in Microsoft Learn — Subscription - Update (SubscriptionUpdate-
 * Parameters.properties.state) and Subscription - Regenerate Primary/Secondary
 * Key. Mocks @azure/identity + global fetch the same way apim-operations.test.ts does.
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

describe('updateSubscription', () => {
  it('PATCHes /subscriptions/{sid} with the new state + If-Match: * and returns the updated entity', async () => {
    const calls: { url: string; init: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return {
        status: 200, ok: true,
        text: async () => JSON.stringify({
          id: `${BASE}/subscriptions/sub-x`, name: 'sub-x',
          properties: { displayName: 'Acme', state: 'suspended', createdDate: '2026-01-01T00:00:00Z' },
        }),
      } as any;
    }));

    const { updateSubscription } = await import('../apim-client');
    const out = await updateSubscription('sub-x', { state: 'suspended' });

    expect(out.name).toBe('sub-x');
    expect(out.state).toBe('suspended');
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(init.method).toBe('PATCH');
    expect(init.headers['If-Match']).toBe('*');
    expect(init.headers.authorization).toBe('Bearer tk');
    expect(url).toContain(`${BASE}/subscriptions/sub-x`);
    expect(url).toContain('api-version=2024-06-01-preview');
    const body = JSON.parse(init.body);
    expect(body.properties.state).toBe('suspended');
    // displayName not provided -> not transmitted
    expect('displayName' in body.properties).toBe(false);
  });

  it('returns a shaped entity (no throw) when PATCH returns the contract inline', async () => {
    // ARM normally echoes the updated SubscriptionContract on PATCH; we resolve
    // the new state directly from that body without an extra read.
    const calls: { url: string; init: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init: init || {} });
      return {
        status: 200, ok: true,
        text: async () => JSON.stringify({ name: 'sub-x', properties: { state: 'active' } }),
      } as any;
    }));

    const { updateSubscription } = await import('../apim-client');
    const out = await updateSubscription('sub-x', { state: 'active' });
    expect(out.state).toBe('active');
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe('PATCH');
    expect(calls[0].url).toContain(`${BASE}/subscriptions/sub-x`);
  });

  it('carries displayName through when provided', async () => {
    let sent: any = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return { status: 200, ok: true, text: async () => JSON.stringify({ name: 'sub-x', properties: { displayName: 'Renamed', state: 'active' } }) } as any;
    }));
    const { updateSubscription } = await import('../apim-client');
    await updateSubscription('sub-x', { displayName: 'Renamed', state: 'active' });
    expect(sent.properties.displayName).toBe('Renamed');
    expect(sent.properties.state).toBe('active');
  });
});

describe('regenerateSubscriptionKey', () => {
  it('POSTs to /subscriptions/{sid}/regeneratePrimaryKey for primary and swallows 204', async () => {
    const calls: { url: string; init: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return { status: 204, ok: false, text: async () => '' } as any;
    }));
    const { regenerateSubscriptionKey } = await import('../apim-client');
    await regenerateSubscriptionKey('sub-x', 'primary');
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].url).toContain(`${BASE}/subscriptions/sub-x/regeneratePrimaryKey`);
  });

  it('POSTs to /subscriptions/{sid}/regenerateSecondaryKey for secondary', async () => {
    let sentUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      sentUrl = url;
      return { status: 204, ok: false, text: async () => '' } as any;
    }));
    const { regenerateSubscriptionKey } = await import('../apim-client');
    await regenerateSubscriptionKey('sub-x', 'secondary');
    expect(sentUrl).toContain(`${BASE}/subscriptions/sub-x/regenerateSecondaryKey`);
  });
});

describe('getSubscriptionKeys', () => {
  it('POSTs to /subscriptions/{sid}/listSecrets and returns the fresh key pair', async () => {
    const calls: { url: string; init: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return { status: 200, ok: true, text: async () => JSON.stringify({ primaryKey: 'NEWP', secondaryKey: 'NEWS' }) } as any;
    }));
    const { getSubscriptionKeys } = await import('../apim-client');
    const out = await getSubscriptionKeys('sub-x');
    expect(out).toEqual({ primaryKey: 'NEWP', secondaryKey: 'NEWS' });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].url).toContain(`${BASE}/subscriptions/sub-x/listSecrets`);
  });
});
