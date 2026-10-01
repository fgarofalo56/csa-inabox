/**
 * BFF route test for /api/items/semantic-model/[id]/roles — #2649.
 *
 * THE BUG. A bundle-installed semantic model is listed under the SYNTHETIC id
 * `loom:<cosmosItemId>` (`app/api/items/_lib/pbi-content-fallback.ts`), and the
 * editor threads whatever the list route handed it into every sub-route. The
 * Azure-native (DEFAULT) branch of this route looks the item up with
 * `loadOwnedItem`, which queries Cosmos `WHERE c.id = @id` — so the prefixed
 * form matched NOTHING and the route 404'd on an item that exists. That was the
 * last failure in the live click-walk (run 30753608459):
 *
 *   404 GET /api/items/semantic-model/loom%3A9ebf823c-…/roles
 *           ?workspaceId=2b289a0b-…&catalog=loom%3A9ebf823c-…
 *
 * The workspace in that URL is correct (the item's own Loom workspace, fixed in
 * #2818). The `loom:`-prefixed *id* is what could not resolve.
 *
 * WHY SERVE AND NOT SKIP. `/refreshes` is skipped for a `loom:` id because Power
 * BI refresh history is a thing a template genuinely cannot have. RLS/OLS roles
 * are the opposite: they are a LOOM-NATIVE concept persisted on this very Cosmos
 * item at `state.model.securityRoles` and compiled to a Synapse SECURITY POLICY
 * / Databricks ROW FILTER. Skipping would leave the Security tab dead for every
 * bundle-installed model.
 *
 * HOW THE MOCKS DISCRIMINATE. `loadOwnedItemMock` is a real keyed lookup over an
 * in-memory map, exactly like the Cosmos `c.id = @id` predicate — an unresolved
 * `loom:` prefix therefore misses on its own, it is not asserted into existence.
 *
 * CONTROLS (green with AND without the fix, so an over-broad "rewrite every id"
 * change is caught):
 *   • a plain Cosmos id must reach the store byte-identical;
 *   • the opt-in XMLA branch must still hand a real Power BI dataset id/catalog
 *     to `getRoles` verbatim and never touch Cosmos;
 *   • a `loom:` id with no backing Cosmos item must still 404.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { WorkspaceItem } from '@/lib/types/workspace';

// ── Cosmos owned-item store: a REAL keyed lookup (mirrors `WHERE c.id = @id`) ──
const store = new Map<string, WorkspaceItem>();
const loadOwnedItemMock = vi.fn(async (id: string, type: string) =>
  type === 'semantic-model' ? (store.get(id) ?? null) : null,
);
const updateOwnedItemMock = vi.fn(
  async (id: string, _type: string, _tenant: string, patch: { state?: Record<string, unknown> }) => {
    const cur = store.get(id);
    if (!cur) return null;
    const next = { ...cur, state: patch.state ?? cur.state } as WorkspaceItem;
    store.set(id, next);
    return next;
  },
);
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...(a as [string, string])),
  updateOwnedItem: (...a: any[]) => updateOwnedItemMock(...(a as [string, string, string, any])),
}));

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

// ── AAS/XMLA (opt-in) — real validateRlsDax + AasError, stubbed transport ─────
const aasConfigGateMock = vi.fn<() => { missing: string; detail: string } | null>(() => ({
  missing: 'LOOM_AAS_SERVER',
  detail: 'no xmla',
}));
const getRolesMock = vi.fn(async (_catalog: string) => [] as any[]);
const setRolesMock = vi.fn(async (_catalog: string, _roles: any[]) => undefined);
const testAsRoleMock = vi.fn(async () => [] as any[]);
vi.mock('@/lib/azure/aas-roles', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  aasConfigGate: () => aasConfigGateMock(),
  getRoles: (...a: any[]) => getRolesMock(...(a as [string])),
  setRoles: (...a: any[]) => setRolesMock(...(a as [string, any[]])),
  testAsRole: (...a: any[]) => (testAsRoleMock as any)(...a),
}));

// ── Synapse: keep the real sqlBracket/sqlString (rls-compiler needs them) ─────
const listRlsPoliciesMock = vi.fn(async () => [] as any[]);
vi.mock('@/lib/azure/synapse-permissions-client', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  listRlsPolicies: (...a: any[]) => (listRlsPoliciesMock as any)(...a),
}));

const synapseExecuteMock = vi.fn(async () => ({ columns: [], rows: [] }) as any);
vi.mock('@/lib/azure/synapse-sql-client', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  dedicatedTarget: () => ({ workspace: 'syn', database: 'pool' }) as any,
  executeQuery: (...a: any[]) => (synapseExecuteMock as any)(...a),
}));

vi.mock('@/lib/azure/databricks-client', () => ({
  executeStatement: vi.fn(async () => ({ columns: [], rows: [] }) as any),
  // Mirrors the real gate: only the workspace host decides it.
  databricksConfigGate: () => (process.env.LOOM_DATABRICKS_HOSTNAME ? null : { missing: 'LOOM_DATABRICKS_HOSTNAME' }),
}));

// #3744 — the warehouse is produced by the platform resolver; the REAL error
// class and body shaper are kept so the route's instanceof branch is real.
const resolveWarehouseMock = vi.fn(async () => 'wh-resolved');
const withResolvedMock = vi.fn(async (fn: (id: string) => Promise<unknown>) => fn(await resolveWarehouseMock()));
vi.mock('@/lib/azure/databricks-sql-warehouse', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure/databricks-sql-warehouse')>('@/lib/azure/databricks-sql-warehouse');
  return {
    ...actual,
    resolveWarehouseIdOrThrow: (...a: unknown[]) => resolveWarehouseMock(...(a as [])),
    // #4776 — statements now run through the self-healing wrapper; it resolves
    // through the SAME mock so a rejected resolution still reaches the route.
    withResolvedWarehouse: (fn: (id: string) => Promise<unknown>) => withResolvedMock(fn),
  };
});

import { GET, PUT, POST } from '../route';

const COSMOS_ID = 'sm-9ebf823c';
const LOOM_ID = `loom:${COSMOS_ID}`;
const LOOM_WS = 'ws-2b289a0b';

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** The URL the editor actually builds (semantic-model-editor.tsx loadRoles). */
function rolesUrl(id: string, extra = '') {
  return (
    `http://localhost/api/items/semantic-model/${encodeURIComponent(id)}/roles` +
    `?workspaceId=${encodeURIComponent(LOOM_WS)}&catalog=${encodeURIComponent(id)}${extra}`
  );
}
const getReq = (id: string) => new NextRequest(rolesUrl(id));
const putReq = (id: string, body: unknown) =>
  new NextRequest(rolesUrl(id), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const testReq = (id: string, body: unknown) =>
  new NextRequest(rolesUrl(id, '&action=test'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

function seedItem(securityRoles?: unknown[]) {
  store.set(COSMOS_ID, {
    id: COSMOS_ID,
    workspaceId: LOOM_WS,
    itemType: 'semantic-model',
    displayName: 'Real-Time Analytics Semantic Model',
    state: {
      content: { kind: 'semantic-model', tables: [], measures: [], relationships: [] },
      model: { ...(securityRoles ? { securityRoles } : {}) },
    },
    createdBy: 'u',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as unknown as WorkspaceItem);
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
  aasConfigGateMock.mockReturnValue({ missing: 'LOOM_AAS_SERVER', detail: 'no xmla' });
  // The deployed estate: Synapse dedicated pool present, no explicit preference
  // → resolveRlsBackend() === 'synapse' (the Azure-native DEFAULT).
  vi.stubEnv('LOOM_SEMANTIC_RLS_BACKEND', '');
  vi.stubEnv('LOOM_SYNAPSE_DEDICATED_POOL', 'loompool');
  vi.stubEnv('LOOM_SYNAPSE_WORKSPACE', 'syn-loom');
  vi.stubEnv('LOOM_DATABRICKS_SQL_WAREHOUSE_ID', '');
  vi.stubEnv('LOOM_DATABRICKS_HOSTNAME', '');
  resolveWarehouseMock.mockResolvedValue('wh-resolved');
  withResolvedMock.mockImplementation(async (fn: (id: string) => Promise<unknown>) => fn(await resolveWarehouseMock()));
});
afterEach(() => vi.unstubAllEnvs());

describe('#2649 — a `loom:` bundle-template id resolves on the Azure-native path', () => {
  it('GET serves a template\'s roles instead of 404ing (the click-walk failure)', async () => {
    seedItem([
      {
        name: 'Region Managers',
        members: ['ops@contoso.com'],
        tablePermissions: [{ table: 'dbo.Sales', filterExpression: '[Region] = "West"', metadataPermission: 'read' }],
      },
    ]);

    const res = await GET(getReq(LOOM_ID), params(LOOM_ID));

    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.native).toBe(true);
    expect(j.backend).toBe('synapse');
    expect(j.roles.map((r: any) => r.name)).toEqual(['Region Managers']);
    // The `loom:` prefix was stripped before the Cosmos lookup.
    expect(loadOwnedItemMock).toHaveBeenCalledWith(COSMOS_ID, 'semantic-model', 'oid-1');
    expect(loadOwnedItemMock).not.toHaveBeenCalledWith(LOOM_ID, expect.anything(), expect.anything());
  });

  it('GET returns an empty role set (200, not 404) for a freshly installed template', async () => {
    // ux-baseline clean-first-open: a bundle model with no roles yet must open
    // to an empty Security tab, never an error banner.
    seedItem();
    const res = await GET(getReq(LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.roles).toEqual([]);
  });

  it('PUT persists roles onto the template\'s Cosmos item', async () => {
    seedItem();
    const res = await PUT(
      putReq(LOOM_ID, {
        roles: [
          {
            name: 'Region Managers',
            modelPermission: 'read',
            tablePermissions: [{ name: 'dbo.Sales', filterExpression: '[Region] = "West"' }],
            members: [{ memberName: 'ops@contoso.com' }],
          },
        ],
      }),
      params(LOOM_ID),
    );

    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.persisted).toBe(true);
    expect(j.roleCount).toBe(1);
    expect(updateOwnedItemMock).toHaveBeenCalledOnce();
    expect((store.get(COSMOS_ID)!.state as any).model.securityRoles[0].name).toBe('Region Managers');
    // The bundle definition under state.content is preserved by the write.
    expect((store.get(COSMOS_ID)!.state as any).content.kind).toBe('semantic-model');
  });

  it('POST ?action=test resolves the template and finds the saved role', async () => {
    seedItem([{ name: 'Region Managers', members: [], tablePermissions: [] }]);
    const res = await POST(
      testReq(LOOM_ID, { roleName: 'Region Managers', effectiveUserName: 'ops@contoso.com' }),
      params(LOOM_ID),
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    // No row filter on the role → the honest "all rows visible" receipt, which
    // is only reachable once the item itself resolved.
    expect(j.note).toMatch(/no row-level filter/i);
  });
});

describe('#2649 controls — the fix must not rewrite ids it has no business touching', () => {
  it('CONTROL: a plain Cosmos id reaches the store byte-identical', async () => {
    seedItem([{ name: 'Analysts', members: [], tablePermissions: [] }]);
    const res = await GET(getReq(COSMOS_ID), params(COSMOS_ID));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.roles.map((r: any) => r.name)).toEqual(['Analysts']);
    expect(loadOwnedItemMock).toHaveBeenCalledWith(COSMOS_ID, 'semantic-model', 'oid-1');
  });

  it('CONTROL: a real Power BI-bound model still gets its roles over opt-in XMLA', async () => {
    // Power BI is OPT-IN and off by default (no-fabric-dependency.md); when it
    // IS selected the dataset id / catalog must reach getRoles verbatim.
    vi.stubEnv('LOOM_SEMANTIC_RLS_BACKEND', 'xmla');
    aasConfigGateMock.mockReturnValue(null);
    const PBI_DATASET = 'c0ffee11-2233-4455-6677-889900aabbcc';
    getRolesMock.mockResolvedValueOnce([{ name: 'PBI Role', modelPermission: 'read', tablePermissions: [] }]);

    const res = await GET(getReq(PBI_DATASET), params(PBI_DATASET));

    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('xmla');
    expect(j.native).toBe(false);
    expect(j.roles.map((r: any) => r.name)).toEqual(['PBI Role']);
    expect(getRolesMock).toHaveBeenCalledWith(PBI_DATASET);
    expect(loadOwnedItemMock).not.toHaveBeenCalled();
  });

  it('CONTROL: a `loom:` id with no backing Cosmos item still 404s', async () => {
    // store is empty — the fix resolves the id, it does not invent the item.
    const res = await GET(getReq(LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.ok).toBe(false);
  });

  it('CONTROL: no native SQL endpoint still returns the honest 501 Azure gate', async () => {
    vi.stubEnv('LOOM_SYNAPSE_DEDICATED_POOL', '');
    vi.stubEnv('LOOM_SYNAPSE_WORKSPACE', '');
    seedItem();
    const res = await GET(getReq(LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(501);
    const j = await res.json();
    expect(j.gate.missing).toBe('LOOM_SYNAPSE_DEDICATED_POOL');
  });

  it('CONTROL: unauthenticated is still 401', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await GET(getReq(LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(401);
  });
});

describe('#3744 — a bound Databricks workspace is a native RLS endpoint (the warehouse is produced)', () => {
  beforeEach(() => {
    vi.stubEnv('LOOM_SYNAPSE_DEDICATED_POOL', '');
    vi.stubEnv('LOOM_SYNAPSE_WORKSPACE', '');
    vi.stubEnv('LOOM_DATABRICKS_HOSTNAME', 'adb-1.azuredatabricks.net');
  });

  it('GET picks databricks with the hostname bound and NO warehouse env', async () => {
    seedItem();
    const res = await GET(getReq(LOOM_ID), params(LOOM_ID));
    // Breaks if hasDbx is reverted to env-only: backend would be 'none' → 501.
    expect(res.status).toBe(200);
    expect((await res.json()).backend).toBe('databricks');
  });

  // PR #4776 — Unity Catalog (the ROW FILTER target) is not in Azure Government,
  // so `auto` must not infer Databricks there. Breaks if `&& !isGovCloud()` is
  // dropped from the auto branch: the same env as the test above yields
  // 200 + backend 'databricks' instead of the 501 native gate.
  it('Gov (LOOM_CLOUD=gcc-high): auto does NOT pick databricks from a bound workspace', async () => {
    vi.stubEnv('LOOM_CLOUD', 'gcc-high');
    seedItem();
    const res = await GET(getReq(LOOM_ID), params(LOOM_ID));
    const j = await res.json();
    expect(j.backend).not.toBe('databricks');
    expect(res.status).toBe(501);
  });

  it('Gov (LOOM_CLOUD=il5): auto does NOT pick databricks even with a warehouse pin', async () => {
    vi.stubEnv('LOOM_CLOUD', 'il5');
    vi.stubEnv('LOOM_DATABRICKS_SQL_WAREHOUSE_ID', 'wh-pinned');
    seedItem();
    const res = await GET(getReq(LOOM_ID), params(LOOM_ID));
    expect((await res.json()).backend).not.toBe('databricks');
    expect(res.status).toBe(501);
  });

  it('Gov control: an EXPLICIT LOOM_SEMANTIC_RLS_BACKEND=databricks is still honoured', async () => {
    // Pins the guard's scope to `auto`: breaks if it is moved onto hasDbx itself.
    vi.stubEnv('LOOM_CLOUD', 'gcc-high');
    vi.stubEnv('LOOM_SEMANTIC_RLS_BACKEND', 'databricks');
    seedItem();
    const res = await GET(getReq(LOOM_ID), params(LOOM_ID));
    expect(res.status).toBe(200);
    expect((await res.json()).backend).toBe('databricks');
  });

  it('PUT deploys on the RESOLVED warehouse id', async () => {
    seedItem();
    const { executeStatement } = await import('@/lib/azure/databricks-client');
    const res = await PUT(putReq(LOOM_ID, { roles: [{
      name: 'West', modelPermission: 'read',
      tablePermissions: [{ name: 'dbo.Sales', filterExpression: '[Region] = "West"' }],
      members: [{ memberName: 'ops@contoso.com' }],
    }] }), params(LOOM_ID));
    expect(res.status).toBe(200);
    // Breaks if the route reads process.env again: it would pass '' as the warehouse.
    expect((executeStatement as any).mock.calls[0][0]).toBe('wh-resolved');
  });

  it('#4776: each DDL step runs through the self-healing wrapper (a re-resolved id reaches executeStatement)', async () => {
    seedItem();
    const { executeStatement } = await import('@/lib/azure/databricks-client');
    // The wrapper re-resolved after the first id turned out to be gone.
    withResolvedMock.mockImplementation(async (fn: (id: string) => Promise<unknown>) => fn('wh-healed'));
    const res = await PUT(putReq(LOOM_ID, { roles: [{
      name: 'West', modelPermission: 'read',
      tablePermissions: [{ name: 'dbo.Sales', filterExpression: '[Region] = "West"' }],
      members: [{ memberName: 'ops@contoso.com' }],
    }] }), params(LOOM_ID));
    expect(res.status).toBe(200);
    // Breaks if the loop calls executeStatement with the id it resolved up front
    // ('wh-resolved') instead of going through withResolvedWarehouse.
    const ids = (executeStatement as any).mock.calls.map((c: unknown[]) => c[0]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set(['wh-healed']));
  });

  it('#4776: test-as-role runs its SELECT through the self-healing wrapper', async () => {
    seedItem([{ name: 'West', members: [], tablePermissions: [{ table: 'Sales', filterExpression: '[Region] = "West"' }] }]);
    const { executeStatement } = await import('@/lib/azure/databricks-client');
    withResolvedMock.mockImplementation(async (fn: (id: string) => Promise<unknown>) => fn('wh-healed'));
    const res = await POST(testReq(LOOM_ID, { roleName: 'West', effectiveUserName: 'ops@contoso.com' }), params(LOOM_ID));
    expect(res.status).toBe(200);
    // Breaks if the SELECT goes back to executeStatement(await resolveWarehouseIdOrThrow(), …): 'wh-resolved'.
    expect((executeStatement as any).mock.calls.map((c: unknown[]) => c[0])).toEqual(['wh-healed']);
  });

  // The test UPN replaces current_user() in the compiled predicate. The
  // replacement text is inserted literally: with a STRING replacement,
  // String.prototype.replace expands `$&` (the match), `` $` `` (the text before
  // it) and `$'` (the text after it), so these UPNs would not reach the
  // statement as typed. The expected predicate is built from the real compiler
  // output with split/join, which has no `$` patterns.
  //
  // Kill power, measured on a sandbox copy with the replacer reverted to a
  // string: all three `$` rows go RED. `$'` reaches the replacement text when
  // the UPN ends in `$`: sparkString closes the literal with `'`, so the text
  // ends `$'`, and a string replacement substitutes the text after the match
  // (here empty) for it, dropping the closing quote.
  it.each([
    ['positive control: a plain UPN', 'ops@contoso.com'],
    ['`$&` in the UPN', 'a$&b@contoso.com'],
    ['`$`` in the UPN', 'a$`b@contoso.com'],
    ["`$'` (a UPN ending in `$`)", 'svc@contoso.com$'],
  ])('test-as-role: %s is carried into the SELECT exactly', async (_n, upn) => {
    const dax = '[Owner] = USERPRINCIPALNAME()';
    seedItem([{ name: 'Own', members: [], tablePermissions: [{ table: 'Sales', filterExpression: dax }] }]);
    const { executeStatement } = await import('@/lib/azure/databricks-client');
    const { daxFilterToDatabricksSql, sparkString } = await import('@/lib/azure/rls-compiler');
    const compiled = daxFilterToDatabricksSql(dax).sql;
    expect(compiled).toContain('current_user()');
    const res = await POST(testReq(LOOM_ID, { roleName: 'Own', effectiveUserName: upn }), params(LOOM_ID));
    expect(res.status).toBe(200);
    const stmt = String((executeStatement as any).mock.calls[0][1]);
    const literal = sparkString(upn);
    // Breaks with `.replace(re, sparkString(upn))`: `$&` re-inserts
    // current_user(), `` $` `` splices the compiled SQL before the match into
    // the literal, and `$'` (UPN ending in `$`) drops the closing quote.
    expect(stmt).toContain(`WHERE (${compiled.split('current_user()').join(literal)}) LIMIT 100;`);
    expect(stmt).not.toContain('current_user()');
  });

  it('PUT reports a classified resolution failure (403 permission), roles still persisted', async () => {
    seedItem();
    const { WarehouseResolutionError } = await import('@/lib/azure/databricks-sql-warehouse');
    resolveWarehouseMock.mockRejectedValueOnce(new WarehouseResolutionError({
      kind: 'permission', step: 'create', status: 403, message: 'refused', remediation: 'grant allow-cluster-create', entitlement: 'allow-cluster-create',
    }));
    const res = await PUT(putReq(LOOM_ID, { roles: [{
      name: 'West', modelPermission: 'read',
      tablePermissions: [{ name: 'dbo.Sales', filterExpression: '[Region] = "West"' }],
      members: [{ memberName: 'ops@contoso.com' }],
    }] }), params(LOOM_ID));
    // Breaks if the failure is swallowed into per-step "FAILED" lines under a 200.
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j).toMatchObject({ ok: false, kind: 'permission', entitlement: 'allow-cluster-create', persisted: true });
  });
});
