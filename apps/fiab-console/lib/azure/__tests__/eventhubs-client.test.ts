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

import {
  createEventHubAuthRule, listEventHubKeys,
  updateEventHubCapture, createDisasterRecoveryConfig,
  deleteDisasterRecoveryConfig, initiateGeoDrFailover,
  regenerateEventHubAuthRuleKeys, listNamespacePrivateEndpointConnections,
  approvePrivateEndpointConnection,
} from '../eventhubs-client';

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

// ===================================================================
// Capture / Geo-DR / SAS rotation / Private endpoints (Event Hubs feature set).
// Asserts the EXACT ARM REST (URL + api-version + method + body) per
// .claude/rules/no-vaporware.md. Grounding:
//   https://learn.microsoft.com/azure/event-hubs/event-hubs-capture-overview
//   https://learn.microsoft.com/rest/api/eventhub/disaster-recovery-configs/create-or-update
//   https://learn.microsoft.com/rest/api/eventhub/event-hubs/regenerate-keys
//   https://learn.microsoft.com/rest/api/eventhub/private-endpoint-connections
// ===================================================================

describe('updateEventHubCapture', () => {
  it('PUTs captureDescription enabled=true with Avro + clamped windows + BlockBlob destination', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ name: 'orders-hub', properties: { captureDescription: { enabled: true } } }), calls);

    await updateEventHubCapture('orders-hub', {
      enabled: true,
      storageAccountResourceId: '/subscriptions/sub-123/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/acct',
      blobContainer: 'captures',
      intervalInSeconds: 5000, // out of range -> clamps to 900
      sizeLimitInBytes: 1, // out of range -> clamps to 10485760
      destination: 'BlockBlob',
    });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe(`${NS_BASE}/eventhubs/orders-hub?api-version=2024-01-01`);
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body);
    const cd = body.properties.captureDescription;
    expect(cd.enabled).toBe(true);
    expect(cd.encoding).toBe('Avro');
    expect(cd.intervalInSeconds).toBe(900);
    expect(cd.sizeLimitInBytes).toBe(10485760);
    expect(cd.destination.name).toBe('EventHubArchive.AzureBlockBlob');
    expect(cd.destination.properties.storageAccountResourceId).toContain('storageAccounts/acct');
    expect(cd.destination.properties.archiveNameFormat).toContain('Namespace');
  });

  it('PUTs captureDescription enabled=false to disable capture (no destination)', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ name: 'orders-hub', properties: {} }), calls);

    await updateEventHubCapture('orders-hub', { enabled: false });

    const body = JSON.parse(calls[0].init.body);
    expect(body.properties.captureDescription).toEqual({ enabled: false });
  });

  it('throws when enabling without a storage account', async () => {
    mockFetch(() => ({}));
    await expect(updateEventHubCapture('orders-hub', { enabled: true, blobContainer: 'c' })).rejects.toThrow(/storageAccountResourceId/);
  });
});

describe('createDisasterRecoveryConfig', () => {
  it('PUTs disasterRecoveryConfigs/{alias} with partnerNamespace ARM id', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ name: 'loom-alias', properties: { role: 'Primary', partnerNamespace: '/sub-2/secondary', provisioningState: 'Accepted' } }), calls);

    const cfg = await createDisasterRecoveryConfig('loom-alias', '/subscriptions/sub-2/providers/Microsoft.EventHub/namespaces/secondary');

    expect(calls[0].url).toBe(`${NS_BASE}/disasterRecoveryConfigs/loom-alias?api-version=2024-01-01`);
    expect(calls[0].init.method).toBe('PUT');
    expect(JSON.parse(calls[0].init.body)).toEqual({ properties: { partnerNamespace: '/subscriptions/sub-2/providers/Microsoft.EventHub/namespaces/secondary' } });
    expect(cfg.role).toBe('Primary');
    expect(cfg.name).toBe('loom-alias');
  });
});

describe('deleteDisasterRecoveryConfig', () => {
  it('DELETEs the alias (accepts 200/204)', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ _status: 200, _body: {} }), calls);
    await deleteDisasterRecoveryConfig('loom-alias');
    expect(calls[0].url).toBe(`${NS_BASE}/disasterRecoveryConfigs/loom-alias?api-version=2024-01-01`);
    expect(calls[0].init.method).toBe('DELETE');
  });
});

describe('initiateGeoDrFailover', () => {
  it('POSTs to the failover endpoint with empty body and accepts 202', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ _status: 202, _body: {} }), calls);
    await initiateGeoDrFailover('loom-alias');
    expect(calls[0].url).toBe(`${NS_BASE}/disasterRecoveryConfigs/loom-alias/failover?api-version=2024-01-01`);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('{}');
  });
});

describe('regenerateEventHubAuthRuleKeys', () => {
  it('POSTs regenerateKeys with keyType and suppresses connection strings when local auth disabled', async () => {
    const calls: Call[] = [];
    mockFetch((url) => {
      if (url.includes('/regenerateKeys')) {
        return { keyName: 'loom-sender', primaryKey: 'NEWPK', primaryConnectionString: 'Endpoint=sb://x/;SharedAccessKey=NEWPK' };
      }
      return { properties: { disableLocalAuth: true } };
    }, calls);

    const keys = await regenerateEventHubAuthRuleKeys('orders-hub', 'loom-sender', 'PrimaryKey');

    const regen = calls.find((c) => c.url.includes('/regenerateKeys'));
    expect(regen).toBeTruthy();
    expect(regen!.url).toBe(`${NS_BASE}/eventhubs/orders-hub/authorizationRules/loom-sender/regenerateKeys?api-version=2024-01-01`);
    expect(regen!.init.method).toBe('POST');
    expect(JSON.parse(regen!.init.body)).toEqual({ keyType: 'PrimaryKey' });
    expect(keys.localAuthDisabled).toBe(true);
    expect(keys.primaryKey).toBeUndefined();
    expect(keys.primaryConnectionString).toBeUndefined();
  });

  it('returns the fresh key when local auth is enabled', async () => {
    mockFetch((url) => {
      if (url.includes('/regenerateKeys')) return { keyName: 'loom-sender', primaryKey: 'NEWPK', primaryConnectionString: 'Endpoint=sb://x/;SharedAccessKey=NEWPK' };
      return { properties: { disableLocalAuth: false } };
    });
    const keys = await regenerateEventHubAuthRuleKeys('orders-hub', 'loom-sender', 'SecondaryKey');
    expect(keys.localAuthDisabled).toBe(false);
    expect(keys.primaryKey).toBe('NEWPK');
  });
});

describe('private endpoint connections', () => {
  it('lists and shapes namespace privateEndpointConnections', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ value: [{
      name: 'pe-conn-1',
      properties: {
        privateEndpoint: { id: '/subscriptions/sub-123/providers/Microsoft.Network/privateEndpoints/pe-1' },
        privateLinkServiceConnectionState: { status: 'Pending', description: 'awaiting' },
        provisioningState: 'Succeeded',
      },
    }] }), calls);

    const conns = await listNamespacePrivateEndpointConnections();

    expect(calls[0].url).toBe(`${NS_BASE}/privateEndpointConnections?api-version=2024-01-01`);
    expect(conns).toHaveLength(1);
    expect(conns[0].name).toBe('pe-conn-1');
    expect(conns[0].connectionStatus).toBe('Pending');
    expect(conns[0].provisioningState).toBe('Succeeded');
  });

  it('PUTs Approved status when approving a connection', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ name: 'pe-conn-1', properties: { privateLinkServiceConnectionState: { status: 'Approved' }, provisioningState: 'Updating' } }), calls);

    const conn = await approvePrivateEndpointConnection('pe-conn-1', 'ok');

    expect(calls[0].url).toBe(`${NS_BASE}/privateEndpointConnections/pe-conn-1?api-version=2024-01-01`);
    expect(calls[0].init.method).toBe('PUT');
    const body = JSON.parse(calls[0].init.body);
    expect(body.properties.privateLinkServiceConnectionState.status).toBe('Approved');
    expect(body.properties.privateLinkServiceConnectionState.description).toBe('ok');
    expect(conn.connectionStatus).toBe('Approved');
  });
});
