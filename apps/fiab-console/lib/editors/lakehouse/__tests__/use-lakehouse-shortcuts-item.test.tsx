/**
 * useLakehouseShortcuts — Test and Delete name the open lakehouse ITEM.
 *
 * A row saved before item keys carries its storage container name (`bronze`)
 * in `lakehouseId`; the routes resolve such a row from the item id. The row
 * below therefore uses a `lakehouseId` that differs from the open item, so the
 * assertions break if the hook sends the row's own `lakehouseId` (`bronze`)
 * instead of `lh-item-1`, and the positive arm breaks if no request is sent.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useLakehouseShortcuts } from '../hooks/use-lakehouse-shortcuts';
import type { ShortcutRow } from '../types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ITEM_ID = 'lh-item-1';
const LEGACY_ROW: ShortcutRow = {
  id: 'sc-1', lakehouseId: 'bronze', name: 'orders', kind: 'files', parentPath: '', fullPath: 'Files/orders',
  targetType: 'adls', targetUri: 'abfss://raw@acct.dfs.core.windows.net/orders', status: 'active',
  createdBy: 'owner@contoso.com', createdAt: '2026-01-01T00:00:00Z',
};

interface Call { url: string; init?: RequestInit }

function installFetch(): Call[] {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    calls.push({ url, init });
    const body = url.includes('/api/lakehouse/shortcuts?') && !init?.method
      ? { ok: true, data: [LEGACY_ROW] }
      : { ok: true, data: LEGACY_ROW };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) as any;
  });
  return calls;
}

function mount(shortcutLakehouseId: string) {
  return renderHook(() => useLakehouseShortcuts({
    shortcutLakehouseId, schemasEnabled: false, containers: null, schemas: null, bundleShortcuts: [],
    loadSchemas: async () => {}, confirm: async () => true, setSqlText: () => {}, setTab: () => {}, tab: 'files',
  }));
}

describe('useLakehouseShortcuts: row actions name the open item', () => {
  it('Test posts the open item id, not the row registry key', async () => {
    const calls = installFetch();
    const { result } = mount(ITEM_ID);
    await act(async () => { await result.current.testShortcut(LEGACY_ROW); });
    const post = calls.find((c) => c.url.includes('/api/lakehouse/shortcuts/test'));
    expect(post, 'Test sent no request').toBeTruthy();
    expect(JSON.parse(String(post!.init?.body))).toEqual({ lakehouseId: ITEM_ID, id: 'sc-1' });
  });

  it('Delete names the open item id, not the row registry key', async () => {
    const calls = installFetch();
    const { result } = mount(ITEM_ID);
    await act(async () => { await result.current.deleteShortcutRow(LEGACY_ROW); });
    const del = calls.find((c) => c.init?.method === 'DELETE');
    expect(del, 'Delete sent no request').toBeTruthy();
    const qs = new URL(del!.url, 'http://x').searchParams;
    expect(qs.get('lakehouseId')).toBe(ITEM_ID);
    expect(qs.get('id')).toBe('sc-1');
  });

  it('an unsaved item sends nothing', async () => {
    const calls = installFetch();
    const { result } = mount('');
    await act(async () => {
      await result.current.testShortcut(LEGACY_ROW);
      await result.current.deleteShortcutRow(LEGACY_ROW);
    });
    expect(calls.map((c) => c.url)).toEqual([]);
  });
});
