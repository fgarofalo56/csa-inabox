/**
 * GHSA-v2g8-gp3r-rg4r — route-level proof that the graph-model ADX family
 * authorizes the caller AND binds every database coordinate it touches.
 *
 * WHAT SHIPPED. `POST [id]/materialize` was
 * `withSession<{ id: string }>(async (req: NextRequest) => …)`: it never bound
 * `session`, never accepted `params`, and never read `[id]`. It then took
 * `const db = String(body?.database || defaultDatabase())` into `.create-merge
 * table` DDL, and `sourceRef(sourceDatabase, sourceTable)` into
 * `.set-or-append <t> <| database('<any db>').['<any table>']` — a
 * CROSS-DATABASE COPY as the Console's UAMI, which reaches every database on
 * the shared cluster. `POST [id]/query` ran on `getSession()` alone and also
 * took `body.database`, so the pair was a complete read primitive: copy any
 * table into a table you own, then read it back.
 *
 * THE DDL IS THE LESSER HALF. The assertions below therefore check the
 * `.set-or-append` SOURCE EXPRESSION, not only which database the command was
 * issued against — a fix that pinned the target database while still emitting
 * `database('victim-db')` in the query body would leave the primitive intact.
 *
 * WHY `toHaveBeenCalledWith` AND NOT `expect.objectContaining` on the guard
 * argument. Part of the property under test is the ABSENCE of a key: the
 * materialize handler ISSUES DDL AND INGESTS, so its guard must stay
 * write-scoped and must never gain `allowReadRoles: true`. `objectContaining`
 * ignores extra keys, so that one-word widening would leave such an assertion
 * green. Deep equality catches it. Do not loosen.
 *
 * MUTATION PROOF — each of these is tsc-valid (exit 0) and turns this file RED.
 * All were executed against this suite and restored:
 *   1. `[id]/materialize/route.ts` — restore the body-supplied target database
 *      (`let db = guard.ctx.database;` … `db = String(body?.database || db);`)
 *        → "ignores a body-supplied target database" fails.
 *   2. `[id]/materialize/route.ts` `resolveSource` — keep the `scopeAdxDatabase`
 *      call but DISCARD its refusal (`scoped.ok ? scoped.database :
 *      String(decl.sourceDatabase)`)
 *        → all three "cross-database .set-or-append" tests fail, including
 *          "refuses a foreign table EVEN WHEN that database really exposes it",
 *          which no table-existence check can rescue.
 *   3. `[id]/materialize/route.ts` — drop `if (guard.res) return guard.res;`
 *        → "a denied caller never reaches ADX", "an id naming no graph model is
 *          refused" and "401 with no session" all fail.
 *   4. `_lib/adx-item-scope.ts` `guardAdxItemRequest` — return
 *      `{ ctx: { session, item: null as any, database: defaultDatabase() } }`
 *      instead of the 404 when the item is missing
 *        → "an id naming no graph model is refused" fails.
 *   5. `_lib/adx-item-scope.ts` `guardAdxItemRequest` — pass
 *      `allowReadRoles: true` unconditionally
 *        → the strict write-scoped guard-shape assertion on materialize fails.
 *   6. `[id]/query/route.ts` — restore `database = String(body?.database ||
 *      database);`
 *        → "query ignores a body-supplied database" fails.
 *   7. `_lib/adx-item-scope.ts` `crossDatabaseReference` — match a token that
 *      cannot occur (the control returns null for real KQL)
 *        → all three "cross-database KQL qualifiers" tests fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: vi.fn(async () => null) }));

/**
 * The graph model under test lives in workspace `ws-1` and targets its OWN
 * database `graphdb`. `siblingdb` is a kql-database item in the SAME workspace —
 * a legitimate cross-database source. `victim-db` belongs to nobody in this
 * workspace: it models another tenant's database on the shared cluster.
 */
const OWN_DB = 'graphdb';
const SIBLING_DB = 'siblingdb';
const VICTIM_DB = 'victim-db';

const ITEM = {
  id: 'gm-1',
  itemType: 'graph-model',
  workspaceId: 'ws-1',
  displayName: 'Orders graph',
  state: { database: OWN_DB },
};
const SIBLING = {
  id: 'kql-1',
  itemType: 'kql-database',
  workspaceId: 'ws-1',
  displayName: 'Sales',
  state: { databaseName: SIBLING_DB },
};

/**
 * Two DIFFERENT Cosmos queries run through this mock: the item point-lookup
 * (`WHERE c.id = @id`) and the workspace sibling scan (`WHERE c.workspaceId`).
 * Dispatching on the query text keeps them independent, so a test can remove
 * the item without also emptying the workspace scope.
 */
const cosmos = vi.hoisted(() => ({
  byId: [] as any[],
  byWorkspace: [] as any[],
}));
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
  /**
   * PER-DATABASE table lists. A flat list for every database would let the
   * TABLE check mask a removed DATABASE check — the foreign table would 404 on
   * "table does not exist" and the suite would look green with the scope gate
   * gone. `victim-db` therefore really does expose `Secrets`, so ONLY the
   * database scope check can stop that binding.
   */
  const tablesByDb: Record<string, string[]> = {
    graphdb: ['Orders', 'Customers'],
    siblingdb: ['Orders', 'Customers'],
    'victim-db': ['Secrets', 'Customers'],
  };
  return {
    KustoError: FakeKustoError,
    tablesByDb,
    // Parameters are declared so `mock.calls[i][0]` is the DATABASE the command
    // ran against — the assertions below read it, and an argument-less vi.fn()
    // types `calls` as `[][]`, which makes those reads a tsc error.
    executeMgmtCommand: vi.fn(async (_db: string, _command: string) => ({ columns: ['RecordCount'], rows: [[3]] })),
    executeQuery: vi.fn(async (_db: string, _kql: string) => ({ columns: ['a'], rows: [[1]], rowCount: 1, executionMs: 2, truncated: false })),
    listTables: vi.fn(async (db: string) => (tablesByDb[db] || []).map((name) => ({ name }))),
    kustoConfigGate: vi.fn(() => null as any),
    defaultDatabase: vi.fn(() => 'loomdb-default'),
  };
});
vi.mock('@/lib/azure/kusto-client', () => kusto);
const FakeKustoError = kusto.KustoError;

import { POST as materializePOST } from '../materialize/route';
import { POST as queryPOST } from '../query/route';

const ctx = { params: Promise.resolve({ id: 'gm-1' }) } as any;

function req(body: any = {}) {
  const url = new URL('http://x/');
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}

/** The EXACT write-scoped guard argument materialize must produce. */
const EXPECTED_WRITE_GUARD = {
  workspaceId: null,
  itemId: 'gm-1',
  itemType: 'graph-model',
  notFound: 'graph model not found',
};
/** The read-only query surface admits shared read roles — and nothing more. */
const EXPECTED_READ_GUARD = { ...EXPECTED_WRITE_GUARD, allowReadRoles: true };

/** Every `.set-or-append` command issued in this test. */
function appendCommands(): string[] {
  return kusto.executeMgmtCommand.mock.calls
    .map((c: any[]) => String(c[1]))
    .filter((cmd) => cmd.startsWith('.set-or-append'));
}

beforeEach(() => {
  vi.clearAllMocks();
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  kusto.kustoConfigGate.mockReturnValue(null);
  kusto.defaultDatabase.mockReturnValue('loomdb-default');
  kusto.listTables.mockImplementation(
    async (db: string) => (kusto.tablesByDb[db] || []).map((name) => ({ name })),
  );
  kusto.executeMgmtCommand.mockResolvedValue({ columns: ['RecordCount'], rows: [[3]] } as any);
  cosmos.byId = [ITEM];
  cosmos.byWorkspace = [ITEM, SIBLING];
});

const NODES = [{
  name: 'Customer',
  properties: [{ name: 'name', type: 'string' }],
  keyColumns: ['id'],
  sourceTable: 'Customers',
}];

// ── LAYER 1 — the caller is authorized against the item ──────────────────────

describe('layer 1 — caller authorization', () => {
  it('a denied caller never reaches ADX (materialize / query)', async () => {
    const { NextResponse } = await import('next/server');
    guard.authorizeItemWorkspace.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'graph model not found' }, { status: 404 }) as any,
    );

    expect((await materializePOST(req({ nodes: NODES }), ctx)).status).toBe(404);
    expect((await queryPOST(req({ gql: 'MATCH (a)-[e]->(b) RETURN a.id' }), ctx)).status).toBe(404);

    expect(kusto.executeMgmtCommand).not.toHaveBeenCalled();
    expect(kusto.executeQuery).not.toHaveBeenCalled();
  });

  it('materialize guards WRITE-scoped — the argument carries no allowReadRoles key', async () => {
    await materializePOST(req({ nodes: NODES }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_WRITE_GUARD);
  });

  it('query guards read-scoped — allowReadRoles and nothing else', async () => {
    await queryPOST(req({ gql: 'MATCH (a)-[e]->(b) RETURN a.id' }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_READ_GUARD);
  });

  it('an id naming no graph model is refused, not fallen through to ADX', async () => {
    cosmos.byId = [];
    const res = await materializePOST(req({ nodes: NODES }), ctx);
    expect(res.status).toBe(404);
    expect(kusto.executeMgmtCommand).not.toHaveBeenCalled();
  });

  it('401 with no session is enforced before anything else', async () => {
    const session: any = await import('@/lib/auth/session');
    const spy = vi.spyOn(session, 'getSession').mockReturnValue(null as any);
    try {
      const res = await materializePOST(req({ nodes: NODES }), ctx);
      expect(res.status).toBe(401);
      expect(guard.authorizeItemWorkspace).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// ── LAYER 2 — the database coordinates are bound to the item ─────────────────

describe('layer 2 — target database binding', () => {
  it('ignores a body-supplied target database — DDL lands in the ITEM’s database', async () => {
    const res = await materializePOST(req({ database: VICTIM_DB, nodes: NODES }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).database).toBe(OWN_DB);
    for (const call of kusto.executeMgmtCommand.mock.calls) {
      expect(call[0]).toBe(OWN_DB);
    }
    expect(kusto.executeMgmtCommand.mock.calls.length).toBeGreaterThan(0);
  });

  it('query ignores a body-supplied database', async () => {
    const res = await queryPOST(req({ database: VICTIM_DB, gql: 'MATCH (a)-[e]->(b) RETURN a.id' }), ctx);
    expect(res.status).toBe(200);
    expect(kusto.executeQuery).toHaveBeenCalledTimes(1);
    expect(kusto.executeQuery.mock.calls[0][0]).toBe(OWN_DB);
    expect((await res.json()).database).toBe(OWN_DB);
  });
});

describe('layer 2 — the cross-database .set-or-append primitive', () => {
  it('refuses a foreign source database — no .set-or-append names it', async () => {
    const res = await materializePOST(
      req({ nodes: [{ ...NODES[0], sourceDatabase: VICTIM_DB, sourceTable: 'Secrets' }] }),
      ctx,
    );
    expect(res.status).toBe(200); // per-binding failures are reported, not fatal
    const j = await res.json();
    expect(j.loaded[0].ok).toBe(false);
    expect(j.loaded[0].error).toMatch(/not bound to any item in this workspace/i);

    // THE PRIMITIVE: no command may reference the foreign database at all.
    for (const cmd of appendCommands()) {
      expect(cmd).not.toContain(VICTIM_DB);
      expect(cmd).not.toMatch(/database\(/);
    }
    expect(appendCommands().length).toBe(0);
  });

  it('refuses a foreign source database on EDGE bindings too', async () => {
    const res = await materializePOST(
      req({
        edges: [{
          name: 'PLACED',
          properties: [],
          originKeyColumns: ['a'],
          targetKeyColumns: ['b'],
          sourceDatabase: VICTIM_DB,
          sourceTable: 'Secrets',
        }],
      }),
      ctx,
    );
    const j = await res.json();
    expect(j.loaded[0].ok).toBe(false);
    expect(j.loaded[0].error).toMatch(/not bound to any item in this workspace/i);
    expect(appendCommands().length).toBe(0);
  });

  it('a source table the resolved database does not expose is refused', async () => {
    const res = await materializePOST(
      req({ nodes: [{ ...NODES[0], sourceTable: 'NotThere' }] }),
      ctx,
    );
    const j = await res.json();
    expect(j.loaded[0].ok).toBe(false);
    expect(j.loaded[0].error).toMatch(/does not exist in database/i);
    expect(appendCommands().length).toBe(0);
  });

  it('refuses a foreign table EVEN WHEN that database really exposes it', async () => {
    // `victim-db` genuinely has a `Secrets` table (see tablesByDb), so the
    // table-existence check cannot be what refuses this — only the database
    // scope check can. This is the assertion that stays red if the scope check
    // is removed and the table check is left in place.
    const res = await materializePOST(
      req({ nodes: [{ ...NODES[0], sourceDatabase: VICTIM_DB, sourceTable: 'Secrets' }] }),
      ctx,
    );
    const j = await res.json();
    expect(j.loaded[0].ok).toBe(false);
    expect(j.loaded[0].error).toMatch(/not bound to any item in this workspace/i);
    expect(appendCommands().length).toBe(0);
  });

  it('fails CLOSED when the source database’s table list cannot be read', async () => {
    kusto.listTables.mockRejectedValue(new FakeKustoError('Forbidden', 403));
    const res = await materializePOST(req({ nodes: NODES }), ctx);
    const j = await res.json();
    expect(j.loaded[0].ok).toBe(false);
    expect(j.loaded[0].error).toMatch(/could not verify source tables/i);
    expect(appendCommands().length).toBe(0);
  });
});

// ── The legitimate owner is NOT refused ──────────────────────────────────────

describe('a legitimate owner still succeeds', () => {
  it('materializes from a table in the model’s own database (no database() qualifier)', async () => {
    const res = await materializePOST(req({ nodes: NODES }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.loaded[0].ok).toBe(true);
    expect(j.loaded[0].rows).toBe(3);
    const [cmd] = appendCommands();
    expect(cmd).toContain(".set-or-append Node_Customer <| ['Customers']");
    expect(cmd).not.toMatch(/database\(/);
  });

  it('materializes from a SIBLING kql-database in the same workspace', async () => {
    const res = await materializePOST(
      req({ nodes: [{ ...NODES[0], sourceDatabase: SIBLING_DB }] }),
      ctx,
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.loaded[0].ok).toBe(true);
    const [cmd] = appendCommands();
    expect(cmd).toContain(`database('${SIBLING_DB}').['Customers']`);
    // ...and the command itself still runs against the model's own database.
    const appendCall = kusto.executeMgmtCommand.mock.calls.find((c: any[]) =>
      String(c[1]).startsWith('.set-or-append'));
    expect(appendCall?.[0]).toBe(OWN_DB);
  });

  it('runs a translated GQL query against the model’s database', async () => {
    const res = await queryPOST(req({ gql: 'MATCH (a)-[e]->(b) RETURN a.id, b.id' }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.mode).toBe('gql');
    expect(kusto.executeQuery.mock.calls[0][0]).toBe(OWN_DB);
  });

  it('runs raw KQL that stays inside the model’s database', async () => {
    const res = await queryPOST(req({ kql: 'Node_Customer | take 10' }), ctx);
    expect(res.status).toBe(200);
    expect(kusto.executeQuery).toHaveBeenCalledWith(OWN_DB, 'Node_Customer | take 10');
  });
});

// ── The raw-KQL escape hatch cannot step out of the pinned database ──────────

describe('cross-database KQL qualifiers', () => {
  it('refuses raw KQL that reaches another database', async () => {
    const res = await queryPOST(req({ kql: `database('${VICTIM_DB}').Secrets | take 100` }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/qualifiers are not allowed/i);
    expect(kusto.executeQuery).not.toHaveBeenCalled();
  });

  it('refuses raw KQL that reaches another CLUSTER', async () => {
    const res = await queryPOST(
      req({ kql: "cluster('other.kusto.windows.net').database('x').T | take 1" }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(kusto.executeQuery).not.toHaveBeenCalled();
  });

  it('refuses the qualifier however it is spaced or cased', async () => {
    for (const kql of ['DataBase ("x").T', 'database\n("x").T | count']) {
      vi.clearAllMocks();
      guard.authorizeItemWorkspace.mockResolvedValue(null as any);
      kusto.kustoConfigGate.mockReturnValue(null);
      const res = await queryPOST(req({ kql }), ctx);
      expect(res.status).toBe(403);
      expect(kusto.executeQuery).not.toHaveBeenCalled();
    }
  });
});
