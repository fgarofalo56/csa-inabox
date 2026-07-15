/**
 * BFF route test for POST /api/thread/open-in-report-builder — operator review
 * 5.3, the "Open in Loom report builder" deep-link. Mocks the session, item
 * CRUD, the PBI source resolver, connections store, kusto listTables, and the
 * lineage write; asserts a DRAFT report is created PRE-BOUND to the source
 * (correct `state.dataSource` union per source type) and the deep link is
 * returned — with honest gates for unresolvable backends.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const loadOwnedItemMock = vi.fn();
const createOwnedItemMock = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
  createOwnedItem: (...a: any[]) => createOwnedItemMock(...a),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } })),
}));

const resolvePbiSourceMock = vi.fn();
vi.mock('@/lib/azure/pbi-source-resolver', async () => {
  const actual: any = await vi.importActual('@/lib/azure/pbi-source-resolver');
  return { ...actual, resolvePbiSource: (...a: any[]) => resolvePbiSourceMock(...a) };
});

const listConnectionsMock = vi.fn(async () => [] as any[]);
const createConnectionMock = vi.fn(async () => ({ id: 'conn-new' }));
vi.mock('@/lib/azure/connections-store', () => ({
  listConnections: (...a: any[]) => listConnectionsMock(...a),
  createConnection: (...a: any[]) => createConnectionMock(...a),
}));

const listTablesMock = vi.fn(async () => [{ name: 'Events' }]);
vi.mock('@/lib/azure/kusto-client', () => ({
  listTables: (...a: any[]) => listTablesMock(...a),
}));

const recordThreadEdgeMock = vi.fn(async () => {});
vi.mock('@/lib/thread/thread-edges', () => ({ recordThreadEdge: (...a: any[]) => recordThreadEdgeMock(...a) }));

import { POST } from '../route';

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/thread/open-in-report-builder', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

const MODEL_ITEM = { id: 'sm-1', itemType: 'semantic-model', displayName: 'Sales model', workspaceId: 'ws-1', state: {} };
const WH_ITEM = { id: 'wh-1', itemType: 'warehouse', displayName: 'Sales WH', workspaceId: 'ws-1', state: {} };
const KDB_ITEM = { id: 'kdb-1', itemType: 'kql-database', displayName: 'Telemetry', workspaceId: 'ws-1', state: {} };

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
  createOwnedItemMock.mockResolvedValue({ ok: true, item: { id: 'rep-1', displayName: 'draft' } });
  listConnectionsMock.mockResolvedValue([]);
  createConnectionMock.mockResolvedValue({ id: 'conn-new' } as any);
  listTablesMock.mockResolvedValue([{ name: 'Events' }] as any);
  loadOwnedItemMock.mockImplementation(async (id: string) => {
    if (id === 'sm-1') return MODEL_ITEM;
    if (id === 'wh-1') return WH_ITEM;
    if (id === 'kdb-1') return KDB_ITEM;
    return null;
  });
});

describe('open-in-report-builder route', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await POST(post({ from: { id: 'sm-1', type: 'semantic-model' } }));
    expect(res.status).toBe(401);
  });

  it('400 for an unsupported source type', async () => {
    const res = await POST(post({ from: { id: 'x', type: 'notebook' } }));
    expect(res.status).toBe(400);
  });

  it('404 when the source item is not in the tenant', async () => {
    const res = await POST(post({ from: { id: 'missing', type: 'warehouse' } }));
    expect(res.status).toBe(404);
  });

  it('semantic-model → draft report bound directly to the model item + deep link', async () => {
    const res = await POST(post({ from: { id: 'sm-1', type: 'semantic-model', name: 'Sales model' } }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.link).toBe('/items/report/rep-1');
    expect(resolvePbiSourceMock).not.toHaveBeenCalled(); // models bind directly

    const [, itemType, payload] = createOwnedItemMock.mock.calls[0];
    expect(itemType).toBe('report');
    expect(payload.workspaceId).toBe('ws-1');
    expect(payload.state.dataSource).toEqual({ kind: 'semantic-model', itemId: 'sm-1' });
    expect(payload.state.sourceItemId).toBe('sm-1');
    expect(payload.state.content.pages).toHaveLength(1);

    expect(recordThreadEdgeMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'open-in-report-builder', toType: 'report', toItemId: 'rep-1',
    }));
  });

  it('warehouse → draft report bound to the resolver\'s direct-query seed', async () => {
    resolvePbiSourceMock.mockResolvedValueOnce({
      connector: 'synapse-sql', server: 'ws.sql.azuresynapse.net', database: 'loomdw',
      defaultTable: 'dbo.fact_sales', behindPrivateEndpoint: true, sourceItemId: 'wh-1',
      loomNativeDataSource: { kind: 'direct-query', target: 'warehouse', sql: 'SELECT TOP 1000 * FROM [dbo].[fact_sales]' },
    });
    const res = await POST(post({ from: { id: 'wh-1', type: 'warehouse', name: 'Sales WH' } }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    const [, , payload] = createOwnedItemMock.mock.calls[0];
    expect(payload.state.dataSource).toEqual({
      kind: 'direct-query', target: 'warehouse', sql: 'SELECT TOP 1000 * FROM [dbo].[fact_sales]',
    });
  });

  it('warehouse with NO default table → honest 400 (no report bound to nothing)', async () => {
    resolvePbiSourceMock.mockResolvedValueOnce({
      connector: 'synapse-sql', server: 'ws.sql.azuresynapse.net', database: 'loomdw',
      behindPrivateEndpoint: true, sourceItemId: 'wh-1',
      loomNativeDataSource: { kind: 'direct-query', target: 'warehouse', sql: '' },
    });
    const res = await POST(post({ from: { id: 'wh-1', type: 'warehouse' } }));
    expect(res.status).toBe(400);
    expect(createOwnedItemMock).not.toHaveBeenCalled();
  });

  it('422 honest gate when the resolver gates (e.g. Synapse env unset)', async () => {
    resolvePbiSourceMock.mockResolvedValueOnce({ gate: 'Set LOOM_SYNAPSE_WORKSPACE …' });
    const res = await POST(post({ from: { id: 'wh-1', type: 'warehouse' } }));
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.gate).toBe(true);
    expect(j.error).toContain('LOOM_SYNAPSE_WORKSPACE');
  });

  it('kql-database → creates a REAL adx Loom Connection and binds the report to its table', async () => {
    resolvePbiSourceMock.mockResolvedValueOnce({
      connector: 'adx', clusterUri: 'https://cluster.kusto.windows.net', database: 'TelemetryDB',
      behindPrivateEndpoint: false, sourceItemId: 'kdb-1',
      loomNativeDataSource: { kind: 'connection', connectionId: '', connType: 'adx', objectRef: { mode: 'kql', kql: '' } },
    });
    const res = await POST(post({ from: { id: 'kdb-1', type: 'kql-database', name: 'Telemetry' } }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    // Default table came from a LIVE listTables call against the cluster.
    expect(listTablesMock).toHaveBeenCalledWith('TelemetryDB', { clusterUri: 'https://cluster.kusto.windows.net' });
    expect(createConnectionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: 'adx', authMethod: 'entra-mi', host: 'https://cluster.kusto.windows.net', database: 'TelemetryDB',
    }));
    const [, , payload] = createOwnedItemMock.mock.calls[0];
    expect(payload.state.dataSource).toEqual({
      kind: 'connection', connectionId: 'conn-new', connType: 'adx',
      objectRef: { mode: 'table', table: 'Events' },
    });
  });

  it('kql-database reuses an existing matching adx connection (no duplicates)', async () => {
    resolvePbiSourceMock.mockResolvedValueOnce({
      connector: 'adx', clusterUri: 'https://cluster.kusto.windows.net', database: 'TelemetryDB',
      behindPrivateEndpoint: false, sourceItemId: 'kdb-1',
      loomNativeDataSource: { kind: 'connection', connectionId: '', connType: 'adx', objectRef: { mode: 'kql', kql: '' } },
    });
    listConnectionsMock.mockResolvedValueOnce([
      { id: 'conn-old', type: 'adx', host: 'https://cluster.kusto.windows.net', database: 'TelemetryDB' },
    ] as any);
    const res = await POST(post({ from: { id: 'kdb-1', type: 'kql-database' } }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(createConnectionMock).not.toHaveBeenCalled();
    const [, , payload] = createOwnedItemMock.mock.calls[0];
    expect(payload.state.dataSource.connectionId).toBe('conn-old');
  });

  it('kql-database with NO tables → honest 400 naming the remediation', async () => {
    resolvePbiSourceMock.mockResolvedValueOnce({
      connector: 'adx', clusterUri: 'https://cluster.kusto.windows.net', database: 'TelemetryDB',
      behindPrivateEndpoint: false, sourceItemId: 'kdb-1',
      loomNativeDataSource: { kind: 'connection', connectionId: '', connType: 'adx', objectRef: { mode: 'kql', kql: '' } },
    });
    listTablesMock.mockResolvedValueOnce([] as any);
    const res = await POST(post({ from: { id: 'kdb-1', type: 'kql-database' } }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toContain('no tables');
    expect(createOwnedItemMock).not.toHaveBeenCalled();
  });
});
