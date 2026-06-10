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

import { GET as STREAMS } from '../streams/route';
import { POST as CONNECT } from '../connect-source/route';
import { POST as PREVIEW } from '../preview/route';
import { GET as ENDPOINTS } from '../endpoints/route';
import { GET as CERTS } from '../keyvault-certificates/route';

const AUTH = { claims: { oid: 'tenant-1', upn: 'u@x' } };

function jsonReq(body: any, ct = 'application/json') {
  return { headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? ct : null) }, json: async () => body } as any;
}
function urlReq(qs = '') {
  return { nextUrl: new URL(`https://x/api/realtime-hub/endpoints${qs}`) } as any;
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
