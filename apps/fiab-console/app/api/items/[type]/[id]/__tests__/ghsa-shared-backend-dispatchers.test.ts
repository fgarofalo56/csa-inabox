/**
 * GHSA-v2g8-gp3r-rg4r (round 3) — route-level proof for the shared-backend
 * DISPATCHERS: the Databricks / Unity Catalog surfaces and the shared Azure
 * Analysis Services tabular database.
 *
 * WHAT SHIPPED:
 *   `databricks-sql-warehouse/[id]/ctas`  POST(req) — no ctx. `CREATE TABLE
 *       <caller catalog>.<caller schema>.<caller table> USING DELTA AS <caller
 *       SELECT>` on the shared Databricks workspace, as the Console identity.
 *       The `^select` check bounds the STATEMENT SHAPE only.
 *   `[type]/[id]/optimize`   getSession only; `[id]` never read. OPTIMIZE
 *       physically rewrites a caller-named Delta table's files (+ ZORDER).
 *   `[type]/[id]/statistics` getSession only; `[id]` never read. CREATE /
 *       UPDATE / DROP STATISTICS on the shared Synapse pool, or ANALYZE TABLE
 *       on Unity Catalog.
 *   `semantic-model/[id]/refresh-policy`  withSession — session, no item authz,
 *       on a route whose own header says "`[id]` is the model". The AAS server
 *       AND database are env-pinned, so every model shares ONE tabular database
 *       and `tableName` came from the body into a TMSL Alter + a TMSL Refresh
 *       that REBUILDS the table's partitions.
 *
 * WHAT THIS SUITE PROVES: Layer 1 on all four — a denied caller reaches no
 * backend, the mutating verbs guard write-scoped and the read verbs read-scoped,
 * and an id naming no item fails closed rather than falling through.
 *
 * WHAT IT DOES NOT PROVE, because it is not true: that `catalog.schema.table`
 * (Unity Catalog), `warehouseId` (Databricks compute) or `tableName` (AAS) is
 * BOUND. None of the three has an item binding in this tree. Layer 1 is a FLOOR
 * on these routes, not a bound, and the residual is asserted at the bottom of
 * this file rather than left to be inferred from a green suite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION, tenantScopeId: () => 'tid-1' }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

const DBX_ITEM: any = {
  id: 'sw-1', itemType: 'databricks-sql-warehouse', workspaceId: 'ws-1', displayName: 'SQL WH', state: {},
};
const SM_ITEM: any = {
  id: 'sm-1', itemType: 'semantic-model', workspaceId: 'ws-1', displayName: 'Sales model', state: {},
};

const cosmos = vi.hoisted(() => ({ byId: [] as any[], byWorkspace: [] as any[] }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => ({
          resources: String(spec?.query || '').includes('c.workspaceId')
            ? cosmos.byWorkspace
            : cosmos.byId,
        }),
      }),
    },
  }),
}));

const dbx = vi.hoisted(() => ({
  databricksConfigGate: vi.fn(() => null as any),
  executeStatement: vi.fn(async () => ({ columns: [], rows: [], executionMs: 12 })),
  getWarehouse: vi.fn(async () => ({ id: 'wh-abc', state: 'RUNNING' })),
}));
vi.mock('@/lib/azure/databricks-client', () => dbx);

const synapse = vi.hoisted(() => ({
  dedicatedTarget: vi.fn(() => ({ server: 's', database: 'dwhpool01', cacheKey: 'k' })),
  executeQuery: vi.fn(async () => ({
    columns: ['n'], rows: [['x']], rowCount: 1, executionMs: 3,
    truncated: false, messages: [], recordsAffected: 1,
  })),
}));
vi.mock('@/lib/azure/synapse-sql-client', () => synapse);

vi.mock('@/lib/azure/adls-client', () => ({
  countParquetFiles: vi.fn(async () => ({ count: 3 })),
  getAccountName: vi.fn(() => 'stlake'),
}));

const aas = vi.hoisted(() => {
  class FakeAasError extends Error { status = 502; }
  return {
    AasError: FakeAasError,
    aasConfigGate: vi.fn(() => null as any),
    setIncrementalRefreshPolicy: vi.fn(async () => undefined),
    applyRefreshPolicy: vi.fn(async () => undefined),
    listPartitions: vi.fn(async () => [{ name: 'p1' }]),
  };
});
vi.mock('@/lib/azure/aas-incremental-refresh', () => aas);

import { POST as ctasPOST } from '../../../databricks-sql-warehouse/[id]/ctas/route';
import { POST as optimizePOST } from '../optimize/route';
import { GET as statsGET, POST as statsPOST } from '../statistics/route';
import { GET as rpGET, PUT as rpPUT } from '../../../semantic-model/[id]/refresh-policy/route';

const dbxCtx = { params: Promise.resolve({ id: 'sw-1' }) } as any;
const typedCtx = { params: Promise.resolve({ type: 'databricks-sql-warehouse', id: 'sw-1' }) } as any;
const smCtx = { params: Promise.resolve({ id: 'sm-1' }) } as any;

function req(body: any = {}, query: Record<string, string> = {}) {
  const url = new URL('http://x/');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}

const CTAS_BODY = { warehouseId: 'wh-abc', catalog: 'main', schema: 'sales', tableName: 't', sql: 'SELECT 1' };
const OPT_BODY = { warehouseId: 'wh-abc', catalog: 'main', schema: 'sales', tableName: 't' };
const STATS_BODY = { action: 'analyze', schema: 'sales', table: 't', catalog: 'main', warehouseId: 'wh-abc' };
const RP_BODY = {
  tableName: 'FactSales',
  policy: {
    rollingWindowGranularity: 'year', rollingWindowPeriods: 5,
    incrementalGranularity: 'day', incrementalPeriods: 10,
  },
};

const DBX_GUARD = {
  workspaceId: null, itemId: 'sw-1', itemType: 'databricks-sql-warehouse',
  notFound: 'databricks sql warehouse not found',
};
const TYPED_GUARD = { workspaceId: null, itemId: 'sw-1', itemType: 'databricks-sql-warehouse', notFound: 'item not found' };
const SM_GUARD = { workspaceId: null, itemId: 'sm-1', itemType: 'semantic-model', notFound: 'semantic model not found' };

async function denyAll() {
  const { NextResponse } = await import('next/server');
  guard.authorizeItemWorkspace.mockResolvedValue(
    NextResponse.json({ ok: false, error: 'not found' }, { status: 404 }) as any,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  dbx.databricksConfigGate.mockReturnValue(null as any);
  dbx.getWarehouse.mockResolvedValue({ id: 'wh-abc', state: 'RUNNING' } as any);
  dbx.executeStatement.mockResolvedValue({ columns: [], rows: [], executionMs: 12 } as any);
  aas.aasConfigGate.mockReturnValue(null as any);
  aas.listPartitions.mockResolvedValue([{ name: 'p1' }] as any);
  process.env.LOOM_SEMANTIC_BACKEND = 'analysis-services';
  cosmos.byId = [DBX_ITEM, SM_ITEM];
  cosmos.byWorkspace = [DBX_ITEM, SM_ITEM];
});

// ── LAYER 1 — a denied caller reaches no backend ───────────────────────────

describe('layer 1 — denial', () => {
  it('ctas / optimize / statistics (both verbs) never reach Databricks or Synapse', async () => {
    await denyAll();
    expect((await ctasPOST(req(CTAS_BODY), dbxCtx)).status).toBe(404);
    expect((await optimizePOST(req(OPT_BODY), typedCtx)).status).toBe(404);
    expect((await statsGET(req({}, { schema: 'sales', table: 't' }), typedCtx)).status).toBe(404);
    expect((await statsPOST(req(STATS_BODY), typedCtx)).status).toBe(404);

    expect(dbx.executeStatement).not.toHaveBeenCalled();
    expect(dbx.getWarehouse).not.toHaveBeenCalled();
    expect(synapse.executeQuery).not.toHaveBeenCalled();
  });

  it('refresh-policy never reaches AAS — no TMSL Alter, no partition rebuild', async () => {
    await denyAll();
    expect((await rpGET(req(), smCtx)).status).toBe(404);
    expect((await rpPUT(req(RP_BODY), smCtx)).status).toBe(404);

    expect(aas.setIncrementalRefreshPolicy).not.toHaveBeenCalled();
    expect(aas.applyRefreshPolicy).not.toHaveBeenCalled();
    expect(aas.listPartitions).not.toHaveBeenCalled();
  });

  it('the guard runs BEFORE the config gate — a denial is not disclosed as "not configured"', async () => {
    // Ordering matters for disclosure: a 503 naming LOOM_* env vars to an
    // unauthorized caller is an estate-configuration leak, and it also masks
    // the denial from anyone reading logs.
    await denyAll();
    dbx.databricksConfigGate.mockReturnValue({ missing: 'LOOM_DATABRICKS_HOST' } as any);
    aas.aasConfigGate.mockReturnValue({ missing: 'LOOM_AAS_XMLA_ENDPOINT' } as any);
    expect((await ctasPOST(req(CTAS_BODY), dbxCtx)).status).toBe(404);
    expect((await rpPUT(req(RP_BODY), smCtx)).status).toBe(404);
  });

  it('an id naming no item is refused, not fallen through', async () => {
    cosmos.byId = [];
    expect((await ctasPOST(req(CTAS_BODY), dbxCtx)).status).toBe(404);
    expect((await optimizePOST(req(OPT_BODY), typedCtx)).status).toBe(404);
    expect((await statsPOST(req(STATS_BODY), typedCtx)).status).toBe(404);
    expect((await rpPUT(req(RP_BODY), smCtx)).status).toBe(404);
    expect(dbx.executeStatement).not.toHaveBeenCalled();
    expect(aas.setIncrementalRefreshPolicy).not.toHaveBeenCalled();
  });
});

describe('layer 1 — write vs read scope', () => {
  it('ctas / optimize / statistics POST / refresh-policy PUT carry NO allowReadRoles', async () => {
    await ctasPOST(req(CTAS_BODY), dbxCtx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, DBX_GUARD);

    vi.clearAllMocks(); guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await optimizePOST(req(OPT_BODY), typedCtx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, TYPED_GUARD);

    vi.clearAllMocks(); guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await statsPOST(req(STATS_BODY), typedCtx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, TYPED_GUARD);

    vi.clearAllMocks(); guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await rpPUT(req(RP_BODY), smCtx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, SM_GUARD);
  });

  it('statistics GET and refresh-policy GET admit shared read roles', async () => {
    await statsGET(req({}, { schema: 'sales', table: 't' }), typedCtx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, { ...TYPED_GUARD, allowReadRoles: true });

    vi.clearAllMocks(); guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await rpGET(req(), smCtx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, { ...SM_GUARD, allowReadRoles: true });
  });
});

// ── The legitimate owner is NOT refused ────────────────────────────────────

describe('a legitimate owner still succeeds', () => {
  it('ctas runs the real CREATE TABLE … USING DELTA', async () => {
    const res = await ctasPOST(req(CTAS_BODY), dbxCtx);
    expect(res.status).toBe(200);
    expect((await res.json()).table).toBe('main.sales.t');
    expect(dbx.executeStatement).toHaveBeenCalled();
    expect(String(dbx.executeStatement.mock.calls[0][1])).toMatch(/CREATE TABLE `main`\.`sales`\.`t` USING DELTA/);
  });

  it('optimize runs the real OPTIMIZE', async () => {
    const res = await optimizePOST(req(OPT_BODY), typedCtx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.engine).toBe('databricks');
    expect(dbx.executeStatement).toHaveBeenCalled();
  });

  it('statistics ANALYZE runs, and its GET lists columns', async () => {
    const p = await statsPOST(req(STATS_BODY), typedCtx);
    expect(p.status).toBe(200);
    expect(dbx.executeStatement).toHaveBeenCalled();

    const g = await statsGET(req({}, { schema: 'sales', table: 't' }), typedCtx);
    expect(g.status).toBe(200);
  });

  it('refresh-policy applies the real TMSL Alter + Refresh and returns partitions', async () => {
    const res = await rpPUT(req(RP_BODY), smCtx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.partitions).toEqual([{ name: 'p1' }]);
    expect(aas.setIncrementalRefreshPolicy).toHaveBeenCalledWith('FactSales', RP_BODY.policy);
    expect(aas.applyRefreshPolicy).toHaveBeenCalled();
  });

  it('refresh-policy still honest-gates when the backend is not selected', async () => {
    process.env.LOOM_SEMANTIC_BACKEND = 'loom-native';
    const res = await rpGET(req(), smCtx);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/LOOM_SEMANTIC_BACKEND=analysis-services/);
  });
});

// ── THE RESIDUAL, ASSERTED ─────────────────────────────────────────────────

describe('RESIDUAL: the data coordinates are NOT bound', () => {
  /**
   * Made visible on purpose. If a later change binds `catalog.schema` or
   * `warehouseId` or `tableName`, THESE are the tests that must fail, and their
   * replacements are the receipt. A green suite that silently stopped covering
   * the gap is the failure mode this whole advisory is about.
   */
  it('an authorized SQL-warehouse owner can still CTAS into another catalog/schema', async () => {
    const res = await ctasPOST(
      req({ ...CTAS_BODY, catalog: 'tenantB', schema: 'private', sql: 'SELECT * FROM tenantB.private.payroll' }),
      dbxCtx,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).table).toBe('tenantB.private.t');
  });

  it('…and can still drive a warehouseId this item does not own', async () => {
    await ctasPOST(req({ ...CTAS_BODY, warehouseId: 'someone-elses-warehouse' }), dbxCtx);
    expect(dbx.getWarehouse).toHaveBeenCalledWith('someone-elses-warehouse');
  });

  it('an authorized semantic-model owner can still rewrite another model’s table policy', async () => {
    const res = await rpPUT(req({ ...RP_BODY, tableName: 'SomeOtherModelsTable' }), smCtx);
    expect(res.status).toBe(200);
    expect(aas.setIncrementalRefreshPolicy).toHaveBeenCalledWith('SomeOtherModelsTable', RP_BODY.policy);
  });
});
