/**
 * Every permissions READ the lakehouse surfaces make names the lakehouse item.
 *
 * GET /api/lakehouse/permissions is scoped to one lakehouse: without
 * `lakehouseId` only a tenant admin is answered, so a surface that drops the id
 * works for an admin and is refused for every item member.
 *
 * The assertion is on the FULL query of every GET issued, as a list of
 * parameter maps, so the value that breaks it is concrete: a read URL built
 * without `lakehouseId` (the map loses that key), or with a different item's
 * id. The list is compared exactly, so a surface that issues no reads at all
 * fails too (an empty list is not the expected list).
 *
 * Writes (POST / DELETE) are tenant-admin routes. The object-tab writes name
 * the item too, so the server acts on the account the item is bound to; that
 * is asserted in permissions-writes-name-item.test.tsx.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, render, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const calls: Array<{ url: string; method: string }> = [];

vi.mock('@/lib/client-fetch', () => ({
  clientFetch: async (url: string, init?: { method?: string }) => {
    calls.push({ url, method: init?.method || 'GET' });
    const q = new URL(url, 'http://x').searchParams;
    // Labelled JSON: the hook's parser reads a body only when it is.
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    if (q.get('list') === 'tables') {
      return json({ ok: true, tables: [{ objectId: 7, schema: 'dbo', name: 'orders', type: 'U' }] });
    }
    if (q.get('list') === 'columns') {
      return json({ ok: true, columns: [{ columnId: 3, name: 'region', dataType: 'varchar' }] });
    }
    return json({ ok: true, assignments: [], knownRoles: [], grants: [], policies: [], denyGrants: [] });
  },
}));
vi.mock('@/lib/components/editor/monaco-textarea', () => ({
  MonacoTextarea: () => <textarea aria-label="predicate" />,
}));

import { useLakehousePermissions } from '../hooks/use-lakehouse-permissions';
import { OneLakeSecurityTab } from '@/lib/panes/onelake-security-tab';

const LH = 'lh-scope';

function reads() {
  return calls
    .filter((c) => c.method === 'GET' && c.url.startsWith('/api/lakehouse/permissions'))
    .map((c) => Object.fromEntries(new URL(c.url, 'http://x').searchParams));
}

beforeEach(() => { calls.length = 0; });
afterEach(() => { cleanup(); });

describe('useLakehousePermissions — reads name the lakehouse', () => {
  it('the container list, every SQL tab, the table list and the column list carry lakehouseId', async () => {
    const confirm = vi.fn(async () => true);
    const { result } = renderHook(() => useLakehousePermissions({ lakehouseId: LH, activeContainer: 'landing', confirm }));

    await act(async () => { result.current.openPerms(); });
    await act(async () => { result.current.selectPermsTab('row'); });
    await act(async () => { result.current.selectPermsTab('table'); });
    await act(async () => { await result.current.loadSqlColumns(7); });

    expect(reads()).toEqual([
      { container: 'landing', lakehouseId: LH },
      { tab: 'row', lakehouseId: LH },
      { tab: 'row', list: 'tables', lakehouseId: LH },
      { tab: 'table', lakehouseId: LH },
      { tab: 'table', list: 'tables', lakehouseId: LH },
      { tab: 'column', list: 'columns', objectId: '7', lakehouseId: LH },
    ]);
  });

  // The object-tab revoke names the item, so the server revokes on the account
  // the item is bound to (the account the listing read). FAILS IF the DELETE
  // drops `lakehouseId` (the map loses that key) or names another item.
  it('a revoke names the lakehouse on the DELETE URL', async () => {
    const confirm = vi.fn(async () => true);
    const { result } = renderHook(() => useLakehousePermissions({ lakehouseId: LH, activeContainer: 'landing', confirm }));
    await act(async () => { await result.current.revokePerm('/subscriptions/s/ra/1'); });
    const del = calls.filter((c) => c.method === 'DELETE').map((c) => Object.fromEntries(new URL(c.url, 'http://x').searchParams));
    expect(del).toEqual([{ tab: 'object', lakehouseId: LH, container: 'landing', id: '/subscriptions/s/ra/1' }]);
    // The reload after the revoke is a read, and names the item.
    expect(reads()).toEqual([{ container: 'landing', lakehouseId: LH }]);
  });
});

describe('OneLakeSecurityTab — reads name the lakehouse', () => {
  it('the column-security state and table list load with lakehouseId', async () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <OneLakeSecurityTab lakehouseId={LH} />
      </FluentProvider>,
    );
    await vi.waitFor(() => expect(reads().length).toBe(2));
    // Both loads start together, so compare as a set (sorted by `list`).
    const got = reads().sort((a, b) => String(a.list || '').localeCompare(String(b.list || '')));
    expect(got).toEqual([
      { tab: 'cls', lakehouseId: LH },
      { tab: 'cls', list: 'tables', lakehouseId: LH },
    ]);
  });
});
