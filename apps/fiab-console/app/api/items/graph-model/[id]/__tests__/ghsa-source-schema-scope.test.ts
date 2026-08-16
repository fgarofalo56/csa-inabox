/**
 * GHSA-v2g8-gp3r-rg4r — RESIDUAL POPULATION, `graph-model/[id]/source-schema`.
 *
 * WHY THIS ROUTE, SPECIFICALLY. #3600 bound the SOURCE coordinates that
 * `[id]/materialize` consumes (`sourceDatabase` → `workspaceAdxScope`,
 * `sourceTable` → that database's own `.show tables`). It did not touch the
 * PICKER that produces those coordinates, and the picker was the reconnaissance
 * half of the same primitive:
 *
 *   - no params        → `.show databases` — the name of EVERY database on the
 *     shared cluster. Nothing else in the item routes enumerates the victim set;
 *     before this route an attacker had to GUESS a database name.
 *   - ?database        → `.show tables` for any one of them.
 *   - ?database&?table → the full column schema of any table on the cluster.
 *
 * Behind `getSession()` alone, with `_ctx` accepted and never read, as the
 * Console's UAMI. Leaving it open also left the picker offering choices its own
 * consumer would refuse — a UI that hands the user a 403.
 *
 * The list is now `workspaceAdxScope(item)` and the picks are bound with
 * `scopeAdxDatabase` against that SAME set, so picker and consumer agree by
 * construction rather than by review.
 *
 * MUTATION PROOF — applied to the route, whole FILE run, reverted. Each turns
 * this file RED:
 *   1. restore `const databases = await listDatabases()` for the no-param case
 *        → "the database list is the WORKSPACE's, never `.show databases`" FAILS.
 *   2. use the raw `?database` instead of `scoped.database`
 *        → "refuses listing tables in a foreign database" and "refuses the
 *          COLUMN schema of a foreign table" FAIL. tsc-clean (exit 0).
 *   3. drop `if (guard.res) return guard.res;`
 *        → "a denied caller never reaches ADX" FAILS.
 *   4. drop `allowReadRoles: true`
 *        → "the picker admits shared read roles" FAILS on the missing key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

const OWN_DB = 'graphdb';
const SIBLING_DB = 'salesdb';
const VICTIM_DB = 'victimdb';

const ITEM: any = {
  id: 'gm-1',
  itemType: 'graph-model',
  workspaceId: 'ws-1',
  displayName: 'Fraud graph',
  state: { database: OWN_DB },
};
const SIBLING: any = {
  id: 'kql-9',
  itemType: 'kql-database',
  workspaceId: 'ws-1',
  displayName: 'Sales',
  state: { databaseName: SIBLING_DB },
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

const kusto = vi.hoisted(() => {
  class FakeKustoError extends Error {
    status: number;
    constructor(message: string, status = 502) { super(message); this.status = status; }
  }
  const tablesByDb: Record<string, string[]> = {
    graphdb: ['Node_Person', 'Edge_Knows'],
    salesdb: ['Orders'],
    victimdb: ['Customers', 'Secrets'],
  };
  return {
    KustoError: FakeKustoError,
    tablesByDb,
    kustoConfigGate: vi.fn(() => null as any),
    defaultDatabase: vi.fn(() => 'loomdb-default'),
    listTables: vi.fn(async (db: string) => (tablesByDb[db] || []).map((name) => ({ name }))),
    // Present so a regression that reinstates cluster enumeration is OBSERVABLE
    // as a call, not merely as different output.
    listDatabases: vi.fn(async () => Object.keys(tablesByDb).map((name) => ({ name }))),
    getTableSchema: vi.fn(async () => ({ OrderedColumns: [{ Name: 'id', CslType: 'System.String' }] })),
  };
});
vi.mock('@/lib/azure/kusto-client', () => kusto);

import { GET } from '../source-schema/route';

const ctx = { params: Promise.resolve({ id: 'gm-1' }) } as any;

function req(query: Record<string, string> = {}) {
  const url = new URL('http://x/');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return { url: url.toString(), nextUrl: url } as any;
}

const EXPECTED_READ_GUARD = {
  workspaceId: null,
  itemId: 'gm-1',
  itemType: 'graph-model',
  notFound: 'graph model not found',
  allowReadRoles: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  kusto.kustoConfigGate.mockReturnValue(null as any);
  kusto.listTables.mockImplementation(
    async (db: string) => (kusto.tablesByDb[db] || []).map((name) => ({ name })),
  );
  cosmos.byId = [ITEM];
  cosmos.byWorkspace = [ITEM, SIBLING];
});

describe('layer 1 — caller authorization', () => {
  it('a denied caller never reaches ADX', async () => {
    const { NextResponse } = await import('next/server');
    guard.authorizeItemWorkspace.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'graph model not found' }, { status: 404 }) as any,
    );
    expect((await GET(req(), ctx)).status).toBe(404);
    expect((await GET(req({ database: VICTIM_DB }), ctx)).status).toBe(404);
    expect(kusto.listDatabases).not.toHaveBeenCalled();
    expect(kusto.listTables).not.toHaveBeenCalled();
    expect(kusto.getTableSchema).not.toHaveBeenCalled();
  });

  it('the picker admits shared read roles', async () => {
    await GET(req(), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_READ_GUARD);
  });

  it('an id naming no graph model is refused, not fallen through to ADX', async () => {
    cosmos.byId = [];
    expect((await GET(req({ database: OWN_DB }), ctx)).status).toBe(404);
    expect(kusto.listTables).not.toHaveBeenCalled();
  });
});

describe('layer 2 — the addressable set is the workspace, not the cluster', () => {
  it('the database list is the WORKSPACE’s, never `.show databases`', async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    const names = j.databases.map((d: any) => d.name);
    expect(names).toEqual([OWN_DB, SIBLING_DB].sort());
    expect(names).not.toContain(VICTIM_DB);
    // The cluster enumeration must not merely be filtered — it must not RUN.
    expect(kusto.listDatabases).not.toHaveBeenCalled();
  });

  it('refuses listing tables in a foreign database', async () => {
    const res = await GET(req({ database: VICTIM_DB }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not bound to any item in this workspace/i);
    expect(kusto.listTables).not.toHaveBeenCalled();
  });

  it('refuses the COLUMN schema of a foreign table', async () => {
    const res = await GET(req({ database: VICTIM_DB, table: 'Secrets' }), ctx);
    expect(res.status).toBe(403);
    expect(kusto.getTableSchema).not.toHaveBeenCalled();
  });

  it('the picker and [id]/materialize admit the SAME set', async () => {
    // materialize binds `sourceDatabase` with scopeAdxDatabase over
    // workspaceAdxScope(item); anything this picker offers must therefore be
    // accepted there, and anything it refuses must be refused there too.
    const offered = (await (await GET(req(), ctx)).json()).databases.map((d: any) => d.name);
    for (const db of offered) {
      const res = await GET(req({ database: db }), ctx);
      expect(res.status).toBe(200);
    }
    expect(offered).not.toContain(VICTIM_DB);
  });
});

describe('a legitimate owner still succeeds', () => {
  it('lists the graph model’s own tables', async () => {
    const res = await GET(req({ database: OWN_DB }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.database).toBe(OWN_DB);
    expect(j.tables.map((t: any) => t.name)).toEqual(['Node_Person', 'Edge_Knows']);
  });

  it('reads columns from a SIBLING kql-database in the same workspace', async () => {
    const res = await GET(req({ database: SIBLING_DB, table: 'Orders' }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.database).toBe(SIBLING_DB);
    expect(j.columns).toEqual([{ name: 'id', type: 'string' }]);
    expect(kusto.getTableSchema).toHaveBeenCalledWith(SIBLING_DB, 'Orders');
  });

  it('an empty ?database resolves to the item’s own database', async () => {
    const res = await GET(req({ database: '' }), ctx);
    expect(res.status).toBe(200);
    // Empty is the "list databases" branch, and it must still be scoped.
    expect((await res.json()).databases.map((d: any) => d.name)).not.toContain(VICTIM_DB);
  });

  it('the ADX config gate still short-circuits before any authorization leak', async () => {
    kusto.kustoConfigGate.mockReturnValue({ missing: 'LOOM_KUSTO_CLUSTER_URI' } as any);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).gate.remediation).toMatch(/LOOM_KUSTO_CLUSTER_URI/);
  });
});
