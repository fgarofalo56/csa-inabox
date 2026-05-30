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

import { getSession } from '@/lib/auth/session';
import {
  listFabricWorkspaces, listEventstreams, listKqlDatabases, listEventhouses,
  connectEventstreamSource, getEventstreamDefinition, FabricError, buildEventstreamDefinition,
} from '@/lib/azure/fabric-client';
import { executeQuery } from '@/lib/azure/kusto-client';

import { GET as STREAMS } from '../streams/route';
import { POST as CONNECT } from '../connect-source/route';
import { POST as PREVIEW } from '../preview/route';
import { GET as ENDPOINTS } from '../endpoints/route';

const AUTH = { claims: { oid: 'tenant-1', upn: 'u@x' } };

function jsonReq(body: any, ct = 'application/json') {
  return { headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? ct : null) }, json: async () => body } as any;
}
function urlReq(qs = '') {
  return { nextUrl: new URL(`https://x/api/realtime-hub/endpoints${qs}`) } as any;
}

beforeEach(() => { vi.resetAllMocks(); });

// ---------------- streams ----------------
describe('GET /api/realtime-hub/streams', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await STREAMS();
    expect(res.status).toBe(401);
  });

  it('aggregates eventstreams (stream) + KQL databases (table) across all workspaces', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (listFabricWorkspaces as any).mockResolvedValue([{ id: 'w1', displayName: 'WS One' }]);
    (listEventstreams as any).mockResolvedValue([{ id: 'es1', displayName: 'Telemetry ES' }]);
    (listKqlDatabases as any).mockResolvedValue([{ id: 'db1', displayName: 'Telemetry DB' }]);
    const res = await STREAMS();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.workspaceCount).toBe(1);
    const stream = j.streams.find((s: any) => s.dataType === 'stream');
    const table = j.streams.find((s: any) => s.dataType === 'table');
    expect(stream.name).toBe('Telemetry ES');
    expect(stream.workspace).toBe('WS One');
    expect(table.name).toBe('Telemetry DB');
  });

  it('passes the Fabric auth gate (403) through verbatim with a hint', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (listFabricWorkspaces as any).mockRejectedValue(new FabricError('Forbidden', 403, undefined, 'u', 'enable SP toggle'));
    const res = await STREAMS();
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.hint).toContain('SP toggle');
  });

  it('falls back to eventhouses when kqlDatabases returns 404', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (listFabricWorkspaces as any).mockResolvedValue([{ id: 'w1', displayName: 'WS' }]);
    (listEventstreams as any).mockResolvedValue([]);
    (listKqlDatabases as any).mockRejectedValue(new FabricError('not found', 404));
    (listEventhouses as any).mockResolvedValue([{ id: 'eh1', displayName: 'EH' }]);
    const res = await STREAMS();
    const j = await res.json();
    expect(j.streams.find((s: any) => s.name === 'EH')).toBeTruthy();
  });
});

// ---------------- connect-source ----------------
describe('POST /api/realtime-hub/connect-source', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await CONNECT(jsonReq({ fabricWorkspaceId: 'w', displayName: 'x', sourceType: 'SampleData' }));
    expect(res.status).toBe(401);
  });

  it('415 when content-type is not JSON', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const res = await CONNECT(jsonReq({}, 'text/plain'));
    expect(res.status).toBe(415);
  });

  it('400 when fabricWorkspaceId is missing', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const res = await CONNECT(jsonReq({ displayName: 'x', sourceType: 'SampleData' }));
    expect(res.status).toBe(400);
  });

  it('400 when sourceType is not a documented Fabric source enum', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const res = await CONNECT(jsonReq({ fabricWorkspaceId: 'w', displayName: 'x', sourceType: 'Bogus' }));
    expect(res.status).toBe(400);
    expect(connectEventstreamSource).not.toHaveBeenCalled();
  });

  it('creates a real Fabric eventstream and returns the new id', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (connectEventstreamSource as any).mockResolvedValue({ id: 'fes-1' });
    const res = await CONNECT(jsonReq({
      fabricWorkspaceId: 'ws-1', displayName: 'Orders', sourceType: 'AzureEventHub', properties: { eventHubName: 'eh' },
    }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.fabricEventstreamId).toBe('fes-1');
    const [ws, input] = (connectEventstreamSource as any).mock.calls[0];
    expect(ws).toBe('ws-1');
    expect(input.sourceType).toBe('AzureEventHub');
    expect(input.properties.eventHubName).toBe('eh');
  });

  it('passes the Fabric auth gate (403) through verbatim', async () => {
    (getSession as any).mockReturnValue(AUTH);
    (connectEventstreamSource as any).mockRejectedValue(new FabricError('Forbidden', 403, undefined, 'u', 'add UAMI to workspace'));
    const res = await CONNECT(jsonReq({ fabricWorkspaceId: 'w', displayName: 'x', sourceType: 'SampleData' }));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.hint).toContain('UAMI');
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

// ---------------- endpoints ----------------
describe('GET /api/realtime-hub/endpoints', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await ENDPOINTS(urlReq('?fabricWorkspaceId=w&eventstreamId=e'));
    expect(res.status).toBe(401);
  });

  it('400 when ids are missing', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const res = await ENDPOINTS(urlReq('?fabricWorkspaceId=w'));
    expect(res.status).toBe(400);
  });

  it('decodes the definition and projects sources/destinations/streams into endpoints', async () => {
    (getSession as any).mockReturnValue(AUTH);
    const topo = {
      sources: [{ name: 's1', type: 'AzureEventHub', properties: { eventHubName: 'eh' } }],
      destinations: [{ name: 'd1', type: 'CustomEndpoint', properties: {} }],
      streams: [{ name: 'st', type: 'DefaultStream', properties: {} }],
    };
    (getEventstreamDefinition as any).mockResolvedValue(buildEventstreamDefinition(topo));
    const res = await ENDPOINTS(urlReq('?fabricWorkspaceId=w&eventstreamId=e'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.endpoints.find((e: any) => e.role === 'source').type).toBe('AzureEventHub');
    expect(j.endpoints.find((e: any) => e.role === 'destination').name).toBe('d1');
    expect(j.endpoints.find((e: any) => e.role === 'stream').type).toBe('DefaultStream');
  });
});
