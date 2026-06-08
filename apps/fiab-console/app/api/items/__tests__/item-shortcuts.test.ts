/**
 * Backend contract tests for the item-level internal lakehouse Shortcuts API —
 * Azure-native parity with Fabric OneLake internal shortcuts (NO Fabric dep).
 *
 *   GET    /api/items/[type]/[id]/shortcuts                  list (no mock array)
 *   POST   /api/items/[type]/[id]/shortcuts                  create + ADLS probe
 *   DELETE /api/items/[type]/[id]/shortcuts/[name]           drop engine obj + row
 *   PATCH  /api/items/[type]/[id]/shortcuts/[name]           rename / move
 *   POST   /api/items/[type]/[id]/shortcuts/[name]/test      live ADLS HEAD → OK/Broken
 *
 * Acceptance (task): create → active/OK; Test → OK; deleting the target path →
 * next Test returns Broken; no mock list.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: vi.fn() }));
vi.mock('@/lib/azure/lakehouse-shortcuts', () => ({
  shortcutId: vi.fn((lh: string, kind: string, parent: string, name: string) => `${lh}:${kind}:${parent}:${name}`),
}));
vi.mock('@/lib/azure/shortcut-client', () => ({
  listShortcuts: vi.fn(),
  createInternalShortcut: vi.fn(),
  testInternalShortcut: vi.fn(),
  getShortcut: vi.fn(),
  deleteShortcut: vi.fn(),
  dropShortcutObject: vi.fn(),
  // real mapping so the test route's pill is exercised honestly
  displayStatus: (s: string) => (s === 'active' ? 'OK' : s === 'error' ? 'Broken' : 'Pending'),
}));

import { GET, POST } from '../[type]/[id]/shortcuts/route';
import { DELETE, PATCH } from '../[type]/[id]/shortcuts/[name]/route';
import { POST as TEST } from '../[type]/[id]/shortcuts/[name]/test/route';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import {
  listShortcuts, createInternalShortcut, testInternalShortcut, getShortcut, deleteShortcut, dropShortcutObject,
} from '@/lib/azure/shortcut-client';

const sess = { claims: { oid: 'o1', upn: 'u@x' } };
const params = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ type: 'lakehouse', id: 'lh1', ...extra }) });
const postReq = (body: any) => ({ json: async () => body } as any);

beforeEach(() => {
  vi.resetAllMocks();
  (loadOwnedItem as any).mockResolvedValue({ id: 'lh1', itemType: 'lakehouse', workspaceId: 'ws1' });
});

describe('GET /api/items/[type]/[id]/shortcuts', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await GET({} as any, params())).status).toBe(401);
  });
  it('404 when the item is not owned', async () => {
    (getSession as any).mockReturnValue(sess);
    (loadOwnedItem as any).mockResolvedValue(null);
    expect((await GET({} as any, params())).status).toBe(404);
  });
  it('returns real registry rows (no mock array)', async () => {
    (getSession as any).mockReturnValue(sess);
    (listShortcuts as any).mockResolvedValue([{ id: 'lh1:files::a', name: 'a', kind: 'files', status: 'active' }]);
    const res = await GET({} as any, params());
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data).toHaveLength(1);
    expect(listShortcuts).toHaveBeenCalledWith('lh1');
  });
});

describe('POST /api/items/[type]/[id]/shortcuts', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await POST(postReq({}), params())).status).toBe(401);
  });
  it('400 on validation failures', async () => {
    (getSession as any).mockReturnValue(sess);
    expect((await POST(postReq({}), params())).status).toBe(400); // no name
    expect((await POST(postReq({ name: 'a', kind: 'bogus', targetUri: 'internal://silver/p' }), params())).status).toBe(400);
    expect((await POST(postReq({ name: 'a', kind: 'files', targetType: 's3', targetUri: 's3://b/p' }), params())).status).toBe(400);
    expect((await POST(postReq({ name: 'a', kind: 'files', targetType: 'internal', targetUri: 'abfss://x' }), params())).status).toBe(400);
  });
  it('creates an internal Files shortcut (active/OK) on the happy path', async () => {
    (getSession as any).mockReturnValue(sess);
    (createInternalShortcut as any).mockResolvedValue({ ok: true, shortcut: { id: 'lh1:files::a', name: 'a', kind: 'files', status: 'active', fullPath: 'Files/a' } });
    const res = await POST(postReq({ name: 'a', kind: 'files', targetType: 'internal', targetUri: 'internal://silver/partner_products' }), params());
    const j = await res.json();
    expect(res.status).toBe(201);
    expect(j.ok).toBe(true);
    expect(j.data.status).toBe('active');
    expect(createInternalShortcut).toHaveBeenCalledTimes(1);
  });
  it('503 honest-gate for a Tables shortcut with no query engine', async () => {
    (getSession as any).mockReturnValue(sess);
    (createInternalShortcut as any).mockResolvedValue({ ok: false, gate: { gated: true, code: 'no_tables_engine', hint: 'set LOOM_SYNAPSE_WORKSPACE' }, shortcut: { id: 'x', status: 'pending' } });
    const res = await POST(postReq({ name: 'a', kind: 'tables', targetType: 'internal', targetUri: 'internal://silver/t', format: 'delta' }), params());
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.code).toBe('no_tables_engine');
    expect(j.data.status).toBe('pending');
  });
  it('502 when the UAMI cannot read the target (403)', async () => {
    (getSession as any).mockReturnValue(sess);
    (createInternalShortcut as any).mockRejectedValue(Object.assign(new Error('This request is not authorized (403).'), { statusCode: 403 }));
    const res = await POST(postReq({ name: 'a', kind: 'files', targetType: 'internal', targetUri: 'internal://silver/p' }), params());
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.code).toBe('adls_access_denied');
  });
});

describe('DELETE /api/items/[type]/[id]/shortcuts/[name]', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await DELETE({} as any, params({ name: 'lh1:files::a' }))).status).toBe(401);
  });
  it('drops the engine object then deletes the row', async () => {
    (getSession as any).mockReturnValue(sess);
    (getShortcut as any).mockResolvedValue({ id: 'lh1:tables::a', engine: 'synapse', engineObject: 'shortcuts.a' });
    (dropShortcutObject as any).mockResolvedValue(undefined);
    (deleteShortcut as any).mockResolvedValue({ ok: true });
    const res = await DELETE({} as any, params({ name: encodeURIComponent('lh1:tables::a') }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(dropShortcutObject).toHaveBeenCalledWith({ engine: 'synapse', engineObject: 'shortcuts.a' });
    expect(deleteShortcut).toHaveBeenCalledWith('lh1', 'lh1:tables::a');
  });
});

describe('PATCH /api/items/[type]/[id]/shortcuts/[name]', () => {
  it('renames: re-creates at the new id and removes the old row', async () => {
    (getSession as any).mockReturnValue(sess);
    (getShortcut as any).mockResolvedValue({ id: 'lh1:files::old', name: 'old', kind: 'files', parentPath: '', targetType: 'internal', targetUri: 'internal://silver/p', createdBy: 'u@x', engine: 'none' });
    (createInternalShortcut as any).mockResolvedValue({ ok: true, shortcut: { id: 'lh1:files::new', name: 'new', status: 'active' } });
    (dropShortcutObject as any).mockResolvedValue(undefined);
    (deleteShortcut as any).mockResolvedValue({ ok: true });
    const res = await PATCH(postReq({ name: 'new' }), params({ name: encodeURIComponent('lh1:files::old') }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data.name).toBe('new');
    expect(deleteShortcut).toHaveBeenCalledWith('lh1', 'lh1:files::old'); // stale row removed
  });
});

describe('POST /api/items/[type]/[id]/shortcuts/[name]/test (live ADLS HEAD)', () => {
  it('404 when the shortcut id is unknown', async () => {
    (getSession as any).mockReturnValue(sess);
    (testInternalShortcut as any).mockResolvedValue(null);
    const res = await TEST({} as any, params({ name: 'nope' }));
    expect(res.status).toBe(404);
  });
  it('OK when the target is reachable', async () => {
    (getSession as any).mockReturnValue(sess);
    (testInternalShortcut as any).mockResolvedValue({ id: 'x', status: 'active' });
    const res = await TEST({} as any, params({ name: 'x' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.displayStatus).toBe('OK');
  });
  it('Broken (502) when the target path was deleted', async () => {
    (getSession as any).mockReturnValue(sess);
    (testInternalShortcut as any).mockResolvedValue({ id: 'x', status: 'error', statusDetail: 'Target path not found (404).' });
    const res = await TEST({} as any, params({ name: 'x' }));
    const j = await res.json();
    expect(res.status).toBe(502);
    expect(j.ok).toBe(false);
    expect(j.displayStatus).toBe('Broken');
    expect(j.code).toBe('broken');
  });
});
