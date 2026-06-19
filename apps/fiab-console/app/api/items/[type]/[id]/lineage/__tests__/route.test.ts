/**
 * Unit tests for /api/items/[type]/[id]/lineage BFF route.
 *
 * The route now delegates to the UNIFIED lineage service (audit-t138): it
 * resolves per-cloud focus keys and overlays Unity Catalog + Purview + Weave.
 * Asserts:
 *   1. unauthenticated → 401
 *   2. Commercial/GCC → Unity Catalog primary; a real upstream edge maps to a
 *      graph edge; backend='unity-catalog'
 *   3. Unity Catalog not configured → NOT fatal: the request still returns 200
 *      with the focus node, and the UC gate is reported in sources[] (graceful
 *      degradation per no-vaporware.md — the other sources still render)
 *   4. GCC-High → Purview Atlas relationships; backend='purview'
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Fully mock the client modules (no importActual) so the real `@azure/identity`
// ESM graph they import at top-level is never loaded under vitest. Stub error
// classes are created via vi.hoisted so they exist before the hoisted vi.mock
// factories run, and are shared with the route (mocked import) so the route's
// `instanceof` checks resolve correctly.
const H = vi.hoisted(() => {
  class UnityCatalogNotConfiguredError extends Error {
    hint: any;
    constructor(hint: any) {
      super(`UC not configured: ${hint?.missingEnvVar}`);
      this.hint = hint;
    }
  }
  class UnityCatalogError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  class PurviewNotConfiguredError extends Error {
    hint: any;
    constructor(hint: any) {
      super('Purview not configured');
      this.hint = hint;
    }
  }
  class PurviewError extends Error {
    status: number;
    constructor(status: number) {
      super('purview error');
      this.status = status;
    }
  }
  return { UnityCatalogNotConfiguredError, UnityCatalogError, PurviewNotConfiguredError, PurviewError };
});

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({ ...(await importOriginal() as any), detectLoomCloud: vi.fn(), isGovCloud: vi.fn() }));
vi.mock('@/lib/azure/unity-catalog-client', () => ({
  getTableLineage: vi.fn(),
  getTableLineageSystemTables: vi.fn(),
  lineageWarehouseId: vi.fn(() => null),
  listWorkspaceHostnames: vi.fn(),
  UnityCatalogNotConfiguredError: H.UnityCatalogNotConfiguredError,
  UnityCatalogError: H.UnityCatalogError,
}));
vi.mock('@/lib/azure/purview-client', () => ({
  getLineageSubgraph: vi.fn(),
  isPurviewConfigured: vi.fn(() => true),
  PurviewNotConfiguredError: H.PurviewNotConfiguredError,
  PurviewError: H.PurviewError,
}));
vi.mock('@/lib/thread/thread-edges', () => ({ listThreadEdges: vi.fn(async () => []) }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
  workspacesContainer: vi.fn(async () => ({
    item: () => ({ read: async () => ({ resource: null }) }),
  })),
}));

import { GET } from '../route';
import { getSession } from '@/lib/auth/session';
import { detectLoomCloud } from '@/lib/azure/cloud-endpoints';
import {
  getTableLineage,
  listWorkspaceHostnames,
  lineageWarehouseId,
} from '@/lib/azure/unity-catalog-client';
import { getLineageSubgraph, isPurviewConfigured } from '@/lib/azure/purview-client';
import { listThreadEdges } from '@/lib/thread/thread-edges';

function call(url: string, type = 'lakehouse', id = 'cat.sch.tbl') {
  const u = new URL(url);
  const req = { nextUrl: u, url } as any;
  return GET(req, { params: Promise.resolve({ type, id }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  (lineageWarehouseId as any).mockReturnValue(null);
  (isPurviewConfigured as any).mockReturnValue(true);
  (listThreadEdges as any).mockResolvedValue([]);
});

describe('GET /api/items/[type]/[id]/lineage', () => {
  it('returns 401 when no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await call('http://x/api/items/lakehouse/cat.sch.tbl/lineage');
    expect(res.status).toBe(401);
  });

  it('Commercial → Unity Catalog: a real upstream edge renders a lineage edge', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (detectLoomCloud as any).mockReturnValue('Commercial');
    (isPurviewConfigured as any).mockReturnValue(false); // no Purview overlay this test
    (listWorkspaceHostnames as any).mockReturnValue(['adb-123.azuredatabricks.net']);
    (getTableLineage as any).mockResolvedValue([
      { source: 'up.sch.tbl', target: 'cat.sch.tbl', workspace_hostname: 'adb-123.azuredatabricks.net' },
    ]);

    const res = await call('http://x/api/items/lakehouse/cat.sch.tbl/lineage?key=cat.sch.tbl');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('unity-catalog');
    expect(j.focusId).toBe('cat.sch.tbl');
    expect(j.edges).toEqual([{ from: 'up.sch.tbl', to: 'cat.sch.tbl' }]);
    const ids = j.nodes.map((n: any) => n.id).sort();
    expect(ids).toEqual(['cat.sch.tbl', 'up.sch.tbl']);
    expect(getTableLineage).toHaveBeenCalledWith('adb-123.azuredatabricks.net', 'cat.sch.tbl');
  });

  it('Unity Catalog not configured → graceful: 200 with focus node + UC gate in sources[]', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (detectLoomCloud as any).mockReturnValue('Commercial');
    (isPurviewConfigured as any).mockReturnValue(false);
    (listWorkspaceHostnames as any).mockImplementation(() => {
      throw new H.UnityCatalogNotConfiguredError({
        missingEnvVar: 'LOOM_DATABRICKS_HOSTNAMES (or LOOM_DATABRICKS_HOSTNAME)',
        bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep (catalog dispatcher)',
        bicepStatus: 'x',
        followUp: 'Set LOOM_DATABRICKS_HOSTNAMES on the Console Container App.',
      });
    });

    const res = await call('http://x/api/items/lakehouse/cat.sch.tbl/lineage?key=cat.sch.tbl');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    const uc = j.sources.find((s: any) => s.source === 'unity-catalog');
    expect(uc.ok).toBe(false);
    expect(uc.gate).toContain('LOOM_DATABRICKS_HOSTNAMES');
    // The focus node still renders (Weave focus) — never an empty graph.
    expect(j.nodes.length).toBeGreaterThanOrEqual(1);
  });

  it('GCC-High → Purview Atlas relationships', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (detectLoomCloud as any).mockReturnValue('GCC-High');
    (isPurviewConfigured as any).mockReturnValue(true);
    (getLineageSubgraph as any).mockResolvedValue({
      baseEntityGuid: 'g-focus',
      guidEntityMap: {
        'g-focus': { guid: 'g-focus', displayText: 'orders', typeName: 'azure_sql_table' },
        'g-up': { guid: 'g-up', displayText: 'raw_orders', typeName: 'azure_sql_table' },
      },
      relations: [{ fromEntityId: 'g-up', toEntityId: 'g-focus', relationshipType: 'process' }],
    });

    const res = await call('http://x/api/items/warehouse/g-focus/lineage', 'warehouse', 'g-focus');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('purview');
    expect(j.focusId).toBe('g-focus');
    expect(j.edges).toEqual([{ from: 'g-up', to: 'g-focus', type: 'process' }]);
    expect(j.nodes).toHaveLength(2);
    expect(j.nodes.every((n: any) => n.source === 'purview')).toBe(true);
  });
});
