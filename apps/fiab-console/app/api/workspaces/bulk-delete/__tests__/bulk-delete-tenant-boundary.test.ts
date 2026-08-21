/**
 * #3833 — TENANT BOUNDARY on POST /api/workspaces/bulk-delete.
 *
 * THE DEFECT THESE PIN. The route used to resolve each id itself:
 *
 *     let ws = await loadWorkspace(id, tenantId);
 *     if (!ws && admin) ws = await loadWorkspaceAdmin(id);   // NO tenant predicate
 *     if (!ws) { failed.push({ id, error: 'not_found' }); continue; }
 *     if (!admin && ws.createdBy && ws.createdBy !== session.claims.oid) { … }
 *     const receipts = await deleteOne(ws, cascade);
 *
 * For `admin === true` the cross-partition read had no tenant filter, the
 * ownership check underneath was skipped WHOLESALE by `!admin &&`, and the doc
 * went straight into `deleteOne`. A tenant admin holding a workspace GUID from
 * another tenant DESTROYED it — and on `cascade`, tore down its Azure backends.
 *
 * The siblings in this family (#3823/#3825/#3826) were reads or authorize
 * bypasses. This one destroys, so these specs assert on the SURVIVAL OF THE DOC
 * and on `teardownWorkspaceBackends` never being reached — not merely on the
 * response body. A response that says `not_found` while the delete already
 * happened would pass a body-only assertion.
 *
 * They exercise the REAL POST handler with mocked Cosmos (per no-vaporware.md),
 * through the same shared resolver the single-workspace route uses, and they
 * cover the four properties the fix must hold plus the control that admin
 * cleanup of same-tenant UAT debris — this endpoint's whole purpose — still
 * works.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'admin-oid', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

interface FakeItem { id: string; pk: string; doc: any }
function makeContainer(crossPartitionById = false) {
  const store = new Map<string, FakeItem>();
  return {
    _store: store,
    item(id: string, pk: string) {
      const key = `${pk}::${id}`;
      return {
        async read<T>() {
          const it = store.get(key);
          if (!it) { const e: any = new Error('not found'); e.code = 404; throw e; }
          return { resource: it.doc as T };
        },
        async delete() {
          if (!store.has(key)) { const e: any = new Error('nf'); e.code = 404; throw e; }
          store.delete(key);
        },
      };
    },
    items: {
      query(q: any) {
        return {
          async fetchAll() {
            if (crossPartitionById) {
              const idParam = q?.parameters?.find((p: any) => p.name === '@id')?.value;
              const rows = [...store.values()].map((v) => v.doc).filter((d) => !idParam || d.id === idParam);
              return { resources: rows };
            }
            return { resources: [] };
          },
        };
      },
    },
  };
}

const containers = {
  workspaces: makeContainer(true),
  items: makeContainer(false),
  workspaceRoles: makeContainer(false),
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => containers.workspaces,
  itemsContainer: async () => containers.items,
  workspaceRolesContainer: async () => containers.workspaceRoles,
}));

vi.mock('@/lib/azure/loom-search', () => ({
  upsertLoomDoc: vi.fn(),
  deleteLoomDoc: vi.fn(),
  docForWorkspace: (w: any) => ({ id: `ws:${w.id}` }),
}));

vi.mock('@/lib/azure/lineage-gc', () => ({ cleanupWorkspaceMetadata: vi.fn() }));

// The DESTRUCTIVE half of a cascade delete. Spied, never stubbed away silently:
// several specs below assert it was NOT reached for a refused id.
const teardownMock = vi.fn(async () => [] as any[]);
vi.mock('@/lib/azure/resource-teardown', () => ({
  teardownWorkspaceBackends: (...a: any[]) => teardownMock(...(a as [])),
}));

const resolveEffectiveRoleMock = vi.fn(async () => null);
vi.mock('@/lib/azure/workspace-roles-client', () => ({
  resolveEffectiveRole: (...a: any[]) => resolveEffectiveRoleMock(...(a as [])),
}));

const isTenantAdminMock = vi.fn(() => true);
vi.mock('@/lib/auth/feature-gate', () => ({
  isTenantAdmin: (...args: any[]) => isTenantAdminMock(...(args as [])),
}));

/** The Entra tenant the admin session lives in. */
const HOME_TID = 'tid-contoso';
/** A DIFFERENT Entra tenant. Nothing in it may ever be deleted from here. */
const FOREIGN_TID = 'tid-fabrikam';
/** Owner oid for the home-tenant workspaces in the batch-shape matrix. */
const HOME_OWNER = 'alice-oid';
/** Owner oid for the foreign-tenant workspaces — a principal in FOREIGN_TID. */
const FOREIGN_OWNER = 'mallory-oid';

function seedWorkspace(id: string, ownerOid: string, extra: Record<string, unknown> = {}) {
  const doc = {
    id, tenantId: ownerOid, name: `ws-${id}`, createdBy: `${ownerOid}@example.test`,
    createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z', ...extra,
  };
  containers.workspaces._store.set(`${ownerOid}::${id}`, { id, pk: ownerOid, doc });
  return doc;
}

/** True while the workspace doc is still in Cosmos — i.e. NOT destroyed. */
const stillExists = (id: string, ownerOid: string) =>
  containers.workspaces._store.has(`${ownerOid}::${id}`);

const post = async (body: unknown) => {
  const { POST } = await import('@/app/api/workspaces/bulk-delete/route');
  return POST({ json: async () => body } as any);
};

beforeEach(() => {
  for (const c of Object.values(containers)) (c as any)._store.clear();
  getSessionMock.mockReturnValue({
    claims: { oid: 'admin-oid', upn: 'admin@contoso.com', tid: HOME_TID },
    exp: Date.now() / 1000 + 3600,
  } as any);
  isTenantAdminMock.mockReturnValue(true);
  resolveEffectiveRoleMock.mockResolvedValue(null);
  teardownMock.mockClear();
  teardownMock.mockResolvedValue([] as any[]);
  delete process.env.LOOM_MULTIUSER_ACL; // default ON
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('#3833 — a tenant admin cannot bulk-delete across the tenant boundary', () => {
  it('REFUSES a foreign-tenant workspace and LEAVES THE DOC INTACT', async () => {
    // The exact attack: an admin in tid-contoso holding a GUID from tid-fabrikam.
    seedWorkspace('wsX', 'mallory-oid', { name: 'Fabrikam Finance', tid: FOREIGN_TID });

    const r = await post({ ids: ['wsX'] });
    const j = await r.json();

    expect(j.ok).toBe(false);
    expect(j.deleted).toEqual([]);
    expect(j.failed).toEqual([{ id: 'wsX', error: 'not_found' }]);
    // The consequence, not just the message: the workspace SURVIVES.
    expect(stillExists('wsX', 'mallory-oid')).toBe(true);
  });

  it('REFUSES a foreign-tenant workspace on CASCADE and never reaches Azure teardown', async () => {
    // cascade is the destructive flag — it tears down the workspace's real Azure
    // backends. The refusal must happen BEFORE deleteOne, not inside it.
    seedWorkspace('wsX', 'mallory-oid', { name: 'Fabrikam Finance', tid: FOREIGN_TID });

    const r = await post({ ids: ['wsX'], cascade: true });
    const j = await r.json();

    expect(j.deleted).toEqual([]);
    expect(j.failed).toEqual([{ id: 'wsX', error: 'not_found' }]);
    expect(stillExists('wsX', 'mallory-oid')).toBe(true);
    // The Azure resources were never touched.
    expect(teardownMock).not.toHaveBeenCalled();
  });

  it('REFUSES a foreign-tenant workspace in FIRST batch position, while a home-tenant id in the same batch deletes', async () => {
    // Position matters: a bypass scoped to "the first id" would delete wsX here
    // and still report a green-looking body for the batch.
    seedWorkspace('wsX', 'mallory-oid', { name: 'Fabrikam Finance', tid: FOREIGN_TID });
    seedWorkspace('wsHome', 'alice-oid', { name: 'Contoso Sales', tid: HOME_TID });

    const r = await post({ ids: ['wsX', 'wsHome'] });
    const j = await r.json();

    expect(j.deleted).toEqual(['wsHome']);
    expect(j.failed).toEqual([{ id: 'wsX', error: 'not_found' }]);
    expect(stillExists('wsX', 'mallory-oid')).toBe(true);
    expect(stillExists('wsHome', 'alice-oid')).toBe(false);
  });

  it('REFUSES a foreign-tenant workspace in LAST batch position too', async () => {
    seedWorkspace('wsHome', 'alice-oid', { name: 'Contoso Sales', tid: HOME_TID });
    seedWorkspace('wsX', 'mallory-oid', { name: 'Fabrikam Finance', tid: FOREIGN_TID });

    const r = await post({ ids: ['wsHome', 'wsX'] });
    const j = await r.json();

    expect(j.deleted).toEqual(['wsHome']);
    expect(j.failed).toEqual([{ id: 'wsX', error: 'not_found' }]);
    expect(stillExists('wsX', 'mallory-oid')).toBe(true);
  });
});

/**
 * BATCH-SHAPE MATRIX — the axis a fixed set of hand-written cases cannot cover.
 *
 * ROUND-2 REVIEW FOUND THE SPECS ABOVE BLIND ABOVE TWO IDS. Every one of them
 * posts one or two ids, so a bypass narrowed to `ids.length >= 3` — call the
 * resolver, DISCARD its tenancy verdict, cross-partition read the doc, delete it
 * — passed all of them and the whole suite stayed green (measured: 2 files /
 * 27 tests / RC=0 with that mutation live). MIDDLE position was untested for the
 * same reason: it is not expressible below three ids.
 *
 * ADDING "A 3-ID CASE" WOULD HAVE CLOSED EXACTLY THOSE TWO HOLES AND LEFT THE
 * NEXT ONE OPEN. Five PRs in this program have died to a bypass narrowed onto an
 * axis the fixtures hard-coded, so the batch SHAPE is a PARAMETER here, not one
 * more fixed case: every size 1..MAX_SHAPE_SIZE crossed with every non-empty
 * subset of positions that are foreign, crossed with cascade off/on. First,
 * middle, last, several-at-once and all-foreign fall OUT of the generator
 * instead of being enumerated by hand, and widening the covered range is a
 * one-token change to MAX_SHAPE_SIZE.
 *
 * THE ASSERTION IS DOCUMENT SURVIVAL (`stillExists`), NOT A CALL COUNT. A bypass
 * that consults the resolver and ignores the answer — the evasion that defeated
 * the strongest instrument in the sibling PR — satisfies any "was it called"
 * check and cannot satisfy this one.
 */

/** Batch sizes 1..this are covered exhaustively (2**n - 1 shapes each). */
const MAX_SHAPE_SIZE = 4;

/** Every non-empty set of foreign positions, for every batch size 1..max. */
function foreignPositionShapes(max: number): { size: number; foreign: number[] }[] {
  const shapes: { size: number; foreign: number[] }[] = [];
  for (let size = 1; size <= max; size++) {
    for (let mask = 1; mask < 1 << size; mask++) {
      const foreign: number[] = [];
      for (let i = 0; i < size; i++) if (mask & (1 << i)) foreign.push(i);
      shapes.push({ size, foreign });
    }
  }
  return shapes;
}

/** Seed one batch: `foreign` positions live in FOREIGN_TID, the rest in HOME_TID. */
function seedShape(size: number, foreign: number[]) {
  const isForeign = new Set(foreign);
  const ids: string[] = [];
  for (let i = 0; i < size; i++) {
    const id = `wsPos${i}`;
    ids.push(id);
    if (isForeign.has(i)) seedWorkspace(id, FOREIGN_OWNER, { name: `Fabrikam ${i}`, tid: FOREIGN_TID });
    else seedWorkspace(id, HOME_OWNER, { name: `Contoso ${i}`, tid: HOME_TID });
  }
  return {
    ids,
    foreignIds: ids.filter((_, i) => isForeign.has(i)),
    homeIds: ids.filter((_, i) => !isForeign.has(i)),
  };
}

describe('#3833 property 1b — the boundary holds at every BATCH SHAPE, not just 1–2 ids', () => {
  const shapes = foreignPositionShapes(MAX_SHAPE_SIZE);

  it('generates every foreign-position subset, including the ones below 3 ids cannot express', () => {
    // The generator is itself under test — a matrix that silently produced two
    // shapes would look like coverage and be none. sum(2**n - 1) for n=1..N.
    expect(shapes).toHaveLength(2 ** (MAX_SHAPE_SIZE + 1) - MAX_SHAPE_SIZE - 2);
    // MIDDLE position, the case that needs 3 ids to exist at all.
    expect(shapes).toContainEqual({ size: 3, foreign: [1] });
    // Interior-only foreign pair — neither end of the batch.
    expect(shapes).toContainEqual({ size: 4, foreign: [1, 2] });
    // Every id foreign: nothing may be deleted at all.
    expect(shapes).toContainEqual({ size: 4, foreign: [0, 1, 2, 3] });
  });

  for (const cascade of [false, true]) {
    for (const { size, foreign } of shapes) {
      const isForeign = new Set(foreign);
      const shape = Array.from({ length: size }, (_, i) => (isForeign.has(i) ? 'F' : 'H')).join('');
      it(`${shape} (${size} ids, cascade=${cascade}) — deletes every HOME id and NO foreign one`, async () => {
        const { ids, foreignIds, homeIds } = seedShape(size, foreign);

        const r = await post({ ids, ...(cascade ? { cascade: true } : {}) });
        const j = await r.json();

        // Body: exactly the home ids, in batch order; every foreign id refused
        // with the same opaque code a nonexistent id gets.
        expect(j.deleted).toEqual(homeIds);
        expect(j.failed).toEqual(foreignIds.map((id) => ({ id, error: 'not_found' })));
        expect(j.ok).toBe(false); // every shape carries at least one foreign id

        // THE CONSEQUENCE, PER ID. This is the assertion a consult-then-discard
        // bypass cannot satisfy: the foreign documents are still in Cosmos.
        for (const id of foreignIds) expect(stillExists(id, FOREIGN_OWNER)).toBe(true);
        for (const id of homeIds) expect(stillExists(id, HOME_OWNER)).toBe(false);

        // On cascade, Azure teardown ran once per HOME id and never for a foreign one.
        expect(teardownMock).toHaveBeenCalledTimes(cascade ? homeIds.length : 0);
      });
    }
  }
});

describe('#3833 property 3 — a foreign id is INDISTINGUISHABLE from a nonexistent id', () => {
  it('emits byte-identical per-id output for a cross-tenant id and an id that does not exist', async () => {
    // route-toolkit.ts states the precedent (404-not-403): an id must not be
    // probeable for existence across tenants. A test that only asserts "foreign
    // is refused" would pass while a distinguishable message leaked existence.
    seedWorkspace('wsX', 'mallory-oid', { name: 'Fabrikam Finance', tid: FOREIGN_TID });

    const rForeign = await post({ ids: ['wsX'] });
    const jForeign = await rForeign.json();

    containers.workspaces._store.clear();
    const rGhost = await post({ ids: ['wsGhost'] });
    const jGhost = await rGhost.json();

    // Same error string...
    expect(jForeign.failed[0].error).toBe(jGhost.failed[0].error);
    // ...and the same SHAPE — no extra field (reason/remediation/detail) on one
    // and not the other. Compared with the id normalized away.
    expect({ ...jForeign.failed[0], id: '<id>' }).toEqual({ ...jGhost.failed[0], id: '<id>' });
    expect(Object.keys(jForeign.failed[0]).sort()).toEqual(Object.keys(jGhost.failed[0]).sort());
    // ...and the same envelope.
    expect(jForeign.ok).toBe(jGhost.ok);
    expect(jForeign.deleted).toEqual(jGhost.deleted);
  });
});

describe('#3833 property 4 — a tid-less workspace doc is refused HONESTLY and distinguishably', () => {
  it('reports tenant_unconfirmed (not forbidden, not not_found) with the backfill remediation, and keeps the doc', async () => {
    seedWorkspace('wsLegacy', 'alice-oid', { name: 'Legacy Sales' }); // no tid

    const r = await post({ ids: ['wsLegacy'] });
    const j = await r.json();

    expect(j.deleted).toEqual([]);
    expect(j.failed).toHaveLength(1);
    const f = j.failed[0];
    expect(f.id).toBe('wsLegacy');
    expect(f.error).toBe('tenant_unconfirmed');
    // Distinguishable from BOTH neighbouring codes — the UI must be able to say
    // something true about why, which 'forbidden' would not permit.
    expect(f.error).not.toBe('forbidden');
    expect(f.error).not.toBe('not_found');
    // deploy-integrity R7 — the reason states what was ESTABLISHED. It must not
    // claim the workspace is missing.
    expect(f.reason).toMatch(/could not confirm the workspace belongs to your Entra tenant/i);
    expect(f.reason).not.toMatch(/not found/i);
    expect(f.remediation).toContain('scripts/csa-loom/backfill-workspace-tid.mjs');
    // And the doc is still there — a refusal, not a delete.
    expect(stillExists('wsLegacy', 'alice-oid')).toBe(true);
  });

  it('does not reach Azure teardown for a tid-less doc even on cascade', async () => {
    seedWorkspace('wsLegacy', 'alice-oid', { name: 'Legacy Sales' });

    const r = await post({ ids: ['wsLegacy'], cascade: true });
    const j = await r.json();

    expect(j.deleted).toEqual([]);
    expect(j.failed[0].error).toBe('tenant_unconfirmed');
    expect(stillExists('wsLegacy', 'alice-oid')).toBe(true);
    expect(teardownMock).not.toHaveBeenCalled();
  });

  it('never leaks tenant_unconfirmed to a NON-admin — they get the plain not_found', async () => {
    // The denial is only recorded for a tenant-admin refusal. A non-admin must
    // not learn that a tid-less workspace with this id exists anywhere.
    seedWorkspace('wsLegacy', 'alice-oid', { name: 'Legacy Sales' });
    isTenantAdminMock.mockReturnValue(false);

    const r = await post({ ids: ['wsLegacy'] });
    const j = await r.json();

    expect(j.failed).toEqual([{ id: 'wsLegacy', error: 'not_found' }]);
    expect(stillExists('wsLegacy', 'alice-oid')).toBe(true);
  });
});

describe('#3833 property 5 — legitimate same-tenant admin cleanup STILL WORKS (the control)', () => {
  it('a tenant admin deletes a FOREIGN-OWNED workspace inside their own confirmed tenant', async () => {
    // This is the endpoint's stated purpose: purging UAT/test debris the admin
    // did not personally create. If this spec fails, the fix over-corrected.
    seedWorkspace('wsUat1', 'alice-oid', { name: 'UAT debris 1', tid: HOME_TID });
    seedWorkspace('wsUat2', 'bob-oid', { name: 'UAT debris 2', tid: HOME_TID });

    const r = await post({ ids: ['wsUat1', 'wsUat2'] });
    const j = await r.json();

    expect(j.ok).toBe(true);
    expect(j.failed).toEqual([]);
    expect(j.deleted.sort()).toEqual(['wsUat1', 'wsUat2']);
    expect(stillExists('wsUat1', 'alice-oid')).toBe(false);
    expect(stillExists('wsUat2', 'bob-oid')).toBe(false);
  });

  it('same-tenant admin cleanup with CASCADE still tears down the Azure backends', async () => {
    seedWorkspace('wsUat1', 'alice-oid', { name: 'UAT debris 1', tid: HOME_TID });

    const r = await post({ ids: ['wsUat1'], cascade: true });
    const j = await r.json();

    expect(j.deleted).toEqual(['wsUat1']);
    expect(teardownMock).toHaveBeenCalledTimes(1);
  });

  it('a NON-admin owner still deletes their own workspace, with NO tid anywhere (legacy doc)', async () => {
    // The blast radius of refusing tid-less docs is confined to the ADMIN path.
    // The owner fast-path never depended on the tenant bypass and must not
    // regress for pre-rel-T11 data.
    seedWorkspace('wsMine', 'admin-oid', { name: 'My Space' });
    getSessionMock.mockReturnValue({
      claims: { oid: 'admin-oid', upn: 'admin@contoso.com' },
      exp: Date.now() / 1000 + 3600,
    } as any);
    isTenantAdminMock.mockReturnValue(false);

    const r = await post({ ids: ['wsMine'] });
    const j = await r.json();

    expect(j.ok).toBe(true);
    expect(j.deleted).toEqual(['wsMine']);
    expect(stillExists('wsMine', 'admin-oid')).toBe(false);
  });
});

describe('#3833 property 2 — authorization is evaluated for ADMINS too (no `!admin &&` short-circuit)', () => {
  it('refuses an admin who resolves at a non-Admin ACL role, instead of skipping the check', async () => {
    // The resolver returns the caller's REAL role when they hold one (step 5
    // runs before the admin bypass), so an admin who is an explicit Member of
    // this workspace resolves via:'acl' role:'Member'. Destroying a workspace
    // is Owner/Admin-scoped — identical to DELETE /api/workspaces/[id].
    //
    // Under the old code `!admin &&` skipped this branch entirely for any
    // admin, so this id was DELETED.
    seedWorkspace('wsShared', 'alice-oid', { name: 'Shared Space', tid: HOME_TID });
    resolveEffectiveRoleMock.mockResolvedValue('Member' as any);

    const r = await post({ ids: ['wsShared'] });
    const j = await r.json();

    expect(j.deleted).toEqual([]);
    expect(j.failed).toEqual([{ id: 'wsShared', error: 'forbidden' }]);
    expect(stillExists('wsShared', 'alice-oid')).toBe(true);
  });

  it('admits an admin who resolves at ACL role Admin', async () => {
    seedWorkspace('wsShared', 'alice-oid', { name: 'Shared Space', tid: HOME_TID });
    resolveEffectiveRoleMock.mockResolvedValue('Admin' as any);

    const r = await post({ ids: ['wsShared'] });
    const j = await r.json();

    expect(j.deleted).toEqual(['wsShared']);
    expect(stillExists('wsShared', 'alice-oid')).toBe(false);
  });

  it('refuses a NON-admin Member — the pre-existing rule, unchanged', async () => {
    seedWorkspace('wsShared', 'alice-oid', { name: 'Shared Space', tid: HOME_TID });
    getSessionMock.mockReturnValue({
      claims: { oid: 'bob-oid', upn: 'bob@contoso.com', tid: HOME_TID },
      exp: Date.now() / 1000 + 3600,
    } as any);
    isTenantAdminMock.mockReturnValue(false);
    resolveEffectiveRoleMock.mockResolvedValue('Member' as any);

    const r = await post({ ids: ['wsShared'] });
    const j = await r.json();

    expect(j.failed).toEqual([{ id: 'wsShared', error: 'forbidden' }]);
    expect(stillExists('wsShared', 'alice-oid')).toBe(true);
  });
});

describe('#3833 — envelope regressions', () => {
  it('401s when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const r = await post({ ids: ['wsX'] });
    expect(r.status).toBe(401);
  });

  it('400s on a body that is not { ids: string[] }', async () => {
    const r = await post({ ids: 'nope' });
    expect(r.status).toBe(400);
  });

  it('400s on an empty id list', async () => {
    const r = await post({ ids: [] });
    expect(r.status).toBe(400);
  });
});
