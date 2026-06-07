/**
 * Contract tests for the Event Hubs CONTROL-plane client additions backing the
 * Eventstream custom-app source node: createEventHubAuthRule (PUT a Send SAS
 * rule) and listEventHubKeys (POST listKeys), plus the disableLocalAuth-aware
 * suppression of connection strings.
 *
 * Per .claude/rules/no-vaporware.md these assert the EXACT ARM REST (URL +
 * api-version + method + body), the AAD bearer header (ARM scope), and that
 * when the namespace reports disableLocalAuth: true the connection strings are
 * suppressed (Entra-only) with localAuthDisabled flagged — never faked keys.
 *
 * Grounding: https://learn.microsoft.com/rest/api/eventhub/event-hubs/list-keys
 *            https://learn.microsoft.com/rest/api/eventhub/event-hubs/create-or-update-authorization-rule
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'AAD.ARM.TOKEN', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return {
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred,
  };
});

import { createEventHubAuthRule, listEventHubKeys } from '../eventhubs-client';

const realFetch = global.fetch;
interface Call { url: string; init?: any }
const NS_BASE = 'https://management.azure.com/subscriptions/sub-123/resourceGroups/rg-loom/providers/Microsoft.EventHub/namespaces/loom-evhns';

function mockFetch(handler: (url: string, init?: any) => any, calls?: Call[]) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    calls?.push({ url: String(url), init });
    const out = handler(String(url), init);
    if (out instanceof Response) return out;
    const status = out?._status ?? 200;
    return new Response(JSON.stringify(out?._body ?? out), { status });
  }) as any;
}

beforeEach(() => {
  process.env.LOOM_EVENTHUB_NAMESPACE = 'loom-evhns';
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-123';
  process.env.LOOM_DLZ_RG = 'rg-loom';
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.LOOM_EVENTHUB_NAMESPACE;
  delete process.env.LOOM_SUBSCRIPTION_ID;
  delete process.env.LOOM_DLZ_RG;
  vi.restoreAllMocks();
});

describe('createEventHubAuthRule', () => {
  it('PUTs a Send-only SAS rule on the event hub with the ARM bearer', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ name: 'loom-sender', properties: { rights: ['Send'] } }), calls);

    const rule = await createEventHubAuthRule('orders-hub', 'loom-sender', ['Send']);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe(`${NS_BASE}/eventhubs/orders-hub/authorizationRules/loom-sender?api-version=2024-01-01`);
    expect(init.method).toBe('PUT');
    expect(init.headers['authorization']).toBe('Bearer AAD.ARM.TOKEN');
    expect(JSON.parse(init.body)).toEqual({ properties: { rights: ['Send'] } });
    expect(rule).toEqual({ name: 'loom-sender', rights: ['Send'], scope: 'orders-hub' });
  });
});

describe('listEventHubKeys — disableLocalAuth aware', () => {
  it('POSTs listKeys and SUPPRESSES connection strings when disableLocalAuth is true', async () => {
    const calls: Call[] = [];
    mockFetch((url, init) => {
      if (url.includes('/listKeys')) {
        return {
          keyName: 'loom-sender',
          primaryKey: 'PKEY',
          primaryConnectionString: 'Endpoint=sb://loom-evhns.servicebus.windows.net/;SharedAccessKeyName=loom-sender;SharedAccessKey=PKEY',
        };
      }
      // namespace GET → disableLocalAuth: true
      return { properties: { disableLocalAuth: true, kafkaEnabled: true } };
    }, calls);

    const keys = await listEventHubKeys('orders-hub', 'loom-sender');

    const listCall = calls.find((c) => c.url.includes('/listKeys'));
    expect(listCall).toBeTruthy();
    expect(listCall!.url).toBe(`${NS_BASE}/eventhubs/orders-hub/authorizationRules/loom-sender/listKeys?api-version=2024-01-01`);
    expect(listCall!.init.method).toBe('POST');
    // Secure-default posture: keys exist in ARM but cannot authenticate → suppressed.
    expect(keys.localAuthDisabled).toBe(true);
    expect(keys.primaryConnectionString).toBeUndefined();
    expect(keys.primaryKey).toBeUndefined();
    expect(keys.keyName).toBe('loom-sender');
  });

  it('returns the connection string when local auth is enabled', async () => {
    mockFetch((url) => {
      if (url.includes('/listKeys')) {
        return { keyName: 'loom-sender', primaryConnectionString: 'Endpoint=sb://x/;SharedAccessKey=K' };
      }
      return { properties: { disableLocalAuth: false } };
    });

    const keys = await listEventHubKeys('orders-hub', 'loom-sender');
    expect(keys.localAuthDisabled).toBe(false);
    expect(keys.primaryConnectionString).toContain('Endpoint=sb://');
  });
});
