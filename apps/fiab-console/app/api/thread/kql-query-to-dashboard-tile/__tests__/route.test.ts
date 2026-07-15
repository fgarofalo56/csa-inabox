/**
 * BFF route test for POST /api/thread/kql-query-to-dashboard-tile — the
 * Query → Dashboard conversion edge (operator review 5.2). Mocks the session,
 * kusto-client I/O, item create, and lineage write; the dashboard-model append
 * helpers run REAL (pure), so the "tile really appended" assertions inspect
 * the actual persisted payload.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const loadKustoItemMock = vi.fn();
const loadKustoItemUnscopedMock = vi.fn(async () => null);
const authorizeWorkspaceMock = vi.fn(async () => null); // null = authorized
const saveItemStateMock = vi.fn(async (item: any, patch: any) => ({ ...item, state: { ...(item.state || {}), ...patch } }));
const resolveDatabaseMock = vi.fn(() => 'TelemetryDB');
const executeQueryMock = vi.fn();
const kustoConfigGateMock = vi.fn(() => null);
vi.mock('@/lib/azure/kusto-client', () => {
  class KustoError extends Error {
    status?: number;
    constructor(m: string, status?: number) { super(m); this.name = 'KustoError'; this.status = status; }
  }
  return {
    loadKustoItem: (...a: any[]) => loadKustoItemMock(...a),
    loadKustoItemUnscoped: (...a: any[]) => loadKustoItemUnscopedMock(...a),
    saveItemState: (...a: any[]) => saveItemStateMock(...a),
    resolveDatabase: (...a: any[]) => resolveDatabaseMock(...a),
    executeQuery: (...a: any[]) => executeQueryMock(...a),
    kustoConfigGate: () => kustoConfigGateMock(),
    KustoError,
  };
});
vi.mock('@/lib/auth/workspace-guard', () => ({
  authorizeWorkspace: (...a: any[]) => authorizeWorkspaceMock(...a),
}));

const createOwnedItemMock = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  createOwnedItem: (...a: any[]) => createOwnedItemMock(...a),
}));

const recordThreadEdgeMock = vi.fn(async () => {});
vi.mock('@/lib/thread/thread-edges', () => ({ recordThreadEdge: (...a: any[]) => recordThreadEdgeMock(...a) }));

import { POST } from '../route';

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/thread/kql-query-to-dashboard-tile', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

const FROM = { id: 'kdb-1', type: 'kql-database', name: 'Telemetry' };
const VALUES = {
  dashboardId: '__new__',
  newDashboardName: 'Ops overview',
  kql: 'Events | summarize count() by bin(Timestamp, 1h)',
  title: 'Events per hour',
  viz: 'timechart',
  size: 'wide',
};

const SRC_ITEM = { id: 'kdb-1', itemType: 'kql-database', displayName: 'Telemetry', workspaceId: 'ws-1', state: {} };
const DASH_ITEM = {
  id: 'dash-1', itemType: 'kql-dashboard', displayName: 'Existing dash', workspaceId: 'ws-1',
  state: {
    tiles: [{ title: 'Old tile', kql: 'Old | take 1', viz: 'table', dataSourceId: 'ds-1' }],
    dataSources: [{ id: 'ds-1', name: 'Telemetry', database: 'TelemetryDB' }],
    parameters: [],
  },
};
const RESULT = { columns: ['c'], columnTypes: ['long'], rows: [[5]], rowCount: 42, executionMs: 3, truncated: false };

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
  kustoConfigGateMock.mockReturnValue(null);
  resolveDatabaseMock.mockReturnValue('TelemetryDB');
  executeQueryMock.mockResolvedValue(RESULT);
  createOwnedItemMock.mockResolvedValue({ ok: true, item: { id: 'dash-new', displayName: 'Ops overview' } });
  loadKustoItemMock.mockImplementation(async (id: string, type: string) => {
    if (id === 'kdb-1' && type === 'kql-database') return SRC_ITEM;
    if (id === 'dash-1' && type === 'kql-dashboard') return structuredClone(DASH_ITEM);
    return null;
  });
});

describe('kql-query-to-dashboard-tile route', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await POST(post({ from: FROM, values: VALUES }));
    expect(res.status).toBe(401);
  });

  it('400 on a non-KQL source type', async () => {
    const res = await POST(post({ from: { id: 'x', type: 'lakehouse' }, values: VALUES }));
    expect(res.status).toBe(400);
  });

  it('400 on a management command (tiles are tabular queries only)', async () => {
    const res = await POST(post({ from: FROM, values: { ...VALUES, kql: '.show tables' } }));
    expect(res.status).toBe(400);
    expect(executeQueryMock).not.toHaveBeenCalled();
  });

  it('400 on a missing title / invalid viz', async () => {
    expect((await POST(post({ from: FROM, values: { ...VALUES, title: '  ' } }))).status).toBe(400);
    expect((await POST(post({ from: FROM, values: { ...VALUES, viz: 'donut' } }))).status).toBe(400);
  });

  it('503 honest gate when ADX is not configured (names the env var)', async () => {
    kustoConfigGateMock.mockReturnValueOnce({ missing: 'LOOM_KUSTO_CLUSTER_URI' } as any);
    const res = await POST(post({ from: FROM, values: VALUES }));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.error).toContain('LOOM_KUSTO_CLUSTER_URI');
  });

  it('422 HONEST error when the query fails validation against ADX — nothing is created', async () => {
    executeQueryMock.mockRejectedValueOnce(new Error("Failed to resolve table or column expression named 'Eventz'"));
    const res = await POST(post({ from: FROM, values: VALUES }));
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.validated).toBe(false);
    expect(j.error).toContain('Eventz');
    expect(createOwnedItemMock).not.toHaveBeenCalled();
    expect(saveItemStateMock).not.toHaveBeenCalled();
    expect(recordThreadEdgeMock).not.toHaveBeenCalled();
  });

  it('validates by EXECUTING against the resolved database with the time tokens bound', async () => {
    await POST(post({ from: FROM, values: VALUES }));
    expect(executeQueryMock).toHaveBeenCalledTimes(1);
    const [db, runnable] = executeQueryMock.mock.calls[0];
    expect(db).toBe('TelemetryDB');
    expect(runnable).toContain('let _startTime =');
    expect(runnable).toContain('let _endTime = now();');
    expect(runnable).toContain(VALUES.kql);
  });

  it('creates a NEW dashboard seeded with the validated tile + a data source', async () => {
    const res = await POST(post({ from: FROM, values: VALUES }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.created).toBe(true);
    expect(j.validated).toBe(true);
    expect(j.rowCount).toBe(42);
    expect(j.link).toBe('/items/kql-dashboard/dash-new');

    expect(createOwnedItemMock).toHaveBeenCalledTimes(1);
    const [, itemType, payload] = createOwnedItemMock.mock.calls[0];
    expect(itemType).toBe('kql-dashboard');
    expect(payload.workspaceId).toBe('ws-1');
    expect(payload.displayName).toBe('Ops overview');
    expect(payload.state.tiles).toHaveLength(1);
    const tile = payload.state.tiles[0];
    expect(tile.title).toBe('Events per hour');
    expect(tile.kql).toBe(VALUES.kql);
    expect(tile.viz).toBe('timechart');
    expect(tile.w).toBe(12); // wide preset
    expect(tile.h).toBe(3);
    const ds = payload.state.dataSources.find((d: any) => d.id === tile.dataSourceId);
    expect(ds?.database).toBe('TelemetryDB');

    expect(recordThreadEdgeMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'create-dashboard-tile-from-query',
      fromType: 'kql-database',
      toType: 'kql-dashboard',
      toItemId: 'dash-new',
    }));
  });

  it('APPENDS the tile to an existing dashboard (tile really appended, source reused)', async () => {
    const res = await POST(post({ from: FROM, values: { ...VALUES, dashboardId: 'dash-1' } }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.created).toBe(false);
    expect(j.dashboardId).toBe('dash-1');
    expect(j.tileCount).toBe(2);

    expect(saveItemStateMock).toHaveBeenCalledTimes(1);
    const [, patch] = saveItemStateMock.mock.calls[0];
    expect(patch.tiles).toHaveLength(2);
    expect(patch.tiles[0].title).toBe('Old tile'); // existing tile preserved
    const added = patch.tiles[1];
    expect(added.title).toBe('Events per hour');
    expect(added.kql).toBe(VALUES.kql);
    expect(added.viz).toBe('timechart');
    // The database matches an existing data source → reused, no duplicate.
    expect(patch.dataSources).toHaveLength(1);
    expect(added.dataSourceId).toBe('ds-1');
    expect(createOwnedItemMock).not.toHaveBeenCalled();
  });

  it('404 when the existing target dashboard is not in the tenant', async () => {
    const res = await POST(post({ from: FROM, values: { ...VALUES, dashboardId: 'dash-missing' } }));
    expect(res.status).toBe(404);
    expect(saveItemStateMock).not.toHaveBeenCalled();
  });

  it('falls back to workspace-visible items when not owner-scoped (app-installed/shared)', async () => {
    // Owner-scoped load misses BOTH items; the unscoped load finds them and
    // authorizeWorkspace admits the caller (tenant admin / ACL member).
    loadKustoItemMock.mockImplementation(async () => null);
    loadKustoItemUnscopedMock.mockImplementation(async (id: string, type: string) => {
      if (id === 'kdb-1' && type === 'kql-database') return SRC_ITEM;
      if (id === 'dash-shared' && type === 'kql-dashboard') {
        return {
          id: 'dash-shared', itemType: 'kql-dashboard', displayName: 'Shared dash', workspaceId: 'ws-shared',
          state: { tiles: [] },
        };
      }
      return null;
    });
    const res = await POST(post({ from: FROM, values: { ...VALUES, dashboardId: 'dash-shared' } }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    // Source read admits read roles; dashboard mutation requires write auth.
    expect(authorizeWorkspaceMock).toHaveBeenCalledWith(expect.anything(), 'ws-1', { allowReadRoles: true });
    expect(authorizeWorkspaceMock).toHaveBeenCalledWith(expect.anything(), 'ws-shared');
    expect(saveItemStateMock).toHaveBeenCalled();
  });

  it('materializes a bundle dashboard\'s content tiles before appending (never shadows starters)', async () => {
    loadKustoItemMock.mockImplementation(async (id: string, type: string) => {
      if (id === 'kdb-1' && type === 'kql-database') return SRC_ITEM;
      if (id === 'dash-bundle' && type === 'kql-dashboard') {
        return {
          id: 'dash-bundle', itemType: 'kql-dashboard', displayName: 'Bundle dash', workspaceId: 'ws-1',
          state: { content: { kind: 'kql-dashboard', tiles: [{ title: 'Starter', kql: 'A | take 1', viz: 'card' }] } },
        };
      }
      return null;
    });
    const res = await POST(post({ from: FROM, values: { ...VALUES, dashboardId: 'dash-bundle' } }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    const [, patch] = saveItemStateMock.mock.calls[0];
    expect(patch.tiles.map((t: any) => t.title)).toEqual(['Starter', 'Events per hour']);
    expect(patch.tiles[0].viz).toBe('stat'); // bundle 'card' materialized as stat
  });
});
