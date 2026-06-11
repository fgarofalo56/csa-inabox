/**
 * Unit tests for the unified-lineage merge engine (audit-t138).
 *
 * Covers the three pure-merge behaviours the catalog "Lineage" tab + the item
 * lineage drawer rely on:
 *   1. identityKey normalization across the UC full_name / abfss path / Atlas
 *      qualifiedName formats so the SAME asset collapses across sources.
 *   2. mergeGraphs collapses nodes sharing an identity, sets multiSource, and
 *      rewrites + de-dupes edges onto the surviving id.
 *   3. getUnifiedLineage fans out to all three sources, and a per-source
 *      failure degrades to a sources[] gate instead of failing the request.
 *
 * The three client modules are fully mocked (vi.hoisted error classes shared
 * with the SUT so `instanceof` resolves) so the real @azure/identity + Cosmos
 * ESM graphs never load under vitest.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const H = vi.hoisted(() => {
  class UnityCatalogNotConfiguredError extends Error {
    hint: any;
    constructor(hint: any) { super(`UC not configured: ${hint?.missingEnvVar}`); this.hint = hint; }
  }
  class UnityCatalogError extends Error {
    status: number; endpoint?: string;
    constructor(message: string, status: number, _b?: any, endpoint?: string) { super(message); this.status = status; this.endpoint = endpoint; }
  }
  class PurviewNotConfiguredError extends Error {
    hint: any;
    constructor(hint?: any) { super('Purview not configured'); this.hint = hint; }
  }
  class PurviewError extends Error {
    status: number;
    constructor(status: number, _b?: any, message?: string) { super(message || 'purview err'); this.status = status; }
  }
  return { UnityCatalogNotConfiguredError, UnityCatalogError, PurviewNotConfiguredError, PurviewError };
});

const mocks = vi.hoisted(() => ({
  getLineageSubgraph: vi.fn(),
  isPurviewConfigured: vi.fn(() => true),
  getTableLineage: vi.fn(),
  getTableLineageSystemTables: vi.fn(),
  lineageWarehouseId: vi.fn(() => null as string | null),
  listWorkspaceHostnames: vi.fn(() => ['adb-test.azuredatabricks.net']),
  listThreadEdges: vi.fn(async () => []),
}));

vi.mock('@/lib/azure/purview-client', () => ({
  getLineageSubgraph: mocks.getLineageSubgraph,
  isPurviewConfigured: mocks.isPurviewConfigured,
  PurviewNotConfiguredError: H.PurviewNotConfiguredError,
  PurviewError: H.PurviewError,
}));
vi.mock('@/lib/azure/unity-catalog-client', () => ({
  getTableLineage: mocks.getTableLineage,
  getTableLineageSystemTables: mocks.getTableLineageSystemTables,
  lineageWarehouseId: mocks.lineageWarehouseId,
  listWorkspaceHostnames: mocks.listWorkspaceHostnames,
  UnityCatalogNotConfiguredError: H.UnityCatalogNotConfiguredError,
  UnityCatalogError: H.UnityCatalogError,
}));
vi.mock('@/lib/thread/thread-edges', () => ({
  listThreadEdges: mocks.listThreadEdges,
}));

// The SUT imports './purview-client' and './unity-catalog-client' (relative);
// alias both spellings so the mocks apply regardless of resolution.
vi.mock('./purview-client', () => ({
  getLineageSubgraph: mocks.getLineageSubgraph,
  isPurviewConfigured: mocks.isPurviewConfigured,
  PurviewNotConfiguredError: H.PurviewNotConfiguredError,
  PurviewError: H.PurviewError,
}));
vi.mock('./unity-catalog-client', () => ({
  getTableLineage: mocks.getTableLineage,
  getTableLineageSystemTables: mocks.getTableLineageSystemTables,
  lineageWarehouseId: mocks.lineageWarehouseId,
  listWorkspaceHostnames: mocks.listWorkspaceHostnames,
  UnityCatalogNotConfiguredError: H.UnityCatalogNotConfiguredError,
  UnityCatalogError: H.UnityCatalogError,
}));

import {
  normalizeIdentity,
  ucIdentity,
  mergeGraphs,
  getUnifiedLineage,
} from '@/lib/azure/unified-lineage';

const session: any = { claims: { oid: 'tenant-1', upn: 'a@b.com' } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isPurviewConfigured.mockReturnValue(true);
  mocks.lineageWarehouseId.mockReturnValue(null);
  mocks.listWorkspaceHostnames.mockReturnValue(['adb-test.azuredatabricks.net']);
  mocks.listThreadEdges.mockResolvedValue([]);
});

describe('normalizeIdentity', () => {
  it('maps a Loom-registered Atlas UC qualifiedName to uc:<fullName>', () => {
    expect(normalizeIdentity('https://adb-x.azuredatabricks.net/api/2.1/unity-catalog/tables/main.bronze.customers'))
      .toBe('uc:main.bronze.customers');
  });
  it('maps a bare catalog.schema.table to uc:<fullName>', () => {
    expect(normalizeIdentity('Main.Bronze.Customers')).toBe('uc:main.bronze.customers');
  });
  it('maps an abfss storage path to a path: identity (lowercased)', () => {
    expect(normalizeIdentity('abfss://c@acct.dfs.core.windows.net/Bronze/'))
      .toBe('path:abfss://c@acct.dfs.core.windows.net/bronze');
  });
  it('passes a guid through unchanged (lowercased)', () => {
    expect(normalizeIdentity('A1B2')).toBe('a1b2');
  });
  it('ucIdentity lowercases', () => {
    expect(ucIdentity('Main.B.C')).toBe('uc:main.b.c');
  });
});

describe('mergeGraphs', () => {
  it('collapses nodes sharing an identity and sets multiSource', () => {
    const graphs: any = [
      {
        source: 'purview',
        nodes: [{ node: { id: 'G1', label: 'main.bronze.customers', type: 'databricks_table', source: 'purview', focus: true }, identities: ['guid:g1', 'uc:main.bronze.customers'] }],
        edges: [],
      },
      {
        source: 'unity-catalog',
        nodes: [{ node: { id: 'main.bronze.customers', label: 'customers', type: 'table', source: 'unity-catalog', focus: true }, identities: ['uc:main.bronze.customers'] }],
        edges: [],
      },
    ];
    const { nodes } = mergeGraphs(graphs);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].multiSource).toEqual(['purview', 'unity-catalog']);
    // Prefers the non-guid label.
    expect(nodes[0].label).toBe('main.bronze.customers');
  });

  it('keeps distinct assets separate and rewrites edges onto canonical ids', () => {
    const graphs: any = [
      {
        source: 'unity-catalog',
        nodes: [
          { node: { id: 'main.bronze.raw', label: 'raw', type: 'table', source: 'unity-catalog' }, identities: ['uc:main.bronze.raw'] },
          { node: { id: 'main.bronze.customers', label: 'customers', type: 'table', source: 'unity-catalog', focus: true }, identities: ['uc:main.bronze.customers'] },
        ],
        edges: [{ from: 'main.bronze.raw', to: 'main.bronze.customers' }],
      },
      {
        source: 'purview',
        nodes: [{ node: { id: 'G1', label: 'customers', type: 'databricks_table', source: 'purview', focus: true }, identities: ['guid:g1', 'uc:main.bronze.customers'] }],
        edges: [],
      },
    ];
    const { nodes, edges } = mergeGraphs(graphs);
    // raw + merged-customers = 2 nodes.
    expect(nodes).toHaveLength(2);
    const merged = nodes.find((n) => n.multiSource);
    expect(merged?.multiSource).toEqual(['purview', 'unity-catalog']);
    // Edge target rewritten to the canonical id of the merged customers node.
    expect(edges).toHaveLength(1);
    expect(edges[0].from).toBe('main.bronze.raw');
    expect(edges[0].to).toBe(merged?.id);
  });

  it('drops self-loops created by the collapse', () => {
    const graphs: any = [
      {
        source: 'unity-catalog',
        nodes: [
          { node: { id: 'a', label: 'a', source: 'unity-catalog' }, identities: ['uc:a'] },
          { node: { id: 'b', label: 'b', source: 'unity-catalog' }, identities: ['uc:shared'] },
        ],
        edges: [{ from: 'a', to: 'b' }],
      },
      {
        source: 'purview',
        nodes: [{ node: { id: 'a2', label: 'a', source: 'purview' }, identities: ['uc:shared'] }],
        edges: [{ from: 'a2', to: 'a2' }],
      },
    ];
    // a and (b,a2) — but a only shares uc:a; b & a2 share uc:shared.
    const { nodes, edges } = mergeGraphs(graphs);
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1); // a -> merged(b,a2); the a2->a2 self-loop dropped
  });
});

describe('getUnifiedLineage', () => {
  it('merges Purview + Unity Catalog focus nodes via the shared identity', async () => {
    mocks.getLineageSubgraph.mockResolvedValue({
      baseEntityGuid: 'G1',
      guidEntityMap: { G1: { guid: 'G1', displayText: 'main.bronze.customers', typeName: 'databricks_table' } },
      relations: [],
    });
    mocks.getTableLineage.mockResolvedValue([
      { source: 'main.bronze.raw', target: 'main.bronze.customers' },
    ]);

    const res = await getUnifiedLineage({
      session,
      purviewGuid: 'G1',
      ucFullName: 'main.bronze.customers',
    });

    expect(res.ok).toBe(true);
    const okSources = res.sources.filter((s) => s.ok).map((s) => s.source).sort();
    expect(okSources).toEqual(['purview', 'unity-catalog', 'weave']);
    const merged = res.nodes.find((n) => n.multiSource);
    expect(merged?.multiSource).toEqual(['purview', 'unity-catalog']);
    // raw upstream + merged focus.
    expect(res.nodes.length).toBe(2);
  });

  it('degrades a Unity Catalog gate into sources[] without failing the request', async () => {
    mocks.getLineageSubgraph.mockResolvedValue({
      baseEntityGuid: 'G1', guidEntityMap: { G1: { guid: 'G1', displayText: 'x', typeName: 't' } }, relations: [],
    });
    mocks.listWorkspaceHostnames.mockImplementation(() => {
      throw new H.UnityCatalogNotConfiguredError({ missingEnvVar: 'LOOM_DATABRICKS_HOSTNAMES' });
    });

    const res = await getUnifiedLineage({ session, purviewGuid: 'G1', ucFullName: 'main.b.c' });
    expect(res.ok).toBe(true);
    const uc = res.sources.find((s) => s.source === 'unity-catalog');
    expect(uc?.ok).toBe(false);
    expect(uc?.gate).toContain('LOOM_DATABRICKS_HOSTNAMES');
    // Purview still contributed.
    expect(res.sources.find((s) => s.source === 'purview')?.ok).toBe(true);
  });

  it('reports a Purview honest gate when LOOM_PURVIEW_ACCOUNT is unset', async () => {
    mocks.isPurviewConfigured.mockReturnValue(false);
    const res = await getUnifiedLineage({ session, purviewGuid: 'G1', ucFullName: 'main.b.c' });
    mocks.getTableLineage.mockResolvedValue([]);
    const pv = res.sources.find((s) => s.source === 'purview');
    expect(pv?.ok).toBe(false);
    expect(pv?.gate).toContain('LOOM_PURVIEW_ACCOUNT');
  });

  it('builds the Weave subgraph from thread edges around the focus item', async () => {
    mocks.listThreadEdges.mockResolvedValue([
      { id: 'e1', fromItemId: 'lake1', fromType: 'lakehouse', toItemId: 'nb1', toType: 'notebook', action: 'analyze-in-notebook', createdAt: 'now' },
      { id: 'e2', fromItemId: 'nb1', fromType: 'notebook', toItemId: 'pbi1', toType: 'powerbi-model', action: 'build-powerbi-model', createdAt: 'now', toExternal: true, toLink: 'https://app' },
    ] as any);
    const res = await getUnifiedLineage({ session, itemId: 'lake1', itemType: 'lakehouse' });
    expect(res.sources.find((s) => s.source === 'weave')?.ok).toBe(true);
    // lake1 -> nb1 -> pbi1 reachable within default depth.
    const ids = res.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['lake1', 'nb1', 'pbi1']);
    expect(res.edges).toHaveLength(2);
  });

  it('uses the system-tables path (entity nodes) when a lineage warehouse is set', async () => {
    mocks.isPurviewConfigured.mockReturnValue(false);
    mocks.lineageWarehouseId.mockReturnValue('wh-1');
    mocks.getTableLineageSystemTables.mockResolvedValue({
      edges: [{ source: 'main.bronze.raw', target: 'main.bronze.customers' }],
      entities: [{ entityType: 'NOTEBOOK', entityId: 'nb-123', target: 'main.bronze.customers', source: 'main.bronze.raw' }],
    });
    const res = await getUnifiedLineage({ session, ucFullName: 'main.bronze.customers' });
    expect(mocks.getTableLineageSystemTables).toHaveBeenCalled();
    expect(mocks.getTableLineage).not.toHaveBeenCalled();
    // A notebook entity node is present (the producing process).
    expect(res.nodes.some((n) => n.type === 'notebook')).toBe(true);
  });
});
