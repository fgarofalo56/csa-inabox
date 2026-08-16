/**
 * GHSA-v2g8-gp3r-rg4r (round 3) — route-level proof for the SHARED Synapse SQL
 * estate: the `warehouse` and `synapse-dedicated-sql-pool` families both sit on
 * ONE env-pinned dedicated pool (`LOOM_SYNAPSE_DEDICATED_POOL`) reached as the
 * Console UAMI, with no OBO on the default path.
 *
 * WHAT SHIPPED, per route:
 *   `warehouse/[id]/clone`            POST(req) — no ctx. `CREATE TABLE <caller
 *                                     target> AS SELECT * FROM <caller source>`.
 *   `synapse-dedicated-sql-pool/[id]/clone`
 *                                     POST(req) — no ctx. `SELECT * INTO …`.
 *   `warehouse/[id]/copy-into`        withSession — session, no item authz.
 *                                     `COPY INTO <caller target>`.
 *   `warehouse/[id]/query`            withSession — `params.id` read ONLY to tag
 *                                     a FinOps receipt. `body.database`
 *                                     re-pointed the TDS connection.
 *   `synapse-dedicated-sql-pool/[id]/query`
 *                                     getSession only; `[id]` read only to pick
 *                                     an accessMode. Same `body.database`.
 *   `warehouse/[id]/schema`           GET(req) — no ctx. Enumerated the pool AND
 *                                     every database on the SQL server.
 *   `warehouse/[id]/script-out`       GET(req) — no ctx. Any object's verbatim
 *                                     OBJECT_DEFINITION.
 *
 * WHAT THIS SUITE PROVES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 *   PROVED — Layer 1 on every route (a denied caller reaches no backend; the
 *   write routes guard write-scoped, the read routes read-scoped; an id naming
 *   no item fails closed rather than falling through), and Layer 2 on the
 *   `database` coordinate (a caller-named database outside the item's workspace
 *   is refused 403 and never reaches TDS; the picker that feeds it offers
 *   exactly the same set).
 *
 *   NOT PROVED, BECAUSE IT IS NOT TRUE — that the `schema.table` coordinate is
 *   bound. It is not. The shared pool records no item→schema ownership anywhere
 *   in the estate, so on `clone` / `copy-into` / `script-out` / the in-database
 *   half of `schema`, Layer 1 is a FLOOR (any signed-in user → a caller who owns
 *   any warehouse item, which is self-service) and NOT a bound. There is a test
 *   below that ASSERTS that residual explicitly rather than leaving a reader to
 *   infer coverage from a passing suite.
 *
 * MUTATION PROOF — the PR body carries the per-mutation verdicts. Every
 * mutation DELETES a control rather than substituting an equal value: #3614's
 * M1 was inert precisely because `requested === scoped.database` on every
 * admitted path, so a substitution proved nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({
  getSession: () => SESSION,
  tenantScopeId: () => 'tid-1',
}));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

/** The env-pinned shared pool — what every item resolves to by default. */
const POOL_DB = 'dwhpool01';
/** A second database on the SAME Synapse SQL server, bound to a sibling item. */
const SIBLING_DB = 'ws1_mart';
/** Another tenant's database on the same server. Exists; is not ours. */
const VICTIM_DB = 'tenantB_dw';

process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-loom';
process.env.LOOM_SYNAPSE_DEDICATED_POOL = POOL_DB;

const WH_ITEM: any = {
  id: 'wh-1', itemType: 'warehouse', workspaceId: 'ws-1', displayName: 'Sales DW',
  state: { provisioning: { status: 'created', secondaryIds: { backend: 'synapse-dedicated', database: POOL_DB } } },
};
const POOL_ITEM: any = {
  id: 'dp-1', itemType: 'synapse-dedicated-sql-pool', workspaceId: 'ws-1', displayName: 'Pool',
  state: {},
};
const SIBLING_ITEM: any = {
  id: 'wh-2', itemType: 'warehouse', workspaceId: 'ws-1', displayName: 'Mart',
  state: { database: SIBLING_DB },
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

const synapse = vi.hoisted(() => ({
  dedicatedTarget: vi.fn(() => ({
    server: 'syn-loom.sql.azuresynapse.net', database: 'dwhpool01', cacheKey: 'dedicated:syn-loom:dwhpool01',
  })),
  serverlessTarget: vi.fn(),
  executeQuery: vi.fn(async () => ({
    columns: ['name'], rows: [['x']], rowCount: 1, executionMs: 5,
    truncated: false, messages: [], recordsAffected: 1,
  })),
  executeQueryAsUser: vi.fn(async () => ({
    columns: [], rows: [], rowCount: 0, executionMs: 1, truncated: false, messages: [], recordsAffected: 0,
  })),
}));
vi.mock('@/lib/azure/synapse-sql-client', () => synapse);

const poolArm = vi.hoisted(() => ({
  getPoolState: vi.fn(async () => ({ state: 'Online', sku: 'DW100c' })),
  resumePool: vi.fn(),
}));
vi.mock('@/lib/azure/synapse-pool-arm', () => poolArm);

const scripting = vi.hoisted(() => ({
  enumerateSqlObjects: vi.fn(async () => ({ views: [], procedures: [], functions: [], warnings: [] })),
  scriptOutSqlObject: vi.fn(async () => ({ ok: true, script: 'CREATE VIEW …' })),
  asScriptObjectType: (v: unknown) => (v === 'view' ? 'view' : null),
  asScriptMode: (v: unknown) => (v === 'create' ? 'create' : null),
}));
vi.mock('@/lib/azure/sql-object-scripting', () => scripting);

const adls = vi.hoisted(() => ({
  KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing'],
  listPaths: vi.fn(async () => [{ name: 'f.csv', isDirectory: false, size: 10 }]),
  getAccountName: vi.fn(() => 'stloomlake'),
  countParquetFiles: vi.fn(async () => ({ count: 3 })),
}));
vi.mock('@/lib/azure/adls-client', () => adls);

vi.mock('@/lib/azure/delta-history', () => ({
  cleanTablePath: (p: string) => p,
  isKnownContainer: (c: string) => ['bronze', 'silver', 'gold', 'landing'].includes(c),
}));

vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: () => ({ missing: 'LOOM_DATABRICKS_HOST' }),
  listWarehouses: vi.fn(async () => []),
  executeStatement: vi.fn(async () => ({ columns: [], rows: [], executionMs: 1 })),
  getWarehouse: vi.fn(async () => ({ id: 'w', state: 'RUNNING' })),
}));

const rateLimit = vi.hoisted(() => ({ enforceRateLimit: vi.fn(async () => null as any) }));
vi.mock('@/lib/azure/rate-limiter', () => rateLimit);
vi.mock('@/lib/finops/query-run', () => ({ recordQueryRun: vi.fn(async () => undefined) }));
vi.mock('@/lib/azure/sql-access-mode', () => ({ resolveAccessMode: vi.fn(async () => 'service') }));
vi.mock('@/lib/azure/sql-user-token-store', () => ({ getUserSqlToken: vi.fn(async () => null) }));

import { POST as whClonePOST } from '../clone/route';
import { GET as copyGET, POST as copyPOST } from '../copy-into/route';
import { POST as whQueryPOST } from '../query/route';
import { GET as whSchemaGET } from '../schema/route';
import { GET as whScriptGET } from '../script-out/route';
import { POST as dpClonePOST } from '../../../synapse-dedicated-sql-pool/[id]/clone/route';
import { POST as dpQueryPOST } from '../../../synapse-dedicated-sql-pool/[id]/query/route';

const whCtx = { params: Promise.resolve({ id: 'wh-1' }) } as any;
const dpCtx = { params: Promise.resolve({ id: 'dp-1' }) } as any;

function req(body: any = {}, query: Record<string, string> = {}) {
  const url = new URL('http://x/');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}

const CLONE_BODY = { sourceSchema: 'gold', sourceTable: 'fact_sales', targetSchema: 'dbo', targetTable: 'copy' };
const COPY_BODY = { targetSchema: 'dbo', targetTable: 'landing', container: 'bronze', sourcePath: 'a/b.csv' };

const WH_WRITE_GUARD = { workspaceId: null, itemId: 'wh-1', itemType: 'warehouse', notFound: 'warehouse not found' };
const DP_WRITE_GUARD = {
  workspaceId: null, itemId: 'dp-1', itemType: 'synapse-dedicated-sql-pool',
  notFound: 'dedicated SQL pool not found',
};

async function denyAll() {
  const { NextResponse } = await import('next/server');
  guard.authorizeItemWorkspace.mockResolvedValue(
    NextResponse.json({ ok: false, error: 'not found' }, { status: 404 }) as any,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  rateLimit.enforceRateLimit.mockResolvedValue(null as any);
  poolArm.getPoolState.mockResolvedValue({ state: 'Online', sku: 'DW100c' } as any);
  synapse.dedicatedTarget.mockReturnValue({
    server: 'syn-loom.sql.azuresynapse.net', database: POOL_DB, cacheKey: `dedicated:syn-loom:${POOL_DB}`,
  } as any);
  synapse.executeQuery.mockResolvedValue({
    columns: ['name'], rows: [[POOL_DB], [SIBLING_DB], [VICTIM_DB]], rowCount: 3, executionMs: 5,
    truncated: false, messages: [], recordsAffected: 1,
  } as any);
  scripting.scriptOutSqlObject.mockResolvedValue({ ok: true, script: 'CREATE VIEW …' } as any);
  cosmos.byId = [WH_ITEM, POOL_ITEM];
  cosmos.byWorkspace = [WH_ITEM, POOL_ITEM, SIBLING_ITEM];
});

// ── LAYER 1 — the caller is authorized against the item ─────────────────────

describe('layer 1 — a denied caller reaches no backend', () => {
  it('warehouse clone / copy-into (both verbs) / query / schema / script-out', async () => {
    await denyAll();
    expect((await whClonePOST(req(CLONE_BODY), whCtx)).status).toBe(404);
    expect((await copyGET(req({}, { container: 'bronze' }), whCtx)).status).toBe(404);
    expect((await copyPOST(req(COPY_BODY), whCtx)).status).toBe(404);
    expect((await whQueryPOST(req({ sql: 'SELECT 1' }), whCtx)).status).toBe(404);
    expect((await whSchemaGET(req(), whCtx)).status).toBe(404);
    expect((await whScriptGET(req({}, { schema: 'gold', name: 'v', type: 'view', mode: 'create' }), whCtx)).status).toBe(404);

    expect(synapse.executeQuery).not.toHaveBeenCalled();
    expect(scripting.scriptOutSqlObject).not.toHaveBeenCalled();
    expect(scripting.enumerateSqlObjects).not.toHaveBeenCalled();
    expect(adls.listPaths).not.toHaveBeenCalled();
  });

  it('dedicated-pool clone / query', async () => {
    await denyAll();
    expect((await dpClonePOST(req(CLONE_BODY), dpCtx)).status).toBe(404);
    expect((await dpQueryPOST(req({ sql: 'SELECT 1' }), dpCtx)).status).toBe(404);
    expect(synapse.executeQuery).not.toHaveBeenCalled();
    expect(synapse.executeQueryAsUser).not.toHaveBeenCalled();
  });

  it('an id naming no item is refused, not fallen through to TDS', async () => {
    cosmos.byId = [];
    expect((await whClonePOST(req(CLONE_BODY), whCtx)).status).toBe(404);
    expect((await whQueryPOST(req({ sql: 'SELECT 1' }), whCtx)).status).toBe(404);
    expect((await dpClonePOST(req(CLONE_BODY), dpCtx)).status).toBe(404);
    expect(synapse.executeQuery).not.toHaveBeenCalled();
  });
});

describe('layer 1 — write routes guard WRITE-scoped, read routes read-scoped', () => {
  it('clone / copy-into POST / query carry NO allowReadRoles key', async () => {
    await whClonePOST(req(CLONE_BODY), whCtx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, WH_WRITE_GUARD);

    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await copyPOST(req(COPY_BODY), whCtx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, WH_WRITE_GUARD);

    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await whQueryPOST(req({ sql: 'SELECT 1' }), whCtx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, WH_WRITE_GUARD);

    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await dpClonePOST(req(CLONE_BODY), dpCtx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, DP_WRITE_GUARD);

    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await dpQueryPOST(req({ sql: 'SELECT 1' }), dpCtx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, DP_WRITE_GUARD);
  });

  it('schema / script-out / the copy-into source picker admit shared read roles', async () => {
    await whSchemaGET(req(), whCtx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, { ...WH_WRITE_GUARD, allowReadRoles: true });

    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await whScriptGET(req({}, { schema: 'gold', name: 'v', type: 'view', mode: 'create' }), whCtx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, { ...WH_WRITE_GUARD, allowReadRoles: true });

    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await copyGET(req({}, {}), whCtx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, { ...WH_WRITE_GUARD, allowReadRoles: true });
  });
});

// ── LAYER 2 — the `database` coordinate is bound to the item's workspace ────

describe('layer 2 — the cross-database re-point is bound', () => {
  it('warehouse query refuses a database outside the workspace — nothing runs', async () => {
    const res = await whQueryPOST(req({ sql: 'SELECT * FROM dbo.Secrets', database: VICTIM_DB }), whCtx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not bound to any item in this workspace/i);
    expect(synapse.executeQuery).not.toHaveBeenCalled();
  });

  it('dedicated-pool query refuses it too — the sibling URL is not a way round', async () => {
    const res = await dpQueryPOST(req({ sql: 'SELECT 1', database: VICTIM_DB }), dpCtx);
    expect(res.status).toBe(403);
    expect(synapse.executeQuery).not.toHaveBeenCalled();
    expect(synapse.executeQueryAsUser).not.toHaveBeenCalled();
  });

  it('refuses a syntactically invalid database name before any lookup', async () => {
    const res = await whQueryPOST(req({ sql: 'SELECT 1', database: 'a";DROP--' }), whCtx);
    expect(res.status).toBe(400);
    expect(synapse.executeQuery).not.toHaveBeenCalled();
  });

  it('the schema picker offers exactly what the query route will admit', async () => {
    // `sys.databases` returns all three; only the two bound to ws-1 come back.
    const res = await whSchemaGET(req(), whCtx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.databases.sort()).toEqual([POOL_DB, SIBLING_DB].sort());
    expect(j.databases).not.toContain(VICTIM_DB);
  });
});

// ── The legitimate owner is NOT refused ─────────────────────────────────────

describe('a legitimate owner still succeeds', () => {
  it('clone runs the real CTAS on the pool', async () => {
    const res = await whClonePOST(req(CLONE_BODY), whCtx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.engine).toBe('synapse-dedicated');
    expect(j.sql).toMatch(/CREATE TABLE \[dbo\]\.\[copy\] WITH \( DISTRIBUTION = ROUND_ROBIN \) AS SELECT \* FROM \[gold\]\.\[fact_sales\]/);
    expect(synapse.executeQuery).toHaveBeenCalled();
  });

  it('dedicated-pool clone runs the real SELECT INTO', async () => {
    const res = await dpClonePOST(req(CLONE_BODY), dpCtx);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(synapse.executeQuery).toHaveBeenCalled();
  });

  it('copy-into runs the real COPY INTO and lists real storage paths', async () => {
    const g = await copyGET(req({}, { container: 'bronze', prefix: '' }), whCtx);
    expect(g.status).toBe(200);
    expect(adls.listPaths).toHaveBeenCalledWith('bronze', '', 200);

    const p = await copyPOST(req(COPY_BODY), whCtx);
    expect(p.status).toBe(200);
    expect((await p.json()).sql).toMatch(/^COPY INTO \[dbo\]\.\[landing\]/);
    expect(synapse.executeQuery).toHaveBeenCalled();
  });

  it('an EMPTY database (what the editor sends by default) still works', async () => {
    const res = await whQueryPOST(req({ sql: 'SELECT 1' }), whCtx);
    expect(res.status).toBe(200);
    expect((await res.json()).database).toBe(POOL_DB);
    expect(synapse.executeQuery).toHaveBeenCalled();
  });

  it('a database bound to a SIBLING item in the same workspace is admitted', async () => {
    const res = await whQueryPOST(req({ sql: 'SELECT 1', database: SIBLING_DB }), whCtx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.database).toBe(SIBLING_DB);
    // ...and the TDS connection really was re-pointed at it.
    expect(synapse.executeQuery.mock.calls[0][0]).toMatchObject({ database: SIBLING_DB });
  });

  it('script-out still returns a real object definition', async () => {
    const res = await whScriptGET(req({}, { schema: 'gold', name: 'v', type: 'view', mode: 'create' }), whCtx);
    expect(res.status).toBe(200);
    expect(scripting.scriptOutSqlObject).toHaveBeenCalled();
  });
});

// ── THE OUTER ERROR ENVELOPE — a regression this PR introduced and closed ───

describe('the outer envelope survives a throw the INNER catch never sees', () => {
  /**
   * Dropping `withSession` from `warehouse/[id]/query` also dropped
   * `route-toolkit`'s `try { … } catch (e) { return apiServerError(e) }`,
   * leaving `enforceRateLimit` and `dedicatedTarget()` outside any try.
   * `dedicatedTarget()` throws on an unset `LOOM_SYNAPSE_DEDICATED_POOL` — the
   * exact state `envPoolDatabase()` exists to tolerate — so the route returned
   * Next's generic HTML 500 and the editor's `await r.json()` could not parse it.
   *
   * The inner catch wraps `executeQuery` ONLY, so it cannot see this. That is
   * the M22/M23 lesson restated: two overlapping controls hide each other's
   * absence, and only a test exercising what the inner one does not run will
   * notice. These are those tests.
   */
  it('warehouse/query returns STRUCTURED json when dedicatedTarget() throws', async () => {
    synapse.dedicatedTarget.mockImplementation(() => {
      throw new Error('Missing env var: LOOM_SYNAPSE_DEDICATED_POOL');
    });
    const res = await whQueryPOST(req({ sql: 'SELECT 1' }), whCtx);
    expect(res.status).toBe(500);
    // Parseable — this is the whole point; an HTML body throws here.
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(typeof j.error).toBe('string');
  });

  it('warehouse/query returns STRUCTURED json when the rate limiter throws', async () => {
    rateLimit.enforceRateLimit.mockRejectedValue(new Error('redis unreachable'));
    const res = await whQueryPOST(req({ sql: 'SELECT 1' }), whCtx);
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });

  it('dedicated-pool/query too (pre-existing gap, same failure mode)', async () => {
    synapse.dedicatedTarget.mockImplementation(() => {
      throw new Error('Missing env var: LOOM_SYNAPSE_DEDICATED_POOL');
    });
    const res = await dpQueryPOST(req({ sql: 'SELECT 1' }), dpCtx);
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });

  it('the INNER catch is still the one that classifies a cancelled query', async () => {
    // Proves the outer envelope did not swallow the inner behaviour — the
    // failure mode of "just wrap everything in one try".
    synapse.executeQuery.mockRejectedValue(Object.assign(new Error('Query canceled'), { code: 'ECANCEL' }));
    const res = await whQueryPOST(req({ sql: 'SELECT 1' }), whCtx);
    expect(res.status).toBe(200);
    expect((await res.json()).canceled).toBe(true);
  });
});

// ── THE RESIDUAL, ASSERTED — not left for a reader to infer ─────────────────

describe('RESIDUAL: schema.table is NOT bound on the shared pool', () => {
  /**
   * This test exists to make an ABSENCE visible. A suite that only proves what
   * was fixed reads, to the next person, as proof the route is safe. It is not:
   * an authorized warehouse owner can still clone from a schema/table belonging
   * to another tenant in the one shared pool, because nothing records who owns
   * `gold.fact_sales`. If a future change binds the table coordinate, THIS test
   * must be the one that fails, and its replacement is the receipt.
   */
  it('an authorized owner can still clone from a schema this item never created', async () => {
    const res = await whClonePOST(
      req({ sourceSchema: 'tenantB_gold', sourceTable: 'payroll', targetSchema: 'dbo', targetTable: 'mine' }),
      whCtx,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).sql).toContain('[tenantB_gold].[payroll]');
    expect(synapse.executeQuery).toHaveBeenCalled();
  });

  it('and the in-database schema enumeration is still pool-wide', async () => {
    /**
     * REWRITTEN after review. The first version asserted
     * `expect(await res.json()).toHaveProperty('schemas')`, which **cannot
     * fail**: a future change narrowing `schemas` to the item's own set still
     * returns a `schemas` property. It proved response shape, not that the gap
     * is open — and a RESIDUAL assertion that does not fail when the residual
     * closes is worse than none, because it makes the block look load-bearing.
     *
     * This asserts the actual leak: a schema belonging to ANOTHER tenant, with
     * its table and row count, comes back to a caller authorized only for THIS
     * warehouse item. When the ownership model lands, this fails — which is the
     * point.
     */
    synapse.executeQuery.mockResolvedValue({
      columns: ['qualified', 'table_name', 'schema_name', 'row_count'],
      rows: [
        ['gold.fact_sales', 'fact_sales', 'gold', 42],
        ['tenantB_gold.payroll', 'payroll', 'tenantB_gold', 9_000_000],
      ],
      rowCount: 2, executionMs: 5, truncated: false, messages: [], recordsAffected: 0,
    } as any);
    const res = await whSchemaGET(req(), whCtx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(Object.keys(j.schemas)).toContain('tenantB_gold');
    expect(j.schemas.tenantB_gold).toEqual([{ table: 'payroll', rows: 9_000_000 }]);
  });
});
