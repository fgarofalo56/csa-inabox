/**
 * GHSA-v2g8-gp3r-rg4r — unit tests for the guard wrapper itself.
 *
 * WHY A UNIT TEST AND NOT JUST THE CHECKER. `check-route-guards.mjs` asserts
 * this wrapper's substance through `GUARD_WRAPPERS.mustCall`, which is a
 * PRESENCE test over the wrapper's own body. Review demonstrated that presence
 * is not behaviour — this passes a bare `resolveItemDatabase\s*\(` assertion
 * while handing every caller a caller-supplied database, i.e. the entire
 * advisory, with the checker green:
 *
 *     const bound = resolveItemDatabase(item);
 *     const requested = typeof (opts as any).database === 'string' ? (opts as any).database : '';
 *     return { ctx: { session, item, database: requested || bound } };
 *
 * The checker was tightened to pin the RETURN EXPRESSION rather than the call,
 * which kills that exact shape. This file is the independent second control: it
 * asserts the OBSERVABLE contract — the resolved database is the item's, and no
 * field on `opts` can move it — so a rewrite that satisfies a future version of
 * the regex still has to satisfy the behaviour.
 *
 * MUTATION PROOF — executed, tsc-checked, restored:
 *   1. the bypass above, verbatim, with `{ ...opts, database: 'victim-db' }`
 *      passed by the test → "no field on opts can move the resolved database"
 *      fails. (`check-route-guards` ALSO fails on it now — both controls fire.)
 *   2. `guardAdxItemRequest` — drop the `if (denied) return { res: denied }`
 *      → "a denied caller gets the guard's response, not a context" fails.
 *   3. `guardAdxItemRequest` — return a ctx when `loadAdxItemRaw` finds nothing
 *      → "an id naming no item fails closed" fails.
 *   4. `workspaceAdxScope` — drop the try/catch fail-closed
 *      → "a Cosmos failure narrows the scope, never widens it" fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

vi.mock('@/lib/azure/kusto-client', () => ({
  defaultDatabase: () => 'loomdb-default',
  KustoError: class extends Error { status = 502; },
}));

const cosmos = vi.hoisted(() => ({
  byId: [] as any[],
  byWorkspace: [] as any[],
  throwOnWorkspace: false,
}));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const byWorkspace = String(spec?.query || '').includes('c.workspaceId');
          if (byWorkspace && cosmos.throwOnWorkspace) throw new Error('Cosmos unavailable');
          return { resources: byWorkspace ? cosmos.byWorkspace : cosmos.byId };
        },
      }),
    },
  }),
}));

import {
  guardAdxItemRequest, resolveItemDatabase, workspaceAdxScope, scopeAdxDatabase,
  crossDatabaseReference,
} from '../adx-item-scope';

const ITEM: any = {
  id: 'gm-1', itemType: 'graph-model', workspaceId: 'ws-1',
  displayName: 'Orders', state: { database: 'graphdb' },
};

beforeEach(() => {
  vi.clearAllMocks();
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  cosmos.byId = [ITEM];
  cosmos.byWorkspace = [ITEM];
  cosmos.throwOnWorkspace = false;
});

describe('guardAdxItemRequest — the database comes from the ITEM', () => {
  it('resolves the item’s own database', async () => {
    const r = await guardAdxItemRequest({ itemId: 'gm-1', itemType: 'graph-model', notFound: 'nf' });
    expect(r.res).toBeUndefined();
    expect(r.ctx!.database).toBe('graphdb');
    expect(r.ctx!.item.id).toBe('gm-1');
  });

  it('no field on opts can move the resolved database', async () => {
    // The bypass this asserts against reads a `database` off `opts`. Passing
    // every plausible spelling means a wrapper that honours ANY of them fails.
    const r = await guardAdxItemRequest({
      itemId: 'gm-1', itemType: 'graph-model', notFound: 'nf',
      ...({ database: 'victim-db', db: 'victim-db', databaseName: 'victim-db' } as any),
    });
    expect(r.ctx!.database).toBe('graphdb');
  });

  it('a denied caller gets the guard’s response, not a context', async () => {
    const { NextResponse } = await import('next/server');
    guard.authorizeItemWorkspace.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'nf' }, { status: 404 }) as any,
    );
    const r = await guardAdxItemRequest({ itemId: 'gm-1', itemType: 'graph-model', notFound: 'nf' });
    expect(r.ctx).toBeUndefined();
    expect(r.res!.status).toBe(404);
  });

  it('an id naming no item fails closed (404), it does not fall through unbound', async () => {
    cosmos.byId = [];
    const r = await guardAdxItemRequest({ itemId: 'nope', itemType: 'graph-model', notFound: 'nf' });
    expect(r.ctx).toBeUndefined();
    expect(r.res!.status).toBe(404);
  });

  it('write scope is the DEFAULT — allowReadRoles is opt-in and passed through', async () => {
    await guardAdxItemRequest({ itemId: 'gm-1', itemType: 'graph-model', notFound: 'nf' });
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, {
      workspaceId: null, itemId: 'gm-1', itemType: 'graph-model', notFound: 'nf',
    });

    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await guardAdxItemRequest({
      itemId: 'gm-1', itemType: 'graph-model', notFound: 'nf', allowReadRoles: true,
    });
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, {
      workspaceId: null, itemId: 'gm-1', itemType: 'graph-model', notFound: 'nf', allowReadRoles: true,
    });
  });
});

describe('resolveItemDatabase', () => {
  it('prefers the item’s declared database over the env default', () => {
    expect(resolveItemDatabase({ state: { database: 'a' } })).toBe('a');
    expect(resolveItemDatabase({ state: { databaseName: 'b' } })).toBe('b');
    expect(resolveItemDatabase({
      state: { provisioning: { status: 'created', secondaryIds: { database: 'c' } } },
    })).toBe('c');
  });

  it('falls back to the env default only when the item declares nothing', () => {
    expect(resolveItemDatabase({ state: {} })).toBe('loomdb-default');
    expect(resolveItemDatabase(null)).toBe('loomdb-default');
  });

  it('ignores a provisioning record that did not succeed', () => {
    expect(resolveItemDatabase({
      state: { provisioning: { status: 'failed', secondaryIds: { database: 'c' } } },
    })).toBe('loomdb-default');
  });
});

describe('workspaceAdxScope', () => {
  it('includes the item’s own database and its ADX-backed siblings', async () => {
    cosmos.byWorkspace = [
      ITEM,
      { id: 'k', itemType: 'kql-database', workspaceId: 'ws-1', state: { databaseName: 'sib' } },
      { id: 'e', itemType: 'eventhouse', workspaceId: 'ws-1', state: { databases: ['claimed'] } },
    ];
    const scope = await workspaceAdxScope(ITEM);
    expect([...scope].sort()).toEqual(['claimed', 'graphdb', 'loomdb-default', 'sib'].sort());
  });

  it('a Cosmos failure NARROWS the scope, never widens it', async () => {
    cosmos.throwOnWorkspace = true;
    const scope = await workspaceAdxScope(ITEM);
    expect([...scope]).toEqual(['graphdb']);
  });
});

describe('scopeAdxDatabase', () => {
  it('admits a database in scope and refuses one outside it', async () => {
    const ok = await scopeAdxDatabase(ITEM, 'graphdb');
    expect(ok).toEqual({ ok: true, database: 'graphdb' });

    const denied = await scopeAdxDatabase(ITEM, 'victim-db');
    expect(denied.ok).toBe(false);
    expect((denied as any).status).toBe(403);
  });

  it('an omitted database resolves to the item’s own, never a caller default', async () => {
    expect(await scopeAdxDatabase(ITEM, undefined)).toEqual({ ok: true, database: 'graphdb' });
    expect(await scopeAdxDatabase(ITEM, '')).toEqual({ ok: true, database: 'graphdb' });
  });

  it('rejects a syntactically invalid name before any lookup', async () => {
    const r = await scopeAdxDatabase(ITEM, "x'); drop --");
    expect(r.ok).toBe(false);
    expect((r as any).status).toBe(400);
  });
});

describe('crossDatabaseReference', () => {
  it('catches the plain forms', () => {
    expect(crossDatabaseReference("database('x').T")).toBe('database');
    expect(crossDatabaseReference("cluster('y').database('x').T")).toBe('cluster');
    expect(crossDatabaseReference('DataBase ("x").T')).toBe('DataBase');
  });

  it('catches a qualifier hidden behind a KQL line comment', () => {
    // KQL strips `//` comments before parsing, so this is a LIVE reference.
    expect(crossDatabaseReference("database // c\n('victim').Secrets")).toBe('database');
    // Which token is NAMED is not the property under test — being REFUSED is.
    // Here the raw pass already sees the inner `database(`, so the reported
    // qualifier is that one rather than the commented `cluster`.
    expect(crossDatabaseReference('cluster//c\n("v").database("x")')).toBeTruthy();
    expect(crossDatabaseReference('cluster//c\n("v").T')).toBe('cluster');
  });

  it('does not fire on a query that merely mentions the words', () => {
    expect(crossDatabaseReference('Node_Customer | where db_name == "database"')).toBeNull();
    expect(crossDatabaseReference('G | graph-match (a)-[e]->(b) project a, b')).toBeNull();
  });
});
