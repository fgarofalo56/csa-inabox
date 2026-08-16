/**
 * GHSA-v2g8-gp3r-rg4r — `POST /api/items/gql-graph/[id]/query`.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE graph-model SUITE. The first pass at
 * this advisory fixed `graph-model/[id]/query` and left this route — its sibling
 * in the same editor family, on the same shared ADX cluster — untouched, with
 * every tell intact: `_ctx` accepted and ignored, `getSession()` as the only
 * check, `const db = String(body?.database || defaultDatabase())` into
 * `executeQuery`, and the caller's `query` CONCATENATED RAW after the generated
 * prelude.
 *
 * No bypass was required to use it. Point `database` at a graph database you
 * own so the `Node_*`/`Edge_*` discovery is satisfied, then send
 * `database('victim').['Secrets'] | take 100` as `query`. Fixing the sibling
 * alone RELOCATED the read primitive to this URL; it did not remove it. That is
 * the property these tests pin.
 *
 * MUTATION PROOF — each executed against this suite, tsc-checked, restored:
 *   1. `route.ts` — restore `const db = String(body?.database || defaultDatabase())`
 *        → "ignores a body-supplied database" fails.
 *   2. `route.ts` — drop the `crossDatabaseReference` check on the ASSEMBLED text
 *        → "refuses a query that reaches another database" fails and
 *          `executeQuery` is reached with `database('victim-db')` in its text.
 *   3. `route.ts` — drop `if (guard.res) return guard.res;`
 *        → "a denied caller never reaches ADX" fails.
 *   4. `_lib/adx-item-scope.ts` `crossDatabaseReference` — scan only the RAW
 *      text (drop the comment-stripped pass)
 *        → "refuses a qualifier hidden behind a KQL line comment" fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);
vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: vi.fn(async () => null) }));

const OWN_DB = 'graphdb';
const VICTIM_DB = 'victim-db';

const ITEM = {
  id: 'gg-1',
  itemType: 'gql-graph',
  workspaceId: 'ws-1',
  displayName: 'Fraud graph',
  state: { database: OWN_DB },
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
    executeQuery: vi.fn(async (_db: string, _kql: string) => ({ columns: ['a'], rows: [[1]], rowCount: 1, executionMs: 2 })),
    // BOTH databases carry a materialized graph, so the `Node_*`/`Edge_*`
    // discovery check cannot be what refuses the foreign one — only the item
    // binding can.
    listTables: vi.fn(async (_db: string) => [{ name: 'Node_Customer' }, { name: 'Edge_PLACED' }]),
    kustoConfigGate: vi.fn(() => null as any),
    defaultDatabase: vi.fn(() => 'loomdb-default'),
  };
});
vi.mock('@/lib/azure/kusto-client', () => kusto);

import { POST } from '../query/route';

const ctx = { params: Promise.resolve({ id: 'gg-1' }) } as any;
function req(body: any = {}) {
  const url = new URL('http://x/');
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}

const EXPECTED_GUARD = {
  workspaceId: null,
  itemId: 'gg-1',
  itemType: 'gql-graph',
  allowReadRoles: true,
  notFound: 'graph not found',
};

beforeEach(() => {
  vi.clearAllMocks();
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  kusto.kustoConfigGate.mockReturnValue(null);
  kusto.listTables.mockResolvedValue([{ name: 'Node_Customer' }, { name: 'Edge_PLACED' }] as any);
  cosmos.byId = [ITEM];
  cosmos.byWorkspace = [ITEM];
});

describe('layer 1 — caller authorization', () => {
  it('a denied caller never reaches ADX', async () => {
    const { NextResponse } = await import('next/server');
    guard.authorizeItemWorkspace.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'graph not found' }, { status: 404 }) as any,
    );
    const res = await POST(req({ query: 'G | count' }), ctx);
    expect(res.status).toBe(404);
    expect(kusto.listTables).not.toHaveBeenCalled();
    expect(kusto.executeQuery).not.toHaveBeenCalled();
  });

  it('runs the canonical guard with the workspace resolved FROM THE ITEM', async () => {
    await POST(req({ query: 'G | count' }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_GUARD);
  });

  it('an id naming no graph is refused, not fallen through to ADX', async () => {
    cosmos.byId = [];
    expect((await POST(req({ query: 'G | count' }), ctx)).status).toBe(404);
    expect(kusto.executeQuery).not.toHaveBeenCalled();
  });

  it('401 with no session', async () => {
    const session: any = await import('@/lib/auth/session');
    const spy = vi.spyOn(session, 'getSession').mockReturnValue(null as any);
    try {
      expect((await POST(req({ query: 'G | count' }), ctx)).status).toBe(401);
      expect(guard.authorizeItemWorkspace).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('layer 2 — the relocated read primitive', () => {
  it('ignores a body-supplied database', async () => {
    const res = await POST(req({ database: VICTIM_DB, query: 'G | count' }), ctx);
    expect(res.status).toBe(200);
    expect(kusto.listTables).toHaveBeenCalledWith(OWN_DB);
    expect(kusto.executeQuery.mock.calls[0][0]).toBe(OWN_DB);
    expect((await res.json()).database).toBe(OWN_DB);
  });

  it('refuses a query that reaches another database — the whole primitive', async () => {
    const res = await POST(
      req({ database: OWN_DB, query: `database('${VICTIM_DB}').['Secrets'] | take 100` }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/qualifiers are not allowed/i);
    expect(kusto.executeQuery).not.toHaveBeenCalled();
  });

  it('refuses a qualifier hidden behind a KQL line comment', async () => {
    // The engine strips `//` comments before parsing, so this IS a live
    // cross-database reference; `database\s*\(` alone does not span a comment.
    const res = await POST(req({ query: `database // c\n('${VICTIM_DB}').Secrets | take 1` }), ctx);
    expect(res.status).toBe(403);
    expect(kusto.executeQuery).not.toHaveBeenCalled();
  });

  it('refuses a cluster() qualifier', async () => {
    const res = await POST(req({ query: "cluster('other.kusto.windows.net').database('x').T" }), ctx);
    expect(res.status).toBe(403);
    expect(kusto.executeQuery).not.toHaveBeenCalled();
  });
});

describe('a legitimate owner still succeeds', () => {
  it('runs a graph query against the item’s own database', async () => {
    const res = await POST(req({ query: 'G | graph-match (a)-[e]->(b) project a, b' }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('adx');
    expect(j.graph.nodeTables).toEqual(['Node_Customer']);
    const [, executed] = kusto.executeQuery.mock.calls[0];
    expect(executed).toContain('make-graph');
    expect(executed).not.toMatch(/\bdatabase\s*\(/);
  });

  it('the openCypher directive path still works', async () => {
    const res = await POST(req({ mode: 'opencypher', query: 'MATCH (a) RETURN a' }), ctx);
    expect(res.status).toBe(200);
    expect(kusto.executeQuery.mock.calls[0][1]).toContain('#crp query_language=opencypher');
  });

  it('an empty database (no materialized graph) still returns the honest 400', async () => {
    kusto.listTables.mockResolvedValue([] as any);
    const res = await POST(req({ query: 'G | count' }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/No materialized graph found/i);
  });
});
