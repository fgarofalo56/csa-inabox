/**
 * Contract tests for the IoT Hub ARM client (built-in Event Hubs endpoint).
 *
 * Per .claude/rules/no-vaporware.md these assert the EXACT ARM REST the client
 * shapes: the Microsoft.Devices/IotHubs GET URL (sovereign-cloud aware), the
 * AAD bearer header, and that the built-in Event Hubs endpoint is correctly
 * derived from `properties.eventHubEndpoints.events` (sb:// scheme + trailing
 * slash stripped to a bare FQDN). Nothing is faked beyond stubbing fetch + the
 * AAD credential.
 *
 * Grounding: https://learn.microsoft.com/rest/api/iothub/iot-hub-resource/get
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

import { getIoTHubEhEndpoint, iotHubConfigGate, IoTHubArmError } from '../iothub-client';

const realFetch = global.fetch;
interface Call { url: string; init?: any }

function mockFetch(handler: (url: string) => any, calls?: Call[]) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    calls?.push({ url: String(url), init });
    const out = handler(String(url));
    if (out instanceof Response) return out;
    const status = out?._status ?? 200;
    return new Response(JSON.stringify(out?._body ?? out), { status });
  }) as any;
}

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-123';
  process.env.LOOM_DLZ_RG = 'rg-loom';
  delete process.env.AZURE_CLOUD;
  delete process.env.LOOM_ARM_ENDPOINT;
  delete process.env.LOOM_IOTHUB_SUB;
  delete process.env.LOOM_IOTHUB_RG;
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.LOOM_SUBSCRIPTION_ID;
  delete process.env.LOOM_DLZ_RG;
  delete process.env.AZURE_CLOUD;
  vi.restoreAllMocks();
});

describe('iotHubConfigGate', () => {
  it('returns null when sub + rg resolve from the shared landing-zone env', () => {
    expect(iotHubConfigGate()).toBeNull();
  });
  it('names the missing subscription var', () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    expect(iotHubConfigGate()).toEqual({ missing: 'LOOM_IOTHUB_SUB (or LOOM_SUBSCRIPTION_ID)' });
  });
});

describe('getIoTHubEhEndpoint', () => {
  it('GETs the Microsoft.Devices ARM resource with an AAD bearer and derives a bare FQDN', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({
      properties: {
        eventHubEndpoints: {
          events: {
            endpoint: 'sb://ihsuprod-xyz.servicebus.windows.net/',
            path: 'my-iot-hub',
            partitionCount: 4,
            retentionTimeInDays: 1,
          },
        },
      },
    }), calls);

    const ep = await getIoTHubEhEndpoint('my-iot-hub');

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe(
      'https://management.azure.com/subscriptions/sub-123/resourceGroups/rg-loom/providers/Microsoft.Devices/IotHubs/my-iot-hub?api-version=2023-06-30',
    );
    expect(init.headers['authorization']).toBe('Bearer AAD.ARM.TOKEN');
    // sb:// + trailing slash stripped.
    expect(ep.fqdn).toBe('ihsuprod-xyz.servicebus.windows.net');
    expect(ep.entityPath).toBe('my-iot-hub');
    expect(ep.partitionCount).toBe(4);
  });

  it('targets the Government ARM host when AZURE_CLOUD is AzureUSGovernment', async () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    const calls: Call[] = [];
    mockFetch(() => ({
      properties: { eventHubEndpoints: { events: { endpoint: 'sb://gov-ns.servicebus.usgovcloudapi.net/', path: 'hub' } } },
    }), calls);

    await getIoTHubEhEndpoint('hub');

    expect(calls[0].url).toContain('https://management.usgovcloudapi.net/');
  });

  it('throws a typed 404 when the hub exposes no built-in Event Hubs endpoint', async () => {
    mockFetch(() => ({ properties: {} }));
    let caught: unknown;
    try { await getIoTHubEhEndpoint('hub'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(IoTHubArmError);
    expect((caught as IoTHubArmError).status).toBe(404);
  });

  it('honors an explicit resource-group override', async () => {
    const calls: Call[] = [];
    mockFetch(() => ({ properties: { eventHubEndpoints: { events: { endpoint: 'sb://n.servicebus.windows.net/', path: 'p' } } } }), calls);
    await getIoTHubEhEndpoint('hub', { resourceGroup: 'rg-iot' });
    expect(calls[0].url).toContain('/resourceGroups/rg-iot/');
  });
});
