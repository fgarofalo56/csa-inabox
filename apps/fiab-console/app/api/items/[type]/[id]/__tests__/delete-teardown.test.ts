/**
 * #5046 - `DELETE /api/items/[type]/[id]` tears down the backing resource(s)
 * before the Cosmos doc goes, and reports what it could not remove.
 *
 * Breaking inputs:
 *   - order ['authorize','teardown','cosmos-delete']: fails if teardown runs
 *     after the delete (refs gone) or before the role check (a Reader would
 *     trigger a backend delete).
 *   - Reader refusal (authorize returns a 403)        -> teardown AND delete
 *     must not run; fails if the role gate is bypassed.
 *   - allowReadRoles:false                            -> fails if flipped.
 *   - orphans in the report                           -> 200, doc STILL deleted,
 *     `warning` + `teardown.orphans` in the body; fails if teardown errors
 *     block the delete or are dropped from the response.
 *   - teardown input carries the item's own recorded state and the URL's type;
 *     fails if teardown were handed a different state/type.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

const order: string[] = [];
const ITEM = { id: 'it-1', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Lake', state: { provisioning: { secondaryIds: { container: 'c', rootPath: 'r' } } } };
const deleteDoc = vi.fn(async () => { order.push('cosmos-delete'); });
const authorize = vi.fn(async (_s: any, _o: any): Promise<NextResponse | null> => { order.push('authorize'); return null; });
const teardown = vi.fn(async (_i: any, _t: string): Promise<any> => {
  order.push('teardown');
  return { status: 'ran', orphans: [], retained: [], removed: [] };
});

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: (s: any, o: any) => authorize(s, o) }));
vi.mock('@/lib/azure/item-teardown-registry', () => ({ teardownForItemDelete: (i: any, t: string) => teardown(i, t) }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: vi.fn(),
  itemsContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [ITEM] }) }) },
    item: () => ({ delete: deleteDoc }),
  })),
}));
vi.mock('@/lib/items/record-open', () => ({ recordItemOpen: vi.fn() }));

import { getSession } from '@/lib/auth/session';
import { DELETE } from '../route';

const ctx = { params: Promise.resolve({ type: 'lakehouse', id: 'it-1' }) };
const REQ = { nextUrl: new URL('http://localhost/api/items/lakehouse/it-1') } as any;

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
  authorize.mockImplementation(async () => { order.push('authorize'); return null; });
  teardown.mockImplementation(async () => { order.push('teardown'); return { status: 'ran', orphans: [], retained: [], removed: [] }; });
  (getSession as any).mockReturnValue({ claims: { oid: 'oid1' } });
});

describe('generic DELETE runs the registered teardown', () => {
  it('authorizes (write roles) -> tears down -> deletes the doc, in that order', async () => {
    const res = await DELETE(REQ, ctx);
    expect(res.status).toBe(200);
    expect(order).toEqual(['authorize', 'teardown', 'cosmos-delete']);
    expect(authorize.mock.calls[0][1]).toMatchObject({ allowReadRoles: false, itemType: 'lakehouse', workspaceId: 'ws-1' });
    expect(teardown.mock.calls[0][0]).toMatchObject({ id: 'it-1', workspaceId: 'ws-1', itemType: 'lakehouse', state: ITEM.state });
    expect(teardown.mock.calls[0][1]).toBe('oid1');
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.warning).toBeUndefined();
  });

  it('a READER (403 from the guard) triggers neither teardown nor delete', async () => {
    authorize.mockImplementationOnce(async () => NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }));
    const res = await DELETE(REQ, ctx);
    expect(res.status).toBe(403);
    expect(teardown, 'a read-only caller reached the backend teardown').not.toHaveBeenCalled();
    expect(deleteDoc, 'a read-only caller deleted the item').not.toHaveBeenCalled();
  });

  it('orphans do NOT block the Cosmos delete and are returned loudly', async () => {
    const orphan = { kind: 'adls-path', ref: 'c/r', result: 'error', error: '403 AuthorizationFailure' };
    teardown.mockImplementationOnce(async () => {
      order.push('teardown');
      return { status: 'ran', orphans: [orphan], retained: [], removed: [], warning: 'Item deleted, but 1 backing resource(s) could not be removed and may still exist: adls-path c/r (403 AuthorizationFailure).' };
    });
    const res = await DELETE(REQ, ctx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(deleteDoc).toHaveBeenCalledTimes(1);
    expect(body.warning).toContain('adls-path c/r');
    expect(body.teardown.orphans).toEqual([orphan]);
  });

  it('no session -> 401 and nothing runs', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await DELETE(REQ, ctx);
    expect(res.status).toBe(401);
    expect(teardown).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();
  });
});
