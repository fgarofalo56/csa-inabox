/**
 * WS-D1 — route-toolkit unit tests. Session, item-crud, and the gate registry
 * are mocked so we assert the wrapper CONTROL FLOW (401 / 404 / 503 / pass) and
 * the augmented context, with no cookies / Cosmos / env.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: vi.fn() }));
vi.mock('@/lib/gates/registry', () => ({ getGate: vi.fn(), gateStatus: vi.fn() }));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn(), enforceCapability: vi.fn() }));
vi.mock('@/lib/auth/dlz-gate', () => ({ denyIfNoDlzAccess: vi.fn() }));

import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { gateStatus, getGate } from '@/lib/gates/registry';
import { requireTenantAdmin, enforceCapability } from '@/lib/auth/feature-gate';
import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';
import { NextResponse } from 'next/server';
import { apiOk } from '../respond';
import {
  withSession,
  withWorkspaceOwner,
  withBackendGate,
  withTenantAdmin,
  withDlzAccess,
  withCapability,
} from '../route-toolkit';

/**
 * The HTTP verbs this toolkit's wrappers are actually exported under. Measured
 * on `origin/main`, counting only handlers wrapped in `withTenantAdmin`:
 * GET/POST are the bulk, DELETE 6, PUT 4, PATCH 3.
 */
const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type HttpVerb = (typeof VERBS)[number];

/**
 * The request fixture — #4019.
 *
 * IT USED TO BE `const req = {} as any;`, ONE OBJECT FOR EVERY SPEC IN THE FILE.
 * `req.method` was `undefined` throughout, so a bypass keyed to ANY verb —
 *
 *     const gate = req.method === 'DELETE' ? null : requireTenantAdmin(sctx.session);
 *
 * — was invisible to the suite that exists specifically to test this wrapper:
 * `undefined === 'DELETE'` is false in every spec, so the gate kept firing
 * exactly as the tests expected. That is the strongest existing evidence that
 * `withTenantAdmin` works, and it could not discriminate the class at all.
 *
 * THE VERB IS A PARAMETER, NOT A CONSTANT. Hard-coding one (say `'POST'`) only
 * MOVES the blind spot onto the other four — measured in #3993, where an arm
 * keyed to `'POST'` was caught and the symmetric `'DELETE'` arm still escaped.
 * Each spec passes the verb it actually means, and `withTenantAdmin` is
 * exercised under all five below.
 */
function req(method: HttpVerb): any {
  return { method, nextUrl: new URL(`http://x/api/admin/route-toolkit-spec?verb=${method}`) };
}
const ctx = <P>(p: P) => ({ params: Promise.resolve(p) } as any);
const SESSION = { claims: { oid: 'user-1', upn: 'u@x' }, exp: 9e9 };

beforeEach(() => {
  vi.resetAllMocks();
  (getGate as any).mockReturnValue({ id: 'svc-x', title: 'Svc X', remediation: 'set X' });
  (gateStatus as any).mockReturnValue({ id: 'svc-x', status: 'configured', missing: [] });
});

describe('withSession', () => {
  it('401s with no session and never calls the handler', async () => {
    (getSession as any).mockReturnValue(null);
    const handler = vi.fn();
    const res = await withSession(handler)(req('GET'), ctx({}));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthenticated' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes the resolved session + params to the handler', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const handler = vi.fn(async (_r, { session, params }) => apiOk({ oid: session.claims.oid, id: params.id }));
    const res = await withSession<{ id: string }>(handler)(req('GET'), ctx({ id: 'abc' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, oid: 'user-1', id: 'abc' });
  });

  it('genericizes a thrown handler error to a 500 (no leak)', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const res = await withSession(async () => { throw new Error('boom: secret conn string'); })(req('GET'), ctx({}));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('internal error');
    expect(JSON.stringify(body)).not.toMatch(/secret conn string/);
  });
});

describe('withWorkspaceOwner', () => {
  it('401s with no session before loading anything', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await withWorkspaceOwner('agent-flow', vi.fn())(req('GET'), ctx({ id: 'i1' }));
    expect(res.status).toBe(401);
    expect(loadOwnedItem).not.toHaveBeenCalled();
  });

  it('404s when the caller does not own the item', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (loadOwnedItem as any).mockResolvedValue(null);
    const handler = vi.fn();
    const res = await withWorkspaceOwner('agent-flow', handler)(req('GET'), ctx({ id: 'i1' }));
    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
    // write-scoped by default (no allowReadRoles), and the SESSION is threaded
    // through so the cross-tenant tid boundary resolves from claims (#2703).
    expect(loadOwnedItem).toHaveBeenCalledWith('i1', 'agent-flow', 'user-1', { session: SESSION });
  });

  it('threads the loaded item + forwards allowReadRoles', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const item = { id: 'i1', workspaceId: 'w1', itemType: 'agent-flow', state: { runs: [1, 2] } };
    (loadOwnedItem as any).mockResolvedValue(item);
    const handler = vi.fn(async (_r, octx) => apiOk({ runs: (octx.item.state.runs as number[]).length }));
    const res = await withWorkspaceOwner('agent-flow', { allowReadRoles: true }, handler)(req('GET'), ctx({ id: 'i1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, runs: 2 });
    expect(loadOwnedItem).toHaveBeenCalledWith('i1', 'agent-flow', 'user-1', { allowReadRoles: true, session: SESSION });
  });
});

describe('withTenantAdmin (R1)', () => {
  it('401s with no session and never runs the admin check or handler', async () => {
    (getSession as any).mockReturnValue(null);
    const handler = vi.fn();
    const res = await withTenantAdmin(handler)(req('GET'), ctx({}));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthenticated' });
    expect(requireTenantAdmin).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns the requireTenantAdmin response unchanged for a non-admin session', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const forbidden = NextResponse.json(
      { ok: false, error: 'forbidden', code: 'admin_only' },
      { status: 403 },
    );
    (requireTenantAdmin as any).mockReturnValue(forbidden);
    const handler = vi.fn();
    const res = await withTenantAdmin(handler)(req('GET'), ctx({}));
    expect(res).toBe(forbidden);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'forbidden', code: 'admin_only' });
    expect(requireTenantAdmin).toHaveBeenCalledWith(SESSION);
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler with session + params when the caller is a tenant admin', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (requireTenantAdmin as any).mockReturnValue(null);
    const handler = vi.fn(async (_r, { session, params }) => apiOk({ oid: session.claims.oid, id: params.id }));
    const res = await withTenantAdmin<{ id: string }>(handler)(req('GET'), ctx({ id: 'pkg-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, oid: 'user-1', id: 'pkg-1' });
  });
});

/**
 * #4019 — A VERB-KEYED BYPASS OF THE SHARED TENANT-ADMIN CHOKEPOINT.
 *
 * `withTenantAdmin` is the single point where "is this caller a tenant admin"
 * is decided for the admin surface — 72 `route.ts` files under `app/api`
 * reference it, and 13 of the handlers it wraps are mutating (6 DELETE, 4 PUT,
 * 3 PATCH). It is correct today. The point of this block is that a whole CLASS
 * of weakening to it was undetectable:
 *
 *     const gate = req.method === 'DELETE' ? null : requireTenantAdmin(sctx.session);
 *
 * Measured in the #3993 review, on the shared wrapper: with a verb-free fixture
 * a `'POST'`-keyed bypass ESCAPED (RC=0); with a verb-carrying one it was CAUGHT
 * (RC=1). The `'DELETE'` arm escaped in both, because no fixture anywhere in the
 * repo carried that verb.
 *
 * NONE OF THOSE 13 MUTATING HANDLERS HAS A CO-LOCATED AUTHZ SPEC — measured:
 * `git grep -l withTenantAdmin` restricted to `__tests__` directories returns 10
 * files and only one sits under any of them. So this file is THE ASSERTION OF
 * RECORD for the verb surface, and it says so rather than leaving that implied.
 *
 * The two arms per verb are what make it a live control rather than a shape
 * check: the DENY arm fails if the gate is skipped for that verb, and the ALLOW
 * arm fails if a "fix" is applied by refusing everything. Neither alone is
 * enough — a gate that denies unconditionally passes the first.
 */
describe.each(VERBS)('withTenantAdmin is verb-INDEPENDENT — %s', (verb) => {
  it(`403s a non-admin on ${verb}, consults the guard, and never runs the handler`, async () => {
    (getSession as any).mockReturnValue(SESSION);
    const forbidden = NextResponse.json(
      { ok: false, error: 'forbidden', code: 'admin_only' },
      { status: 403 },
    );
    (requireTenantAdmin as any).mockReturnValue(forbidden);
    const handler = vi.fn();

    const res = await withTenantAdmin(handler)(req(verb), ctx({}));

    expect(res.status).toBe(403);
    // The guard was CONSULTED — not merely "a 403 came back from somewhere".
    // A bypass returns 200 here, and a bypass that also happens to 403 for an
    // unrelated reason still fails this line.
    expect(requireTenantAdmin).toHaveBeenCalledWith(SESSION);
    expect(handler).not.toHaveBeenCalled();
  });

  it(`still lets a tenant admin through on ${verb}`, async () => {
    // The liveness half. Without it, "deny every verb" passes the arm above and
    // the pair would prove nothing about discrimination.
    (getSession as any).mockReturnValue(SESSION);
    (requireTenantAdmin as any).mockReturnValue(null);
    const handler = vi.fn(async () => apiOk({ verb }));

    const res = await withTenantAdmin(handler)(req(verb), ctx({}));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, verb });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('#4019 — the fixture itself carries a verb', () => {
  it('POPULATION: every verb the wrapper is exported under has an arm', () => {
    // The guard on the guard. If someone narrows VERBS to one entry, the arms
    // above silently stop covering the other four — the same zero-population
    // failure the verb-free `{}` fixture was. Pinned by name, not by count
    // alone: a list of five copies of 'GET' would satisfy a length check.
    expect([...VERBS].sort()).toEqual(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);
  });

  it('CONTROL: `req(verb).method` is really the verb, so a `req.method` bypass is reachable', () => {
    // Without this, a fixture helper that silently dropped `method` would put
    // the whole file back where it started and every arm above would still pass.
    for (const v of VERBS) expect(req(v).method).toBe(v);
  });
});

describe('withDlzAccess (R1)', () => {
  it('401s with no session and never runs the DLZ check', async () => {
    (getSession as any).mockReturnValue(null);
    const handler = vi.fn();
    const res = await withDlzAccess('scaling', handler)(req('GET'), ctx({}));
    expect(res.status).toBe(401);
    expect(denyIfNoDlzAccess).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns the denyIfNoDlzAccess response unchanged when DLZ access is denied', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const denied = NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
    (denyIfNoDlzAccess as any).mockResolvedValue(denied);
    const handler = vi.fn();
    const res = await withDlzAccess('cost', handler)(req('GET'), ctx({}));
    expect(res).toBe(denied);
    expect(res.status).toBe(403);
    expect(denyIfNoDlzAccess).toHaveBeenCalledWith(SESSION, 'cost');
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler (forwarding the pane) when DLZ access is allowed', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (denyIfNoDlzAccess as any).mockResolvedValue(null);
    const handler = vi.fn(async (_r, { session }) => apiOk({ oid: session.claims.oid }));
    const res = await withDlzAccess('monitoring', handler)(req('GET'), ctx({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, oid: 'user-1' });
    expect(denyIfNoDlzAccess).toHaveBeenCalledWith(SESSION, 'monitoring');
  });
});

/**
 * C22 (#3088) — `withCapability` is the NON-DISCARDABLE form of the idiom that
 * left /api/setup/deploy open with every CI guard green: `const gate = await
 * enforceCapability(…); if (gate) return gate;` puts the whole authorization in
 * one deletable line. These pin that the wrapper is byte-compatible with that
 * idiom — same 401, the enforceCapability 403 returned UNCHANGED, the same
 * (capabilityId, requiredRole) threaded through — so the routes converted to it
 * authorize identically for legitimate and illegitimate callers alike.
 */
describe('withCapability (C22)', () => {
  it('401s with no session and never runs the capability check or the handler', async () => {
    (getSession as any).mockReturnValue(null);
    const handler = vi.fn();
    const res = await withCapability('admin.env-config', 'Admin', handler)(req('GET'), ctx({}));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthenticated' });
    expect(enforceCapability).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns the enforceCapability 403 UNCHANGED and never runs the handler', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const forbidden = NextResponse.json(
      { ok: false, error: 'forbidden', capability: 'admin.env-config', requiredRole: 'Admin' },
      { status: 403 },
    );
    (enforceCapability as any).mockResolvedValue(forbidden);
    const handler = vi.fn();
    const res = await withCapability('admin.env-config', 'Admin', handler)(req('GET'), ctx({}));
    expect(res).toBe(forbidden); // the SAME object — no re-wrapping, no body drift
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('threads the exact capability id + required role through to the gate', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (enforceCapability as any).mockResolvedValue(null);
    await withCapability('admin.deploy-dlz', 'Contributor', async () => apiOk({}))(req('GET'), ctx({}));
    expect(enforceCapability).toHaveBeenCalledWith(SESSION, 'admin.deploy-dlz', 'Contributor');
  });

  it('runs the handler with session + params when the caller holds the capability', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (enforceCapability as any).mockResolvedValue(null);
    const handler = vi.fn(async (_r, { session, params }) => apiOk({ oid: session.claims.oid, id: params.id }));
    const res = await withCapability<{ id: string }>('admin.env-config', 'Admin', handler)(req('GET'), ctx({ id: 'svc-adx' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, oid: 'user-1', id: 'svc-adx' });
  });
});

describe('withBackendGate (composed inside withSession)', () => {
  it('session comes FIRST: 401 before any gate disclosure', async () => {
    (getSession as any).mockReturnValue(null);
    (gateStatus as any).mockReturnValue({ id: 'svc-x', status: 'blocked', missing: ['LOOM_X'] });
    const handler = vi.fn();
    const res = await withSession(withBackendGate('svc-x', handler))(req('GET'), ctx({}));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('503 gate envelope when the backend is blocked', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (gateStatus as any).mockReturnValue({ id: 'svc-x', status: 'blocked', missing: ['LOOM_X'] });
    const handler = vi.fn();
    const res = await withSession(withBackendGate('svc-x', handler))(req('GET'), ctx({}));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, gated: true, gate: { id: 'svc-x' }, missing: ['LOOM_X'] });
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler when configured', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (gateStatus as any).mockReturnValue({ id: 'svc-x', status: 'configured', missing: [] });
    const res = await withSession(withBackendGate('svc-x', async () => apiOk({ ran: true })))(req('GET'), ctx({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ran: true });
  });
});
