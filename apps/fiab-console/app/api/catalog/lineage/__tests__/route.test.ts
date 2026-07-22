/**
 * Unit tests for GET /api/catalog/lineage — L1 column-facet gating.
 *
 * The L1 acceptance bar: WITHOUT `?columns=true` the response payload is
 * BYTE-IDENTICAL to the pre-L1 shape (proven via a serialized-JSON snapshot
 * comparison — key order and all); WITH `?columns=true` the envelope gains
 * `columnEdges` (real column lineage from the Databricks system tables when a
 * lineage warehouse is wired; honest empty otherwise) and nodes gain `columns`
 * badges.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const H = vi.hoisted(() => {
  class UnityCatalogNotConfiguredError extends Error {
    hint: any;
    constructor(hint?: any) { super('UC not configured'); this.hint = hint; }
  }
  class UnityCatalogError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
  }
  class PurviewNotConfiguredError extends Error {
    hint: any;
    constructor(hint?: any) { super('Purview not configured'); this.hint = hint; }
  }
  class PurviewError extends Error {
    status: number;
    constructor(status: number) { super('purview error'); this.status = status; }
  }
  class OneLakeError extends Error {
    status: number;
    constructor(status: number) { super('onelake error'); this.status = status; }
  }
  class OneLakeLineageNotSupportedError extends Error {
    hint: any; endpoint?: string;
    constructor() { super('onelake lineage not supported'); }
  }
  return {
    UnityCatalogNotConfiguredError, UnityCatalogError, PurviewNotConfiguredError,
    PurviewError, OneLakeError, OneLakeLineageNotSupportedError,
  };
});

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/purview-client', () => ({
  getLineageSubgraph: vi.fn(),
  isPurviewConfigured: vi.fn(() => false),
  PurviewNotConfiguredError: H.PurviewNotConfiguredError,
  PurviewError: H.PurviewError,
}));
vi.mock('@/lib/azure/unity-catalog-client', () => ({
  getTableLineage: vi.fn(),
  getTableLineageSystemTables: vi.fn(),
  getColumnLineageSystemTables: vi.fn(),
  lineageWarehouseId: vi.fn(() => null),
  listWorkspaceHostnames: vi.fn(() => []),
  UnityCatalogNotConfiguredError: H.UnityCatalogNotConfiguredError,
  UnityCatalogError: H.UnityCatalogError,
}));
vi.mock('@/lib/azure/onelake-catalog-client', () => ({
  getWorkspaceLineage: vi.fn(),
  OneLakeError: H.OneLakeError,
  OneLakeLineageNotSupportedError: H.OneLakeLineageNotSupportedError,
}));
vi.mock('@/lib/azure/lineage-gc', () => ({
  annotateDeletedLoomNodes: vi.fn(async () => {}),
}));
// unified-lineage's transitive value imports (Cosmos / identity probes) must
// never load real SDKs under vitest — synthesizeColumnGraph itself is pure.
vi.mock('@/lib/thread/thread-edges', () => ({ listThreadEdges: vi.fn(async () => []) }));
vi.mock('@/lib/azure/asset-identity', () => ({
  resolveAssetIdentities: vi.fn(async (i: any) => i),
  storagePathIdentity: () => undefined,
}));

import { GET } from '../route';
import { getSession } from '@/lib/auth/session';
import { getLineageSubgraph } from '@/lib/azure/purview-client';
import {
  getTableLineage, getColumnLineageSystemTables, lineageWarehouseId,
} from '@/lib/azure/unity-catalog-client';

function call(qs: string) {
  const url = `http://x/api/catalog/lineage?${qs}`;
  return GET({ nextUrl: new URL(url), url } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
  (lineageWarehouseId as any).mockReturnValue(null);
});

describe('GET /api/catalog/lineage — default payload (no ?columns=true)', () => {
  it('unity-catalog: byte-identical to the pre-L1 payload (snapshot), no columnEdges key', async () => {
    (getTableLineage as any).mockResolvedValue([
      { source: 'up.sch.t', target: 'cat.sch.t' },
    ]);
    const res = await call('source=unity-catalog&id=cat.sch.t&host=adb-1.azuredatabricks.net');
    expect(res.status).toBe(200);
    const body = await res.json();
    // Serialized comparison — proves key set AND key order match the pre-L1
    // payload exactly (byte-identical envelope).
    expect(JSON.stringify(body)).toBe(JSON.stringify({
      ok: true,
      source: 'unity-catalog',
      nodes: [
        { id: 'up.sch.t', label: 'up.sch.t', type: 'table', source: 'unity-catalog' },
        { id: 'cat.sch.t', label: 'cat.sch.t', type: 'table', source: 'unity-catalog' },
      ],
      edges: [{ from: 'up.sch.t', to: 'cat.sch.t' }],
    }));
    expect('columnEdges' in body).toBe(false);
    // The column-lineage backend is never even queried on the default path.
    expect(getColumnLineageSystemTables).not.toHaveBeenCalled();
  });

  it('purview: no columnEdges key on the default path', async () => {
    (getLineageSubgraph as any).mockResolvedValue({
      baseEntityGuid: 'g1',
      guidEntityMap: { g1: { guid: 'g1', displayText: 'orders', typeName: 'azure_sql_table', qualifiedName: 'q1' } },
      relations: [],
    });
    const res = await call('source=purview&id=g1');
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect('columnEdges' in body).toBe(false);
  });
});

describe('GET /api/catalog/lineage?columns=true — L1 column facet', () => {
  it('unity-catalog + lineage warehouse: real column edges (kind:column) + node columns badges', async () => {
    (getTableLineage as any).mockResolvedValue([
      { source: 'main.bronze.raw', target: 'main.bronze.customers' },
    ]);
    (lineageWarehouseId as any).mockReturnValue('wh-1');
    (getColumnLineageSystemTables as any).mockResolvedValue({
      edges: [
        { sourceTable: 'main.bronze.raw', sourceColumn: 'id', targetTable: 'main.bronze.customers', targetColumn: 'customer_id' },
      ],
      columnsByTable: {
        'main.bronze.raw': ['id'],
        'main.bronze.customers': ['customer_id'],
      },
    });
    const res = await call('source=unity-catalog&id=main.bronze.customers&host=adb-1.azuredatabricks.net&columns=true');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(getColumnLineageSystemTables).toHaveBeenCalledWith('adb-1.azuredatabricks.net', 'main.bronze.customers', 'wh-1');
    expect(body.columnEdges).toEqual([
      { from: 'col:main.bronze.raw::id', to: 'col:main.bronze.customers::customer_id', type: 'column', kind: 'column' },
    ]);
    const raw = body.nodes.find((n: any) => n.id === 'main.bronze.raw');
    expect(raw.columns).toEqual(['id']);
  });

  it('unity-catalog without a lineage warehouse: honest empty columnEdges (no fabrication)', async () => {
    (getTableLineage as any).mockResolvedValue([
      { source: 'a.b.c', target: 'd.e.f' },
    ]);
    const res = await call('source=unity-catalog&id=d.e.f&host=adb-1.azuredatabricks.net&columns=true');
    const body = await res.json();
    expect(body.columnEdges).toEqual([]);
    expect(getColumnLineageSystemTables).not.toHaveBeenCalled();
  });

  it('unity-catalog: a column-lineage gate degrades to empty columnEdges without blanking the table graph', async () => {
    (getTableLineage as any).mockResolvedValue([
      { source: 'a.b.c', target: 'd.e.f' },
    ]);
    (lineageWarehouseId as any).mockReturnValue('wh-1');
    (getColumnLineageSystemTables as any).mockRejectedValue(
      new H.UnityCatalogError('system.access.column_lineage not granted', 403),
    );
    const res = await call('source=unity-catalog&id=d.e.f&host=adb-1.azuredatabricks.net&columns=true');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toHaveLength(2);
    expect(body.columnEdges).toEqual([]);
  });

  it('purview: honest empty columnEdges until the L4 column push lands', async () => {
    (getLineageSubgraph as any).mockResolvedValue({
      baseEntityGuid: 'g1',
      guidEntityMap: { g1: { guid: 'g1', displayText: 'orders', typeName: 'azure_sql_table', qualifiedName: 'q1' } },
      relations: [],
    });
    const res = await call('source=purview&id=g1&columns=true');
    const body = await res.json();
    expect(body.columnEdges).toEqual([]);
  });
});
