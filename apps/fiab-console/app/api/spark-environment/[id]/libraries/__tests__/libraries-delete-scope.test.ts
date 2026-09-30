/**
 * DELETE /api/spark-environment/[id]/libraries — the blob deleted is re-derived
 * from the environment's own library root (#4619).
 *
 * The recorded `path` / `containerName` on a library entry are item state; the
 * route must only delete `landing/spark-env-libs/<this environment id>/<name>`
 * and refuse (400, nothing deleted, state untouched) any entry that names
 * anything else. Each load-bearing assertion names the input that breaks it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/adls-client', () => ({ uploadFile: vi.fn(), deletePath: vi.fn() }));
vi.mock('@/app/api/items/_lib/item-crud', async () => {
  const { NextResponse } = await import('next/server');
  return {
    loadOwnedItem: vi.fn(),
    updateOwnedItem: vi.fn(),
    jerr: (error: string, status = 500) => NextResponse.json({ ok: false, error }, { status }),
  };
});

import { DELETE } from '../route';
import { getSession } from '@/lib/auth/session';
import { deletePath } from '@/lib/azure/adls-client';
import { loadOwnedItem, updateOwnedItem } from '@/app/api/items/_lib/item-crud';

const owner = { claims: { upn: 'o@x', tid: 't1', oid: 'owner-oid' } };

function lib(over: Record<string, unknown> = {}) {
  return { name: 'lib.whl', path: 'spark-env-libs/env-1/lib.whl', containerName: 'landing', type: 'whl', ...over };
}
function itemWith(libs: unknown[], id = 'env-1') {
  return { id, itemType: 'spark-environment', state: { customLibraries: libs } };
}
function delReq(name: string) {
  const u = new URL('http://x/api/spark-environment/env-1/libraries');
  u.searchParams.set('name', name);
  return { nextUrl: u } as any;
}
const ctx = (id = 'env-1') => ({ params: Promise.resolve({ id }) }) as any;

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(owner);
  (deletePath as any).mockResolvedValue(undefined);
  (updateOwnedItem as any).mockImplementation(async (_id: string, _t: string, _o: string, patch: any) => ({ id: 'env-1', ...patch }));
});

describe('DELETE libraries — authorization', () => {
  it('401 without a session, and nothing is deleted', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await DELETE(delReq('lib.whl'), ctx());
    expect(res.status).toBe(401);
    expect(deletePath).not.toHaveBeenCalled();
  });

  it('404 when the caller does not own the environment, and nothing is deleted', async () => {
    // Breaks if the ownership load were skipped: the route would go on to delete.
    (loadOwnedItem as any).mockResolvedValue(null);
    const res = await DELETE(delReq('lib.whl'), ctx());
    expect(res.status).toBe(404);
    expect(deletePath).not.toHaveBeenCalled();
    expect(updateOwnedItem).not.toHaveBeenCalled();
  });

  it('the owner deletes an entry at its own library location (positive pair)', async () => {
    // Breaks if the derivation refuses the location POST itself writes.
    (loadOwnedItem as any).mockResolvedValue(itemWith([lib()]));
    const res = await DELETE(delReq('lib.whl'), ctx());
    expect(res.status).toBe(200);
    expect(deletePath).toHaveBeenCalledWith('landing', 'spark-env-libs/env-1/lib.whl');
    expect((await res.json()).customLibraries).toEqual([]);
  });

  it('accepts the entry recorded under a loom: synthetic route id, resolved to a Cosmos id', async () => {
    // The list route hands the editor `loom:<id>`; POST records whichever id it
    // was called with. Breaks if only item.id were admitted as the root.
    (loadOwnedItem as any).mockResolvedValue(itemWith([lib({ path: 'spark-env-libs/loom:abc/lib.whl' })], 'cosmos-1'));
    const res = await DELETE(delReq('lib.whl'), ctx('loom:abc'));
    expect(res.status).toBe(200);
    expect(deletePath).toHaveBeenCalledWith('landing', 'spark-env-libs/loom:abc/lib.whl');
  });
});

describe('DELETE libraries — recorded location outside the environment root', () => {
  it.each([
    ['another environment\'s folder', { path: 'spark-env-libs/env-2/lib.whl' }],
    ['a ".." escape out of the root', { path: 'spark-env-libs/env-1/../../gold/lib.whl' }],
    ['a path outside spark-env-libs', { path: 'Files/lib.whl' }],
    ['a leading slash', { path: '/spark-env-libs/env-1/lib.whl' }],
    ['a different container', { containerName: 'gold' }],
    ['a NUL in the path', { path: 'spark-env-libs/env-1/lib.whl\u0000' }],
    ['a path whose file name differs from the entry name', { path: 'spark-env-libs/env-1/other.whl' }],
  ])('400 on an entry recorded at %s: nothing deleted, state untouched', async (_label, over) => {
    // Breaks if DELETE uses the recorded `path` / `containerName` instead of the
    // re-derived location: deletePath would be called and the answer 200.
    (loadOwnedItem as any).mockResolvedValue(itemWith([lib(over)]));
    const res = await DELETE(delReq('lib.whl'), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
    expect(deletePath).not.toHaveBeenCalled();
    expect(updateOwnedItem).not.toHaveBeenCalled();
  });

  it('400 when the derived location itself is not a safe blob path (control char in the environment id)', async () => {
    // The root is built from the environment id, which `isPlainSegment` screens
    // for separators and dot segments only. Here the recorded path EQUALS the
    // derived one, so the root-equality check admits it; the only refusal is the
    // blob-rel-path shape check on the path. Breaks if that check is removed:
    // deletePath would be called with "spark-env-libs/env\u0001/lib.whl".
    const id = 'env\u0001';
    (loadOwnedItem as any).mockResolvedValue(itemWith([lib({ path: `spark-env-libs/${id}/lib.whl` })], id));
    const res = await DELETE(delReq('lib.whl'), ctx(id));
    expect(res.status).toBe(400);
    expect(deletePath).not.toHaveBeenCalled();
    expect(updateOwnedItem).not.toHaveBeenCalled();
  });
});

describe('DELETE libraries — name query validation', () => {
  it.each([
    ['a "/" separator', 'a/b.whl'],
    ['a backslash', 'a\\b.whl'],
    ['a bare ".."', '..'],
    ['a NUL', 'lib\u0000.whl'],
    ['a space', 'my lib.whl'],
  ])('400 on a name with %s, before the item is even loaded', async (_label, name) => {
    // Breaks if the LIB_NAME_RE / isPlainSegment check on `name` is removed:
    // the route would load the item and (with a matching entry) delete.
    (loadOwnedItem as any).mockResolvedValue(itemWith([lib({ name })]));
    const res = await DELETE(delReq(name), ctx());
    expect(res.status).toBe(400);
    expect(loadOwnedItem).not.toHaveBeenCalled();
    expect(deletePath).not.toHaveBeenCalled();
  });
});
