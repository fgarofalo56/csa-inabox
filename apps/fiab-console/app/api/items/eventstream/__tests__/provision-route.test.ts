/**
 * Backend contract tests for POST /api/items/eventstream/[id]/provision.
 *
 * The route maps a saved canvas topology onto the Azure-native Eventstream
 * backend: an Event Hub (transport) + a Stream Analytics job (transform). Real
 * ARM I/O is mocked at the eventhubs-client / stream-analytics-client / kusto-
 * client boundaries; these tests pin the route contract:
 *   - auth + not-found + empty-topology gates
 *   - EH-only path (no transforms) → ehId, asaJobId: null
 *   - EH + ASA path (filter → kusto sink) → wires input/output/transformation
 *   - honest gates: EH not configured → 503; ASA not configured → partial
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Fully self-contained mocks (no importActual): the real clients import
// @azure/identity at module top-level, which the shared pnpm store can't fully
// resolve under vitest. The route only needs the symbols mocked below, and the
// error classes are defined here so `instanceof` checks in the route still work.
vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/kusto-client', () => {
  class KustoError extends Error { status: number; constructor(m: string, s = 500) { super(m); this.status = s; } }
  return {
    KustoError,
    loadKustoItem: vi.fn(),
    saveItemState: vi.fn(async (_i: any, p: any) => ({ state: p })),
    clusterUri: vi.fn(() => 'https://adx-loom.eastus2.kusto.windows.net'),
    defaultDatabase: vi.fn(() => 'loomdb-default'),
  };
});
vi.mock('@/lib/azure/eventhubs-client', () => {
  class EventHubsArmError extends Error { status: number; body: unknown; constructor(s: number, b: unknown, m?: string) { super(m); this.status = s; this.body = b; } }
  return {
    EventHubsArmError,
    eventhubsConfigGate: vi.fn(() => null),
    readEventHubsConfig: vi.fn(() => ({ subscriptionId: 'sub1', resourceGroup: 'rg1', namespace: 'ns1' })),
    listEventHubs: vi.fn(async () => []),
    createEventHub: vi.fn(async () => ({ name: 'x' })),
    listConsumerGroups: vi.fn(async () => []),
    createConsumerGroup: vi.fn(async () => ({ name: 'cg' })),
    listNamespaceKeys: vi.fn(async () => ({
      primaryConnectionString: 'cs', secondaryConnectionString: 'cs2',
      primaryKey: 'pk', secondaryKey: 'sk', keyName: 'RootManageSharedAccessKey',
    })),
  };
});
vi.mock('@/lib/azure/stream-analytics-client', () => {
  class AsaNotConfiguredError extends Error { missing: string[]; constructor(m: string[]) { super(`missing ${m.join(',')}`); this.missing = m; } }
  return {
    AsaNotConfiguredError,
    readAsaConfig: vi.fn(() => ({ subscriptionId: 'sub1', resourceGroup: 'rgAsa' })),
    createOrUpdateJob: vi.fn(async (s: any) => ({ id: `/subscriptions/sub1/resourceGroups/rgAsa/providers/Microsoft.StreamAnalytics/streamingjobs/${s.name}`, name: s.name })),
    createOrUpdateInput: vi.fn(async () => ({ id: 'in', name: 'input-eh' })),
    createOrUpdateOutput: vi.fn(async () => ({ id: 'out', name: 'output' })),
    saveTransformation: vi.fn(async () => undefined),
  };
});

import { getSession } from '@/lib/auth/session';
import { loadKustoItem } from '@/lib/azure/kusto-client';
import {
  eventhubsConfigGate, createEventHub, createConsumerGroup, listNamespaceKeys, listEventHubs, listConsumerGroups, readEventHubsConfig,
} from '@/lib/azure/eventhubs-client';
import { saveItemState, clusterUri, defaultDatabase } from '@/lib/azure/kusto-client';
import {
  readAsaConfig, AsaNotConfiguredError, createOrUpdateJob,
  createOrUpdateInput, createOrUpdateOutput, saveTransformation,
} from '@/lib/azure/stream-analytics-client';
import { POST } from '../[id]/provision/route';

const ctx = { params: Promise.resolve({ id: 'es-abcdef12-0000' }) };
const req = {} as any;

function item(state: any) {
  return { id: 'es-abcdef12-0000', workspaceId: 'w', itemType: 'eventstream', displayName: 'Orders Stream', state };
}

beforeEach(() => {
  vi.resetAllMocks();
  (eventhubsConfigGate as any).mockReturnValue(null);
  (readEventHubsConfig as any).mockReturnValue({ subscriptionId: 'sub1', resourceGroup: 'rg1', namespace: 'ns1' });
  (listEventHubs as any).mockResolvedValue([]);
  (listConsumerGroups as any).mockResolvedValue([]);
  (createEventHub as any).mockResolvedValue({ name: 'x' });
  (createConsumerGroup as any).mockResolvedValue({ name: 'cg' });
  (saveItemState as any).mockResolvedValue({ state: {} });
  (clusterUri as any).mockReturnValue('https://adx-loom.eastus2.kusto.windows.net');
  (defaultDatabase as any).mockReturnValue('loomdb-default');
  (listNamespaceKeys as any).mockResolvedValue({ primaryKey: 'pk', secondaryKey: 'sk', keyName: 'RootManageSharedAccessKey', primaryConnectionString: 'cs', secondaryConnectionString: 'cs2' });
  (readAsaConfig as any).mockReturnValue({ subscriptionId: 'sub1', resourceGroup: 'rgAsa' });
  (createOrUpdateJob as any).mockImplementation(async (s: any) => ({ id: `/subscriptions/sub1/resourceGroups/rgAsa/providers/Microsoft.StreamAnalytics/streamingjobs/${s.name}`, name: s.name }));
  (createOrUpdateInput as any).mockResolvedValue({ id: 'in', name: 'input-eh' });
  (createOrUpdateOutput as any).mockResolvedValue({ id: 'out', name: 'output' });
  (saveTransformation as any).mockResolvedValue(undefined);
  delete (process.env as any).AZURE_CLOUD;
});

describe('POST /api/items/eventstream/[id]/provision', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
  });

  it('404 when the item is missing', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o' } });
    (loadKustoItem as any).mockResolvedValue(null);
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
  });

  it('422 when the topology has no source or destination', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o' } });
    (loadKustoItem as any).mockResolvedValue(item({ sources: [], sinks: [] }));
    const res = await POST(req, ctx);
    expect(res.status).toBe(422);
  });

  it('503 with hint when Event Hubs is not configured', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o' } });
    (loadKustoItem as any).mockResolvedValue(item({
      source: { kind: 'eventhub', name: 'src' }, sink: { kind: 'eventhub', name: 'dst' },
    }));
    (eventhubsConfigGate as any).mockReturnValue({ missing: 'LOOM_EVENTHUB_NAMESPACE' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('not_configured');
    expect(j.hint).toContain('LOOM_EVENTHUB_NAMESPACE');
  });

  it('EH-only (no transforms): creates hub + consumer group, asaJobId null', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o' } });
    (loadKustoItem as any).mockResolvedValue(item({
      source: { kind: 'eventhub', name: 'src' },
      sink: { kind: 'eventhub', name: 'dst' },
      transforms: [],
    }));
    const res = await POST(req, ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.asaJobId).toBeNull();
    expect(j.ehId).toContain('/providers/Microsoft.EventHub/namespaces/ns1/eventhubs/orders-stream');
    expect(createEventHub).toHaveBeenCalledTimes(1);
    expect(createConsumerGroup).toHaveBeenCalled();
    expect(createOrUpdateJob).not.toHaveBeenCalled();
  });

  it('filter → kusto sink: provisions EH + ASA job, input, kusto output, transformation', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o' } });
    (loadKustoItem as any).mockResolvedValue(item({
      source: { kind: 'eventhub', name: 'src' },
      transforms: [{ kind: 'filter', name: 't1', expression: 'amount > 100' }],
      sink: { kind: 'kusto', name: 'adx', database: 'OrdersDb', table: 'Flagged' },
    }));
    const res = await POST(req, ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.ehId).toContain('Microsoft.EventHub');
    expect(j.asaJobId).toContain('Microsoft.StreamAnalytics/streamingjobs/asa-loom-es-abcde');
    expect(createOrUpdateJob).toHaveBeenCalledTimes(1);
    expect(createOrUpdateInput).toHaveBeenCalledTimes(1);
    const out = (createOrUpdateOutput as any).mock.calls[0][1];
    expect(out.datasourceType).toBe('Microsoft.Kusto/clusters/databases');
    expect(out.kustoDatabase).toBe('OrdersDb');
    const saql = (saveTransformation as any).mock.calls[0][1] as string;
    expect(saql).toContain('WHERE (amount > 100)');
    expect(saql).toContain('INTO [output-kusto]');
  });

  it('transforms present but ASA not configured: partial result, EH still provisioned', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'o' } });
    (loadKustoItem as any).mockResolvedValue(item({
      source: { kind: 'eventhub', name: 'src' },
      transforms: [{ kind: 'filter', name: 't1', expression: 'x > 1' }],
      sink: { kind: 'eventhub', name: 'dst' },
    }));
    (readAsaConfig as any).mockImplementation(() => { throw new AsaNotConfiguredError(['LOOM_ASA_RG']); });
    const res = await POST(req, ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.partial).toBe(true);
    expect(j.asaJobId).toBeNull();
    expect(j.hint).toContain('LOOM_ASA_RG');
    expect(createOrUpdateJob).not.toHaveBeenCalled();
  });

  it('DoD cloud: skips ASA, returns partial with disclosure', async () => {
    (process.env as any).AZURE_CLOUD = 'AzureDod';
    (getSession as any).mockReturnValue({ claims: { oid: 'o' } });
    (loadKustoItem as any).mockResolvedValue(item({
      source: { kind: 'eventhub', name: 'src' },
      transforms: [{ kind: 'filter', name: 't1', expression: 'x > 1' }],
      sink: { kind: 'eventhub', name: 'dst' },
    }));
    const res = await POST(req, ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.partial).toBe(true);
    expect(j.asaJobId).toBeNull();
    expect(j.hint).toContain('DoD');
    expect(createOrUpdateJob).not.toHaveBeenCalled();
  });
});
