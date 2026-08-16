/**
 * GHSA-v2g8-gp3r-rg4r — RESIDUAL POPULATION, tapestry family (link / geo /
 * timeline).
 *
 * Tapestry is the THIRD editor family reading the same materialized
 * `Node_*`/`Edge_*` ADX tables as `graph-model` and `gql-graph`. #3600 fixed
 * those two and did not reach this one, so all three tapestry panes still
 * carried the advisory's shape verbatim: `_ctx` accepted and never read,
 * `getSession()` as the only check, and
 * `String(body?.database || defaultDatabase())` straight into
 * `discoverGraphTables` + `executeQuery` as the Console's UAMI, which reaches
 * every database on the shared cluster.
 *
 * The advisory's own note is why all three are bound in one change rather than
 * one at a time: fixing a single sibling "does not remove the read primitive, it
 * relocates which URL carries it".
 *
 * WHY THERE IS NO `crossDatabaseReference` ASSERTION HERE, stated so its absence
 * is not read as an oversight: unlike `gql-graph/[id]/query`, none of these
 * routes concatenates caller-authored KQL. Every fragment comes from the typed
 * `analysis` / `window` enums, numeric bounds, or ids already refused by
 * `isSafeId`, so there is no text through which a `database(…)` qualifier could
 * arrive. `discoverGraphTables` is the only ADX call that takes the coordinate,
 * and it is now called with the bound name.
 *
 * MUTATION PROOF — applied to the routes, whole FILE run, reverted. Each turns
 * this file RED:
 *   1. link — restore `const db = String(body?.database || defaultDatabase())`
 *        → "link refuses a foreign database" FAILS and `discoverGraphTables` is
 *          reached with the victim name. tsc-clean (exit 0).
 *   2. geo — same restoration → "geo refuses a foreign database" FAILS.
 *   3. timeline — same restoration → "timeline refuses a foreign database" FAILS.
 *   4. any one route — drop `if (guard.res) return guard.res;`
 *        → the matching "a denied caller never reaches ADX" leg FAILS.
 *   5. link — move the `scopeAdxDatabase` call BELOW `discoverGraphTables`
 *        → "the binding happens BEFORE the discovery probe" FAILS: the refusal
 *          status is still 403 but ADX was already touched with the foreign
 *          name, which is a disclosure (does that database exist? does it hold a
 *          graph?) even when the response is a refusal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

/**
 * A tapestry item declares no database of its own — the editor's "ADX database
 * (optional)" field is ephemeral UI state, never persisted — so it resolves to
 * the deployment default, exactly as the shipped route did when the field was
 * left blank. `graphdb` is a graph-model SIBLING in the same workspace, which is
 * what makes a non-empty pick legitimate at all. `victimdb` is another tenant's.
 */
const DEFAULT_DB = 'loomdb-default';
const SIBLING_DB = 'graphdb';
const VICTIM_DB = 'victimdb';

const ITEM: any = {
  id: 'tap-1',
  itemType: 'tapestry',
  workspaceId: 'ws-1',
  displayName: 'Case 42',
  state: {},
};
const SIBLING: any = {
  id: 'gm-1',
  itemType: 'graph-model',
  workspaceId: 'ws-1',
  displayName: 'Fraud graph',
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

const kusto = vi.hoisted(() => {
  class FakeKustoError extends Error {
    status: number;
    constructor(message: string, status = 502) { super(message); this.status = status; }
  }
  return {
    KustoError: FakeKustoError,
    kustoConfigGate: vi.fn(() => null as any),
    defaultDatabase: vi.fn(() => 'loomdb-default'),
    executeQuery: vi.fn(async () => ({
      columns: ['Id', 'Name', 'Label', 'Latitude', 'Longitude', 'Source', 'Target'],
      rows: [['n1', 'Ada', 'Person', 51.5, -0.1, 'n1', 'n2']],
    })),
  };
});
vi.mock('@/lib/azure/kusto-client', () => kusto);

/**
 * `discoverGraphTables` is the FIRST ADX call each pane makes, so it is the
 * probe that must never see an unbound name. Kept as a spy for that reason.
 */
const tapestry = vi.hoisted(() => ({
  discoverGraphTables: vi.fn(async () => ({
    nodeTables: ['Node_Person'],
    edgeTables: ['Edge_Knows'],
  })),
  buildGraphPrelude: vi.fn(() => 'let G = …;'),
  buildLinkKql: vi.fn(() => 'G | graph-match (a)-[e]->(b) project a, e, b'),
  buildGeoKql: vi.fn(() => 'Node_Person | project Id, Name, Label, Latitude, Longitude'),
  buildTimelineKql: vi.fn(() => 'Edge_Knows | summarize count() by bin(ts, 1d)'),
  isSafeId: vi.fn((v: string) => /^[A-Za-z0-9_\-.]+$/.test(v)),
  TIMELINE_WINDOWS: { hour: '1h', day: '1d', week: '7d' },
}));
vi.mock('@/lib/azure/tapestry-graph', () => tapestry);

import { POST as linkPOST } from '../link/route';
import { POST as geoPOST } from '../geo/route';
import { POST as timelinePOST } from '../timeline/route';

const ctx = { params: Promise.resolve({ id: 'tap-1' }) } as any;

function req(body: any = {}) {
  const url = new URL('http://x/');
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}

const EXPECTED_READ_GUARD = {
  workspaceId: null,
  itemId: 'tap-1',
  itemType: 'tapestry',
  notFound: 'tapestry not found',
  allowReadRoles: true,
};

/** Every pane, so a fix that lands on two of three cannot read as green. */
const PANES: Array<[string, (r: any, c: any) => Promise<Response>]> = [
  ['link', linkPOST as any],
  ['geo', geoPOST as any],
  ['timeline', timelinePOST as any],
];

beforeEach(() => {
  vi.clearAllMocks();
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  kusto.kustoConfigGate.mockReturnValue(null as any);
  tapestry.discoverGraphTables.mockResolvedValue({
    nodeTables: ['Node_Person'], edgeTables: ['Edge_Knows'],
  } as any);
  tapestry.isSafeId.mockImplementation((v: string) => /^[A-Za-z0-9_\-.]+$/.test(v));
  cosmos.byId = [ITEM];
  cosmos.byWorkspace = [ITEM, SIBLING];
});

describe.each(PANES)('tapestry [id]/%s', (name, handler) => {
  it('a denied caller never reaches ADX', async () => {
    const { NextResponse } = await import('next/server');
    guard.authorizeItemWorkspace.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'tapestry not found' }, { status: 404 }) as any,
    );
    const res = await handler(req({ analysis: 'pattern', database: SIBLING_DB }), ctx);
    expect(res.status).toBe(404);
    expect(tapestry.discoverGraphTables).not.toHaveBeenCalled();
    expect(kusto.executeQuery).not.toHaveBeenCalled();
  });

  it('admits shared read roles — these panes only query', async () => {
    await handler(req({ analysis: 'pattern' }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_READ_GUARD);
  });

  it(`${name} refuses a foreign database`, async () => {
    const res = await handler(req({ analysis: 'pattern', database: VICTIM_DB }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not bound to any item in this workspace/i);
    expect(kusto.executeQuery).not.toHaveBeenCalled();
  });

  it('the binding happens BEFORE the discovery probe', async () => {
    // A refusal issued AFTER `discoverGraphTables` would still leak whether the
    // named database exists and whether it holds a materialized graph.
    await handler(req({ analysis: 'pattern', database: VICTIM_DB }), ctx);
    expect(tapestry.discoverGraphTables).not.toHaveBeenCalled();
  });

  it('an id naming no tapestry is refused, not fallen through to ADX', async () => {
    cosmos.byId = [];
    const res = await handler(req({ analysis: 'pattern' }), ctx);
    expect(res.status).toBe(404);
    expect(kusto.executeQuery).not.toHaveBeenCalled();
  });

  it('an EMPTY database (the editor default) resolves to the item’s own', async () => {
    const res = await handler(req({ analysis: 'pattern' }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).database).toBe(DEFAULT_DB);
    expect(tapestry.discoverGraphTables).toHaveBeenCalledWith(DEFAULT_DB);
  });

  it('a SIBLING graph-model’s database in the same workspace is admitted', async () => {
    const res = await handler(req({ analysis: 'pattern', database: SIBLING_DB }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).database).toBe(SIBLING_DB);
    expect(kusto.executeQuery).toHaveBeenCalledWith(SIBLING_DB, expect.any(String));
  });
});

describe('the panes still do their job for a legitimate owner', () => {
  it('link returns graph rows', async () => {
    const res = await linkPOST(req({ analysis: 'pattern', database: SIBLING_DB }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('adx');
    expect(j.graph).toEqual({ nodeTables: ['Node_Person'], edgeTables: ['Edge_Knows'] });
    expect(j.rows).toHaveLength(1);
  });

  it('geo returns a GeoJSON FeatureCollection', async () => {
    const res = await geoPOST(req({ database: SIBLING_DB }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.count).toBe(1);
    expect(j.featureCollection.features[0].geometry.coordinates).toEqual([-0.1, 51.5]);
  });

  it('timeline returns binned rows', async () => {
    const res = await timelinePOST(req({ window: 'week', database: SIBLING_DB }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.window).toBe('week');
    expect(tapestry.buildTimelineKql).toHaveBeenCalledWith(['Edge_Knows'], 'week');
  });

  it('link still rejects an unsafe id BEFORE touching ADX', async () => {
    const res = await linkPOST(
      req({ analysis: 'neighbors', sourceId: "x' | union database('victimdb').Secrets //" }), ctx,
    );
    expect(res.status).toBe(400);
    expect(kusto.executeQuery).not.toHaveBeenCalled();
  });
});
