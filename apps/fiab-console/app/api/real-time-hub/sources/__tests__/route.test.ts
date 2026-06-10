/**
 * Contract test for the hyphenated alias route:
 *
 *   GET /api/real-time-hub/sources  — stable alias for GET /api/rti-hub.
 *
 * The alias must re-export the exact same handler so the two paths return an
 * identical payload (no divergent logic, per no-vaporware.md). We mock the same
 * client boundary the canonical route uses and assert the alias enforces the
 * auth gate and emits the same Azure-native data-streams contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

vi.mock('@/lib/azure/eventhubs-client', () => {
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
  listStreamingResourcesViaGraph, rtiSubscriptionScope,
  eventhubsConfigGate,
} from '@/lib/azure/eventhubs-client';
import { listAllOwnedItems, listOwnedWorkspaces } from '@/app/api/items/_lib/item-crud';

import { GET } from '../route';
import { GET as CANONICAL_GET } from '@/app/api/rti-hub/route';

const AUTH = { claims: { oid: 'tenant-1', upn: 'u@x' } };

beforeEach(() => {
  vi.resetAllMocks();
  (rtiSubscriptionScope as any).mockReturnValue(['sub-1']);
  (eventhubsConfigGate as any).mockReturnValue({ missing: 'LOOM_EVENTHUB_NAMESPACE' });
  (listStreamingResourcesViaGraph as any).mockResolvedValue([]);
  (listAllOwnedItems as any).mockResolvedValue([]);
  (listOwnedWorkspaces as any).mockResolvedValue([]);
});

describe('GET /api/real-time-hub/sources (alias)', () => {
  it('re-exports the canonical rti-hub GET handler', () => {
    expect(GET).toBe(CANONICAL_GET);
  });

  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns the same Azure-native data-streams contract as the canonical route', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (listStreamingResourcesViaGraph as any).mockResolvedValue([
      { id: '/subscriptions/sub-1/rg/ns1', name: 'ns1', resourceKind: 'eventhub-namespace', location: 'eastus', resourceGroup: 'rg', subscriptionId: 'sub-1' },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('azure-native');
    expect(j.tabs.dataStreams.find((r: any) => r.name === 'ns1' && r.kind === 'eventhub-namespace')).toBeTruthy();
  });
});
