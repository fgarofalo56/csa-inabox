/**
 * GHSA-v2g8-gp3r-rg4r — route-level proof that `POST /api/items/lakehouse/[id]/
 * query` authorizes the caller against the lakehouse ITEM.
 *
 * WHAT SHIPPED. The handler signature was
 * `POST(req, _ctx: { params: Promise<{ id: string }> })` — it accepted the route
 * context and IGNORED it, so `[id]` was never read and `getSession()` was the
 * only check. The shared Synapse Serverless endpoint is reached with the
 * Console's own identity, so any signed-in user in any tenant could execute
 * T-SQL through it by hitting any lakehouse id (or a nonexistent one). The
 * target `database` also came from the request body.
 *
 * The existing backend-contract suite for this route (`query.test.ts`) stays
 * as-is and still passes; this file adds only the authorization property.
 *
 * MUTATION PROOF — each is tsc-valid and turns this file RED. Both executed and
 * restored:
 *   1. `[id]/query/route.ts` — drop `if (guard.res) return guard.res;`
 *      (destructure `guard.ctx ?? { … }`)
 *        → "a denied caller never reaches Synapse" and "an id naming no
 *          lakehouse is refused" fail.
 *   2. `[id]/query/route.ts` — take the database from the body again
 *        → "ignores a body-supplied database" fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: vi.fn(async () => null) }));

const ITEM: any = {
  id: 'lh-1',
  itemType: 'lakehouse',
  workspaceId: 'ws-1',
  displayName: 'Bronze lake',
  state: {},
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

// `_lib/adx-item-scope` imports `defaultDatabase` from the kusto client; the
// lakehouse route itself never touches ADX.
vi.mock('@/lib/azure/kusto-client', () => ({
  defaultDatabase: () => 'loomdb-default',
  KustoError: class extends Error { status = 502; },
}));

const synapse = vi.hoisted(() => ({
  executeQuery: vi.fn(async () => ({ columns: ['a'], rows: [[1]], rowCount: 1, executionMs: 4, truncated: false })),
  serverlessTarget: vi.fn((database = 'master') => ({ server: 's', database, cacheKey: `k:${database}` })),
  getSynapseSqlSuffix: () => 'sql.azuresynapse.net',
}));
vi.mock('@/lib/azure/synapse-sql-client', () => synapse);

import { POST } from '../[id]/query/route';

const ctx = { params: Promise.resolve({ id: 'lh-1' }) } as any;
function req(body: any = {}) {
  const url = new URL('http://x/');
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}

/**
 * The exact guard argument. `allowReadRoles: true` is DELIBERATE and asserted:
 * the Serverless SQL analytics endpoint is read-only, so a shared Viewer
 * running a Preview is a legitimate caller — refusing them would break the
 * editor's Preview tab and the entity-diagram column enrichment. Asserting it
 * explicitly means a future edit cannot silently flip the surface's scope in
 * either direction without this test noticing.
 */
const EXPECTED_GUARD = {
  workspaceId: null,
  itemId: 'lh-1',
  itemType: 'lakehouse',
  allowReadRoles: true,
  notFound: 'lakehouse not found',
};

beforeEach(() => {
  vi.clearAllMocks();
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  cosmos.byId = [ITEM];
  cosmos.byWorkspace = [ITEM];
  process.env.LOOM_SYNAPSE_WORKSPACE = 'loomsyn';
});

describe('POST /api/items/lakehouse/[id]/query — caller authorization', () => {
  it('a denied caller never reaches Synapse', async () => {
    const { NextResponse } = await import('next/server');
    guard.authorizeItemWorkspace.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'lakehouse not found' }, { status: 404 }) as any,
    );
    const res = await POST(req({ sql: 'SELECT 1' }), ctx);
    expect(res.status).toBe(404);
    expect(synapse.executeQuery).not.toHaveBeenCalled();
  });

  it('runs the canonical guard with the workspace resolved FROM THE ITEM', async () => {
    await POST(req({ sql: 'SELECT 1' }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_GUARD);
  });

  it('an id naming no lakehouse is refused, not fallen through to Synapse', async () => {
    cosmos.byId = [];
    const res = await POST(req({ sql: 'SELECT 1' }), ctx);
    expect(res.status).toBe(404);
    expect(synapse.executeQuery).not.toHaveBeenCalled();
  });

  it('401 with no session, before the guard runs', async () => {
    const session: any = await import('@/lib/auth/session');
    const spy = vi.spyOn(session, 'getSession').mockReturnValue(null as any);
    try {
      const res = await POST(req({ sql: 'SELECT 1' }), ctx);
      expect(res.status).toBe(401);
      expect(guard.authorizeItemWorkspace).not.toHaveBeenCalled();
      expect(synapse.executeQuery).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('ignores a body-supplied database — the target comes from the ITEM', async () => {
    const res = await POST(req({ sql: 'SELECT 1', database: 'someone-elses-db' }), ctx);
    expect(res.status).toBe(200);
    expect(synapse.serverlessTarget).toHaveBeenCalledWith('master');
    expect((await res.json()).database).toBe('master');
  });

  it('honours a database the ITEM declares', async () => {
    cosmos.byId = [{ ...ITEM, state: { sqlDatabase: 'lakedb' } }];
    const res = await POST(req({ sql: 'SELECT 1' }), ctx);
    expect(res.status).toBe(200);
    expect(synapse.serverlessTarget).toHaveBeenCalledWith('lakedb');
  });

  it('an authorized owner still gets rows back', async () => {
    const res = await POST(req({ sql: 'SELECT TOP 10 * FROM OPENROWSET(...) AS r' }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.columns).toEqual(['a']);
    expect(synapse.executeQuery).toHaveBeenCalledTimes(1);
  });
});
