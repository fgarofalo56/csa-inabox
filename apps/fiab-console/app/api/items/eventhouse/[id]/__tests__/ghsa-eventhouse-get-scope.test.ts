/**
 * GHSA-v2g8-gp3r-rg4r — route-level proof that `GET /api/items/eventhouse/[id]`
 * authorizes the caller AND narrows the cluster-wide database enumeration to the
 * item's own workspace.
 *
 * WHAT SHIPPED. `export async function GET()` — no `ctx` at all, so `[id]` could
 * not be read even in principle. Behind `getSession()` it ran
 * `listDatabasesWithDetails()` → `.show databases details` CLUSTER-WIDE and
 * returned, for every tenant's KQL database: name, total size, retention
 * (SoftDeletePeriod), hot-cache window (DataHotSpan) and table count.
 *
 * WHY THIS ONE MATTERS MORE THAN ITS VERB SUGGESTS. It is the reconnaissance
 * half of the advisory's worst second-pass finding: `[id]/policies` rewrites
 * `.alter database policy retention` on a caller-named database and ADX then
 * ages the victim's data out on its own schedule. #3600/#3614 bound the
 * mutation; this route still handed out the target list AND each target's
 * current retention. Binding one and not the other RELOCATES the primitive.
 *
 * MUTATION PROOF — each applied to the route, this WHOLE file run, then
 * reverted. Recorded per `no-vaporware`/the advisory's own receipt bar; the
 * measured verdicts are in the PR body.
 *   E1  delete `if (guard.res) return guard.res;`     → a denied caller reaches ADX
 *   E2  drop the `.filter((d) => scope.has(d.name))`  → cluster-wide list returns
 *   E3  pass `allowReadRoles: false` (i.e. omit it)   → a Viewer is refused
 *   E4  `guardAdxItemRequest` returns a ctx for a missing item → unbound fall-through
 *
 * NOTE ON MUTATION SHAPE. E2 DELETES the filter rather than substituting an
 * "equal" value, because #3614's M1 was inert exactly that way: a substitution
 * that cannot change behaviour on any admitted path proves nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

const OWN_DB = 'ehdb';
const CREATED_DB = 'createddb';
const SIBLING_DB = 'siblingdb';
const VICTIM_DB = 'victim-db';

const ITEM: any = {
  id: 'eh-1',
  itemType: 'eventhouse',
  workspaceId: 'ws-1',
  displayName: 'Telemetry',
  state: { databaseName: OWN_DB, databases: [CREATED_DB] },
};

const SIBLING: any = {
  id: 'kql-9',
  itemType: 'kql-database',
  workspaceId: 'ws-1',
  displayName: 'Sales',
  state: { databaseName: SIBLING_DB },
};

const cosmos = vi.hoisted(() => ({
  byId: [] as any[],
  byWorkspace: [] as any[],
  /** Make the SIBLING (workspace-scoped) query throw — the fail-closed probe. */
  throwOnWorkspaceQuery: false,
}));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const isWorkspaceQuery = String(spec?.query || '').includes('c.workspaceId');
          if (isWorkspaceQuery && cosmos.throwOnWorkspaceQuery) throw new Error('cosmos down');
          return { resources: isWorkspaceQuery ? cosmos.byWorkspace : cosmos.byId };
        },
      }),
    },
  }),
}));

/**
 * The shared cluster as ADX really answers it: FOUR databases, only three of
 * which any item in ws-1 is bound to. `victim-db` carries the retention +
 * hot-cache + size + table-count fields that make this route a targeting map.
 */
const CLUSTER_DATABASES = [
  { name: OWN_DB, totalSizeMb: 10, retentionDays: 365, hotCacheDays: 31, tableCount: 4 },
  { name: CREATED_DB, totalSizeMb: 2, retentionDays: 90, hotCacheDays: 7, tableCount: 1 },
  { name: SIBLING_DB, totalSizeMb: 5, retentionDays: 30, hotCacheDays: 3, tableCount: 2 },
  { name: VICTIM_DB, totalSizeMb: 900, retentionDays: 3650, hotCacheDays: 90, tableCount: 77 },
];

const kusto = vi.hoisted(() => {
  class FakeKustoError extends Error {
    status: number;
    constructor(message: string, status = 502) { super(message); this.status = status; }
  }
  return {
    KustoError: FakeKustoError,
    clusterUri: vi.fn(() => 'https://adx.example.kusto.windows.net'),
    defaultDatabase: vi.fn(() => 'ehdb'),
    listDatabasesWithDetails: vi.fn(async () => [] as any[]),
  };
});
vi.mock('@/lib/azure/kusto-client', () => kusto);

const arm = vi.hoisted(() => ({
  getKustoClusterArm: vi.fn(async () => ({
    sku: { name: 'Dev(No SLA)_Standard_E2a_v4' },
    optimizedAutoscale: { isEnabled: true, minimum: 2, maximum: 4 },
  })),
}));
vi.mock('@/lib/azure/kusto-arm-client', () => arm);

import { GET } from '../route';

const ctx = { params: Promise.resolve({ id: 'eh-1' }) } as any;
const req = {} as any;

const EXPECTED_READ_GUARD = {
  workspaceId: null,
  itemId: 'eh-1',
  itemType: 'eventhouse',
  notFound: 'eventhouse not found',
  allowReadRoles: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  kusto.listDatabasesWithDetails.mockResolvedValue(CLUSTER_DATABASES as any);
  kusto.clusterUri.mockReturnValue('https://adx.example.kusto.windows.net');
  kusto.defaultDatabase.mockReturnValue(OWN_DB);
  arm.getKustoClusterArm.mockResolvedValue({
    sku: { name: 'Dev(No SLA)_Standard_E2a_v4' },
    optimizedAutoscale: { isEnabled: true, minimum: 2, maximum: 4 },
  } as any);
  cosmos.byId = [ITEM];
  cosmos.byWorkspace = [ITEM, SIBLING];
  cosmos.throwOnWorkspaceQuery = false;
});

// ── LAYER 1 — the caller is authorized against the item ──────────────────────

describe('layer 1 — caller authorization', () => {
  it('a denied caller never reaches ADX', async () => {
    const { NextResponse } = await import('next/server');
    guard.authorizeItemWorkspace.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'eventhouse not found' }, { status: 404 }) as any,
    );
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
    expect(kusto.listDatabasesWithDetails).not.toHaveBeenCalled();
    expect(arm.getKustoClusterArm).not.toHaveBeenCalled();
  });

  it('guards READ-scoped — the editor must open for a Viewer', async () => {
    await GET(req, ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_READ_GUARD);
  });

  it('an id naming no eventhouse is refused, not fallen through to ADX', async () => {
    cosmos.byId = [];
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
    expect(kusto.listDatabasesWithDetails).not.toHaveBeenCalled();
  });
});

// ── LAYER 2 — the enumeration is narrowed to the item's workspace ────────────

describe('layer 2 — the database list is workspace-scoped', () => {
  it('does not disclose a database outside this workspace — name OR metadata', async () => {
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    const names = j.databases.map((d: any) => d.name);
    expect(names).not.toContain(VICTIM_DB);
    // The targeting fields specifically: nothing about the victim leaks, not
    // even its size or its current retention window.
    expect(JSON.stringify(j)).not.toContain(VICTIM_DB);
    expect(JSON.stringify(j)).not.toContain('3650');
    expect(JSON.stringify(j)).not.toContain('77');
  });

  it('returns exactly the databases this workspace is bound to', async () => {
    const res = await GET(req, ctx);
    const j = await res.json();
    expect(j.databases.map((d: any) => d.name).sort()).toEqual(
      [OWN_DB, CREATED_DB, SIBLING_DB].sort(),
    );
  });

  it('fails CLOSED to the item’s own scope when the SIBLING query throws', async () => {
    /**
     * REWRITTEN after review. The first version called
     * `vi.doMock('@/lib/azure/cosmos-client', …)` AFTER the top-level
     * `import { GET } from '../route'`. `vi.doMock` is not hoisted and does not
     * re-evaluate an already-resolved module graph, so the intended throw never
     * fired and the assertion — "victim-db is absent" — was already true from
     * `beforeEach`. It passed identically whether `workspaceAdxScope` failed
     * closed or wide open, i.e. it was decoration.
     *
     * The flag pattern below makes the throw real, and the assertion is now the
     * NARROWING itself: the sibling's database drops out (it could not be read),
     * the item's own two remain, and the victim is still absent. If the catch
     * ever widened instead of narrowing, this fails.
     */
    cosmos.throwOnWorkspaceQuery = true;
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const names = (await res.json()).databases.map((d: any) => d.name);
    expect(names.sort()).toEqual([OWN_DB, CREATED_DB].sort());
    expect(names).not.toContain(SIBLING_DB);
    expect(names).not.toContain(VICTIM_DB);
  });

  it('the fail-closed probe is REAL — the same call without it sees the sibling', async () => {
    // The control for the test above: with the flag off, SIBLING_DB IS present.
    // Without this pair, "sibling absent" could mean the throw fired or could
    // mean the sibling was never in scope to begin with.
    cosmos.throwOnWorkspaceQuery = false;
    const names = (await (await GET(req, ctx)).json()).databases.map((d: any) => d.name);
    expect(names).toContain(SIBLING_DB);
  });
});

// ── The legitimate owner is NOT refused ─────────────────────────────────────

describe('a legitimate owner still gets a working editor', () => {
  it('returns the cluster URI, default database, sku and autoscale', async () => {
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.cluster).toBe('https://adx.example.kusto.windows.net');
    expect(j.defaultDatabase).toBe(OWN_DB);
    expect(j.sku).toEqual({ name: 'Dev(No SLA)_Standard_E2a_v4' });
    expect(j.optimizedAutoscale).toEqual({ isEnabled: true, minimum: 2, maximum: 4 });
  });

  it('keeps every per-database detail field for a database IN scope', async () => {
    const res = await GET(req, ctx);
    const j = await res.json();
    const own = j.databases.find((d: any) => d.name === OWN_DB);
    expect(own).toEqual({
      name: OWN_DB, totalSizeMb: 10, retentionDays: 365, hotCacheDays: 31, tableCount: 4,
    });
  });

  it('an ARM failure still renders databases (best-effort cluster read)', async () => {
    arm.getKustoClusterArm.mockRejectedValue(new Error('no Reader on the cluster'));
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.databases.length).toBe(3);
    expect(j.optimizedAutoscale).toBeNull();
  });

  it('surfaces an ADX failure with its own status, not a generic 500', async () => {
    kusto.listDatabasesWithDetails.mockRejectedValue(new kusto.KustoError('Forbidden', 403));
    const res = await GET(req, ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).ok).toBe(false);
  });
});
