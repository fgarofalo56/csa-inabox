/**
 * /api/synapse/notebooks/[name] — name validation + item-scoped writes (#4619).
 *
 *   PUT / DELETE  401 / tenant admin writes any valid name without an item /
 *                 a non-admin with no `?itemId=` gets `admin_only` /
 *                 unknown item 404 / read-only role 403 / a name not bound to
 *                 the item 403 `notebook_not_bound` / a bound name on a
 *                 writable item reaches the sink
 *   PUT           every rejected name shape is a 400 before any lookup
 *   GET           stays session-scoped
 *
 * `resolveItemAccessByOid` is mocked so each case picks its access answer;
 * the binding rule (lib/notebook/synapse-notebook-binding) runs for real, and
 * the fixture names are BUILT with `boundNotebookName`, never transcribed, so
 * a change to the suffix format cannot make the fixture disagree with the rule.
 *
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
}));
vi.mock('@/lib/azure/adls-client', () => ({ uploadFile: vi.fn() }));

import { GET, PUT, DELETE } from '../[name]/route';
import { getSession } from '@/lib/auth/session';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { listNotebooks, upsertNotebook, deleteNotebook, synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';
import { uploadFile } from '@/lib/azure/adls-client';
import { boundNotebookName, notebookItemToken } from '@/lib/notebook/synapse-notebook-binding';
import { UNSCOPED_NOTEBOOK_REFUSAL } from '@/lib/notebook/synapse-notebook-write';

const user = { claims: { upn: 'u@x', tid: 't1', oid: 'user-oid' } };
const admin = { claims: { upn: 'a@x', tid: 't1', oid: 'admin-oid' } };
const PROPS = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 2 };

const ITEM_ID = '3f2a9c1e-7b4d-4e8a-9f10-1234567890ab';
const OTHER_ID = 'b7e1d2c3-0a9f-4e8d-8c7b-6a5f4e3d2c1b';
const BOUND = boundNotebookName('Sales nb', ITEM_ID)!;
const OTHER_BOUND = boundNotebookName('Sales nb', OTHER_ID)!;

// Fixture arithmetic, asserted so a fixture that stops reaching the rule is red
// here rather than silently green below: both names are valid NAME_RE shapes,
// share the same display prefix, and differ ONLY in the item token.
it('fixture: the two bound names differ only in their item token', () => {
  expect(BOUND).toBe(`Sales_nb_${notebookItemToken(ITEM_ID)}`);
  expect(OTHER_BOUND).toBe(`Sales_nb_${notebookItemToken(OTHER_ID)}`);
  expect(BOUND).not.toBe(OTHER_BOUND);
});

function access(canWrite: boolean, id = ITEM_ID) {
  return { item: { id, displayName: 'Sales nb', itemType: 'synapse-notebook' }, role: canWrite ? 'Owner' : 'Viewer', via: 'workspace', canWrite };
}

function req(method: 'PUT' | 'DELETE', name: string, itemId?: string, body?: unknown) {
  const q = itemId === undefined ? '' : `?itemId=${encodeURIComponent(itemId)}`;
  return new NextRequest(`http://localhost/api/synapse/notebooks/${name}${q}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
}
const ctx = (name: string) => ({ params: Promise.resolve({ name }) }) as any;

function sinkCalls() {
  return (upsertNotebook as any).mock.calls.length
    + (deleteNotebook as any).mock.calls.length
    + (uploadFile as any).mock.calls.length;
}

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid';
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-ws';
  process.env.LOOM_SILVER_URL = 'https://acct.dfs.core.windows.net/silver';
  (synapseConfigGate as any).mockReturnValue(null);
  (upsertNotebook as any).mockImplementation(async (name: string) => ({ name }));
  (deleteNotebook as any).mockResolvedValue(undefined);
  (uploadFile as any).mockResolvedValue({ size: 1 });
  (listNotebooks as any).mockResolvedValue([{ name: 'nb_1', properties: PROPS }]);
  (resolveItemAccessByOid as any).mockResolvedValue(access(true));
});

describe('PUT /api/synapse/notebooks/[name] — who may write', () => {
  it('401 without a session, and the sink is never called', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await PUT(req('PUT', BOUND, ITEM_ID, { properties: PROPS }), ctx(BOUND))).status).toBe(401);
    expect(sinkCalls()).toBe(0);
  });

  it('a tenant admin writes any valid name with no item, and no item lookup runs', async () => {
    // Breaks if the admin bypass is removed or moved after the itemId check:
    // a free name with no itemId would then be refused. Also breaks if admins
    // are forced through the item lookup (resolveItemAccessByOid called).
    (getSession as any).mockReturnValue(admin);
    const res = await PUT(req('PUT', 'nb_1', undefined, { properties: PROPS }), ctx('nb_1'));
    expect(res.status).toBe(200);
    expect(upsertNotebook).toHaveBeenCalledWith('nb_1', { name: 'nb_1', properties: PROPS });
    expect((uploadFile as any).mock.calls[0][1]).toBe('loom/notebooks/syn-ws/nb_1.ipynb');
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
  });

  it('a tenant admin who NAMES an item gets the tenant-bounded lookup: an unresolvable id is a 404', async () => {
    // Breaks if a tenant-admin shortcut runs ahead of the item lookup (the
    // write would succeed with 200 and the lookup would not be called) — the
    // shape that lets an admin's itemId skip the tenant boundary.
    (getSession as any).mockReturnValue(admin);
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await PUT(req('PUT', 'nb_1', ITEM_ID, { properties: PROPS }), ctx('nb_1'));
    expect(res.status).toBe(404);
    expect(resolveItemAccessByOid).toHaveBeenCalledWith(admin, ITEM_ID, 'synapse-notebook');
    expect(sinkCalls()).toBe(0);
  });

  it('a tenant admin with a resolved item may still write a name outside its binding (legacy name)', async () => {
    // Positive pair for the case above. `nb_1` is not BOUND, so this breaks if
    // the unbound-name branch refuses admins (403 notebook_not_bound) — the
    // editor sends ?itemId= with a legacy free name, and admins must keep it.
    expect('nb_1').not.toBe(BOUND);
    (getSession as any).mockReturnValue(admin);
    const res = await PUT(req('PUT', 'nb_1', ITEM_ID, { properties: PROPS }), ctx('nb_1'));
    expect(res.status).toBe(200);
    expect(resolveItemAccessByOid).toHaveBeenCalledWith(admin, ITEM_ID, 'synapse-notebook');
    expect(upsertNotebook).toHaveBeenCalledWith('nb_1', { name: 'nb_1', properties: PROPS });
  });

  it('a non-admin with NO itemId gets admin_only with the notebook reason; no lookup, no sink', async () => {
    // Breaks if the no-itemId branch falls through to the lookup (it would be
    // called with ''), or if it returns null (upsert → 200), or if the
    // refusal loses the surface-specific reason.
    (getSession as any).mockReturnValue(user);
    const res = await PUT(req('PUT', BOUND, undefined, { properties: PROPS }), ctx(BOUND));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.code).toBe('admin_only');
    expect(j.reason).toBe(UNSCOPED_NOTEBOOK_REFUSAL.reason);
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
    expect(sinkCalls()).toBe(0);
  });

  it('a non-admin writer saves the name bound to their item (positive pair)', async () => {
    // Breaks if PUT is still tenant-admin gated (403 admin_only), if the item
    // lookup uses a different item type than synapse-notebook, or if the item
    // id is not passed through from ?itemId=.
    (getSession as any).mockReturnValue(user);
    const res = await PUT(req('PUT', BOUND, ITEM_ID, { properties: PROPS }), ctx(BOUND));
    expect(res.status).toBe(200);
    expect(resolveItemAccessByOid).toHaveBeenCalledWith(user, ITEM_ID, 'synapse-notebook');
    expect(upsertNotebook).toHaveBeenCalledWith(BOUND, { name: BOUND, properties: PROPS });
  });

  it('the bound-name suffix match is case-insensitive (upper-cased token still binds)', async () => {
    // Breaks if the comparison becomes case-sensitive. Disclosed as a design
    // pin: Synapse artifact names are case-insensitive, so both spellings
    // address the same artifact.
    (getSession as any).mockReturnValue(user);
    const upper = `Sales_nb_${notebookItemToken(ITEM_ID)!.toUpperCase()}`;
    expect((await PUT(req('PUT', upper, ITEM_ID, { properties: PROPS }), ctx(upper))).status).toBe(200);
  });

  it.each([
    ['another item\'s bound name', () => OTHER_BOUND],
    ['a free name with no token', () => 'nb_1'],
    ['the token with a trailing character', () => `${BOUND}x`],
    ['the token followed by another segment', () => `${BOUND}_v2`],
    ['the bare token with no "_" separator', () => notebookItemToken(ITEM_ID)!],
    ['the token glued to a prefix with no "_"', () => `Sales${notebookItemToken(ITEM_ID)}`],
  ])('403 notebook_not_bound for %s, and the sink is never called', async (_label, mk) => {
    // Breaks if the isNameBoundToItem check is removed or loosened to a
    // substring/`includes`/no-separator suffix test: each of these names would
    // reach upsertNotebook with a 200.
    (getSession as any).mockReturnValue(user);
    const name = mk();
    const res = await PUT(req('PUT', name, ITEM_ID, { properties: PROPS }), ctx(name));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.code).toBe('notebook_not_bound');
    expect(j.boundName).toBe(BOUND);
    expect(sinkCalls()).toBe(0);
  });

  it('the binding is checked against the RESOLVED item id, not the caller-sent id', async () => {
    // The lookup answers with a different item than the one named. Breaks if
    // the binding is derived from ?itemId= instead of access.item.id: BOUND
    // would then match and the write would be a 200. (In production the two
    // ids are equal; this pins which one the rule reads.)
    (getSession as any).mockReturnValue(user);
    (resolveItemAccessByOid as any).mockResolvedValue(access(true, OTHER_ID));
    const res = await PUT(req('PUT', BOUND, ITEM_ID, { properties: PROPS }), ctx(BOUND));
    expect(res.status).toBe(403);
    expect((await res.json()).boundName).toBe(OTHER_BOUND);
    expect(sinkCalls()).toBe(0);
  });

  it('403 read_only when the caller\'s role on the item cannot write', async () => {
    // Breaks if the canWrite check is removed: a bound name on a viewer's
    // item would reach upsertNotebook with a 200.
    (getSession as any).mockReturnValue(user);
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await PUT(req('PUT', BOUND, ITEM_ID, { properties: PROPS }), ctx(BOUND));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('read_only');
    expect(sinkCalls()).toBe(0);
  });

  it('404 when the item does not resolve for the caller', async () => {
    // Breaks if a null access answer is treated as allowed (200) or crashes
    // on access.canWrite (500).
    (getSession as any).mockReturnValue(user);
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await PUT(req('PUT', BOUND, ITEM_ID, { properties: PROPS }), ctx(BOUND));
    expect(res.status).toBe(404);
    expect(sinkCalls()).toBe(0);
  });
});

describe('PUT /api/synapse/notebooks/[name] — name validation', () => {
  it.each([
    ['a "/" separator', 'a%2Fb'],
    ['a ".." traversal', '..%2F..%2Fx'],
    ['a bare ".."', '..'],
    ['a backslash', 'a%5Cb'],
    ['a dot', 'nb.ipynb'],
    ['a NUL', 'nb%00'],
    ['a control character', 'nb%01x'],
    ['a malformed percent-escape', '%E0%A4%A'],
    ['an empty name', '%20'],
    ['an over-long name', 'a'.repeat(261)],
  ])('400 on a name with %s, before any lookup, and the sink is never called', async (_label, raw) => {
    // Breaks if NAME_RE is loosened to admit separators/dots/controls, if the
    // decode error is not caught (500), or if authorization runs before name
    // validation (the lookup would be called for a non-admin).
    for (const s of [admin, user]) {
      vi.clearAllMocks();
      (getSession as any).mockReturnValue(s);
      const res = await PUT(req('PUT', 'placeholder', ITEM_ID, { properties: PROPS }), ctx(raw));
      expect(res.status).toBe(400);
      expect((await res.json()).ok).toBe(false);
      expect(resolveItemAccessByOid).not.toHaveBeenCalled();
      expect(sinkCalls()).toBe(0);
    }
  });
});

describe('DELETE /api/synapse/notebooks/[name]', () => {
  it('a non-admin with no itemId gets admin_only, and deleteNotebook is never called', async () => {
    // Breaks if DELETE has no gate at all (deleteNotebook → 200).
    (getSession as any).mockReturnValue(user);
    const res = await DELETE(req('DELETE', BOUND), ctx(BOUND));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('admin_only');
    expect(deleteNotebook).not.toHaveBeenCalled();
  });

  it('a non-admin writer deletes the name bound to their item (positive pair)', async () => {
    // Breaks if DELETE is still tenant-admin only (403) or ignores ?itemId=.
    (getSession as any).mockReturnValue(user);
    const res = await DELETE(req('DELETE', BOUND, ITEM_ID), ctx(BOUND));
    expect(res.status).toBe(200);
    expect(deleteNotebook).toHaveBeenCalledWith(BOUND);
  });

  it('a non-admin cannot delete another item\'s notebook through their own item', async () => {
    // Breaks if DELETE skips the binding check: OTHER_BOUND would be deleted.
    (getSession as any).mockReturnValue(user);
    const res = await DELETE(req('DELETE', OTHER_BOUND, ITEM_ID), ctx(OTHER_BOUND));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('notebook_not_bound');
    expect(deleteNotebook).not.toHaveBeenCalled();
  });

  it('a read-only role cannot delete the bound notebook', async () => {
    // Breaks if DELETE skips the canWrite check.
    (getSession as any).mockReturnValue(user);
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    expect((await DELETE(req('DELETE', BOUND, ITEM_ID), ctx(BOUND))).status).toBe(403);
    expect(deleteNotebook).not.toHaveBeenCalled();
  });

  it('a tenant admin deletes any valid name (positive pair)', async () => {
    (getSession as any).mockReturnValue(admin);
    const res = await DELETE(req('DELETE', 'nb_1'), ctx('nb_1'));
    expect(res.status).toBe(200);
    expect(deleteNotebook).toHaveBeenCalledWith('nb_1');
  });
});

describe('GET /api/synapse/notebooks/[name]', () => {
  it('stays session-scoped: a non-admin can read a notebook', async () => {
    // Breaks if GET were gated tenant-admin or item-scoped (403 / 404).
    (getSession as any).mockReturnValue(user);
    const res = await GET({} as any, ctx('nb_1'));
    expect(res.status).toBe(200);
    expect((await res.json()).notebook.name).toBe('nb_1');
  });

  it('400 (not 500) on a malformed percent-escape', async () => {
    // Breaks if decodeURIComponent is called unguarded: the URIError would be
    // caught by withSession and answered as a 500.
    (getSession as any).mockReturnValue(user);
    expect((await GET({} as any, ctx('%E0%A4%A'))).status).toBe(400);
  });
});
