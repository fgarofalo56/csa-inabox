/**
 * /api/synapse/notebooks/[name] — name validation + tenant-admin gate (#4619).
 *
 *   PUT / DELETE  401 / 403 non-admin (sink never called) / admin reaches the sink
 *   PUT           every rejected name shape is a 400 with the sink never called
 *   GET           stays session-scoped
 *
 * Each load-bearing assertion names the input that breaks it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/synapse-artifacts-client', () => ({
  synapseConfigGate: vi.fn(() => null),
  listNotebooks: vi.fn(),
  upsertNotebook: vi.fn(),
  deleteNotebook: vi.fn(),
}));
vi.mock('@/lib/azure/adls-client', () => ({ uploadFile: vi.fn() }));

import { GET, PUT, DELETE } from '../[name]/route';
import { getSession } from '@/lib/auth/session';
import { listNotebooks, upsertNotebook, deleteNotebook, synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';
import { uploadFile } from '@/lib/azure/adls-client';

const user = { claims: { upn: 'u@x', tid: 't1', oid: 'user-oid' } };
const admin = { claims: { upn: 'a@x', tid: 't1', oid: 'admin-oid' } };
const PROPS = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 2 };

const putReq = (body: unknown) => ({ json: async () => body }) as any;
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
});

describe('PUT /api/synapse/notebooks/[name] — authorization', () => {
  it('401 without a session, and the sink is never called', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await PUT(putReq({ properties: PROPS }), ctx('nb_1'))).status).toBe(401);
    expect(sinkCalls()).toBe(0);
  });

  it('403 admin_only for a signed-in non-admin, and the sink is never called', async () => {
    // Breaks if PUT is not tenant-admin gated: a valid name + body would reach
    // upsertNotebook and the ADLS backup and answer 200.
    (getSession as any).mockReturnValue(user);
    const res = await PUT(putReq({ properties: PROPS }), ctx('nb_1'));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('admin_only');
    expect(sinkCalls()).toBe(0);
  });

  it('a tenant admin reaches the sink, and the backup lands under the notebook name (positive pair)', async () => {
    // Breaks if the gate refuses admins, or the backup path stops being
    // derived from the validated name.
    (getSession as any).mockReturnValue(admin);
    const res = await PUT(putReq({ properties: PROPS }), ctx('nb_1'));
    expect(res.status).toBe(200);
    expect(upsertNotebook).toHaveBeenCalledWith('nb_1', { name: 'nb_1', properties: PROPS });
    expect((uploadFile as any).mock.calls[0][0]).toBe('silver');
    expect((uploadFile as any).mock.calls[0][1]).toBe('loom/notebooks/syn-ws/nb_1.ipynb');
  });
});

describe('PUT /api/synapse/notebooks/[name] — name validation (tenant admin)', () => {
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
  ])('400 on a name with %s, and the sink is never called', async (_label, raw) => {
    // Breaks if NAME_RE is loosened to admit separators/dots/controls, or if
    // the decode error is not caught (the malformed escape would then be a 500).
    (getSession as any).mockReturnValue(admin);
    const res = await PUT(putReq({ properties: PROPS }), ctx(raw));
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
    expect(sinkCalls()).toBe(0);
  });
});

describe('DELETE /api/synapse/notebooks/[name]', () => {
  it('403 admin_only for a signed-in non-admin, and deleteNotebook is never called', async () => {
    // Breaks if DELETE is not tenant-admin gated (it would call deleteNotebook → 200).
    (getSession as any).mockReturnValue(user);
    const res = await DELETE({} as any, ctx('nb_1'));
    expect(res.status).toBe(403);
    expect(deleteNotebook).not.toHaveBeenCalled();
  });

  it('a tenant admin deletes (positive pair)', async () => {
    (getSession as any).mockReturnValue(admin);
    const res = await DELETE({} as any, ctx('nb_1'));
    expect(res.status).toBe(200);
    expect(deleteNotebook).toHaveBeenCalledWith('nb_1');
  });
});

describe('GET /api/synapse/notebooks/[name]', () => {
  it('stays session-scoped: a non-admin can read a notebook', async () => {
    // Breaks if GET were gated tenant-admin (403).
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
