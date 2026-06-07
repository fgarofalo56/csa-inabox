/**
 * Backend contract tests for the RTI hub catalog route:
 *
 *   GET /api/rti-hub  — unified stream catalog (Azure-native default):
 *     cross-subscription Event Hubs / IoT Hub / ADX discovery via Resource
 *     Graph + Loom item index, grouped into data-streams / azure-events /
 *     fabric-events tabs, each row carrying a subscribe pre-fill.
 *
 * Real ARM / Resource Graph / Cosmos I/O is mocked at the client boundary;
 * these pin the route contract: auth gate, the honest 503 infra-gate when no
 * subscription is configured, tab assignment, subscribe pre-fill shape, the
 * Fabric opt-in gate, and partial-result warnings (per no-vaporware.md +
 * no-fabric-dependency.md).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

vi.mock('@/lib/azure/eventhubs-client', () => {
  // Self-contained mock — do NOT importActual (it pulls @azure/identity, whose
  // transitive deps aren't installed in CI's isolated store). EventHubsArmError
  // is re-declared so the route's `instanceof` 503-suppression still works.
  class EventHubsArmError extends Error {
    status: number; body: unknown;
    constructor(status: number, body?: unknown, message?: string) {
      super(message || `Event Hubs ARM call failed (${status})`);
      this.name = 'EventHubsArmError'; this.status = status; this.body = body;
    }
  }
  return {
    EventHubsArmError,
    listStreamingResourcesViaGraph: vi.fn(),
    rtiSubscriptionScope: vi.fn(),
    listEventHubs: vi.fn(),
    eventhubsConfigGate: vi.fn(),
    readEventHubsConfig: vi.fn(),
  };
});

vi.mock('@/app/api/items/_lib/item-crud', () => ({
  listAllOwnedItems: vi.fn(),
  listOwnedWorkspaces: vi.fn(),
}));

import { getSession } from '@/lib/auth/session';
import {
  listStreamingResourcesViaGraph, rtiSubscriptionScope, listEventHubs,
  eventhubsConfigGate, readEventHubsConfig,
} from '@/lib/azure/eventhubs-client';
import { listAllOwnedItems, listOwnedWorkspaces } from '@/app/api/items/_lib/item-crud';

import { GET } from '../route';

const AUTH = { claims: { oid: 'tenant-1', upn: 'u@x' } };

beforeEach(() => {
  vi.resetAllMocks();
  // Sensible defaults the happy-path tests build on.
  (rtiSubscriptionScope as any).mockReturnValue(['sub-1']);
  (eventhubsConfigGate as any).mockReturnValue({ missing: 'LOOM_EVENTHUB_NAMESPACE' });
  (listStreamingResourcesViaGraph as any).mockResolvedValue([]);
  (listAllOwnedItems as any).mockResolvedValue([]);
  (listOwnedWorkspaces as any).mockResolvedValue([]);
});

describe('GET /api/rti-hub', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('503 honest infra-gate when no subscription is configured', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (rtiSubscriptionScope as any).mockReturnValue([]);
    const res = await GET();
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('not_configured');
    expect(j.hint).toMatch(/LOOM_SUBSCRIPTION_ID/);
  });

  it('dataStreams includes a Resource Graph EH namespace and a Loom eventstream', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (listAllOwnedItems as any).mockResolvedValue([
      { id: 'es1', itemType: 'eventstream', displayName: 'Telemetry ES', workspaceId: 'ws-1' },
      { id: 'lh1', itemType: 'lakehouse', displayName: 'ignored', workspaceId: 'ws-1' },
    ]);
    (listOwnedWorkspaces as any).mockResolvedValue([{ id: 'ws-1', name: 'WS One' }]);
    (listStreamingResourcesViaGraph as any).mockResolvedValue([
      { id: '/subscriptions/sub-1/rg/ns1', name: 'ns1', resourceKind: 'eventhub-namespace', location: 'eastus', resourceGroup: 'rg', subscriptionId: 'sub-1' },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('azure-native');
    const ds = j.tabs.dataStreams;
    expect(ds.find((r: any) => r.name === 'Telemetry ES' && r.kind === 'eventstream')).toBeTruthy();
    expect(ds.find((r: any) => r.name === 'ns1' && r.kind === 'eventhub-namespace')).toBeTruthy();
    // non-stream Loom item types are excluded
    expect(ds.find((r: any) => r.name === 'ignored')).toBeFalsy();
    expect(j.workspaceCount).toBe(1);
  });

  it('azureEvents tab carries the static Blob Storage events connector', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const res = await GET();
    const j = await res.json();
    const ev = j.tabs.azureEvents.find((r: any) => r.subscribePreFill.sourceType === 'AzureBlobStorageEvents');
    expect(ev).toBeTruthy();
    expect(ev.kind).toBe('azure-event');
  });

  it('fabricEvents is [] and gated when LOOM_EVENTSTREAM_BACKEND is unset', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const res = await GET();
    const j = await res.json();
    expect(j.tabs.fabricEvents).toEqual([]);
    expect(j.fabricEventsGated).toBe(true);
    expect(j.fabricGateReason).toMatch(/opt-in|not available/i);
  });

  it('expands the configured EH namespace into entity rows with AzureEventHub pre-fill', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (eventhubsConfigGate as any).mockReturnValue(null);
    (readEventHubsConfig as any).mockReturnValue({ subscriptionId: 'sub-1', resourceGroup: 'rg', namespace: 'loom-ns' });
    (listEventHubs as any).mockResolvedValue([{ name: 'telemetry', partitionCount: 4, messageRetentionInDays: 1 }]);
    const res = await GET();
    const j = await res.json();
    const entity = j.tabs.dataStreams.find((r: any) => r.kind === 'eventhub-entity' && r.name === 'telemetry');
    expect(entity).toBeTruthy();
    expect(entity.subscribePreFill.sourceType).toBe('AzureEventHub');
    expect(entity.subscribePreFill.properties.eventHubName).toBe('telemetry');
    expect(j.eventhubsConfigured).toBe(true);
  });

  it('IoT Hub rows carry an AzureIoTHub subscribe pre-fill', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (listStreamingResourcesViaGraph as any).mockResolvedValue([
      { id: '/subscriptions/sub-1/rg/iot1', name: 'iot1', resourceKind: 'iothub', location: 'eastus', resourceGroup: 'rg', subscriptionId: 'sub-1' },
    ]);
    const res = await GET();
    const j = await res.json();
    const iot = j.tabs.dataStreams.find((r: any) => r.kind === 'iothub');
    expect(iot).toBeTruthy();
    expect(iot.subscribePreFill.sourceType).toBe('AzureIoTHub');
  });

  it('Resource Graph failure populates warnings[] but still returns 200 with partial data', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (listStreamingResourcesViaGraph as any).mockRejectedValue(new Error('Reader role missing'));
    (listAllOwnedItems as any).mockResolvedValue([
      { id: 'es1', itemType: 'eventstream', displayName: 'Telemetry ES', workspaceId: 'ws-1' },
    ]);
    (listOwnedWorkspaces as any).mockResolvedValue([{ id: 'ws-1', name: 'WS One' }]);
    const res = await GET();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.warnings.find((w: any) => w.source === 'resource-graph')).toBeTruthy();
    // Loom items still present despite the graph failure.
    expect(j.tabs.dataStreams.find((r: any) => r.name === 'Telemetry ES')).toBeTruthy();
  });
});
