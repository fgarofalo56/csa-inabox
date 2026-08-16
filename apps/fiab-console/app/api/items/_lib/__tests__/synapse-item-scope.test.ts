/**
 * GHSA-v2g8-gp3r-rg4r (round 3) — unit proof for `_lib/synapse-item-scope.ts`.
 *
 * The route suites exercise this module end to end; this file pins the
 * properties they cannot reach from a handler:
 *   - the RESOLUTION ORDER (provisioning binding wins over a state field, which
 *     wins over the env pool) — because the platform WRITES
 *     `state.provisioning.secondaryIds.database` and a divergence would mean we
 *     gate a database the platform does not use;
 *   - fail-CLOSED on a Cosmos failure, in both directions — the scope must
 *     NARROW to the item's own database, never widen;
 *   - the guard's FAIL-SAFE envelope, which can only ever produce a DENIAL.
 *     This is #3614's M22 lesson: the guard reaches Cosmos, a dependency the
 *     adopting handlers never had, so an unhandled throw would surface as Next's
 *     generic HTML 500 that the editors' `await r.json()` cannot parse. The test
 *     asserts BOTH halves — a structured 500, and that it is not a `ctx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-1', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
const session = vi.hoisted(() => ({ current: null as any }));
vi.mock('@/lib/auth/session', () => ({ getSession: () => session.current }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

const cosmos = vi.hoisted(() => ({
  byId: [] as any[],
  byWorkspace: [] as any[],
  throwOnQuery: false,
  throwOnContainer: false,
}));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => {
    if (cosmos.throwOnContainer) throw new Error('cosmos unreachable');
    return {
      items: {
        query: (spec: any) => ({
          fetchAll: async () => {
            if (cosmos.throwOnQuery) throw new Error('query failed');
            return {
              resources: String(spec?.query || '').includes('c.workspaceId')
                ? cosmos.byWorkspace
                : cosmos.byId,
            };
          },
        }),
      },
    };
  },
}));

import {
  resolveItemSynapseDatabase,
  workspaceSynapseScope,
  scopeSynapseDatabase,
  guardSynapseItemRequest,
} from '../synapse-item-scope';

const POOL = 'dwhpool01';

beforeEach(() => {
  vi.clearAllMocks();
  session.current = SESSION;
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  cosmos.throwOnQuery = false;
  cosmos.throwOnContainer = false;
  cosmos.byId = [];
  cosmos.byWorkspace = [];
  process.env.LOOM_SYNAPSE_DEDICATED_POOL = POOL;
});

describe('resolveItemSynapseDatabase — resolution order', () => {
  it('prefers what the PROVISIONER recorded over any editor-written state field', async () => {
    expect(
      resolveItemSynapseDatabase({
        state: {
          database: 'editor_wrote_this',
          provisioning: { status: 'created', secondaryIds: { database: 'provisioner_wrote_this' } },
        },
      } as any),
    ).toBe('provisioner_wrote_this');
  });

  it('ignores a provisioning binding that did not succeed', () => {
    expect(
      resolveItemSynapseDatabase({
        state: {
          database: 'editor_db',
          provisioning: { status: 'remediation', secondaryIds: { database: 'never_created' } },
        },
      } as any),
    ).toBe('editor_db');
  });

  it('falls back to the env-pinned pool for an item that declares nothing', () => {
    expect(resolveItemSynapseDatabase({ state: {} } as any)).toBe(POOL);
    expect(resolveItemSynapseDatabase(null)).toBe(POOL);
  });

  it('does not THROW when the pool env var is unset — it yields empty', () => {
    // `dedicatedTarget()` throws on a missing env var, and this module is on the
    // authorization path: a config gap must not become a 500 a caller can
    // distinguish from a denial.
    delete process.env.LOOM_SYNAPSE_DEDICATED_POOL;
    expect(resolveItemSynapseDatabase({ state: {} } as any)).toBe('');
    process.env.LOOM_SYNAPSE_DEDICATED_POOL = POOL;
  });

  it('returns NULL for an item type this module does not model', () => {
    /**
     * `guardSynapseItemRequest` is deliberately reused as the backend-agnostic
     * Layer-1 guard by the Databricks/UC and AAS dispatchers. Resolving a
     * `databricks-sql-warehouse` item to the env-pinned SYNAPSE pool would hand
     * a future maintainer reading `ctx.database` a Databricks item pointed at a
     * Synapse database with no error. Null makes that unrepresentable.
     */
    expect(
      resolveItemSynapseDatabase({ itemType: 'databricks-sql-warehouse', state: { database: 'x' } } as any),
    ).toBeNull();
    expect(resolveItemSynapseDatabase({ itemType: 'kql-database', state: {} } as any)).toBeNull();
  });

  it('still resolves for every type it DOES model', () => {
    for (const t of ['warehouse', 'synapse-dedicated-sql-pool', 'synapse-serverless-sql-pool', 'lakehouse', 'semantic-model']) {
      expect(resolveItemSynapseDatabase({ itemType: t, state: {} } as any)).toBe(POOL);
    }
  });
});

describe('workspaceSynapseScope — fails CLOSED', () => {
  const ITEM: any = { id: 'wh-1', itemType: 'warehouse', workspaceId: 'ws-1', state: { database: 'own_db' } };

  it('includes siblings bound in the SAME workspace', async () => {
    cosmos.byWorkspace = [ITEM, { itemType: 'warehouse', workspaceId: 'ws-1', state: { database: 'sib_db' } }];
    const scope = await workspaceSynapseScope(ITEM);
    expect([...scope].sort()).toEqual(['own_db', 'sib_db']);
  });

  it('NARROWS to the item’s own database when the sibling query throws', async () => {
    cosmos.throwOnQuery = true;
    const scope = await workspaceSynapseScope(ITEM);
    expect([...scope]).toEqual(['own_db']);
  });

  it('NARROWS when the container itself is unreachable', async () => {
    cosmos.throwOnContainer = true;
    const scope = await workspaceSynapseScope(ITEM);
    expect([...scope]).toEqual(['own_db']);
  });

  it('does not admit an unrelated item type that happens to carry a database field', async () => {
    // The Cosmos query filters by itemType, so a `kql-database` in the same
    // workspace never widens the SYNAPSE scope. Modelled by the query returning
    // only the types it asked for.
    cosmos.byWorkspace = [ITEM];
    const scope = await workspaceSynapseScope(ITEM);
    expect(scope.has('adx_db')).toBe(false);
  });
});

describe('scopeSynapseDatabase', () => {
  const ITEM: any = { id: 'wh-1', itemType: 'warehouse', workspaceId: 'ws-1', state: { database: 'own_db' } };

  it('blank resolves to the item’s own database (the editor default path)', async () => {
    cosmos.byWorkspace = [ITEM];
    expect(await scopeSynapseDatabase(ITEM, '')).toEqual({ ok: true, database: 'own_db' });
    expect(await scopeSynapseDatabase(ITEM, undefined)).toEqual({ ok: true, database: 'own_db' });
  });

  it('refuses an identifier outside the T-SQL name charset with 400, before any lookup', async () => {
    const r = await scopeSynapseDatabase(ITEM, "x'; DROP DATABASE y--");
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses an out-of-scope database with 403 and names what IS addressable', async () => {
    cosmos.byWorkspace = [ITEM];
    const r = await scopeSynapseDatabase(ITEM, 'tenantB_dw');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.error).toMatch(/not bound to any item in this workspace/i);
      expect(r.error).toContain('own_db');
    }
  });

  it('admits a database the workspace really is bound to', async () => {
    cosmos.byWorkspace = [ITEM, { itemType: 'warehouse', workspaceId: 'ws-1', state: { database: 'sib_db' } }];
    expect(await scopeSynapseDatabase(ITEM, 'sib_db')).toEqual({ ok: true, database: 'sib_db' });
  });

  it('FAILS CLOSED on a blank request from an item type it does not model', async () => {
    // Unreachable from any shipped route, asserted so it stays that way: a
    // non-Synapse item must not silently receive the shared pool.
    const foreign: any = { id: 'x', itemType: 'databricks-sql-warehouse', workspaceId: 'ws-1', state: {} };
    const r = await scopeSynapseDatabase(foreign, '');
    expect(r).toMatchObject({ ok: false, status: 400 });
    if (!r.ok) expect(r.error).toMatch(/not backed by a Synapse SQL database/i);
  });
});

describe('guardSynapseItemRequest', () => {
  const ITEM: any = { id: 'wh-1', itemType: 'warehouse', workspaceId: 'ws-1', state: { database: 'own_db' } };
  const OPTS = { itemId: 'wh-1', itemType: 'warehouse', notFound: 'warehouse not found' };

  it('401s with no session, and never touches Cosmos', async () => {
    session.current = null;
    const r = await guardSynapseItemRequest(OPTS);
    expect(r.ctx).toBeUndefined();
    expect(r.res!.status).toBe(401);
    expect(guard.authorizeItemWorkspace).not.toHaveBeenCalled();
  });

  it('returns the ladder’s denial verbatim', async () => {
    const { NextResponse } = await import('next/server');
    guard.authorizeItemWorkspace.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'warehouse not found' }, { status: 404 }) as any,
    );
    const r = await guardSynapseItemRequest(OPTS);
    expect(r.ctx).toBeUndefined();
    expect(r.res!.status).toBe(404);
  });

  it('FAILS CLOSED on an id naming no item — the ladder’s one permissive case', async () => {
    cosmos.byId = [];
    const r = await guardSynapseItemRequest(OPTS);
    expect(r.ctx).toBeUndefined();
    expect(r.res!.status).toBe(404);
  });

  it('binds the database FROM THE ITEM on success', async () => {
    cosmos.byId = [ITEM];
    const r = await guardSynapseItemRequest(OPTS);
    expect(r.res).toBeUndefined();
    expect(r.ctx!.item.id).toBe('wh-1');
    expect(r.ctx!.database).toBe('own_db');
  });

  it('the fail-safe envelope produces a STRUCTURED denial, never a ctx', async () => {
    cosmos.throwOnContainer = true;
    const r = await guardSynapseItemRequest(OPTS);
    // Never a pass...
    expect(r.ctx).toBeUndefined();
    // ...and parseable JSON, which is the whole point (the editors do
    // `await r.json()`; Next's generic HTML 500 would throw there).
    expect(r.res!.status).toBe(500);
    const j = await r.res!.json();
    expect(j.ok).toBe(false);
  });

  it('threads allowReadRoles ONLY when asked', async () => {
    cosmos.byId = [ITEM];
    await guardSynapseItemRequest(OPTS);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, {
      workspaceId: null, itemId: 'wh-1', itemType: 'warehouse', notFound: 'warehouse not found',
    });
    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await guardSynapseItemRequest({ ...OPTS, allowReadRoles: true });
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, {
      workspaceId: null, itemId: 'wh-1', itemType: 'warehouse', notFound: 'warehouse not found',
      allowReadRoles: true,
    });
  });
});
