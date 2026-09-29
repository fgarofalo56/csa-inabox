/**
 * /api/synapse/notebooks (collection) — item-scoped POST / DELETE (#4619).
 *
 *   POST    upsert: tenant admin any name; non-admin needs an itemId (body or
 *           ?itemId=) of a writable synapse-notebook item and a name bound to it
 *   DELETE  ?name=: same model, and the name must pass NAME_RE (400) before any
 *           lookup or dev-plane call
 *   GET     stays session-scoped
 *
 * `resolveItemAccessByOid` is mocked; the binding rule runs for real and the
 * fixture names are built with `boundNotebookName`, never transcribed.
 * Each load-bearing assertion names the input that breaks it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));
vi.mock('@/lib/azure/synapse-artifacts-client', () => ({
  synapseConfigGate: vi.fn(() => null),
  listNotebooks: vi.fn(),
  upsertNotebook: vi.fn(),
  deleteNotebook: vi.fn(),
  emptyNotebookProperties: vi.fn(() => ({ cells: [] })),
}));

import { GET, POST, DELETE } from '../route';
import { getSession } from '@/lib/auth/session';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { listNotebooks, upsertNotebook, deleteNotebook, synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';
import { boundNotebookName } from '@/lib/notebook/synapse-notebook-binding';

const user = { claims: { upn: 'u@x', tid: 't1', oid: 'user-oid' } };
const admin = { claims: { upn: 'a@x', tid: 't1', oid: 'admin-oid' } };
const ITEM_ID = '3f2a9c1e-7b4d-4e8a-9f10-1234567890ab';
const OTHER_ID = 'b7e1d2c3-0a9f-4e8d-8c7b-6a5f4e3d2c1b';
const BOUND = boundNotebookName('Sales nb', ITEM_ID)!;
const OTHER_BOUND = boundNotebookName('Sales nb', OTHER_ID)!;

function access(canWrite: boolean) {
  return { item: { id: ITEM_ID, displayName: 'Sales nb', itemType: 'synapse-notebook' }, role: 'Owner', via: 'owner', canWrite };
}
const post = (body: unknown, query = '') => new NextRequest(`http://localhost/api/synapse/notebooks${query}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
});
const del = (query: string) => new NextRequest(`http://localhost/api/synapse/notebooks${query}`, { method: 'DELETE' });
const noCtx = { params: Promise.resolve({}) } as any;

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid';
  (synapseConfigGate as any).mockReturnValue(null);
  (upsertNotebook as any).mockImplementation(async (name: string) => ({ name }));
  (deleteNotebook as any).mockResolvedValue(undefined);
  (listNotebooks as any).mockResolvedValue([{ name: 'nb_1', properties: {} }]);
  (resolveItemAccessByOid as any).mockResolvedValue(access(true));
});

describe('POST /api/synapse/notebooks', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await POST(post({ name: BOUND, itemId: ITEM_ID }), noCtx)).status).toBe(401);
    expect(upsertNotebook).not.toHaveBeenCalled();
  });

  it('a non-admin with no itemId gets admin_only, no lookup, no upsert', async () => {
    // Breaks if POST is left session-only (the upsert would run → 200), which
    // is what it was before this change.
    (getSession as any).mockReturnValue(user);
    const res = await POST(post({ name: BOUND }), noCtx);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('admin_only');
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
    expect(upsertNotebook).not.toHaveBeenCalled();
  });

  it('a non-admin writer creates the bound name with itemId in the BODY (positive pair)', async () => {
    // Breaks if the body itemId is ignored (403 admin_only) or POST refuses writers.
    (getSession as any).mockReturnValue(user);
    const res = await POST(post({ name: BOUND, itemId: ITEM_ID }), noCtx);
    expect(res.status).toBe(200);
    expect(resolveItemAccessByOid).toHaveBeenCalledWith(user, ITEM_ID, 'synapse-notebook');
    expect(upsertNotebook).toHaveBeenCalledWith(BOUND, { name: BOUND, properties: { cells: [] } });
  });

  it('a non-admin writer creates the bound name with itemId in the QUERY', async () => {
    // Breaks if the ?itemId= fallback is dropped (403 admin_only).
    (getSession as any).mockReturnValue(user);
    const res = await POST(post({ name: BOUND }, `?itemId=${ITEM_ID}`), noCtx);
    expect(res.status).toBe(200);
    expect(resolveItemAccessByOid).toHaveBeenCalledWith(user, ITEM_ID, 'synapse-notebook');
  });

  it('a non-admin cannot upsert another item\'s notebook or a free name', async () => {
    // Breaks if POST skips the binding check: either name would be upserted.
    (getSession as any).mockReturnValue(user);
    for (const name of [OTHER_BOUND, 'nb_1']) {
      const res = await POST(post({ name, itemId: ITEM_ID }), noCtx);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('notebook_not_bound');
    }
    expect(upsertNotebook).not.toHaveBeenCalled();
  });

  it('a read-only role cannot upsert', async () => {
    // Breaks if POST skips the canWrite check.
    (getSession as any).mockReturnValue(user);
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    expect((await POST(post({ name: BOUND, itemId: ITEM_ID }), noCtx)).status).toBe(403);
    expect(upsertNotebook).not.toHaveBeenCalled();
  });

  it('a tenant admin upserts any valid name with no item', async () => {
    (getSession as any).mockReturnValue(admin);
    expect((await POST(post({ name: 'nb_1' }), noCtx)).status).toBe(200);
    expect(upsertNotebook).toHaveBeenCalledWith('nb_1', expect.anything());
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
  });

  it('a tenant admin who names an unresolvable item gets 404 and no upsert', async () => {
    // Breaks if a tenant-admin shortcut runs ahead of the item lookup: the
    // upsert would run (200) with the lookup never called.
    (getSession as any).mockReturnValue(admin);
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await POST(post({ name: 'nb_1', itemId: ITEM_ID }), noCtx);
    expect(res.status).toBe(404);
    expect(resolveItemAccessByOid).toHaveBeenCalledWith(admin, ITEM_ID, 'synapse-notebook');
    expect(upsertNotebook).not.toHaveBeenCalled();
  });

  it('400 on an invalid name before any lookup', async () => {
    // Breaks if authorization runs before NAME_RE (the lookup would be called).
    (getSession as any).mockReturnValue(user);
    const res = await POST(post({ name: 'a/b', itemId: ITEM_ID }), noCtx);
    expect(res.status).toBe(400);
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/synapse/notebooks?name=', () => {
  it.each([
    ['a "/" separator', 'a%2Fb'],
    ['a ".." segment', '..'],
    ['a dot', 'nb.ipynb'],
    ['a NUL', 'nb%00'],
    ['a space', 'a%20b'],
    ['an over-long name', 'a'.repeat(261)],
  ])('400 on a name with %s — even for a tenant admin — before deleteNotebook', async (_label, raw) => {
    // Breaks if NAME_RE is removed from the collection DELETE (it had none
    // before this change): the admin would reach deleteNotebook with a 200.
    (getSession as any).mockReturnValue(admin);
    const res = await DELETE(del(`?name=${raw}`), noCtx);
    expect(res.status).toBe(400);
    expect(deleteNotebook).not.toHaveBeenCalled();
  });

  it('a non-admin with no itemId gets admin_only, and deleteNotebook is never called', async () => {
    // Breaks if DELETE is left session-only (deleteNotebook → 200).
    (getSession as any).mockReturnValue(user);
    const res = await DELETE(del(`?name=${BOUND}`), noCtx);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('admin_only');
    expect(deleteNotebook).not.toHaveBeenCalled();
  });

  it('a non-admin writer deletes the bound name (positive pair)', async () => {
    // Breaks if DELETE ignores ?itemId= or refuses writers.
    (getSession as any).mockReturnValue(user);
    const res = await DELETE(del(`?name=${BOUND}&itemId=${ITEM_ID}`), noCtx);
    expect(res.status).toBe(200);
    expect(deleteNotebook).toHaveBeenCalledWith(BOUND);
  });

  it('a non-admin cannot delete another item\'s notebook', async () => {
    // Breaks if DELETE skips the binding check.
    (getSession as any).mockReturnValue(user);
    const res = await DELETE(del(`?name=${OTHER_BOUND}&itemId=${ITEM_ID}`), noCtx);
    expect(res.status).toBe(403);
    expect(deleteNotebook).not.toHaveBeenCalled();
  });
});

describe('GET /api/synapse/notebooks', () => {
  it('stays session-scoped: a non-admin lists notebooks', async () => {
    // Breaks if GET were gated (403).
    (getSession as any).mockReturnValue(user);
    const res = await GET(new NextRequest('http://localhost/api/synapse/notebooks'), noCtx);
    expect(res.status).toBe(200);
    expect((await res.json()).notebooks.map((n: any) => n.name)).toEqual(['nb_1']);
  });
});
