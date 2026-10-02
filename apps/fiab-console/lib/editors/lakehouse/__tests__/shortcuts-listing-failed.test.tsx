/**
 * Shortcuts: a failed listing is unknown, not empty; refusals show their next
 * step; a create that saved a pending or error row shows that row.
 *
 *   - useLakehouseShortcuts sets `shortcutsListFailed` when the listing fails
 *     and clears it at the start of every listing. The pane then shows the
 *     error, and NOT "No shortcuts registered yet" or the bundle's Register
 *     actions (rows count as registered by name, and the list is unknown).
 *   - The listing, create, register and Delete refusals carry `remediation`,
 *     shown after the error as Test does.
 *   - A create answered 503 (engine not configured) or 502 (bind failed) still
 *     saved a row and answers it in `data`; the list is reloaded so it shows.
 *
 * What breaks each assertion is named at it.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup, screen, waitFor } from '@testing-library/react';
import { useLakehouseShortcuts } from '../hooks/use-lakehouse-shortcuts';
import { ShortcutsPane } from '../panes/shortcuts-pane';
import { LakehouseEditorContext } from '../lakehouse-editor-context';
import type { LakehouseEditorCtx } from '../lakehouse-editor-context';
import { renderWithProviders, installFetchMock } from '../../__tests__/test-helpers';
import type { ShortcutRow } from '../types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const LH = 'lh-item-1';
const ROW: ShortcutRow = {
  id: 'sc-1', lakehouseId: LH, name: 'orders', kind: 'files', parentPath: '', fullPath: 'Files/orders',
  targetType: 'adls', targetUri: 'abfss://raw@acct.dfs.core.windows.net/orders', status: 'active',
  createdBy: 'owner@contoso.com', createdAt: '2026-01-01T00:00:00Z',
};
const PENDING: ShortcutRow = { ...ROW, id: 'sc-2', name: 'ext', targetType: 's3', status: 'pending' };
// The item refusal as authorizeItem sends it (code + remediation).
const NOT_FOUND = { ok: false, code: 'item_not_found', error: 'Lakehouse not found.', remediation: 'Check that the lakehouse still exists and that you can open it.' };

type Reply = { status: number; body: unknown };
interface Call { url: string; method: string }

/** Each request takes the next reply queued for its route key ('list', 'post', 'delete'). */
function installFetch(queues: Record<'list' | 'post' | 'delete', Reply[]>): Call[] {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({ url, method });
    const key = method === 'DELETE' ? 'delete' : method === 'POST' ? 'post' : 'list';
    const next = queues[key].shift();
    if (!next) throw new Error(`unexpected ${method} ${url}: no reply queued`);
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } }) as any;
  });
  return calls;
}
const listed = (rows: ShortcutRow[]): Reply => ({ status: 200, body: { ok: true, data: rows } });
const lists = (calls: Call[]) => calls.filter((c) => c.method === 'GET' && c.url.includes('/api/lakehouse/shortcuts?')).length;

function mountHook() {
  return renderHook(() => useLakehouseShortcuts({
    shortcutLakehouseId: LH, schemasEnabled: false, containers: null, schemas: null, bundleShortcuts: [],
    loadSchemas: async () => {}, confirm: async () => true, setSqlText: () => {}, setTab: () => {}, tab: 'files',
  }));
}

describe('useLakehouseShortcuts — the listing', () => {
  it('a refused listing sets shortcutsListFailed and shows the error with its remediation; a success clears it', async () => {
    installFetch({ list: [{ status: 404, body: NOT_FOUND }, listed([])], post: [], delete: [] });
    const { result } = mountHook();
    await act(async () => { await result.current.loadShortcuts(); });
    // Breaks if the catch does not set the flag (false), or the remediation is
    // dropped from the message (the error alone).
    expect([result.current.shortcutsListFailed, result.current.shortcutsError])
      .toEqual([true, `${NOT_FOUND.error} ${NOT_FOUND.remediation}`]);
    await act(async () => { await result.current.loadShortcuts(); });
    // Breaks if the flag is not cleared when a listing starts: it stays true
    // over a successful EMPTY listing, and the pane would hide its empty state.
    expect([result.current.shortcutsListFailed, result.current.shortcutsError, result.current.shortcuts])
      .toEqual([false, null, []]);
  });
});

describe('useLakehouseShortcuts — refusals show their remediation', () => {
  it('Delete', async () => {
    installFetch({ list: [], post: [], delete: [{ status: 404, body: NOT_FOUND }] });
    const { result } = mountHook();
    await act(async () => { await result.current.deleteShortcutRow(ROW); });
    // Breaks if Delete reads `error` only.
    expect(result.current.shortcutsError).toBe(`${NOT_FOUND.error} ${NOT_FOUND.remediation}`);
  });

  it('Register (bundle shortcut)', async () => {
    installFetch({ list: [], post: [{ status: 404, body: NOT_FOUND }], delete: [] });
    const { result } = mountHook();
    await act(async () => { await result.current.registerBundleShortcut({ name: 'orders', target: ROW.targetUri }); });
    // Breaks if Register reads `hint || error` only.
    expect(result.current.shortcutsError).toBe(`${NOT_FOUND.error} ${NOT_FOUND.remediation}`);
  });

  it('New shortcut (wizard submit)', async () => {
    installFetch({ list: [], post: [{ status: 404, body: NOT_FOUND }], delete: [] });
    const { result } = mountHook();
    await act(async () => { result.current.setScName('orders'); });
    await act(async () => { await result.current.submitShortcut(); });
    // Breaks if the wizard submit reads `hint || error` only.
    expect(result.current.scSubmitError).toBe(`${NOT_FOUND.error} ${NOT_FOUND.remediation}`);
  });
});

describe('useLakehouseShortcuts — a create that saved a row reloads the list', () => {
  const GATE = 'The S3 engine is not configured. Set LOOM_S3_ENGINE, then use Test.';

  it('Register: a 503 with the saved pending row reloads, then shows the error', async () => {
    const calls = installFetch({
      list: [listed([PENDING])],
      post: [{ status: 503, body: { ok: false, code: 'engine_not_configured', error: GATE, hint: GATE, data: PENDING } }],
      delete: [],
    });
    const { result } = mountHook();
    await act(async () => { await result.current.registerBundleShortcut({ name: 'ext', target: 's3://b/k' }); });
    // Breaks if the hook throws before reloading (0 listings, the row unseen),
    // or sets the error before the reload (loadShortcuts clears it: null).
    expect([lists(calls), result.current.shortcuts, result.current.shortcutsError]).toEqual([1, [PENDING], GATE]);
  });

  it('a refusal saves nothing and does not reload (control)', async () => {
    const calls = installFetch({ list: [], post: [{ status: 404, body: NOT_FOUND }], delete: [] });
    const { result } = mountHook();
    await act(async () => { await result.current.registerBundleShortcut({ name: 'ext', target: 's3://b/k' }); });
    // Breaks if every failed create reloads (an unqueued listing throws, and
    // the count is 1).
    expect(lists(calls)).toBe(0);
  });

  it('New shortcut: a 502 with the saved error row reloads, and the wizard keeps the error', async () => {
    const BIND = 'Binding the S3 source failed.';
    const calls = installFetch({
      list: [listed([{ ...PENDING, status: 'error' }])],
      post: [{ status: 502, body: { ok: false, code: 'external_bind_error', error: BIND, hint: BIND, data: { ...PENDING, status: 'error' } } }],
      delete: [],
    });
    const { result } = mountHook();
    await act(async () => { result.current.setScName('ext'); });
    await act(async () => { await result.current.submitShortcut(); });
    // Breaks if the submit throws before reloading (0 listings).
    expect([lists(calls), result.current.scSubmitError]).toEqual([1, BIND]);
  });
});

// ------------------------------------------------------------------- pane

const PLANNED = { name: 'planned_sales', target: 'abfss://bronze@acct.dfs.core.windows.net/sales', description: 'Sales feed' };

function mountPane(over: Record<string, unknown>) {
  installFetchMock({ '/api/lakehouse/access': () => ({ ok: true, lakehouseId: LH, canWrite: true }) });
  const value = {
    id: LH, isNewItem: false, setActionError: () => {}, setActionStatus: () => {},
    shortcutLakehouseId: LH, shortcuts: [], shortcutsBusy: false, shortcutsError: null, shortcutsListFailed: false,
    loadShortcuts: vi.fn(), selectedShortcut: null, setSelectedShortcut: vi.fn(),
    openShortcutWizard: vi.fn(), testShortcut: vi.fn(), deleteShortcutRow: vi.fn(), queryShortcut: vi.fn(),
    bundleShortcuts: [PLANNED], regBusy: null, registerBundleShortcut: vi.fn(), registerAllBundleShortcuts: vi.fn(),
    setSqlText: vi.fn(), setTab: vi.fn(),
    ...over,
  } as unknown as LakehouseEditorCtx;
  renderWithProviders(<LakehouseEditorContext.Provider value={value}><ShortcutsPane /></LakehouseEditorContext.Provider>);
}

describe('ShortcutsPane — a failed listing is not reported as empty', () => {
  const LIST_ERROR = `${NOT_FOUND.error} ${NOT_FOUND.remediation}`;

  it('failed listing: the error and its remediation show; no empty state and no Register actions', async () => {
    mountPane({ shortcutsError: LIST_ERROR, shortcutsListFailed: true });
    // Breaks if the error bar is not rendered (the absences below would then
    // pass on a pane that shows nothing).
    expect(await screen.findByText(LIST_ERROR)).toBeTruthy();
    expect(screen.getByText(/The shortcut list could not be read/)).toBeTruthy();
    // Breaks if the pane ignores shortcutsListFailed: shortcuts is [] here, so
    // the empty state and the bundle's Register buttons would render.
    expect([
      screen.queryByText('No shortcuts registered yet'),
      screen.queryByRole('button', { name: /^Register all$/ }),
      screen.queryByRole('button', { name: /^Register$/ }),
    ]).toEqual([null, null, null]);
  });

  it('successful empty listing: the empty state and Register actions show (control)', async () => {
    mountPane({});
    // Breaks if the guard hides the empty state even when the listing
    // succeeded (for example the flag inverted).
    expect(await screen.findByText('No shortcuts registered yet')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Register all$/ })).toBeTruthy());
    expect(screen.queryByText(/The shortcut list could not be read/)).toBeNull();
  });
});
