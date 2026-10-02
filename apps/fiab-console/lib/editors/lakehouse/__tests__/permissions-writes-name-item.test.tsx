/**
 * The object-tab WRITES name the lakehouse item.
 *
 * GET /api/lakehouse/permissions lists container role assignments on the
 * account the item is bound to. The grant (Permissions dialog and Share) and
 * the revoke must reach the SAME account, so each write carries `lakehouseId`
 * and the server resolves the account from the item. A write without it is
 * refused by the server, so a surface that drops the id fails for every item.
 *
 * Every assertion reads the full request (method, query or JSON body) of each
 * write, so the value that breaks it is concrete: a POST body or DELETE query
 * without `lakehouseId`, or with another item's id. An unsaved item (no id)
 * sends no write at all.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useLakehousePermissions } from '../hooks/use-lakehouse-permissions';
import { useLakehouseSecondary } from '../hooks/use-lakehouse-secondary';

const LH = 'lh-writes';

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];

function installFetch() {
  calls = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const method = String(init?.method || 'GET').toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url, method, body });
    const json = { ok: true, assignments: [], knownRoles: [], assignment: { id: 'x' } };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } }) as any;
  });
}

/** The permissions writes issued, with the DELETE query read into a map. */
function writes() {
  return calls
    .filter((c) => c.url.startsWith('/api/lakehouse/permissions') && c.method !== 'GET')
    .map((c) => (c.method === 'DELETE'
      ? { method: c.method, query: Object.fromEntries(new URL(c.url, 'http://x').searchParams) }
      : { method: c.method, body: c.body }));
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mountPerms(lakehouseId: string) {
  return renderHook(() => useLakehousePermissions({
    lakehouseId, activeContainer: 'landing', confirm: async () => true,
  }));
}

function mountSecondary(id: string, isNewItem: boolean) {
  return renderHook(() => useLakehouseSecondary({
    id, isNewItem, activeContainer: 'landing', shortcutLakehouseId: isNewItem ? '' : id,
    schemasEnabled: false, setSchemasEnabled: () => {}, loadPaths: async () => {},
    tablesPrefix: 'Tables', confirm: async () => true,
    itemQ: { data: undefined } as any, maintainTable: '', tab: 'files',
  }));
}

describe('Permissions dialog writes name the lakehouse', () => {
  // FAILS IF the grant body drops `lakehouseId` or `tab: 'object'`: the body
  // no longer equals this object.
  it('a grant posts the item id with the principal and role', async () => {
    installFetch();
    const { result } = mountPerms(LH);
    await act(async () => { result.current.setNewPrincipalId('p1'); });
    await act(async () => { await result.current.grantPerm(); });
    expect(writes()).toEqual([{
      method: 'POST',
      body: {
        tab: 'object', lakehouseId: LH, container: 'landing', principalId: 'p1',
        principalType: 'User', role: 'Storage Blob Data Reader',
      },
    }]);
  });

  // FAILS IF the revoke query drops `lakehouseId`.
  it('a revoke names the item on the DELETE query', async () => {
    installFetch();
    const { result } = mountPerms(LH);
    await act(async () => { await result.current.revokePerm('/subscriptions/s/ra/1'); });
    expect(writes()).toEqual([{
      method: 'DELETE',
      query: { tab: 'object', lakehouseId: LH, container: 'landing', id: '/subscriptions/s/ra/1' },
    }]);
  });

  // FAILS IF an unsaved item (no id) still sends a write: the server would
  // refuse it, and the list would not be empty. Paired with the two cases above,
  // which send exactly one write each for a saved item.
  it('an unsaved lakehouse sends no grant or revoke', async () => {
    installFetch();
    const { result } = mountPerms('');
    await act(async () => { result.current.setNewPrincipalId('p1'); });
    await act(async () => { await result.current.grantPerm(); });
    await act(async () => { await result.current.revokePerm('/subscriptions/s/ra/1'); });
    expect(writes()).toEqual([]);
  });
});

describe('Share names the lakehouse', () => {
  // FAILS IF the Share body drops `lakehouseId` or names another item.
  it('Share posts the item id', async () => {
    installFetch();
    const { result } = mountSecondary(LH, false);
    await act(async () => { result.current.setSharePrincipal('p2'); });
    await act(async () => { await result.current.grantShare(); });
    expect(writes()).toEqual([{
      method: 'POST',
      body: {
        tab: 'object', lakehouseId: LH, container: 'landing', principalId: 'p2',
        principalType: 'User', role: 'Storage Blob Data Reader',
      },
    }]);
  });

  // FAILS IF Share posts for an unsaved item. Paired with the case above.
  it('Share on an unsaved lakehouse sends nothing', async () => {
    installFetch();
    const { result } = mountSecondary('new', true);
    await act(async () => { result.current.setSharePrincipal('p2'); });
    await act(async () => { await result.current.grantShare(); });
    expect(writes()).toEqual([]);
  });
});
