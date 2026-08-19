/**
 * BFF route tests for the GENERIC /api/items/[type]/[id]/endorsement.
 *
 * WHY THIS FILE EXISTS (review finding). This route had ZERO spec coverage, and
 * two separate changes landed on it in one PR: the #3697 read-scope fix
 * (`loadOwnedItem(..., { allowReadRoles: true })` on GET) and a
 * `migrate-route-toolkit` rewrite of both auth prologues onto `withSession`.
 * A codemod rewriting an unpinned authorization surface is exactly the shape
 * that should not ship untested.
 *
 * THE INVARIANT THAT MATTERS MOST — the read/write SPLIT:
 *
 *   GET   reads `state.endorsement`          → { allowReadRoles: true }
 *   PATCH promotes / clears / certifies      → write scope, NO allowReadRoles
 *
 * `check-route-guards.mjs` has no rule that a MUTATING handler must not pass
 * `allowReadRoles` (that is the #3693 shape), so nothing else in CI watches
 * this. These specs assert the flag each verb passes, not merely the status
 * code, so a future "make PATCH work for viewers too" edit fails here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Role of the caller in the mocked estate. */
type Role = 'writer' | 'viewer' | 'none';
const world = { role: 'writer' as Role, admin: false };

const ITEM = {
  id: 'item-1',
  workspaceId: 'ws-1',
  itemType: 'lakehouse',
  displayName: 'Sales LH',
  state: { endorsement: 'Promoted' } as Record<string, unknown>,
};

const session = { value: null as any };
vi.mock('@/lib/auth/session', () => ({ getSession: () => session.value }));
vi.mock('@/lib/auth/feature-gate', () => ({ isTenantAdmin: () => world.admin }));

/** Records the options each handler passed, so the SCOPE itself is assertable. */
const loadCalls: Array<{ allowReadRoles?: boolean }> = [];
const updateCalls: Array<Record<string, unknown>> = [];

vi.mock('../../../../_lib/item-crud', () => ({
  loadOwnedItem: vi.fn(async (_id: string, _type: string, _oid: string, opts: any = {}) => {
    loadCalls.push({ allowReadRoles: opts.allowReadRoles });
    // Real scope semantics: a read-only member resolves ONLY when the call site
    // opted in; a non-member never resolves.
    if (world.role === 'none') return null;
    if (world.role === 'viewer' && !opts.allowReadRoles) return null;
    return { ...ITEM, state: { ...ITEM.state } };
  }),
  updateOwnedItem: vi.fn(async (_id: string, _type: string, _oid: string, patch: any) => {
    updateCalls.push(patch);
    return { ...ITEM, ...patch };
  }),
}));

const ctx = { params: Promise.resolve({ type: 'lakehouse', id: 'item-1' }) };
const patchReq = (body: unknown) =>
  new Request('http://x/api/items/lakehouse/item-1/endorsement', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }) as any;

beforeEach(() => {
  loadCalls.length = 0;
  updateCalls.length = 0;
  world.role = 'writer';
  world.admin = false;
  session.value = { claims: { oid: 'oid-1', tid: 'tid-1', upn: 'u@t.com' } };
});

describe('endorsement route — authentication', () => {
  it('GET 401s with no session, before any item read', async () => {
    session.value = null;
    const { GET } = await import('../route');
    const res = await GET(new Request('http://x') as any, ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: 'unauthenticated' });
    expect(loadCalls, 'the item was read before the session check').toEqual([]);
  });

  it('PATCH 401s with no session, before any item read or write', async () => {
    session.value = null;
    const { PATCH } = await import('../route');
    const res = await PATCH(patchReq({ endorsement: 'Promoted' }), ctx);
    expect(res.status).toBe(401);
    expect(loadCalls).toEqual([]);
    expect(updateCalls).toEqual([]);
  });
});

describe('endorsement route — the READ/WRITE scope split (#3697)', () => {
  it('GET opts into read roles, so a shared read-only member gets 200', async () => {
    world.role = 'viewer';
    const { GET } = await import('../route');
    const res = await GET(new Request('http://x') as any, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, endorsement: 'Promoted' });
    // The flag itself, not just the outcome.
    expect(loadCalls).toEqual([{ allowReadRoles: true }]);
  });

  it('PATCH does NOT opt into read roles, so the same member gets 404 on a mutation', async () => {
    world.role = 'viewer';
    const { PATCH } = await import('../route');
    const res = await PATCH(patchReq({ endorsement: 'Promoted' }), ctx);
    expect(res.status).toBe(404);
    expect(loadCalls, 'PATCH must not pass allowReadRoles — it mutates')
      .toEqual([{ allowReadRoles: undefined }]);
    expect(updateCalls).toEqual([]);
  });

  it('a non-member is refused by BOTH verbs', async () => {
    world.role = 'none';
    const { GET, PATCH } = await import('../route');
    expect((await GET(new Request('http://x') as any, ctx)).status).toBe(404);
    expect((await PATCH(patchReq({ endorsement: 'Promoted' }), ctx)).status).toBe(404);
    expect(updateCalls).toEqual([]);
  });
});

describe('endorsement route — the certify gate is real', () => {
  it('a write-capable non-admin may Promote', async () => {
    const { PATCH } = await import('../route');
    const res = await PATCH(patchReq({ endorsement: 'Promoted' }), ctx);
    expect(res.status).toBe(200);
    expect((updateCalls[0] as any).state.endorsement).toBe('Promoted');
  });

  it('a non-admin CANNOT Certify (403 certifier_required) and nothing is written', async () => {
    const { PATCH } = await import('../route');
    const res = await PATCH(patchReq({ endorsement: 'Certified' }), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, code: 'certifier_required' });
    expect(updateCalls, 'a refused certify must not persist').toEqual([]);
  });

  it('a tenant admin CAN Certify', async () => {
    world.admin = true;
    const { PATCH } = await import('../route');
    const res = await PATCH(patchReq({ endorsement: 'Certified' }), ctx);
    expect(res.status).toBe(200);
    expect((updateCalls[0] as any).state.endorsement).toBe('Certified');
  });

  it('"Master data" is gated the same way as Certified', async () => {
    const { PATCH } = await import('../route');
    expect((await PATCH(patchReq({ endorsement: 'Master data' }), ctx)).status).toBe(403);
  });

  it('an unknown endorsement is a 400 and never reaches the item read', async () => {
    const { PATCH } = await import('../route');
    const res = await PATCH(patchReq({ endorsement: 'Blessed' }), ctx);
    expect(res.status).toBe(400);
    expect(loadCalls).toEqual([]);
  });

  it('an explicit clear (null / "None") removes the key rather than writing a value', async () => {
    const { PATCH } = await import('../route');
    expect((await PATCH(patchReq({ endorsement: null }), ctx)).status).toBe(200);
    expect(Object.hasOwn((updateCalls[0] as any).state, 'endorsement')).toBe(false);
    expect((await PATCH(patchReq({ endorsement: 'None' }), ctx)).status).toBe(200);
    expect(Object.hasOwn((updateCalls[1] as any).state, 'endorsement')).toBe(false);
  });
});
