/**
 * Backend contract tests for the Real-Time Hub BFF routes:
 *
 *   GET  /api/realtime-hub/streams         aggregate eventstreams + KQL DBs across workspaces
 *   POST /api/realtime-hub/connect-source  create a real Fabric eventstream w/ a Microsoft source
 *   POST /api/realtime-hub/preview         preview recent events via the Kusto query path
 *   GET  /api/realtime-hub/endpoints       surface a stream's endpoints from its definition
 *
 * Real Fabric/Kusto I/O is mocked at the client boundary; these pin the
 * route contract: auth gates, payload shape, content-type guard, and the
 * honest infra-gate error pass-through (per no-vaporware.md).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

vi.mock('@/lib/azure/fabric-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/fabric-client');
  return {
    ...actual,
    listFabricWorkspaces: vi.fn(),
    listEventstreams: vi.fn(),
    listKqlDatabases: vi.fn(),
    listEventhouses: vi.fn(),
    connectEventstreamSource: vi.fn(),
    getEventstreamDefinition: vi.fn(),
  };
});

vi.mock('@/lib/azure/kusto-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/kusto-client');
  return { ...actual, executeQuery: vi.fn(), defaultDatabase: vi.fn(() => 'loomdb-default') };
});

// NOTE: no importActual here — kv-secrets-client transitively imports
// @azure/identity, which isn't resolvable in the isolated worktree node_modules.
// The route only uses these named exports, so a flat factory is sufficient.
vi.mock('@/lib/azure/kv-secrets-client', () => ({
  KeyVaultError: class KeyVaultError extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s; } },
  putKeyVaultSecret: vi.fn(),
  vaultUrl: vi.fn(),
  listKeyVaultCertificates: vi.fn(),
  certVaultConfigGate: vi.fn(),
  certVaultUrl: vi.fn(),
}));

// Azure-native default path uses item-crud (Cosmos) — mock at the boundary.
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  createOwnedItem: vi.fn(),
  listAllOwnedItems: vi.fn(),
  listOwnedWorkspaces: vi.fn(),
  loadOwnedItem: vi.fn(),
}));

// Event Hubs / IoT Hub clients — flat factories (no importActual; like
// kv-secrets-client these transitively import @azure/identity which isn't
// resolvable in the isolated test env). The *ArmError classes are redefined
// here so the options/provision routes' `instanceof` pass-through still works
// (route + test share the same mocked class).
vi.mock('@/lib/azure/eventhubs-client', () => ({
  EventHubsArmError: class EventHubsArmError extends Error {
    status: number; body: unknown;
    constructor(status: number, body?: unknown, message?: string) { super(message || `eh ${status}`); this.status = status; this.body = body; }
  },
  rtiSubscriptionScope: vi.fn(),
  listStreamingResourcesViaGraph: vi.fn(),
  listEventHubsIn: vi.fn(),
  listConsumerGroupsIn: vi.fn(),
  listEventHubAuthRulesIn: vi.fn(),
  ensureEventHub: vi.fn(),
  ensureConsumerGroup: vi.fn(),
  ensureNamespace: vi.fn(),
}));
vi.mock('@/lib/azure/iothub-client', () => ({
  IoTHubArmError: class IoTHubArmError extends Error {
    status: number; body: unknown;
    constructor(status: number, body?: unknown, message?: string) { super(message || `iot ${status}`); this.status = status; this.body = body; }
  },
  listIoTHubConsumerGroups: vi.fn(),
  ensureIoTHubConsumerGroup: vi.fn(),
}));
// Loom connections store — backs the dataConnectionId picker (options kind=connections).
vi.mock('@/lib/azure/connections-store', () => ({
  listConnections: vi.fn(),
}));

import { getSession } from '@/lib/auth/session';
import { createOwnedItem, listAllOwnedItems, listOwnedWorkspaces, loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import {
  listFabricWorkspaces, listEventstreams, listKqlDatabases, listEventhouses,
  connectEventstreamSource, getEventstreamDefinition, FabricError, buildEventstreamDefinition,
} from '@/lib/azure/fabric-client';
import { executeQuery } from '@/lib/azure/kusto-client';
import {
  putKeyVaultSecret, vaultUrl, listKeyVaultCertificates, certVaultConfigGate, certVaultUrl,
} from '@/lib/azure/kv-secrets-client';
import {
  rtiSubscriptionScope, listStreamingResourcesViaGraph, listEventHubsIn,
  listConsumerGroupsIn, listEventHubAuthRulesIn, ensureEventHub, ensureConsumerGroup, ensureNamespace,
  EventHubsArmError,
} from '@/lib/azure/eventhubs-client';
import { listIoTHubConsumerGroups, ensureIoTHubConsumerGroup } from '@/lib/azure/iothub-client';
import { listConnections } from '@/lib/azure/connections-store';

import { GET as STREAMS } from '../streams/route';
import { POST as CONNECT } from '../connect-source/route';
import { POST as PREVIEW } from '../preview/route';
import { GET as ENDPOINTS } from '../endpoints/route';
import { GET as CERTS } from '../keyvault-certificates/route';
import { GET as OPTIONS } from '../options/route';
import { POST as PROVISION } from '../provision/route';

const AUTH = { claims: { oid: 'tenant-1', upn: 'u@x' } };

function jsonReq(body: any, ct = 'application/json') {
  return { headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? ct : null) }, json: async () => body } as any;
}
function urlReq(qs = '') {
  return { nextUrl: new URL(`https://x/api/realtime-hub/endpoints${qs}`) } as any;
}
function optReq(qs = '') {
  return { nextUrl: new URL(`https://x/api/realtime-hub/options${qs}`) } as any;
}

beforeEach(() => { vi.resetAllMocks(); });

// ---------------- streams (Azure-native default) ----------------
describe('GET /api/realtime-hub/streams', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await STREAMS();
    expect(res.status).toBe(401);
  });

  it('lists Loom eventstream (stream) + kql-database (table) items, Azure-native', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (listAllOwnedItems as any).mockResolvedValue([
      { id: 'es1', itemType: 'eventstream', displayName: 'Telemetry ES', workspaceId: 'ws-1' },
      { id: 'db1', itemType: 'kql-database', displayName: 'Telemetry DB', workspaceId: 'ws-1' },
      { id: 'lh1', itemType: 'lakehouse', displayName: 'ignored', workspaceId: 'ws-1' },
    ]);
    (listOwnedWorkspaces as any).mockResolvedValue([{ id: 'ws-1', name: 'WS One' }]);
    const res = await STREAMS();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('azure-native');
    expect(j.workspaceCount).toBe(1);
    const stream = j.streams.find((s: any) => s.dataType === 'stream');
    const table = j.streams.find((s: any) => s.dataType === 'table');
    expect(stream.name).toBe('Telemetry ES');
    expect(stream.workspace).toBe('WS One');
    expect(table.name).toBe('Telemetry DB');
    // non-stream item types are excluded
    expect(j.streams.find((s: any) => s.name === 'ignored')).toBeFalsy();
  });
});

// ---------------- connect-source (Azure-native default) ----------------
describe('POST /api/realtime-hub/connect-source', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await CONNECT(jsonReq({ workspaceId: 'w', displayName: 'x', sourceType: 'SampleData' }));
    expect(res.status).toBe(401);
  });

  it('415 when content-type is not JSON', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const res = await CONNECT(jsonReq({}, 'text/plain'));
    expect(res.status).toBe(415);
  });

  it('400 when workspaceId is missing (Azure-native default)', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const res = await CONNECT(jsonReq({ displayName: 'x', sourceType: 'SampleData' }));
    expect(res.status).toBe(400);
  });

  it('400 when sourceType is not a documented source enum', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const res = await CONNECT(jsonReq({ workspaceId: 'w', displayName: 'x', sourceType: 'Bogus' }));
    expect(res.status).toBe(400);
    expect(createOwnedItem).not.toHaveBeenCalled();
  });

  it('creates a Loom-native eventstream item carrying the source', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (createOwnedItem as any).mockResolvedValue({ ok: true, item: { id: 'es-1', displayName: 'Orders' } });
    const res = await CONNECT(jsonReq({
      workspaceId: 'ws-1', displayName: 'Orders', sourceType: 'AzureEventHub', properties: { eventHubName: 'eh' },
    }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('azure-native');
    expect(j.eventstreamId).toBe('es-1');
    const [, itemType, body] = (createOwnedItem as any).mock.calls[0];
    expect(itemType).toBe('eventstream');
    expect(body.workspaceId).toBe('ws-1');
    expect(body.state.source.type).toBe('AzureEventHub');
    expect(body.state.source.properties.eventHubName).toBe('eh');
  });

  it('surfaces createOwnedItem failure verbatim', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (createOwnedItem as any).mockResolvedValue({ ok: false, status: 404, error: 'workspace not found' });
    const res = await CONNECT(jsonReq({ workspaceId: 'bad', displayName: 'x', sourceType: 'SampleData' }));
    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.error).toContain('workspace not found');
  });

  it('accepts AzureEventGridCustomTopic (business-events topic) as a source type', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (createOwnedItem as any).mockResolvedValue({ ok: true, item: { id: 'es-eg' } });
    const res = await CONNECT(jsonReq({
      workspaceId: 'ws-1', displayName: 'Orders signals', sourceType: 'AzureEventGridCustomTopic',
      properties: { topic: 'orders-events', inputSchema: 'CloudEventSchemaV1_0' },
    }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.sourceType).toBe('AzureEventGridCustomTopic');
    const [, , body] = (createOwnedItem as any).mock.calls[0];
    expect(body.state.source.type).toBe('AzureEventGridCustomTopic');
    expect(body.state.source.properties.topic).toBe('orders-events');
  });
});

// ---------------- connect-source: MQTT mTLS (Key Vault certs) ----------------
describe('POST /api/realtime-hub/connect-source — MQTT mTLS', () => {
  it('accepts the Mqtt source type and persists CA/client cert refs in the topology', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (vaultUrl as any).mockReturnValue(null); // no password supplied → KV not required
    (createOwnedItem as any).mockResolvedValue({ ok: true, item: { id: 'es-mqtt', displayName: 'Telemetry MQTT' } });
    const res = await CONNECT(jsonReq({
      workspaceId: 'ws-1', displayName: 'Telemetry MQTT', sourceType: 'Mqtt',
      properties: {
        brokerUrl: 'ssl://broker:8883', topic: 'devices/+/telemetry', protocolVersion: 'V5',
        useMtls: 'true', caCertName: 'mqtt-ca', clientCertName: 'mqtt-client',
        certVaultUri: 'https://kv.vault.azure.net',
      },
    }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.sourceType).toBe('Mqtt');
    const [, , body] = (createOwnedItem as any).mock.calls[0];
    expect(body.state.source.type).toBe('Mqtt');
    expect(body.state.source.properties.caCertName).toBe('mqtt-ca');
    expect(body.state.source.properties.clientCertName).toBe('mqtt-client');
    expect(body.state.source.properties.certVaultUri).toBe('https://kv.vault.azure.net');
  });

  it('writes a supplied broker password to Key Vault and keeps only a secretRef', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (vaultUrl as any).mockReturnValue('https://kv.vault.azure.net');
    (putKeyVaultSecret as any).mockResolvedValue({ name: 'es-source-1-password-123' });
    (createOwnedItem as any).mockResolvedValue({ ok: true, item: { id: 'es-mqtt2' } });
    const res = await CONNECT(jsonReq({
      workspaceId: 'ws-1', displayName: 'Secured MQTT', sourceType: 'Mqtt',
      properties: { brokerUrl: 'ssl://broker:8883', topic: 't', username: 'u', password: 's3cret' },
    }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(putKeyVaultSecret).toHaveBeenCalled();
    const [, , body] = (createOwnedItem as any).mock.calls[0];
    expect(body.state.source.properties.password).toBeUndefined();
    expect(body.state.source.properties.passwordSecretRef).toBe('es-source-1-password-123');
  });

  it('503 when a password is supplied but no Key Vault is configured', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (vaultUrl as any).mockReturnValue(null);
    const res = await CONNECT(jsonReq({
      workspaceId: 'ws-1', displayName: 'x', sourceType: 'Mqtt',
      properties: { brokerUrl: 'ssl://b', topic: 't', password: 'p' },
    }));
    expect(res.status).toBe(503);
    expect(createOwnedItem).not.toHaveBeenCalled();
  });
});

// ---------------- keyvault-certificates (mTLS cert picker source) ----------------
describe('GET /api/realtime-hub/keyvault-certificates', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await CERTS();
    expect(res.status).toBe(401);
  });

  it('returns an honest gate (200) when no cert vault is configured', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (certVaultConfigGate as any).mockReturnValue({ missing: 'LOOM_EVENTSTREAM_CERT_VAULT', detail: 'set it' });
    const res = await CERTS();
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.configured).toBe(false);
    expect(j.gate.missing).toBe('LOOM_EVENTSTREAM_CERT_VAULT');
    expect(j.certificates).toEqual([]);
  });

  it('lists real Key Vault certificates when the vault is configured', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (certVaultConfigGate as any).mockReturnValue(null);
    (certVaultUrl as any).mockReturnValue('https://kv.vault.azure.net');
    (listKeyVaultCertificates as any).mockResolvedValue([
      { name: 'mqtt-ca', id: 'https://kv.vault.azure.net/certificates/mqtt-ca', enabled: true },
    ]);
    const res = await CERTS();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.configured).toBe(true);
    expect(j.vaultUri).toBe('https://kv.vault.azure.net');
    expect(j.certificates[0].name).toBe('mqtt-ca');
  });
});

// ---------------- preview ----------------
describe('POST /api/realtime-hub/preview', () => {
  const RESULT = { columns: ['ts'], columnTypes: ['datetime'], rows: [['t']], rowCount: 1, executionMs: 4, truncated: false };

  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await PREVIEW(jsonReq({ table: 'T' }));
    expect(res.status).toBe(401);
  });

  it('415 when content-type is not JSON', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const res = await PREVIEW(jsonReq({ table: 'T' }, 'text/plain'));
    expect(res.status).toBe(415);
  });

  it('400 when table is missing', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const res = await PREVIEW(jsonReq({}));
    expect(res.status).toBe(400);
  });

  it('runs a quoted take query against the chosen database, capped at the limit', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (executeQuery as any).mockResolvedValue(RESULT);
    const res = await PREVIEW(jsonReq({ database: 'db1', table: 'Events', limit: 9999 }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.rowCount).toBe(1);
    const [db, kql] = (executeQuery as any).mock.calls[0];
    expect(db).toBe('db1');
    expect(kql).toBe('["Events"] | take 200'); // clamped to MAX_LIMIT
  });

  it('502 with structured error when the Kusto query throws', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (executeQuery as any).mockRejectedValue(new Error('table not found'));
    const res = await PREVIEW(jsonReq({ table: 'Missing' }));
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.error).toContain('table not found');
  });
});

// ---------------- endpoints (Azure-native default) ----------------
describe('GET /api/realtime-hub/endpoints', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await ENDPOINTS(urlReq('?workspaceId=w&eventstreamId=e'));
    expect(res.status).toBe(401);
  });

  it('400 when eventstreamId is missing', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const res = await ENDPOINTS(urlReq('?workspaceId=w'));
    expect(res.status).toBe(400);
  });

  it('projects the Loom eventstream item topology into endpoints', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (loadOwnedItem as any).mockResolvedValue({
      id: 'e', itemType: 'eventstream', workspaceId: 'w',
      state: { definition: {
        sources: [{ name: 's1', type: 'AzureEventHub', properties: { eventHubName: 'eh' } }],
        destinations: [{ name: 'd1', type: 'CustomEndpoint', properties: {} }],
        streams: [{ name: 'st', type: 'DefaultStream', properties: {} }],
      } },
    });
    const res = await ENDPOINTS(urlReq('?workspaceId=w&eventstreamId=e'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('azure-native');
    expect(j.endpoints.find((e: any) => e.role === 'source').type).toBe('AzureEventHub');
    expect(j.endpoints.find((e: any) => e.role === 'destination').name).toBe('d1');
    expect(j.endpoints.find((e: any) => e.role === 'stream').type).toBe('DefaultStream');
  });

  it('404 when the eventstream item is not found', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (loadOwnedItem as any).mockResolvedValue(null);
    const res = await ENDPOINTS(urlReq('?workspaceId=w&eventstreamId=missing'));
    expect(res.status).toBe(404);
  });
});

// ---------------- options (cascading source-binding dropdowns) ----------------
describe('GET /api/realtime-hub/options', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await OPTIONS(optReq('?kind=namespaces'));
    expect(res.status).toBe(401);
  });

  it('503 not_configured when no subscription is configured (namespaces)', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (rtiSubscriptionScope as any).mockReturnValue([]);
    const res = await OPTIONS(optReq('?kind=namespaces'));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.code).toBe('not_configured');
    expect(j.bicep).toContain('rti-hub-rbac.bicep');
  });

  it('namespaces: returns only Event Hubs namespaces + filter facets', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (rtiSubscriptionScope as any).mockReturnValue(['sub-1']);
    (listStreamingResourcesViaGraph as any).mockResolvedValue([
      { id: '/ns1', name: 'ns-alpha', resourceKind: 'eventhub-namespace', resourceGroup: 'rg-a', subscriptionId: 'sub-1', location: 'eastus' },
      { id: '/iot1', name: 'iot-x', resourceKind: 'iothub', resourceGroup: 'rg-b', subscriptionId: 'sub-1', location: 'westus' },
      { id: '/adx1', name: 'adx', resourceKind: 'adx-cluster', resourceGroup: 'rg-c', subscriptionId: 'sub-1', location: 'eastus' },
    ]);
    const res = await OPTIONS(optReq('?kind=namespaces&service=eventhub'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.options.map((o: any) => o.name)).toEqual(['ns-alpha']);
    expect(j.options[0].subscriptionId).toBe('sub-1');
    expect(j.facets.resourceGroups).toContain('rg-a');
  });

  it('namespaces: service=iothub returns only IoT hubs', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (rtiSubscriptionScope as any).mockReturnValue(['sub-1']);
    (listStreamingResourcesViaGraph as any).mockResolvedValue([
      { id: '/ns1', name: 'ns-alpha', resourceKind: 'eventhub-namespace', resourceGroup: 'rg-a', subscriptionId: 'sub-1', location: 'eastus' },
      { id: '/iot1', name: 'iot-x', resourceKind: 'iothub', resourceGroup: 'rg-b', subscriptionId: 'sub-1', location: 'westus' },
    ]);
    const res = await OPTIONS(optReq('?kind=namespaces&service=iothub'));
    const j = await res.json();
    expect(j.options.map((o: any) => o.name)).toEqual(['iot-x']);
  });

  it('eventhubs: 400 when namespace scope is incomplete', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const res = await OPTIONS(optReq('?kind=eventhubs&namespace=ns'));
    expect(res.status).toBe(400);
  });

  it('eventhubs: lists hubs from the chosen namespace', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (listEventHubsIn as any).mockResolvedValue([
      { name: 'telemetry', partitionCount: 4, messageRetentionInDays: 1 },
    ]);
    const res = await OPTIONS(optReq('?kind=eventhubs&subscriptionId=s&resourceGroup=rg&namespace=ns'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.options[0].name).toBe('telemetry');
    const [scope] = (listEventHubsIn as any).mock.calls[0];
    expect(scope).toEqual({ subscriptionId: 's', resourceGroup: 'rg', namespace: 'ns' });
  });

  it('consumerGroups: always includes $Default', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (listConsumerGroupsIn as any).mockResolvedValue([{ name: 'loom-receiver', eventHub: 'telemetry' }]);
    const res = await OPTIONS(optReq('?kind=consumerGroups&subscriptionId=s&resourceGroup=rg&namespace=ns&eventHub=telemetry'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.options.map((o: any) => o.name)).toEqual(expect.arrayContaining(['$Default', 'loom-receiver']));
  });

  it('iotConsumerGroups: 400 without hubName', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const res = await OPTIONS(optReq('?kind=iotConsumerGroups'));
    expect(res.status).toBe(400);
  });

  it('connections: lists Loom connections, optionally filtered by type', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (listConnections as any).mockResolvedValue([
      { id: 'c1', name: 'orders-sb', type: 'service-bus' },
      { id: 'c2', name: 'sales-sql', type: 'azure-sql' },
    ]);
    const res = await OPTIONS(optReq('?kind=connections&type=service-bus'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    // Only the matching type, bound by id with the name as the label.
    expect(j.options).toEqual([{ id: 'c1', name: 'orders-sb', description: 'service-bus' }]);
  });

  it('surfaces an ARM error verbatim (status + body)', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (listEventHubsIn as any).mockRejectedValue(new EventHubsArmError(403, { error: 'AuthorizationFailed' }, 'forbidden'));
    const res = await OPTIONS(optReq('?kind=eventhubs&subscriptionId=s&resourceGroup=rg&namespace=ns'));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.body).toEqual({ error: 'AuthorizationFailed' });
  });
});

// ---------------- provision (create-if-missing) ----------------
describe('POST /api/realtime-hub/provision', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await PROVISION(jsonReq({ kind: 'eventhub' }));
    expect(res.status).toBe(401);
  });

  it('415 when content-type is not JSON', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const res = await PROVISION(jsonReq({ kind: 'eventhub' }, 'text/plain'));
    expect(res.status).toBe(415);
  });

  it('400 when namespace scope is missing for an event hub', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const res = await PROVISION(jsonReq({ kind: 'eventhub', eventHub: 'eh' }));
    expect(res.status).toBe(400);
    expect(ensureEventHub).not.toHaveBeenCalled();
  });

  it('400 when location is missing for a namespace create', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const res = await PROVISION(jsonReq({ kind: 'namespace', subscriptionId: 's', resourceGroup: 'rg', namespace: 'ns' }));
    expect(res.status).toBe(400);
    expect(ensureNamespace).not.toHaveBeenCalled();
  });

  it('creates an Event Hubs namespace (idempotent) and returns it', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (ensureNamespace as any).mockResolvedValue({ name: 'loom-ns', location: 'eastus', sku: 'Standard' });
    const res = await PROVISION(jsonReq({
      kind: 'namespace', subscriptionId: 's', resourceGroup: 'rg', namespace: 'loom-ns', location: 'eastus', sku: 'Standard',
    }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.created.name).toBe('loom-ns');
    const [scope, spec] = (ensureNamespace as any).mock.calls[0];
    expect(scope).toEqual({ subscriptionId: 's', resourceGroup: 'rg', namespace: 'loom-ns' });
    expect(spec).toEqual({ location: 'eastus', sku: 'Standard' });
  });

  it('creates an event hub (idempotent) and returns it', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (ensureEventHub as any).mockResolvedValue({ name: 'telemetry', partitionCount: 2, messageRetentionInDays: 1 });
    const res = await PROVISION(jsonReq({
      kind: 'eventhub', subscriptionId: 's', resourceGroup: 'rg', namespace: 'ns', eventHub: 'telemetry', partitionCount: 2, retentionDays: 1,
    }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.created.name).toBe('telemetry');
    const [scope, spec] = (ensureEventHub as any).mock.calls[0];
    expect(scope).toEqual({ subscriptionId: 's', resourceGroup: 'rg', namespace: 'ns' });
    expect(spec.name).toBe('telemetry');
  });

  it('creates a consumer group on an event hub', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (ensureConsumerGroup as any).mockResolvedValue({ name: 'loom-receiver', eventHub: 'telemetry' });
    const res = await PROVISION(jsonReq({
      kind: 'consumerGroup', subscriptionId: 's', resourceGroup: 'rg', namespace: 'ns', eventHub: 'telemetry', consumerGroup: 'loom-receiver',
    }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.created.name).toBe('loom-receiver');
  });

  it('creates an IoT Hub consumer group', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (ensureIoTHubConsumerGroup as any).mockResolvedValue({ name: 'loom-iot', hubName: 'iot-x' });
    const res = await PROVISION(jsonReq({ kind: 'iotConsumerGroup', hubName: 'iot-x', consumerGroup: 'loom-iot' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.created.name).toBe('loom-iot');
  });

  it('surfaces an ARM create error verbatim (status + body)', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (ensureEventHub as any).mockRejectedValue(new EventHubsArmError(403, { error: 'AuthorizationFailed' }, 'forbidden'));
    const res = await PROVISION(jsonReq({ kind: 'eventhub', subscriptionId: 's', resourceGroup: 'rg', namespace: 'ns', eventHub: 'eh' }));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.body).toEqual({ error: 'AuthorizationFailed' });
  });
});
