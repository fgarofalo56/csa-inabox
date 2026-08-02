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
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...(a as [string, string, string])),
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
}));

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
