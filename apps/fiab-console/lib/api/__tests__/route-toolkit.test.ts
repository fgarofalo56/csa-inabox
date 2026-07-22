/**
 * WS-D1 — route-toolkit unit tests. Session, item-crud, and the gate registry
 * are mocked so we assert the wrapper CONTROL FLOW (401 / 404 / 503 / pass) and
 * the augmented context, with no cookies / Cosmos / env.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: vi.fn() }));
vi.mock('@/lib/gates/registry', () => ({ getGate: vi.fn(), gateStatus: vi.fn() }));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn() }));
vi.mock('@/lib/auth/dlz-gate', () => ({ denyIfNoDlzAccess: vi.fn() }));

import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { gateStatus, getGate } from '@/lib/gates/registry';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';
import { NextResponse } from 'next/server';
import { apiOk } from '../respond';
import {
  withSession,
  withWorkspaceOwner,
  withBackendGate,
  withTenantAdmin,
  withDlzAccess,
} from '../route-toolkit';

const req = {} as any;
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
    const res = await withSession(handler)(req, ctx({}));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthenticated' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes the resolved session + params to the handler', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const handler = vi.fn(async (_r, { session, params }) => apiOk({ oid: session.claims.oid, id: params.id }));
    const res = await withSession<{ id: string }>(handler)(req, ctx({ id: 'abc' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, oid: 'user-1', id: 'abc' });
  });

  it('genericizes a thrown handler error to a 500 (no leak)', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const res = await withSession(async () => { throw new Error('boom: secret conn string'); })(req, ctx({}));
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
    const res = await withWorkspaceOwner('agent-flow', vi.fn())(req, ctx({ id: 'i1' }));
    expect(res.status).toBe(401);
    expect(loadOwnedItem).not.toHaveBeenCalled();
  });

  it('404s when the caller does not own the item', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (loadOwnedItem as any).mockResolvedValue(null);
    const handler = vi.fn();
    const res = await withWorkspaceOwner('agent-flow', handler)(req, ctx({ id: 'i1' }));
    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
    // write-scoped by default (no allowReadRoles)
    expect(loadOwnedItem).toHaveBeenCalledWith('i1', 'agent-flow', 'user-1', {});
  });

  it('threads the loaded item + forwards allowReadRoles', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const item = { id: 'i1', workspaceId: 'w1', itemType: 'agent-flow', state: { runs: [1, 2] } };
    (loadOwnedItem as any).mockResolvedValue(item);
    const handler = vi.fn(async (_r, octx) => apiOk({ runs: (octx.item.state.runs as number[]).length }));
    const res = await withWorkspaceOwner('agent-flow', { allowReadRoles: true }, handler)(req, ctx({ id: 'i1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, runs: 2 });
    expect(loadOwnedItem).toHaveBeenCalledWith('i1', 'agent-flow', 'user-1', { allowReadRoles: true });
  });
});

describe('withTenantAdmin (R1)', () => {
  it('401s with no session and never runs the admin check or handler', async () => {
    (getSession as any).mockReturnValue(null);
    const handler = vi.fn();
    const res = await withTenantAdmin(handler)(req, ctx({}));
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
    const res = await withTenantAdmin(handler)(req, ctx({}));
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
    const res = await withTenantAdmin<{ id: string }>(handler)(req, ctx({ id: 'pkg-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, oid: 'user-1', id: 'pkg-1' });
  });
});

describe('withDlzAccess (R1)', () => {
  it('401s with no session and never runs the DLZ check', async () => {
    (getSession as any).mockReturnValue(null);
    const handler = vi.fn();
    const res = await withDlzAccess('scaling', handler)(req, ctx({}));
    expect(res.status).toBe(401);
    expect(denyIfNoDlzAccess).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns the denyIfNoDlzAccess response unchanged when DLZ access is denied', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const denied = NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
    (denyIfNoDlzAccess as any).mockResolvedValue(denied);
    const handler = vi.fn();
    const res = await withDlzAccess('cost', handler)(req, ctx({}));
    expect(res).toBe(denied);
    expect(res.status).toBe(403);
    expect(denyIfNoDlzAccess).toHaveBeenCalledWith(SESSION, 'cost');
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler (forwarding the pane) when DLZ access is allowed', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (denyIfNoDlzAccess as any).mockResolvedValue(null);
    const handler = vi.fn(async (_r, { session }) => apiOk({ oid: session.claims.oid }));
    const res = await withDlzAccess('monitoring', handler)(req, ctx({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, oid: 'user-1' });
    expect(denyIfNoDlzAccess).toHaveBeenCalledWith(SESSION, 'monitoring');
  });
});

describe('withBackendGate (composed inside withSession)', () => {
  it('session comes FIRST: 401 before any gate disclosure', async () => {
    (getSession as any).mockReturnValue(null);
    (gateStatus as any).mockReturnValue({ id: 'svc-x', status: 'blocked', missing: ['LOOM_X'] });
    const handler = vi.fn();
    const res = await withSession(withBackendGate('svc-x', handler))(req, ctx({}));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('503 gate envelope when the backend is blocked', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (gateStatus as any).mockReturnValue({ id: 'svc-x', status: 'blocked', missing: ['LOOM_X'] });
    const handler = vi.fn();
    const res = await withSession(withBackendGate('svc-x', handler))(req, ctx({}));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, gated: true, gate: { id: 'svc-x' }, missing: ['LOOM_X'] });
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler when configured', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (gateStatus as any).mockReturnValue({ id: 'svc-x', status: 'configured', missing: [] });
    const res = await withSession(withBackendGate('svc-x', async () => apiOk({ ran: true })))(req, ctx({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ran: true });
  });
});
