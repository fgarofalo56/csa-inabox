/**
 * GHSA-v8r7-c2p5-mjf2, fifth pass — route-level proof for the three
 * `items/[type]/[id]/*` dispatchers the advisory's closing sweep found:
 *
 *   `[id]/security`    Unity Catalog column masks + row filters. `[id]` was
 *       NEVER destructured (`const { type } = await ctxParams(ctx)`);
 *       `getSession()` was the whole authorization; `catalog` + `warehouseId`
 *       came off the query string (GET) / body (POST) into `ucSql` — CREATE OR
 *       REPLACE FUNCTION, ALTER TABLE … SET MASK / SET ROW FILTER, and the
 *       DROPs — as the Console managed identity. Dropping a column mask or a
 *       row filter is removing the control itself.
 *   `[id]/alerts`      ALL FOUR verbs took `_ctx`. `?alertId=` reached
 *       `trashDbxAlert` / `deleteScheduledQueryRule`. The only WRITE + DELETE
 *       entry in this sweep.
 *   `[id]/monitoring`  READ-ONLY — asserted as such below rather than softened.
 *       `?warehouseId=` was REQUIRED and reached `listQueryHistory`, whose
 *       entries carry other tenants' submitted `query_text`.
 *
 * WHAT THIS SUITE PROVES: Layer 1 on all three — a denied caller reaches no
 * backend, an id naming no item fails closed, the mutating verbs guard
 * write-scoped and the read verbs read-scoped, the deployment gates run BELOW
 * the ownership check, and `/new` gets an honest gate rather than the red 404
 * that would otherwise land four clicks from a create page.
 *
 * WHAT IT DOES NOT PROVE, because it is not true: that `catalog`,
 * `warehouseId` or `alertId` is BOUND to the item. None has an item binding in
 * this tree. Layer 1 is a FLOOR on these routes, not a bound, and the residual
 * is ASSERTED at the bottom of this file rather than left to be inferred from a
 * green suite — the same shape `ghsa-shared-backend-dispatchers.test.ts` uses
 * for the round-3 routes.
 *
 * Every spec names the mutation that turns it red. Session, the workspace
 * ladder, Cosmos and every backend client are mocked — no cookies, no Cosmos,
 * no Databricks, no ARM, no TDS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
const session = vi.hoisted(() => ({ current: null as any }));
vi.mock('@/lib/auth/session', () => ({
  getSession: () => session.current,
  tenantScopeId: () => 'tid-1',
}));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

const DBX_ITEM: any = {
  id: 'sw-1', itemType: 'databricks-sql-warehouse', workspaceId: 'ws-1', displayName: 'SQL WH', state: {},
};
const WH_ITEM: any = {
  id: 'wh-1', itemType: 'warehouse', workspaceId: 'ws-1', displayName: 'Warehouse', state: {},
};

const cosmos = vi.hoisted(() => ({ byId: [] as any[], byWorkspace: [] as any[] }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => ({
          resources: String(spec?.query || '').includes('c.workspaceId') ? cosmos.byWorkspace : cosmos.byId,
        }),
      }),
    },
  }),
}));

// ── backends ────────────────────────────────────────────────────────────────
const dbx = vi.hoisted(() => ({
  databricksConfigGate: vi.fn(() => null as any),
  listWarehouses: vi.fn(async () => [{ id: 'wh-default', state: 'RUNNING' }]),
  listWarehouseEvents: vi.fn(async () => [] as any[]),
  listQueryHistory: vi.fn(async () => ({ entries: [] as any[] })),
  createDbxQuery: vi.fn(async () => ({ id: 'q-1' })),
  createDbxAlert: vi.fn(async () => ({ id: 'a-1' })),
  listDbxAlerts: vi.fn(async () => ({ alerts: [] as any[] })),
  updateDbxAlert: vi.fn(async () => ({ id: 'a-1' })),
  trashDbxAlert: vi.fn(async () => undefined),
}));
vi.mock('@/lib/azure/databricks-client', () => dbx);

const uc = vi.hoisted(() => ({
  ucSql: vi.fn(async () => ({ columns: ['c'], rows: [['v']], rowCount: 1, executionMs: 5 })),
}));
vi.mock('@/lib/azure/uc-sql', () => uc);

const monitor = vi.hoisted(() => {
  class MonitorNotConfiguredError extends Error { missing = ['LOOM_ALERT_RG']; }
  class MonitorError extends Error { status = 403; }
  return {
    MonitorNotConfiguredError, MonitorError,
    upsertScheduledQueryRule: vi.fn(async () => '/subscriptions/s/rg/rule'),
    listScheduledQueryRules: vi.fn(async () => [] as any[]),
    deleteScheduledQueryRule: vi.fn(async () => undefined),
  };
});
vi.mock('@/lib/azure/monitor-client', () => monitor);
vi.mock('@/lib/azure/monitor-gate', () => ({ monitorGate: vi.fn(() => null) }));

const cloud = vi.hoisted(() => ({
  isGovCloud: vi.fn(() => false),
  cloudBoundaryLabel: vi.fn(() => 'Azure Government'),
}));
vi.mock('@/lib/azure/cloud-endpoints', () => cloud);

const synapse = vi.hoisted(() => ({
  dedicatedTarget: vi.fn(() => ({ server: 's', database: 'dwhpool01', cacheKey: 'k' })),
  executeQuery: vi.fn(async () => ({
    columns: ['n'], rows: [['x']], rowCount: 1, executionMs: 3, truncated: false, messages: [], recordsAffected: 1,
  })),
}));
vi.mock('@/lib/azure/synapse-sql-client', () => synapse);
vi.mock('@/lib/azure/synapse-artifacts-client', () => ({ synapseConfigGate: vi.fn(() => null) }));
vi.mock('@/lib/azure/synapse-pool-arm', () => ({ getPoolState: vi.fn(async () => ({ state: 'Online', sku: 'DW100c' })) }));

import { GET as secGET, POST as secPOST } from '../security/route';
import {
  GET as alertsGET, POST as alertsPOST, PATCH as alertsPATCH, DELETE as alertsDELETE,
} from '../alerts/route';
import { GET as monGET } from '../monitoring/route';

// ── request / ctx helpers ───────────────────────────────────────────────────
function ctx(type: string, id = 'sw-1') {
  return { params: Promise.resolve({ type, id }) } as any;
}
function req(body: any = {}, query: Record<string, string> = {}) {
  const url = new URL('http://x/');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}

const DBX = 'databricks-sql-warehouse';

/** The guard arguments each verb must present. `allowReadRoles` is the whole
 *  read/write distinction, so it is asserted rather than assumed. */
const secGuardArgs = { workspaceId: null, itemId: 'sw-1', itemType: DBX, notFound: expect.any(String) };

/** NOTHING reached ANY backend — all four clients this suite covers. */
function noBackendRan() {
  expect(uc.ucSql).not.toHaveBeenCalled();
  expect(dbx.listWarehouses).not.toHaveBeenCalled();
  expect(dbx.listWarehouseEvents).not.toHaveBeenCalled();
  expect(dbx.listQueryHistory).not.toHaveBeenCalled();
  expect(dbx.listDbxAlerts).not.toHaveBeenCalled();
  expect(dbx.createDbxAlert).not.toHaveBeenCalled();
  expect(dbx.updateDbxAlert).not.toHaveBeenCalled();
  expect(dbx.trashDbxAlert).not.toHaveBeenCalled();
  expect(monitor.listScheduledQueryRules).not.toHaveBeenCalled();
  expect(monitor.upsertScheduledQueryRule).not.toHaveBeenCalled();
  expect(monitor.deleteScheduledQueryRule).not.toHaveBeenCalled();
  expect(synapse.executeQuery).not.toHaveBeenCalled();
}

/**
 * A FRESH response per call, deliberately. `mockResolvedValue` would hand every
 * route the SAME `NextResponse`, and a `Response` body can only be read once —
 * so a spec that read two denials failed with "Body has already been read",
 * which looks like a route defect and is a harness defect. Found while writing
 * this file; recorded so it is not reintroduced.
 */
async function denyAll() {
  const { NextResponse } = await import('next/server');
  guard.authorizeItemWorkspace.mockImplementation(
    async () => NextResponse.json({ ok: false, error: 'not found' }, { status: 404 }) as any,
  );
}

const MASK_BODY = {
  wizard: 'column-mask',
  warehouseId: 'victim-warehouse',
  catalog: 'tenantB',
  params: {
    catalog: 'tenantB', schema: 'hr', tableName: 'people', columnName: 'ssn',
    columnType: 'STRING', maskMode: 'null', allowedGroup: 'hr-admins',
  },
};
const DROP_MASK_BODY = {
  action: 'drop-mask',
  warehouseId: 'victim-warehouse',
  catalog: 'tenantB',
  params: { catalog: 'tenantB', schema: 'hr', tableName: 'people', columnName: 'ssn' },
};
const ALERT_BODY = {
  name: 'a', sql: 'SELECT 1 AS value', column: 'value', op: 'GREATER_THAN',
  threshold: 1, warehouseId: 'wh-default',
};

let savedGov: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  session.current = SESSION;
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  dbx.databricksConfigGate.mockReturnValue(null as any);
  dbx.listWarehouses.mockResolvedValue([{ id: 'wh-default', state: 'RUNNING' }] as any);
  cloud.isGovCloud.mockReturnValue(false);
  uc.ucSql.mockResolvedValue({ columns: ['c'], rows: [['v']], rowCount: 1, executionMs: 5 } as any);
  cosmos.byId = [DBX_ITEM, WH_ITEM];
  cosmos.byWorkspace = [DBX_ITEM, WH_ITEM];
  savedGov = process.env.LOOM_SYNAPSE_WORKSPACE;
});
afterEach(() => {
  if (savedGov === undefined) delete process.env.LOOM_SYNAPSE_WORKSPACE;
  else process.env.LOOM_SYNAPSE_WORKSPACE = savedGov;
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1 — the route id must convey authority
// ═══════════════════════════════════════════════════════════════════════════

describe('layer 1 — unauthenticated', () => {
  // MUTATION: drop `guardSynapseItemRequest` from any route → 200 instead of 401.
  it('401s every verb of every route and reaches no backend', async () => {
    session.current = null;
    expect((await secGET(req({}, { catalog: 'tenantB', warehouseId: 'victim' }), ctx(DBX))).status).toBe(401);
    expect((await secPOST(req(MASK_BODY), ctx(DBX))).status).toBe(401);
    expect((await alertsGET(req(), ctx(DBX))).status).toBe(401);
    expect((await alertsPOST(req(ALERT_BODY), ctx(DBX))).status).toBe(401);
    expect((await alertsPATCH(req({}, { alertId: 'a-1' }), ctx(DBX))).status).toBe(401);
    expect((await alertsDELETE(req({}, { alertId: 'a-1' }), ctx(DBX))).status).toBe(401);
    expect((await monGET(req({}, { warehouseId: 'victim' }), ctx(DBX))).status).toBe(401);

    expect(guard.authorizeItemWorkspace).not.toHaveBeenCalled();
    noBackendRan();
  });
});

describe('layer 1 — a denied caller', () => {
  // THE ADVISORY'S CORE FINDING, on the UC route.
  //   MUTATION: remove the `guardSynapseItemRequest` call from
  //   `authorizeUcSecurityRequest` → the 404 becomes a 200 carrying the victim
  //   catalog's whole protection map, and the POST executes DDL on it.
  it('security: neither verb reaches Unity Catalog', async () => {
    await denyAll();
    expect((await secGET(req({}, { catalog: 'tenantB', warehouseId: 'victim' }), ctx(DBX))).status).toBe(404);
    expect((await secPOST(req(MASK_BODY), ctx(DBX))).status).toBe(404);
    expect((await secPOST(req(DROP_MASK_BODY), ctx(DBX))).status).toBe(404);
    expect(uc.ucSql).not.toHaveBeenCalled();
    expect(dbx.listWarehouses).not.toHaveBeenCalled();
  });

  // MUTATION: remove the guard from `authorizeAlertsRequest` → the DELETE
  // reaches `trashDbxAlert('a-1')` again.
  it('alerts: no verb reaches Databricks or Azure Monitor — including DELETE', async () => {
    await denyAll();
    expect((await alertsGET(req(), ctx(DBX))).status).toBe(404);
    expect((await alertsPOST(req(ALERT_BODY), ctx(DBX))).status).toBe(404);
    expect((await alertsPATCH(req({ name: 'x' }, { alertId: 'a-1' }), ctx(DBX))).status).toBe(404);
    expect((await alertsDELETE(req({}, { alertId: 'a-1' }), ctx(DBX))).status).toBe(404);
    noBackendRan();
  });

  // MUTATION: remove the guard from the monitoring GET → the query history of
  // `victim-warehouse`, including other tenants' `query_text`, is returned.
  it('monitoring: neither branch reaches its backend', async () => {
    await denyAll();
    expect((await monGET(req({}, { warehouseId: 'victim-warehouse' }), ctx(DBX))).status).toBe(404);
    process.env.LOOM_SYNAPSE_WORKSPACE = 'ws';
    expect((await monGET(req(), ctx('synapse-dedicated-sql-pool', 'wh-1'))).status).toBe(404);
    expect(dbx.listWarehouseEvents).not.toHaveBeenCalled();
    expect(dbx.listQueryHistory).not.toHaveBeenCalled();
    expect(synapse.executeQuery).not.toHaveBeenCalled();
  });

  // FAIL-CLOSED. `authorizeItemWorkspace` returns null (= allow) for an id that
  // names no item of that type; `guardSynapseItemRequest` closes that with its
  // own item load. MUTATION: make that load permissive → these become 200.
  it('an id naming no item is refused, not fallen through', async () => {
    cosmos.byId = [];
    expect((await secGET(req({}, { catalog: 'tenantB' }), ctx(DBX))).status).toBe(404);
    expect((await secPOST(req(DROP_MASK_BODY), ctx(DBX))).status).toBe(404);
    expect((await alertsDELETE(req({}, { alertId: 'a-1' }), ctx(DBX))).status).toBe(404);
    expect((await monGET(req({}, { warehouseId: 'w' }), ctx(DBX))).status).toBe(404);
    noBackendRan();
  });

  // The 404 body must name BOTH causes and assert NEITHER (deploy-integrity R7).
  // MUTATION: replace `ITEM_UNREACHABLE` with a bare 'not found' → red here.
  it('the 404 body is actionable and asserts no single cause', async () => {
    cosmos.byId = [];
    const body = await (await secGET(req({}, { catalog: 'c' }), ctx(DBX))).json();
    expect(body.error).toMatch(/does not exist/i);
    expect(body.error).toMatch(/read-only/i);
    expect(body.error).not.toMatch(/^not found$/i);

    const alertsBody = await (await alertsDELETE(req({}, { alertId: 'a-1' }), ctx(DBX))).json();
    expect(alertsBody.error).toMatch(/does not exist/i);
    expect(alertsBody.error).toMatch(/read-only/i);
  });
});

describe('layer 1 — write vs read scope', () => {
  // MUTATION: add `allowReadRoles: true` to the security guard (either verb) →
  // a read-only Viewer reaches the mask/filter map and the DDL executor.
  it('security guards WRITE-scoped on BOTH verbs — no allowReadRoles', async () => {
    await secGET(req({}, { catalog: 'c' }), ctx(DBX));
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, secGuardArgs);
    expect(guard.authorizeItemWorkspace.mock.calls[0][1]).not.toHaveProperty('allowReadRoles');

    vi.clearAllMocks(); guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    dbx.databricksConfigGate.mockReturnValue(null as any);
    dbx.listWarehouses.mockResolvedValue([{ id: 'wh-default', state: 'RUNNING' }] as any);
    await secPOST(req(MASK_BODY), ctx(DBX));
    expect(guard.authorizeItemWorkspace.mock.calls[0][1]).not.toHaveProperty('allowReadRoles');
  });

  // MUTATION: add `allowReadRoles` to POST/PATCH/DELETE → a Viewer deletes rules.
  it('alerts guards WRITE-scoped on POST / PATCH / DELETE and READ-scoped on GET', async () => {
    await alertsGET(req(), ctx(DBX));
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(
      SESSION, { ...secGuardArgs, allowReadRoles: true },
    );

    for (const call of [
      () => alertsPOST(req(ALERT_BODY), ctx(DBX)),
      () => alertsPATCH(req({ name: 'x' }, { alertId: 'a-1' }), ctx(DBX)),
      () => alertsDELETE(req({}, { alertId: 'a-1' }), ctx(DBX)),
    ]) {
      vi.clearAllMocks();
      guard.authorizeItemWorkspace.mockResolvedValue(null as any);
      dbx.databricksConfigGate.mockReturnValue(null as any);
      await call();
      expect(guard.authorizeItemWorkspace.mock.calls[0][1]).not.toHaveProperty('allowReadRoles');
    }
  });

  // MUTATION: drop `allowReadRoles` from monitoring → a legitimate Viewer of a
  // shared workspace loses a READ-ONLY tab. Over-tightening is a defect too.
  it('monitoring guards READ-scoped — it only reads', async () => {
    await monGET(req({}, { warehouseId: 'wh-default' }), ctx(DBX));
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(
      SESSION, { ...secGuardArgs, allowReadRoles: true },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ORDERING — the deployment gates must not run above the ownership check
// ═══════════════════════════════════════════════════════════════════════════

describe('gate ordering — no estate disclosure to an unauthorized caller', () => {
  // MUTATION: hoist `resolveBackendGate()` above the guard (i.e. restore the
  // single `resolveGate(type)` this route shipped with) → the denied caller is
  // told which LOOM_* var is missing, or which sovereign boundary this is.
  it('security: a denied caller is NOT told the deployment is unconfigured', async () => {
    await denyAll();
    dbx.databricksConfigGate.mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' } as any);
    const r = await secGET(req({}, { catalog: 'c' }), ctx(DBX));
    expect(r.status).toBe(404);
    expect(JSON.stringify(await r.json())).not.toMatch(/LOOM_DATABRICKS_HOSTNAME/);
  });

  it('security: a denied caller is NOT told which sovereign boundary this is', async () => {
    await denyAll();
    cloud.isGovCloud.mockReturnValue(true);
    const r = await secPOST(req(MASK_BODY), ctx(DBX));
    expect(r.status).toBe(404);
    expect(JSON.stringify(await r.json())).not.toMatch(/Azure Government/);
  });

  it('alerts / monitoring: a denied caller is NOT told the backend is unconfigured', async () => {
    await denyAll();
    dbx.databricksConfigGate.mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' } as any);
    for (const r of [
      await alertsGET(req(), ctx(DBX)),
      await monGET(req({}, { warehouseId: 'w' }), ctx(DBX)),
    ]) {
      expect(r.status).toBe(404);
      expect(JSON.stringify(await r.json())).not.toMatch(/LOOM_DATABRICKS_HOSTNAME/);
    }
  });

  // The ITEM-TYPE gate is the one thing that MAY precede authorization: it is a
  // pure function of the URL and discloses nothing. MUTATION: move it below the
  // guard → an unsupported type 404s instead of explaining itself, and the
  // "use the SQL wizards instead" affordance is lost.
  it('security: the item-TYPE gate still answers first — it discloses nothing', async () => {
    const r = await secGET(req({}, { catalog: 'c' }), ctx('warehouse', 'wh-1'));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.gated).toBe(true);
    expect(j.error).toMatch(/Databricks SQL Warehouse items/);
    expect(guard.authorizeItemWorkspace).not.toHaveBeenCalled();
    expect(uc.ucSql).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE UNSAVED ITEM — an honest gate, never a red 404 (ux-baseline / auto-bind)
// ═══════════════════════════════════════════════════════════════════════════

describe('the /new dead end', () => {
  /**
   * All three surfaces are reachable at `id === 'new'`, checked at the call
   * sites rather than assumed:
   *   security    sql-warehouse-editor.tsx:913/:1980 — no `isNew` in that file.
   *   alerts      sql-warehouse-editor.tsx:920/:1943 AND
   *               phase3/warehouse-editor.tsx:454/:914 (that editor HAS `isNew`
   *               and uses it for two other tabs, but not for this dialog).
   *   monitoring  sql-warehouse-editor.tsx:1244 and synapse-sql-editors.tsx:1099
   *               (phase3/warehouse-editor.tsx:725 already gates it).
   * MUTATION: remove the `id === UNSAVED_ITEM_ID` branch from any of the three
   * → that route 404s, and the panel paints a RED banner on a freshly created
   * item.
   */
  it('security returns the honest gate, not a 404, and never reads Cosmos', async () => {
    const r = await secGET(req({}, { catalog: 'c', warehouseId: 'w' }), ctx(DBX, 'new'));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.gated).toBe(true);
    expect(j.code).toBe('unsaved_item');
    expect(j.error).toMatch(/Save this item first/i);
    expect(guard.authorizeItemWorkspace).not.toHaveBeenCalled();
    expect(uc.ucSql).not.toHaveBeenCalled();
  });

  it('security POST is gated too — no DDL from an unsaved item', async () => {
    const r = await secPOST(req(MASK_BODY), ctx(DBX, 'new'));
    expect(r.status).toBe(200);
    expect((await r.json()).code).toBe('unsaved_item');
    expect(uc.ucSql).not.toHaveBeenCalled();
  });

  it('alerts gates every verb, including DELETE', async () => {
    for (const call of [
      () => alertsGET(req(), ctx(DBX, 'new')),
      () => alertsPOST(req(ALERT_BODY), ctx(DBX, 'new')),
      () => alertsPATCH(req({ name: 'x' }, { alertId: 'a-1' }), ctx(DBX, 'new')),
      () => alertsDELETE(req({}, { alertId: 'a-1' }), ctx(DBX, 'new')),
    ]) {
      vi.clearAllMocks();
      guard.authorizeItemWorkspace.mockResolvedValue(null as any);
      const r = await call();
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.gated).toBe(true);
      expect(j.code).toBe('unsaved_item');
      expect(guard.authorizeItemWorkspace).not.toHaveBeenCalled();
      noBackendRan();
    }
  });

  it('monitoring returns a code the panel renders as a WARNING, not the red branch', async () => {
    const r = await monGET(req({}, { warehouseId: 'w' }), ctx(DBX, 'new'));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(false);
    // `warehouse-monitoring.tsx` paints `!ok && !code` red. A code is what makes
    // this a warning, so the code — not just the message — is the assertion.
    expect(j.code).toBe('unsaved_item');
    expect(guard.authorizeItemWorkspace).not.toHaveBeenCalled();
    expect(dbx.listQueryHistory).not.toHaveBeenCalled();
  });

  // EXACT MATCH ONLY. Real ids are `crypto.randomUUID()`, so a substring or
  // prefix test would let a real id skip ownership entirely.
  // MUTATION: `id.includes('new')` / `id.startsWith('new')` → red here.
  it('near-miss ids do NOT skip ownership', async () => {
    for (const id of ['new-1', 'renew', 'NEW', 'newest', 'anew']) {
      vi.clearAllMocks();
      await denyAll();
      const r = await secGET(req({}, { catalog: 'c' }), ctx(DBX, id));
      expect(r.status, `id=${id} must reach the ownership check`).toBe(404);

      vi.clearAllMocks();
      await denyAll();
      expect((await alertsDELETE(req({}, { alertId: 'a' }), ctx(DBX, id))).status).toBe(404);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The legitimate owner is NOT refused
// ═══════════════════════════════════════════════════════════════════════════

describe('a legitimate owner still succeeds', () => {
  it('security GET reads the real information_schema through ucSql', async () => {
    const r = await secGET(req({}, { catalog: 'main', schema: 'sales', warehouseId: 'wh-default' }), ctx(DBX));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('databricks-uc');
    expect(uc.ucSql).toHaveBeenCalled();
  });

  it('security GET with no catalog still returns the empty-but-ok shell', async () => {
    const r = await secGET(req(), ctx(DBX));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.needsCatalog).toBe(true);
    expect(uc.ucSql).not.toHaveBeenCalled();
  });

  it('security POST executes the real two-statement mask DDL', async () => {
    const r = await secPOST(req(MASK_BODY), ctx(DBX));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(uc.ucSql).toHaveBeenCalledTimes(2); // CREATE FUNCTION, then ALTER TABLE
    expect(String(uc.ucSql.mock.calls[0][1])).toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(String(uc.ucSql.mock.calls[1][1])).toMatch(/SET MASK/i);
  });

  it('security still honest-gates when Databricks is unconfigured (authorized caller)', async () => {
    dbx.databricksConfigGate.mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' } as any);
    const r = await secGET(req({}, { catalog: 'main' }), ctx(DBX));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.gated).toBe(true);
    expect(j.error).toMatch(/LOOM_DATABRICKS_HOSTNAME/);
  });

  it('security still honest-gates Unity Catalog at a sovereign boundary', async () => {
    cloud.isGovCloud.mockReturnValue(true);
    const r = await secGET(req({}, { catalog: 'main' }), ctx(DBX));
    expect(r.status).toBe(200);
    expect((await r.json()).error).toMatch(/Azure Government/);
  });

  it('alerts lists, creates, patches and deletes for an owner', async () => {
    expect((await alertsGET(req(), ctx(DBX))).status).toBe(200);
    expect(dbx.listDbxAlerts).toHaveBeenCalled();

    const created = await alertsPOST(req(ALERT_BODY), ctx(DBX));
    expect(created.status).toBe(200);
    expect((await created.json()).alertId).toBe('a-1');

    expect((await alertsPATCH(req({ name: 'x' }, { alertId: 'a-1' }), ctx(DBX))).status).toBe(200);
    expect((await alertsDELETE(req({}, { alertId: 'a-1' }), ctx(DBX))).status).toBe(200);
    expect(dbx.trashDbxAlert).toHaveBeenCalledWith('a-1');
  });

  it('monitoring returns the real Databricks timeline for an owner', async () => {
    const r = await monGET(req({}, { warehouseId: 'wh-default' }), ctx(DBX));
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
    expect(dbx.listWarehouseEvents).toHaveBeenCalledWith('wh-default', 200);
    expect(dbx.listQueryHistory).toHaveBeenCalledWith({ warehouseId: 'wh-default', maxResults: 50 });
  });

  it('monitoring still 400s a Databricks request with no warehouseId (authorized caller)', async () => {
    const r = await monGET(req(), ctx(DBX));
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('missing_warehouse');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE RESIDUAL, ASSERTED — Layer 1 is a FLOOR here, not a BOUND
// ═══════════════════════════════════════════════════════════════════════════

describe('RESIDUAL: the backend coordinates are NOT bound to the item', () => {
  /**
   * Made visible on purpose, exactly as `ghsa-shared-backend-dispatchers.test.ts`
   * does for the round-3 routes. If a later change binds `catalog`,
   * `warehouseId` or `alertId` to the item, THESE are the tests that must fail,
   * and their replacements are the receipt. A green suite that silently stopped
   * covering the gap is the failure mode this advisory is about.
   */
  it('an authorized warehouse owner can still drop a mask in another catalog', async () => {
    const r = await secPOST(req(DROP_MASK_BODY), ctx(DBX));
    expect(r.status).toBe(200);
    expect(String(uc.ucSql.mock.calls[0][1])).toMatch(/tenantB/);
  });

  it('…and can still drive a warehouseId this item does not own', async () => {
    await secGET(req({}, { catalog: 'main', warehouseId: 'someone-elses-warehouse' }), ctx(DBX));
    expect(uc.ucSql.mock.calls[0][0]).toBe('someone-elses-warehouse');
  });

  it('an authorized owner can still read another warehouse’s query history', async () => {
    await monGET(req({}, { warehouseId: 'someone-elses-warehouse' }), ctx(DBX));
    expect(dbx.listQueryHistory).toHaveBeenCalledWith({
      warehouseId: 'someone-elses-warehouse', maxResults: 50,
    });
  });

  it('an authorized owner can still delete an alert this item never created', async () => {
    await alertsDELETE(req({}, { alertId: 'someone-elses-alert' }), ctx(DBX));
    expect(dbx.trashDbxAlert).toHaveBeenCalledWith('someone-elses-alert');
  });
});
